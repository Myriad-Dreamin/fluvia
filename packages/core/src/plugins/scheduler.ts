/**
 * The scheduler is the asynchronous core. Submitting a call never blocks: the
 * line is answered with a call id and two variable names, and the work joins a
 * dataflow graph whose edges are the handles the agent passed along.
 *
 * Three rules define the semantics, and everything else follows from them:
 *
 * 1. A call runs once every handle it consumes is `ready`.
 * 2. A call is **skipped** as soon as one handle it consumes turns `void` — the
 *    producing call settled on the other channel. That is what makes
 *    `explain(err3)` legal to submit before anyone knows whether `c3` fails:
 *    if `c3` succeeds, `err3` is void and the recovery path quietly disappears.
 * 3. Skips and cancellations cascade, so a failed root never leaves orphaned
 *    work waiting forever.
 *
 * @module @fluvia/core/plugins/scheduler
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { FluviaError } from '../types.ts'
import type { ArgNode, CallOutcome, CallRecord, DepRef, FunctionDef, RuntimeFacade, SkipReason } from '../types.ts'
import type { RawArg, ParsedLine } from '../parser.ts'
import type { Tracer } from '../trace.ts'
import { describe, toCallError } from '../describe.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    calls: Scheduler
  }
}

/** Scheduler configuration, supplied by the CLI. */
export interface SchedulerConfig {
  /** The session tracer. */
  tracer: Tracer
  /** Maximum number of implementations running at once. */
  concurrency: number
  /**
   * Where `cx.sleep` gets its timers. Defaults to the host's. The bench replay
   * passes a virtual clock here so a recorded session re-runs deterministically
   * and as fast as the machine allows.
   */
  timers?: Timers
}

/** The two timer functions `cx.sleep` needs; the host's globals satisfy it. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const HOST_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Raised for a line that parses but cannot be scheduled. */
export class SubmitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubmitError'
  }
}

/** Bookkeeping for a call whose implementation is executing. */
interface Execution {
  controller: AbortController
  /**
   * Set when the call was cancelled while running: the implementation may keep
   * going, but its eventual result is ignored so `cancel()` is immediate from
   * the agent's point of view.
   */
  detached: boolean
}

export class Scheduler extends Service {
  static inject = ['functions', 'env', 'notify']

  private readonly records = new Map<string, CallRecord>()
  private readonly queue: CallRecord[] = []
  private readonly executions = new Map<string, Execution>()
  /** handle id → calls waiting on it. */
  private readonly waiters = new Map<string, Set<string>>()
  private readonly idleWaiters: (() => void)[] = []
  private readonly tracer: Tracer
  private readonly timers: Timers
  private seq = 0

  /** Maximum simultaneous executions; queued calls wait for a slot. */
  readonly concurrency: number

  constructor(ctx: Context, config: SchedulerConfig) {
    super(ctx, 'calls')
    this.tracer = config.tracer
    this.concurrency = config.concurrency
    this.timers = config.timers ?? HOST_TIMERS
  }

  /** Milliseconds since the session origin; the clock inspection reports use. */
  now(): number {
    return this.tracer.now()
  }

  /** Read-only view handed to implementations and inspection commands. */
  get facade(): RuntimeFacade {
    return {
      call: (id) => this.records.get(id),
      calls: () => this.list(),
      agents: () => this.ctx.env.agents(),
    }
  }

  /** Every call, in submission order. */
  list(): CallRecord[] {
    return [...this.records.values()]
  }

  /** One call by id. */
  get(id: string): CallRecord | undefined {
    return this.records.get(id)
  }

  /** Calls that have not reached a terminal state. */
  live(): CallRecord[] {
    return this.list().filter((call) => !isTerminal(call.state))
  }

