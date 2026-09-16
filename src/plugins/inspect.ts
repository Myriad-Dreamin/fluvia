/**
 * Inspection is a first-class part of the interface, not a debug afterthought.
 * An agent that fires calls and forgets them needs a way back in: what is still
 * running, what is this call waiting for, and — because several agents share
 * one runtime — how is *that* agent doing.
 *
 * So `list`, `cancel`, `inspect`, `vars`, `defs` and `help` are registered as
 * ordinary functions in the same registry as the toolbox. They differ in one
 * respect only: `kind: 'control'` means they answer synchronously and bind no
 * handles, because an answer you have to wait for is useless for triage.
 *
 * Visibility follows the handle scope (`Environment.scope`) rather than a
 * separate switch, because it is the same question: under `runtime` scope one
 * operator drives every agent and sees everything, while under `agent` scope
 * the agents are mutually untrusted, so a caller inspects and cancels only its
 * own calls. Inspection that crossed that line would leak both the shape of
 * another agent's work and digests of its payloads.
 *
 * @module fluvia/plugins/inspect
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CallRecord, FunctionDef } from '../core/types.ts'
import { isTerminal } from './scheduler.ts'
import { ms, percentile, renderArgs, renderSignature, renderSkip, table } from '../cli/format.ts'

/** What a control function returns: text for the terminal, rows for `--json`. */
export interface ControlResult {
  /** Rendered answer. */
  text: string
  /** Machine-readable rows, echoed in machine mode. */
  rows?: unknown[]
}

/** Build the control functions bound to one runtime context. */
export function controlFunctions(ctx: Context): FunctionDef[] {
  return [
    {
      name: 'list',
      out: 'listing',
      kind: 'control',
      summary: 'Show calls that have not settled yet; `list("all")` includes finished ones.',
      params: '(scope?)',
      positional: ['scope'],
      run: (args: { scope?: string }, cx) => listCalls(ctx, cx.agent, args.scope ?? 'live'),
    },
    {
      name: 'cancel',
      out: 'cancelled',
      kind: 'control',
      summary: 'Abort a call by id. Dependents of the cancelled call are skipped.',
      params: '(id)',
      positional: ['id'],
      run: (args: { id?: string }, cx) => cancelCall(ctx, args.id, cx.agent),
    },
    {
      name: 'inspect',
      out: 'report',
      kind: 'control',
      summary: 'Analyse the session, one call (`inspect(c3)`) or one agent (`inspect(@tuner)`).',
      params: '(target?)',
      positional: ['target'],
      run: (args: { target?: string }, cx) => inspectTarget(ctx, cx.agent, args.target),
    },
    {
      name: 'vars',
      out: 'vars',
      kind: 'control',
      summary: 'List bound handles with their states and payload summaries.',
      params: '()',
      run: (_args, cx) => listVars(ctx, cx.agent),
    },
    {
      name: 'defs',
      out: 'defs',
      kind: 'control',
      summary: 'List the preloaded functions.',
      params: '()',
      run: () => listDefs(ctx),
    },
    {
      name: 'help',
      out: 'help',
      kind: 'control',
      summary: 'Show the call syntax and the built-in commands.',
      params: '()',
      run: () => ({ text: HELP }),
    },
  ]
}

/**
 * True when the caller may see another agent's work — i.e. when the runtime is
 * driven by one operator rather than shared by untrusted agents.
 */
function seesEveryAgent(ctx: Context): boolean {
  return ctx.env.scope === 'runtime'
}

/** Calls the caller is allowed to see. */
function visibleCalls(ctx: Context, caller: string): CallRecord[] {
  const calls = ctx.calls.list()
  return seesEveryAgent(ctx) ? calls : calls.filter((call) => call.agent === caller)
}

