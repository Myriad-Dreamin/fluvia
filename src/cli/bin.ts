/**
 * The fluvia CLI: a cordis application whose services are the runtime an agent
 * talks to. Composition follows DeepSeek Harness — one plugin per concern,
 * wired over a shared `Context` — so a deployment can swap the toolbox or the
 * notification handler without touching the scheduler.
 *
 * Usage:
 *   tsx src/cli/bin.ts [--agent a0] [--preload <module>] [--trace <file.jsonl.gz>]
 *                      [--concurrency 4] [--notify stdout|file:<p>|dsh[:…]]
 *                      [--script <file>] [--proc-dir <dir>] [--json] [--quiet]
 *
 * @module fluvia/cli/bin
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Tracer } from '../core/trace.ts'
import type { CallOutcome, SessionStats } from '../core/types.ts'
import { FunctionRegistry } from '../plugins/registry.ts'
import { Environment } from '../plugins/env.ts'
import { NotifyHub } from '../plugins/notify.ts'
import { Scheduler, isTerminal } from '../plugins/scheduler.ts'
import { ProcessSupervisor } from '../plugins/processes.ts'
import { controlFunctions, HELP } from '../plugins/inspect.ts'
import { CliSession, Output } from './session.ts'
import { createSink } from './sinks.ts'

/** How long shutdown waits for in-flight calls before cancelling them. */
const DRAIN_TIMEOUT_MS = 60_000

const { values } = parseArgs({
  options: {
    agent: { type: 'string', default: 'a0' },
    preload: { type: 'string', multiple: true },
    trace: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    notify: { type: 'string', multiple: true },
    script: { type: 'string' },
    session: { type: 'string' },
    'proc-dir': { type: 'string' },
    json: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  process.stdout.write(`${HELP}\n`)
  process.exit(0)
}

/** Default toolbox, resolved next to this file so the CWD does not matter. */
const DEFAULT_TOOLBOX = fileURLToPath(new URL('../toolbox/default.ts', import.meta.url))

const sessionId = values.session ?? sessionIdFrom(values.trace)
const tracer = new Tracer(values.trace)
const out = new Output(tracer, values.json ? 'json' : 'human')
const concurrency = Math.max(1, Number(values.concurrency) || 4)

const ctx = new Context()
await ctx.plugin(FunctionRegistry)
await ctx.plugin(Environment, { tracer })
await ctx.plugin(NotifyHub, tracer)
await ctx.plugin(ProcessSupervisor, { tracer, dir: values['proc-dir'] ?? join(tmpdir(), 'fluvia', sessionId) })
await ctx.plugin(Scheduler, { tracer, concurrency })
// Services appear when their fiber starts, which is a microtask after plugin();
// inject() resolves once every name below is live, so nothing races the input.
await ctx.inject(['functions', 'env', 'notify', 'processes', 'calls'], () => {})

ctx.functions.registerAll(controlFunctions(ctx))

const preloads = values.preload?.length ? values.preload : [DEFAULT_TOOLBOX]
for (const specifier of preloads) {
  try {
    await ctx.functions.preload(specifier)
  } catch (error) {
    out.say('', `✗ preload ${specifier}: ${(error as Error).message}`, 'error')
  }
}

tracer.emit('session.start', {
  meta: {
    v: 1,
    session: sessionId,
    origin: tracer.origin,
    runtime: { node: process.version, platform: process.platform, fluvia: '0.1.0' },
    concurrency,
    preload: ctx.functions.preloaded,
    sinks: values.notify ?? ['stdout'],
  },
})

for (const spec of values.notify ?? ['stdout']) {
  try {
    ctx.notify.register(await createSink(spec, { out, session: sessionId, hub: ctx.notify }))
  } catch (error) {
    out.say('', `✗ ${(error as Error).message}`, 'error')
  }
}

const session = new CliSession(ctx, out, tracer, { defaultAgent: values.agent! })

// `--quiet` drops the banner only: suppressing answers would leave an agent
// submitting calls it never learns the handles for.
if (!values.quiet) out.say('', banner(), 'info')
out.json({
  type: 'ready',
  session: sessionId,
  agent: values.agent,
  concurrency,
  functions: ctx.functions.list().map((def) => def.name),
})

await readInput()
await shutdown(values.script ? 'script complete' : 'input closed')

/** Feed lines from a script file, or from stdin until EOF or `.exit`. */
async function readInput(): Promise<void> {
  if (values.script) {
    for (const line of readFileSync(values.script, 'utf8').split('\n')) {
      if (session.handle(line) === 'exit') return
    }
    return
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    if (session.handle(line) === 'exit') break
  }
  rl.close()
}

/**
 * Close the session: let live calls finish, cancel whatever is left, flush the
 * sinks, then seal the trace. The order matters — a notification produced by a
 * cancellation still has to reach its sink before the file closes.
 */
async function shutdown(reason: string): Promise<void> {
  const timer = setTimeout(() => ctx.calls.abortAll('drain timeout'), DRAIN_TIMEOUT_MS)
  await ctx.calls.drain()
  clearTimeout(timer)
  ctx.calls.abortAll('session closing')
  await ctx.calls.drain()
  // A spawned process outlives the call that started it, and its exit is a
  // notification the agent is owed, so it gets the same drain budget.
  const kill = setTimeout(() => ctx.processes.killAll(), DRAIN_TIMEOUT_MS)
  await ctx.processes.drain()
  clearTimeout(kill)
  await ctx.notify.close()

  const stats = collectStats()
  tracer.emit('session.end', { reason, stats })
  out.say('', `session ${sessionId} closed: ${stats.calls} calls, ${stats.notifications} notifications`, 'info')
  out.json({ type: 'bye', session: sessionId, reason, stats, trace: values.trace ?? null })
  await tracer.close()
  process.exit(0)
}

/** Roll up the session for the trace footer. */
function collectStats(): SessionStats {
  const calls = ctx.calls.list()
  const outcomes: Record<CallOutcome, number> = { done: 0, failed: 0, cancelled: 0, skipped: 0 }
  let busy = 0
  for (const call of calls) {
    if (isTerminal(call.state)) outcomes[call.state as CallOutcome]++
    if (call.at.start !== undefined && call.at.settle !== undefined) busy += call.at.settle - call.at.start
  }
  return {
    calls: calls.length,
    outcomes,
    agents: ctx.env.agents().length,
    notifications: ctx.notify.history.length,
    wallMs: Math.round(tracer.now() * 1000) / 1000,
    busyMs: Math.round(busy * 1000) / 1000,
  }
}

/** Session id derived from the trace file name, so the two always agree. */
function sessionIdFrom(trace?: string): string {
  const fromFile = trace?.split(/[\\/]/).pop()?.replace(/\.jsonl(\.gz)?$/, '')
  if (fromFile) return fromFile
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15)
  return `s-${stamp.slice(0, 8)}-${stamp.slice(8, 14)}`
}

/** First thing an agent sees: what is loaded and how to ask for more. */
function banner(): string {
  const names = ctx.functions
    .list()
    .filter((def) => def.kind !== 'control')
    .map((def) => def.name)
  return [
    `fluvia ${sessionId} · concurrency ${concurrency} · agent ${values.agent}`,
    `loaded: ${names.join(', ') || '(no toolbox)'}`,
    'calls answer instantly and notify when they settle · help() for the syntax',
  ].join('\n')
}
