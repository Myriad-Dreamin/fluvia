/**
 * `fluvia serve` — the runtime, on the side of the boundary the model cannot
 * reach.
 *
 * Everything that decides what an instruction *does* is a flag here: which
 * toolbox is preloaded, how much concurrency exists, where the trace is
 * written, how much any one agent may ask for. None of it is reachable over the
 * wire, so a model that owns its whole sandbox still only gets to submit lines
 * against the instruction set this command chose.
 *
 * Usage:
 *   tsx src/server/bin.ts --listen unix:/run/fluvia.sock --preload <module>
 *                         [--concurrency 4] [--trace out/serve.jsonl.gz]
 *                         [--token-file <path>] [--scope agent|runtime]
 *
 * @module fluvia/server/bin
 */

import { createServer } from 'node:net'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { Tracer } from '../core/trace.ts'
import type { CallOutcome, SessionStats } from '../core/types.ts'
import { FunctionRegistry } from '../plugins/registry.ts'
import { Environment } from '../plugins/env.ts'
import type { HandleScope } from '../plugins/env.ts'
import { NotifyHub } from '../plugins/notify.ts'
import { Scheduler, isTerminal } from '../plugins/scheduler.ts'
import { controlFunctions } from '../plugins/inspect.ts'
import { AgentNamer, Connection } from './connection.ts'
import type { ConnectionPolicy } from './connection.ts'
import { formatAddress, parseAddress } from './protocol.ts'