  /**
   * Schedule a call. Returns as soon as the record exists — by design, before
   * any work has started.
   *
   * @throws SubmitError when the callee is unknown or an argument names a
   * handle that was never bound.
   */
  submit(agent: string, parsed: ParsedLine, def: FunctionDef): CallRecord {
    const seq = this.seq++
    const id = `c${seq}`
    const deps: DepRef[] = []
    const args = parsed.args.map((arg) => this.resolveRefs(arg, deps, agent))

    const value = this.ctx.env.bind(`${def.out}${seq}`, 'value', id, agent)
    const error = this.ctx.env.bind(`err${seq}`, 'error', id, agent)
    const record: CallRecord = {
      id,
      seq,
      agent,
      fn: def.name,
      args,
      deps,
      // The environment may have suffixed a colliding name, so the record
      // reports the names it actually bound rather than the ones requested.
      bind: { value: value.name, error: error.name },
      handles: { value: value.id, error: error.id },
      state: 'waiting',
      at: { submit: this.tracer.now() },
      progress: [],
    }
    this.records.set(id, record)
    this.ctx.env.agent(agent).calls.push(id)

    for (const dep of deps) {
      let set = this.waiters.get(dep.handle)
      if (!set) this.waiters.set(dep.handle, (set = new Set()))
      set.add(id)
    }

    this.tracer.emit('call.submit', {
      agent,
      call: id,
      fn: def.name,
      args,
      deps,
      bind: record.bind,
      handles: record.handles,
    })
    this.evaluate(record)
    return record
  }

  /**
   * Cancel a call. A waiting or queued call is cancelled outright; a running
   * one has its {@link AbortSignal} fired and is detached, so the agent is not
   * left waiting on an implementation that ignores cancellation.
   *
   * @returns whether anything was cancelled, and the state observed.
   */
  cancel(id: string, by: string, reason = 'cancelled by agent'): { ok: boolean; state: CallRecord['state'] } {
    const record = this.records.get(id)
    if (!record) throw new SubmitError(`unknown call: ${id}`)
    if (isTerminal(record.state)) return { ok: false, state: record.state }

    const queued = this.queue.indexOf(record)
    if (queued >= 0) this.queue.splice(queued, 1)
    const execution = this.executions.get(id)
    if (execution) {
      execution.detached = true
      execution.controller.abort(new FluviaError('Cancelled', reason))
      this.executions.delete(id)
    }
    this.tracer.emit('call.cancel', { call: id, by, reason })
    record.cancel = { by, reason }
    this.settle(record, 'cancelled')
    this.pump()
    return { ok: true, state: 'cancelled' }
  }