/** `list()` — the triage view. */
function listCalls(ctx: Context, caller: string, scope: string): ControlResult {
  const all = scope === 'all' || scope === 'done'
  const calls = visibleCalls(ctx, caller).filter((call) => (all ? true : !isTerminal(call.state)))
  if (!calls.length) {
    return { text: all ? 'no calls yet' : 'nothing in flight', rows: [] }
  }
  const now = ctx.calls.now()
  const rows = calls.map((call) => [
    call.id,
    call.agent,
    call.fn,
    call.state,
    ms((call.at.settle ?? now) - call.at.submit),
    blockedOn(ctx, call),
  ])
  return {
    text: table(['call', 'agent', 'fn', 'state', 'age', 'blocked on / result'], rows),
    rows: calls.map((call) => ({ id: call.id, agent: call.agent, fn: call.fn, state: call.state })),
  }
}

/** One line of "what is this call waiting for", or how it ended. */
function blockedOn(ctx: Context, call: CallRecord): string {
  if (call.state === 'waiting') {
    const pending = call.deps.filter((dep) => ctx.env.handle(dep.handle)?.state === 'pending')
    return pending.length ? pending.map((dep) => dep.name).join(', ') : '—'
  }
  if (call.state === 'queued') return `queued (limit ${ctx.calls.concurrency})`
  if (call.state === 'running') return call.progress.at(-1)?.note ?? 'running'
  if (call.state === 'done') return `${call.bind.value} ready`
  if (call.state === 'failed') return `${call.error?.kind}: ${call.error?.message}`
  if (call.state === 'skipped') return renderSkip(call.skip!.reason, call.skip!.from)
  return call.cancel?.reason ?? ''
}

/** `cancel(c5)`. */
function cancelCall(ctx: Context, id: string | undefined, agent: string): ControlResult {
  if (!id) return { text: 'cancel(id) needs a call id, e.g. cancel(c5)' }
  const target = ctx.calls.get(id)
  if (target && !seesEveryAgent(ctx) && target.agent !== agent) {
    // Refuse without confirming it exists: "not yours" and "not a call" have to
    // read the same, or cancel() becomes a probe for other agents' call ids.
    return { text: `unknown call: ${id}` }
  }
  const result = ctx.calls.cancel(id, agent)
  return {
    text: result.ok ? `${id} cancelled; dependents will be skipped` : `${id} already ${result.state}, nothing to cancel`,
    rows: [{ id, ...result }],
  }
}

/** `inspect()` / `inspect(c3)` / `inspect(@tuner)` / `inspect(kernel0)`. */
function inspectTarget(ctx: Context, caller: string, target?: string): ControlResult {
  if (!target) return inspectSession(ctx, caller)
  const named = target.startsWith('@') ? target.slice(1) : target
  if (target.startsWith('@')) {
    if (!seesEveryAgent(ctx) && named !== caller) return { text: `unknown agent: @${named}` }
    return inspectAgent(ctx, named)
  }
  const call = ctx.calls.get(target) ?? ctx.calls.get(ctx.env.lookup(target, caller)?.call ?? '')
  if (call) {
    if (!seesEveryAgent(ctx) && call.agent !== caller) return { text: `unknown target: ${target}` }
    return inspectCall(ctx, call)
  }
  if (ctx.env.agents().some((agent) => agent.id === named)) {
    if (!seesEveryAgent(ctx) && named !== caller) return { text: `unknown target: ${target}` }
    return inspectAgent(ctx, named)
  }
  return { text: `unknown target: ${target}. Try a call id (c3), a handle (kernel0) or an agent (@tuner).` }
}

