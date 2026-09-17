/**
 * Live mode: the agent drives a fluvia runtime that runs in this page.
 *
 * There is no server, socket or bridge. The page builds the same in-memory
 * runtime the benchmark slices use (registry, environment, scheduler,
 * notification hub, default toolbox) on a wall clock, so calls take real time
 * and settle in the background exactly as they do under `pnpm serve`.
 * Submissions go through `dispatchLine` with the server's prefix policy: the
 * agent's identity is fixed, and an `@agent` prefix is refused.
 *
 * @module pi-web-fluvia/live
 */

import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import type { CallRecord, FunctionDef, Notification } from '@fluvia/core/types'
import { dispatchLine } from '@fluvia/core/dispatch'
import type { IsaEntry, ServerFrame } from '@fluvia/core/protocol'
import { createRuntime, wallClock } from '@fluvia/core/bench/runtime'
import type { MemoryRuntime } from '@fluvia/core/bench/runtime'
import { Coalescer } from './coalesce.ts'
import { deliverToAgent } from './deliver.ts'
import { isaFromToolbox, renderAnswer, renderSystemPrompt } from './describe.ts'
import type { FluviaNotifyMessage } from './messages.ts'
import { renderNotifyBlock } from './render.ts'
import { createFluviaTool } from './tool.ts'

export interface LiveOptions {
  /** The instruction set loaded into the page's runtime. */
  toolbox: FunctionDef[]
  /** Agent id the lines are attributed to. */
  agent?: string
  /** Scheduler concurrency. */
  concurrency?: number
  /**
   * Keep settled calls instead of delivering them, for a replay that decides
   * when each notification reaches the agent. See {@link LiveSession.take}.
   */
  holdNotifications?: boolean
  /** Called for every delivery, after it is handed to the agent. */
  onDeliver?(message: FluviaNotifyMessage): void
  onError?(error: Error): void
}

type Answer = Extract<ServerFrame, { t: 'ack' | 'control' | 'error' }>

export class LiveSession {
  private agentRef: Agent | undefined
  private closed = false
  private readonly held = new Map<string, Notification>()
  readonly tool: AgentTool<any>
  readonly isa: IsaEntry[]
  readonly session = `web-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`

  private constructor(
    private readonly rt: MemoryRuntime,
    readonly agent: string,
    private readonly coalescer: Coalescer<Notification>,
    private readonly options: LiveOptions,
  ) {
    this.isa = isaFromToolbox(rt.ctx.functions.list())
    this.tool = createFluviaTool((line) => renderAnswer(this.submit(line)), this.isa)
  }

  static async start(options: LiveOptions): Promise<LiveSession> {
    let session: LiveSession | undefined
    const coalescer = new Coalescer<Notification>((batch) => session?.deliver(batch))
    const agent = options.agent ?? 'pi'
    const rt = await createRuntime({
      clock: wallClock(),
      toolbox: options.toolbox,
      concurrency: options.concurrency ?? 4,
      onNotify: (notification) => {
        if (notification.agent !== agent) return
        if (options.holdNotifications) session?.hold(notification)
        else coalescer.add(notification)
      },
    })
    session = new LiveSession(rt, agent, coalescer, options)
    return session
  }

  get systemPrompt(): string {
    return renderSystemPrompt(this.isa, { agent: this.agent, session: this.session })
  }

  /** Every call so far, in submission order. */
  calls(): CallRecord[] {
    return this.rt.ctx.calls.list()
  }

  /** Every runtime event so far, for export. */
  get events() {
    return this.rt.tracer.events
  }

  /** Calls that have not settled yet. */
  get live(): number {
    return this.rt.ctx.calls.live().length
  }

  /** Submit one line as this agent; answers at once, never waits for the call. */
  submit(line: string): Answer {
    if (this.closed) return { t: 'error', message: 'the runtime was stopped' }
    const trimmed = line.trim()
    this.rt.tracer.emit('agent.input', { agent: this.agent, line: trimmed })
    const result = dispatchLine(this.rt.ctx, trimmed, { agent: this.agent, prefix: 'reject' })
    switch (result.kind) {
      case 'ack': {
        const call = result.call
        return {
          t: 'ack',
          call: call.id,
          fn: call.fn,
          bind: call.bind,
          deps: call.deps.map((dep) => ({ name: dep.name, from: dep.from, kind: dep.kind })),
          state: call.state,
        }
      }
      case 'control':
        return { t: 'control', fn: result.fn, text: result.result.text, rows: result.result.rows ?? [] }
      case 'error':
        return { t: 'error', message: result.message }
      case 'exit':
        return { t: 'error', message: '.exit does nothing here: the runtime belongs to the page' }
      case 'noop':
        return { t: 'control', fn: 'noop', text: '(nothing to run)', rows: [] }
    }
  }

  /** Call ids settled and held, not yet delivered. */
  heldCalls(): string[] {
    return [...this.held.keys()]
  }

  /** Remove and return the held notifications for these calls, in the given order. */
  take(calls: string[]): Notification[] {
    const out: Notification[] = []
    for (const call of calls) {
      const notification = this.held.get(call)
      if (!notification) continue
      this.held.delete(call)
      out.push(notification)
    }
    return out
  }

  /** Deliver a batch of settled calls to the agent now, as one message. */
  deliverNow(batch: Notification[]): void {
    if (batch.length) this.deliver(batch)
  }

  private hold(notification: Notification): void {
    this.held.set(notification.call, notification)
  }

  /** Route deliveries to this agent from now on. */
  attach(agent: Agent): void {
    this.agentRef = agent
  }

  /** Cancel everything still running and stop delivering. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.coalescer.dispose()
    this.rt.ctx.calls.abortAll('runtime stopped')
  }

  private deliver(batch: Notification[]): void {
    if (this.closed) return
    const message: FluviaNotifyMessage = {
      role: 'fluvia-notify',
      text: renderNotifyBlock(batch, { agent: this.agent, session: this.session }),
      count: batch.length,
      source: 'live',
      timestamp: Date.now(),
    }
    if (this.agentRef) deliverToAgent(this.agentRef, message, this.options.onError)
    this.options.onDeliver?.(message)
  }
}