  /** Resolve once no call is waiting, queued or running. */
  drain(): Promise<void> {
    if (!this.live().length) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Abort everything still live; used at shutdown. */
  abortAll(reason: string): void {
    for (const call of this.live()) this.cancel(call.id, 'system', reason)
  }

  /* ----------------------------------------------------------- internals */

  /** Rewrite a parsed argument, recording a dependency for each handle name. */
  private resolveRefs(arg: RawArg, deps: DepRef[], owner: string): ArgNode {
    switch (arg.n) {
      case 'lit':
        return arg
      case 'ref': {
        const handle = this.ctx.env.lookup(arg.name, owner)
        if (!handle) {
          throw new SubmitError(
            `unknown handle: ${arg.name}. Handles are bound by earlier calls; \`vars\` lists the live ones.`,
          )
        }
        deps.push({ handle: handle.id, name: handle.name, kind: handle.kind, from: handle.call })
        return { n: 'ref', name: arg.name, handle: handle.id }
      }
      case 'arr':
        return { n: 'arr', items: arg.items.map((item) => this.resolveRefs(item, deps, owner)) }
      case 'obj':
        return {
          n: 'obj',
          props: arg.props.map((prop) => ({ key: prop.key, value: this.resolveRefs(prop.value, deps, owner) })),
        }
    }
  }

  /** Move a waiting call forward: skip it, queue it, or leave it waiting. */
  private evaluate(call: CallRecord): void {
    if (call.state !== 'waiting') return
    for (const dep of call.deps) {
      const handle = this.ctx.env.handle(dep.handle)!
      if (handle.state === 'void') {
        this.skip(call, skipReason(this.records.get(dep.from)?.state, dep.kind), dep.from)
        return
      }
      if (handle.state === 'pending') return
    }
    call.state = 'queued'
    this.tracer.emit('call.queued', { call: call.id, blockedMs: round(this.tracer.now() - call.at.submit) })
    this.queue.push(call)
    this.pump()
  }

  /** Start queued calls while slots are free. */
  private pump(): void {
    while (this.executions.size < this.concurrency && this.queue.length) {
      this.start(this.queue.shift()!)
    }
    this.checkIdle()
  }

  /** Begin executing a call whose dependencies are all ready. */
  private start(call: CallRecord): void {
    const def = this.ctx.functions.get(call.fn)
    if (!def) {
      call.error = { kind: 'UnknownFunction', message: `${call.fn} is no longer registered` }
      this.settle(call, 'failed')
      return
    }
    const controller = new AbortController()
    const execution: Execution = { controller, detached: false }
    this.executions.set(call.id, execution)
    call.state = 'running'
    call.at.start = this.tracer.now()
    this.tracer.emit('call.start', { call: call.id, waitedMs: round(call.at.start - call.at.submit) })

    const cx = {
      call: call.id,
      agent: call.agent,
      signal: controller.signal,
      progress: (note: string, pct?: number) => {
        if (execution.detached) return
        const at = this.tracer.emit('call.progress', { call: call.id, note, pct })
        call.progress.push({ at, note, pct })
      },
      sleep: (ms: number) => sleep(ms, controller.signal, this.timers),
      runtime: this.facade,
    }

    let args: Record<string, unknown>
    try {
      args = this.materializeArgs(def, call)
    } catch (thrown) {
      this.executions.delete(call.id)
      call.error = toCallError(thrown)
      this.settle(call, 'failed')
      return
    }

    Promise.resolve()
      .then(() => def.run(args, cx))
      .then(
        (value) => {
          if (execution.detached) return
          this.executions.delete(call.id)
          call.value = value
          this.settle(call, 'done')
        },
        (thrown: unknown) => {
          if (execution.detached) return
          this.executions.delete(call.id)
          call.error = toCallError(thrown)
          this.settle(call, 'failed')
        },
      )
      .finally(() => this.pump())
  }

  /**
   * Build the implementation's argument object. Object literals merge as named
   * parameters; everything else — handles and scalars — fills the positional
   * slots the function declared. So `compileKernel(kernel0, { opt: 3 })`
   * arrives as `{ kernel: <payload>, opt: 3 }`.
   */
  private materializeArgs(def: FunctionDef, call: CallRecord): Record<string, unknown> {
    const positional = def.positional ?? []
    const args: Record<string, unknown> = {}
    let slot = 0
    for (const node of call.args) {
      const value = this.materialize(node)
      if (node.n === 'obj') {
        Object.assign(args, value as object)
      } else if (slot < positional.length) {
        args[positional[slot++]!] = value
      } else {
        throw new FluviaError(
          'ArgumentError',
          `${def.name} takes ${positional.length} positional argument(s); pass the rest as an object`,
        )
      }
    }
    return args
  }

  /** Substitute handle payloads into an argument tree. */
  private materialize(node: ArgNode): unknown {
    switch (node.n) {
      case 'lit':
        return node.v
      case 'ref':
        return this.ctx.env.value(node.handle)
      case 'arr':
        return node.items.map((item) => this.materialize(item))
      case 'obj':
        return Object.fromEntries(node.props.map((prop) => [prop.key, this.materialize(prop.value)]))
    }
  }

  /** Mark a call as never-ran because an upstream handle turned void. */
  private skip(call: CallRecord, reason: SkipReason, from: string): void {
    call.skip = { reason, from }
    this.settle(call, 'skipped')
  }

  /**
   * Bring a call to a terminal state: settle both handles, trace it, wake the
   * calls it was blocking and publish the notification.
   */
  private settle(call: CallRecord, outcome: CallOutcome): void {
    call.state = outcome
    call.at.settle = this.tracer.now()
    const valueHandle = this.ctx.env.handle(call.handles.value)!
    const errorHandle = this.ctx.env.handle(call.handles.error)!

    let ready: { name: string; kind: 'value' | 'error'; type?: string; summary?: string } | null = null
    if (outcome === 'done') {
      const digest = describe(call.value)
      this.ctx.env.settle(valueHandle, 'ready', call.value, digest)
      this.ctx.env.settle(errorHandle, 'void')
      ready = { name: valueHandle.name, kind: 'value', ...digest }
    } else if (outcome === 'failed') {
      const error = call.error!
      this.ctx.env.settle(errorHandle, 'ready', { $type: error.kind, $summary: error.message, ...error }, {
        type: error.kind,
        summary: error.message,
      })
      this.ctx.env.settle(valueHandle, 'void')
      ready = { name: errorHandle.name, kind: 'error', type: error.kind, summary: error.message }
    } else {
      this.ctx.env.settle(valueHandle, 'void')
      this.ctx.env.settle(errorHandle, 'void')
    }

    const runMs = call.at.start === undefined ? 0 : round(call.at.settle - call.at.start)
    this.tracer.emit('call.settle', {
      call: call.id,
      outcome,
      runMs,
      totalMs: round(call.at.settle - call.at.submit),
      value: outcome === 'done' ? describe(call.value) : undefined,
      error: call.error,
      skip: call.skip,
      cancel: call.cancel,
    })

    // Both handles are settled by now, so what happens to each dependent is
    // already decided. Deciding it *before* waking them keeps the narration in
    // causal order: this call's notification is published first, and the skips
    // it cascades are announced after it rather than before.
    const dependents: CallRecord[] = []
    for (const handle of [valueHandle, errorHandle]) {
      for (const id of this.waiters.get(handle.id) ?? []) {
        const dependent = this.records.get(id)
        if (dependent && dependent.state === 'waiting' && !dependents.includes(dependent)) dependents.push(dependent)
      }
      this.waiters.delete(handle.id)
    }
    const unblocked = dependents
      .filter((dependent) => dependent.deps.every((dep) => this.ctx.env.handle(dep.handle)!.state === 'ready'))
      .map((dependent) => dependent.id)

    this.ctx.notify.publish(call, unblocked, ready)
    for (const dependent of dependents) this.evaluate(dependent)
    this.checkIdle()
  }

  /** Release `drain()` waiters once nothing is live. */
  private checkIdle(): void {
    if (this.live().length) return
    while (this.idleWaiters.length) this.idleWaiters.shift()!()
  }
}

/** Terminal states never change again. */
export function isTerminal(state: CallRecord['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled' || state === 'skipped'
}

/** Why a consumer is skipped, given how its producer settled. */
function skipReason(producer: CallRecord['state'] | undefined, kind: DepRef['kind']): SkipReason {
  if (producer === 'cancelled') return 'upstream_cancelled'
  if (producer === 'skipped') return 'upstream_skipped'
  // A void handle on a settled producer means it took the other channel: a
  // failed producer voids its value handle, a successful one voids its error.
  return kind === 'error' ? 'upstream_ok' : 'upstream_failed'
}

/** Abortable sleep used by implementations through `cx.sleep`. */
export function sleep(ms: number, signal?: AbortSignal, timers: Timers = HOST_TIMERS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new FluviaError('Cancelled', 'aborted'))
    const timer = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      timers.clearTimeout(timer)
      reject(signal?.reason ?? new FluviaError('Cancelled', 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Round to microsecond precision so the trace stays readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