/** Everything known about one call. */
function inspectCall(ctx: Context, call: CallRecord): ControlResult {
  const lines: string[] = []
  lines.push(`${call.id} ${call.fn}(${renderArgs(call.args)})  [${call.state}]  agent=${call.agent}`)
  if (call.deps.length) {
    lines.push(
      `  deps: ${call.deps
        .map((dep) => {
          const handle = ctx.env.handle(dep.handle)!
          return `${dep.name} (${dep.kind} of ${dep.from}, ${handle.state})`
        })
        .join(', ')}`,
    )
  }
  const value = ctx.env.handle(call.handles.value)!
  const error = ctx.env.handle(call.handles.error)!
  lines.push(
    `  binds: ${value.name} [${value.state}${value.state === 'ready' ? ` ${value.type} ${value.summary}` : ''}]` +
      `, ${error.name} [${error.state}${error.state === 'ready' ? ` ${error.type}` : ''}]`,
  )
  const now = ctx.calls.now()
  lines.push(
    `  timing: submitted +${ms(call.at.submit)}` +
      (call.at.start === undefined ? '' : `, started +${ms(call.at.start)} (waited ${ms(call.at.start - call.at.submit)})`) +
      (call.at.settle === undefined
        ? `, still ${call.state} after ${ms(now - call.at.submit)}`
        : `, settled +${ms(call.at.settle)} (ran ${ms(call.at.settle - (call.at.start ?? call.at.settle))})`),
  )
  if (call.progress.length) {
    lines.push('  progress:')
    for (const entry of call.progress) {
      lines.push(`    +${ms(entry.at)} ${entry.note}${entry.pct === undefined ? '' : ` (${Math.round(entry.pct)}%)`}`)
    }
  }
  if (call.error) {
    lines.push(`  error: ${call.error.kind}: ${call.error.message}${call.error.retryable ? ' (retryable)' : ''}`)
    if (call.error.detail !== undefined) lines.push(`  detail: ${JSON.stringify(call.error.detail)}`)
  }
  if (call.skip) lines.push(`  skipped: ${renderSkip(call.skip.reason, call.skip.from)}`)
  if (call.cancel) lines.push(`  cancelled by ${call.cancel.by}: ${call.cancel.reason}`)
  const dependents = ctx.calls.list().filter((other) => other.deps.some((dep) => dep.from === call.id))
  if (dependents.length) lines.push(`  dependents: ${dependents.map((other) => `${other.id} (${other.state})`).join(', ')}`)
  return { text: lines.join('\n'), rows: [call] }
}

/** Per-agent analysis: how this caller is actually doing. */
function inspectAgent(ctx: Context, id: string): ControlResult {
  const agent = ctx.env.agents().find((record) => record.id === id)
  if (!agent) return { text: `unknown agent: @${id}` }
  const calls = agent.calls.map((callId) => ctx.calls.get(callId)!).filter(Boolean)
  const settled = calls.filter((call) => isTerminal(call.state))
  const totals = settled.map((call) => call.at.settle! - call.at.submit)
  const waits = settled.filter((call) => call.at.start !== undefined).map((call) => call.at.start! - call.at.submit)
  const runs = settled.filter((call) => call.at.start !== undefined).map((call) => call.at.settle! - call.at.start!)
  const lag = ctx.notify.deliveries.filter((entry) => entry.agents.includes(id)).map((entry) => entry.latencyMs)

  const lines = [
    `@${agent.id}  joined +${ms(agent.joinedAt)}  ${agent.lines} lines  ${calls.length} calls  (${ctx.calls
      .list()
      .filter((call) => call.agent === id && !isTerminal(call.state)).length} live)`,
    `  outcomes: ${renderOutcomes(calls)}`,
    `  latency (submit→settle): p50 ${ms(percentile(totals, 0.5))}  p95 ${ms(percentile(totals, 0.95))}  max ${ms(Math.max(0, ...totals))}`,
    `  wait vs run: mean wait ${ms(mean(waits))}  mean run ${ms(mean(runs))}  (wait is queueing and dependencies)`,
    `  notification lag: p50 ${ms(percentile(lag, 0.5))}  p95 ${ms(percentile(lag, 0.95))}`,
  ]
  const byFunction = groupBy(calls, (call) => call.fn)
  lines.push(
    '  ' +
      table(
        ['fn', 'calls', 'p50 run', 'failed'],
        [...byFunction].map(([fn, group]) => [
          fn,
          group.length,
          ms(percentile(group.filter((call) => call.at.start).map((call) => call.at.settle! - call.at.start!), 0.5)),
          group.filter((call) => call.state === 'failed').length,
        ]),
      ).split('\n').join('\n  '),
  )
  return { text: lines.join('\n'), rows: [{ agent: agent.id, calls: calls.length }] }
}

