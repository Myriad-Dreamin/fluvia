/**
 * A complete fluvia runtime held in memory: the same registry, environment,
 * scheduler, notification hub and CLI session the terminal runs, wired to a
 * clock and to a tracer that keeps events in an array instead of a gzip file.
 * Nothing here touches the filesystem or the network, so the same module runs
 * under `pnpm bench` and inside a browser page.
 *
 * The clock decides what kind of runtime it is. A {@link VirtualClock} makes a
 * replay that moves only when told to; {@link wallClock} makes a live runtime
 * whose calls take real time, which is how a browser app runs fluvia with no
 * server at all.
 *
 * @module fluvia/bench/runtime
 */

import { Context } from '@deepseek-ai/cordis'
import type { FunctionDef, Notification, TraceEvent } from '../core/types.ts'
import type { Tracer } from '../core/trace.ts'
import { FunctionRegistry } from '../plugins/registry.ts'
import { Environment } from '../plugins/env.ts'
import type { HandleScope } from '../plugins/env.ts'
import { NotifyHub } from '../plugins/notify.ts'
import { Scheduler } from '../plugins/scheduler.ts'
import { controlFunctions } from '../plugins/inspect.ts'
import { CliSession, Output } from '../cli/session.ts'
import { renderNotificationLine } from '../cli/format.ts'
import type { Timers } from '../plugins/scheduler.ts'

/** What a runtime needs from a clock: the time, and timers for `cx.sleep`. */
export interface RuntimeClock extends Timers {
  now(): number
}

/** Real time, measured from the moment the clock is made. */
export function wallClock(): RuntimeClock {
  const origin = performance.now()
  return {
    now: () => performance.now() - origin,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

type Body = Record<string, unknown>

/** Records every event in memory, stamped with virtual time. */
export class MemoryTracer {
  readonly origin = 0
  readonly path = 'memory'
  readonly events: TraceEvent[] = []
  private seq = 0
  private readonly listeners: ((event: TraceEvent) => void)[] = []

  constructor(private readonly clock: RuntimeClock) {}

  now(): number {
    return this.clock.now()
  }

  emit(k: string, body: Body): number {
    const t = this.clock.now()
    const event = { seq: this.seq++, t: Math.round(t * 1000) / 1000, k, ...body } as unknown as TraceEvent
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
    return t
  }

  /** Observe events as they are emitted; returns an unsubscribe. */
  on(listener: (event: TraceEvent) => void): () => void {
    this.listeners.push(listener)
    return () => this.listeners.splice(this.listeners.indexOf(listener), 1)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** The CLI's output channel, minus stdout: everything lands in the trace only. */
class MemoryOutput extends Output {
  constructor(private readonly memory: MemoryTracer) {
    super(memory as unknown as Tracer, 'json')
  }

  override say(agent: string, text: string, level: 'info' | 'error' | 'notify' = 'info'): void {
    this.memory.emit('cli.output', { agent, level, text })
  }

  override json(): void {}
}

/** What {@link createRuntime} needs. */
export interface RuntimeOptions {
  clock: RuntimeClock
  toolbox: FunctionDef[]
  concurrency: number
  scope?: HandleScope
  /** Called for every notification the hub publishes. */
  onNotify?: (notification: Notification) => void
}

/** A running in-memory runtime. */
export interface MemoryRuntime {
  ctx: Context
  tracer: MemoryTracer
  session: CliSession
}

export async function createRuntime(options: RuntimeOptions): Promise<MemoryRuntime> {
  const tracer = new MemoryTracer(options.clock)
  const asTracer = tracer as unknown as Tracer
  const ctx = new Context()
  await ctx.plugin(FunctionRegistry)
  await ctx.plugin(Environment, { tracer: asTracer, scope: options.scope ?? 'runtime' })
  await ctx.plugin(NotifyHub, asTracer)
  await ctx.plugin(Scheduler, { tracer: asTracer, concurrency: options.concurrency, timers: options.clock })
  await ctx.inject(['functions', 'env', 'notify', 'calls'], () => {})
  ctx.functions.registerAll(controlFunctions(ctx))
  ctx.functions.registerAll(options.toolbox)

  const out = new MemoryOutput(tracer)
  // The `stdout` sink, as the CLI registers it: the agent reads notifications
  // in the same stream as its acknowledgements.
  ctx.notify.register({
    name: 'stdout',
    deliver(batch) {
      for (const notification of batch) {
        out.say(notification.agent, renderNotificationLine(notification), 'notify')
        options.onNotify?.(notification)
      }
    },
  })
  const session = new CliSession(ctx, out, asTracer, { defaultAgent: 'a0' })
  return { ctx, tracer, session }
}