const { values } = parseArgs({
  options: {
    listen: { type: 'string', default: 'unix:/tmp/fluvia.sock' },
    preload: { type: 'string', multiple: true },
    concurrency: { type: 'string', default: '4' },
    trace: { type: 'string' },
    session: { type: 'string' },
    'token-file': { type: 'string' },
    scope: { type: 'string', default: 'agent' },
    'max-connections': { type: 'string', default: '32' },
    'max-in-flight': { type: 'string', default: '32' },
    'max-line-bytes': { type: 'string', default: '2048' },
    rate: { type: 'string', default: '20' },
    'keep-on-disconnect': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  process.stdout.write(
    [
      'fluvia serve — run the instruction set outside the model\'s reach',
      '',
      '  --listen <addr>          unix:<path> (default) or tcp:<host>:<port>',
      '  --preload <module>       toolbox module, repeatable; this IS the instruction set',
      '  --concurrency <n>        implementations running at once, shared by every agent',
      '  --trace <file>           gzip JSONL trace, written host-side',
      '  --token-file <path>      shared secret a client must present (mandatory for tcp:)',
      '  --scope agent|runtime    handle namespace per agent (default) or shared',
      '  --max-connections <n>    live connections (default 32)',
      '  --max-in-flight <n>      unsettled calls per agent (default 32)',
      '  --max-line-bytes <n>     longest submitted line (default 2048)',
      '  --rate <n>               submissions per second per agent (default 20)',
      '  --keep-on-disconnect     leave an agent\'s calls running when it drops',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

const address = parseAddress(values.listen!)
const token = values['token-file'] ? readFileSync(values['token-file'], 'utf8').trim() : undefined
if (address.kind === 'tcp' && !token) {
  // A TCP endpoint is reachable by anything that can route to it, and what it
  // accepts is "run instructions on the host". Refusing to start without a
  // secret is the only safe default.
  process.stderr.write('fluvia serve: --token-file is required with a tcp: address\n')
  process.exit(2)
}

const sessionId = values.session ?? `srv-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
const tracer = new Tracer(values.trace)
const concurrency = Math.max(1, Number(values.concurrency) || 4)
const scope = (values.scope === 'runtime' ? 'runtime' : 'agent') satisfies HandleScope

const ctx = new Context()
await ctx.plugin(FunctionRegistry)
await ctx.plugin(Environment, { tracer, scope })
await ctx.plugin(NotifyHub, tracer)
await ctx.plugin(Scheduler, { tracer, concurrency })
await ctx.inject(['functions', 'env', 'notify', 'calls'], () => {})

ctx.functions.registerAll(controlFunctions(ctx))
const DEFAULT_TOOLBOX = fileURLToPath(new URL('../toolbox/default.ts', import.meta.url))
for (const specifier of values.preload?.length ? values.preload : [DEFAULT_TOOLBOX]) {
  await ctx.functions.preload(specifier)
}

tracer.emit('session.start', {
  meta: {
    v: 1,
    session: sessionId,
    origin: tracer.origin,
    runtime: { node: process.version, platform: process.platform, fluvia: '0.1.0' },
    concurrency,
    preload: ctx.functions.preloaded,
    sinks: ['connection'],
  },
})

const policy: ConnectionPolicy = {
  limits: {
    maxLineBytes: Math.max(64, Number(values['max-line-bytes']) || 2048),
    maxInFlight: Math.max(1, Number(values['max-in-flight']) || 32),
    submitsPerSecond: Math.max(1, Number(values.rate) || 20),
  },
  token,
  onDisconnect: values['keep-on-disconnect'] ? 'keep' : 'cancel',
}

const namer = new AgentNamer()
const connections = new Set<Connection>()
const maxConnections = Math.max(1, Number(values['max-connections']) || 32)

// One sink for the whole runtime: a notification goes to the connection whose
// agent owns the call, and to nobody else. Routing by identity here — rather
// than letting clients subscribe — is what keeps one agent's results private.
ctx.notify.register({
  name: 'connection',
  deliver(batch) {
    for (const notification of batch) {
      for (const connection of connections) {
        if (connection.agentId === notification.agent) connection.deliver({ t: 'result', notification })
      }
    }
  },
})

const server = createServer((socket) => {
  if (connections.size >= maxConnections) {
    socket.end(`${JSON.stringify({ t: 'bye', reason: 'too many connections' })}\n`)
    return
  }
  const connection = new Connection(ctx, socket, tracer, namer, policy, sessionId)
  connections.add(connection)
  socket.on('close', () => connections.delete(connection))
})

if (address.kind === 'unix') {
  mkdirSync(dirname(address.path), { recursive: true })
  // A stale socket from a killed server would otherwise make listen() fail.
  rmSync(address.path, { force: true })
  server.listen(address.path, () => {
    // The socket file IS the access control for a unix endpoint.
    chmodSync(address.path, 0o600)
    announce()
  })
} else {
  server.listen(address.port, address.host, announce)
}

/** Print what an operator needs, including how a client should connect. */
function announce(): void {
  const isa = ctx.functions.list().filter((def) => def.kind !== 'control')
  process.stdout.write(
    [
      `fluvia serve — session ${sessionId}`,
      `  listening   ${formatAddress(address)}${token ? ' (token required)' : ''}`,
      `  instruction set  ${isa.length} functions: ${isa.map((def) => def.name).join(', ')}`,
      `  preloaded   ${ctx.functions.preloaded.join(', ')}`,
      `  concurrency ${concurrency} · handle scope ${scope} · ${policy.limits.maxInFlight} in flight/agent · ${policy.limits.submitsPerSecond}/s`,
      values.trace ? `  trace       ${values.trace}` : '  trace       (none)',
      '',
      `  connect:    pnpm connect --connect ${formatAddress(address)}`,
      '',
    ].join('\n'),
  )
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}

/** Close connections, settle the trace, and leave no socket file behind. */
async function shutdown(reason: string): Promise<void> {
  for (const connection of connections) connection.close(`server shutting down (${reason})`)
  server.close()
  ctx.calls.abortAll('server shutting down')
  await ctx.calls.drain()
  await ctx.notify.close()
  tracer.emit('session.end', { reason, stats: collectStats() })
  await tracer.close()
  if (address.kind === 'unix') rmSync(address.path, { force: true })
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