/** Whole-session analysis, including how parallel the session actually was. */
function inspectSession(ctx: Context, caller: string): ControlResult {
  const calls = visibleCalls(ctx, caller)
  const now = ctx.calls.now()
  const busy = calls.reduce(
    (total, call) => total + (call.at.start === undefined ? 0 : (call.at.settle ?? now) - call.at.start),
    0,
  )
  const live = calls.filter((call) => !isTerminal(call.state))
  const lines = [
    `session +${ms(now)} wall  ·  concurrency limit ${ctx.calls.concurrency}  ·  ${ctx.notify.names.join(', ') || 'no sinks'}`,
    `  calls: ${calls.length} (${renderOutcomes(calls)})`,
    `  live: ${live.filter((call) => call.state === 'running').length} running, ${live.filter((call) => call.state === 'queued').length} queued, ${live.filter((call) => call.state === 'waiting').length} waiting`,
    `  busy ${ms(busy)} over ${ms(now)} wall → mean parallelism ${(busy / Math.max(now, 1)).toFixed(2)} of ${ctx.calls.concurrency}`,
    `  notifications: ${ctx.notify.history.length} emitted, ${ctx.notify.deliveries.length} deliveries`,
  ]
  const roster = seesEveryAgent(ctx) ? ctx.env.agents() : ctx.env.agents().filter((agent) => agent.id === caller)
  const rows = roster.map((agent) => {
    const owned = calls.filter((call) => call.agent === agent.id)
    const totals = owned.filter((call) => call.at.settle !== undefined).map((call) => call.at.settle! - call.at.submit)
    return [agent.id, owned.length, owned.filter((call) => !isTerminal(call.state)).length, ms(percentile(totals, 0.5)), ms(percentile(totals, 0.95)), renderOutcomes(owned)]
  })
  lines.push('  ' + table(['agent', 'calls', 'live', 'p50', 'p95', 'outcomes'], rows).split('\n').join('\n  '))
  return { text: lines.join('\n'), rows }
}

/** `vars()` — the handle names this caller can use. */
function listVars(ctx: Context, caller: string): ControlResult {
  const handles = ctx.env.handles(caller)
  if (!handles.length) return { text: 'no handles bound yet', rows: [] }
  const rows = handles.map((handle) => [
    handle.name,
    handle.state,
    handle.call,
    handle.type ?? '',
    handle.summary ?? (handle.state === 'void' ? '(never)' : ''),
  ])
  return { text: table(['handle', 'state', 'from', 'type', 'summary'], rows), rows: handles }
}

/** `defs()` — what this CLI preloaded. */
function listDefs(ctx: Context): ControlResult {
  const defs = ctx.functions.list()
  const rows = defs.map((def) => [renderSignature(def), def.kind === 'control' ? 'control' : `⇒ ${def.out}N`, def.summary])
  return { text: table(['function', 'binds', 'what it does'], rows), rows: defs.map((def) => def.name) }
}

/** Outcome mix as `done 4, failed 1`. */
function renderOutcomes(calls: CallRecord[]): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.state, (counts.get(call.state) ?? 0) + 1)
  return [...counts].map(([state, count]) => `${state} ${count}`).join(', ') || 'none'
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const group = map.get(key(item))
    if (group) group.push(item)
    else map.set(key(item), [item])
  }
  return map
}

/** `help()` — the whole interface on one screen. */
const HELP = `fluvia — fully asynchronous dataflow CLI

One call per line, JS call syntax, no computation:
  prepareKernel({ size: 4096, dtype: "f32" })   → answers instantly with c0, kernel0, err0
  compileKernel(kernel0, { opt: 3 })            → waits for kernel0, then runs
  @tuner benchmark(kernel2, dataset1)           → submitted as agent "tuner"

Every call binds two handles: <out>N carries the value, errN carries the failure.
Exactly one of them becomes ready; the other becomes void. A call whose handle
turns void is skipped, so recovery paths (explain(err3)) and happy paths can both
be submitted up front.

Results arrive as notifications; do not poll for them.

Built-ins: list, list("all"), cancel(c3), inspect(), inspect(c3), inspect(@agent),
vars, defs, help. Type .exit to close the session.` as const

/** Exported for the CLI banner. */
export { HELP }
