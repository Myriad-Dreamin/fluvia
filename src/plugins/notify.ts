/**
 * The notification hub. A call settles in the background, long after the line
 * that submitted it was answered, so the only way an agent learns about it is a
 * push. The hub builds one {@link Notification} per terminal call and fans it
 * out to every registered {@link NotificationSink}.
 *
 * Sinks are plugins: `stdout` writes to the terminal the agent is reading, and
 * `fluvia-dsh` (src/plugins/notify-dsh.ts) speaks DeepSeek Harness's dialect.
 * The hub itself stays dumb on purpose — it owns fan-out, delivery accounting
 * and the trace, and nothing about any particular transport.
 *
 * @module fluvia/plugins/notify
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CallRecord, Notification, NotificationSink } from '../core/types.ts'
import type { Tracer } from '../core/trace.ts'
import { renderNotificationText } from '../cli/format.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    notify: NotifyHub
  }
}

export class NotifyHub extends Service {
  private readonly sinks: NotificationSink[] = []
  private readonly emittedAt = new Map<string, number>()
  private readonly byId = new Map<string, Notification>()
  private pending = new Set<Promise<void>>()
  private next = 0

  /** Every notification published this session, in order. `inspect()` reads it. */
  readonly history: Notification[] = []

  /** Every delivery a sink reported, for notification-lag analysis. */
  readonly deliveries: { sink: string; ids: string[]; agents: string[]; at: number; latencyMs: number; bytes: number }[] = []

  constructor(
    ctx: Context,
    private readonly tracer: Tracer,
  ) {
    super(ctx, 'notify')
  }

  /** Register a sink. Sinks receive every notification, for every agent. */
  register(sink: NotificationSink): () => void {
    this.sinks.push(sink)
    return () => {
      const index = this.sinks.indexOf(sink)
      if (index >= 0) this.sinks.splice(index, 1)
    }
  }

  /** Names of the registered sinks, for the trace header. */
  get names(): string[] {
    return this.sinks.map((sink) => sink.name)
  }

  /**
   * Build the notification for a settled call and fan it out.
   *
   * @param call — the settled call.
   * @param unblocked — calls this settlement made runnable, so the agent can
   * anticipate what follows instead of polling for it.
   */
  publish(call: CallRecord, unblocked: string[], ready: Notification['ready']): Notification {
    const id = `n${this.next++}`
    const at = this.tracer.now()
    const waitedMs = round((call.at.start ?? call.at.settle ?? at) - call.at.submit)
    const runMs = round(call.at.start === undefined ? 0 : (call.at.settle ?? at) - call.at.start)
    const notification: Notification = {
      id,
      at,
      agent: call.agent,
      call: call.id,
      fn: call.fn,
      outcome: call.state as Notification['outcome'],
      bind: call.bind,
      ready,
      error: call.error,
      skip: call.skip,
      timing: { waitedMs, runMs, totalMs: round(waitedMs + runMs) },
      unblocked,
      text: '',
    }
    notification.text = renderNotificationText(notification)
    this.emittedAt.set(id, at)
    this.history.push(notification)
    this.byId.set(id, notification)
    this.tracer.emit('notify.emit', { id, call: call.id, agent: call.agent, outcome: notification.outcome })

    for (const sink of this.sinks) {
      const task = Promise.resolve()
        .then(() => sink.deliver([notification]))
        .then(
          () => {
            // A coalescing sink reports its own deliveries through
            // `recordDelivery`, because `deliver()` returning only means the
            // notification was buffered. Sinks that deliver inline are
            // accounted here.
            if (!sink.coalescing) {
              this.recordDelivery(sink.name, [id], new TextEncoder().encode(notification.text).length)
            }
          },
          (error: Error) => {
            this.tracer.emit('cli.output', {
              agent: call.agent,
              level: 'error',
              text: `sink ${sink.name} failed: ${error.message}`,
            })
          },
        )
        .finally(() => this.pending.delete(task))
      this.pending.add(task)
    }
    return notification
  }

  /**
   * Record that a sink delivered notifications, measuring the lag from the
   * moment each was emitted. The perf report draws this as the emit→deliver
   * arrow, which is what tells you whether an agent learned about a result in
   * time to act on it.
   */
  recordDelivery(sink: string, ids: string[], bytes: number): void {
    const now = this.tracer.now()
    const first = ids.map((id) => this.emittedAt.get(id)).find((value) => value !== undefined)
    const latencyMs = first === undefined ? 0 : round(now - first)
    // Attribution is by notification, not by sink: `inspect(@agent)` asks how
    // long *that* agent waited to hear about its own calls.
    const agents = [...new Set(ids.map((id) => this.byId.get(id)?.agent).filter((agent): agent is string => !!agent))]
    this.deliveries.push({ sink, ids, agents, at: now, latencyMs, bytes })
    this.tracer.emit('notify.deliver', {
      id: ids,
      sink,
      // One agent when the batch belongs to one, empty when a coalescing sink
      // mixed several: a joined string would read as a nonexistent agent id.
      agent: agents.length === 1 ? agents[0]! : '',
      latencyMs,
      bytes,
    })
  }

  /** Wait for in-flight deliveries, then close every sink. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.pending])
    for (const sink of this.sinks) await sink.close?.()
  }
}

/** Round to microsecond precision so the trace stays readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
