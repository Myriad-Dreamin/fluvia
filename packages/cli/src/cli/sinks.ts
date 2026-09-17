/**
 * Sink wiring for `--notify`. The CLI itself only knows two transports — the
 * terminal the agent is reading and a JSONL file — because every other
 * destination belongs to a harness. `dsh:` specs are handed to `fluvia-dsh`
 * (`@fluvia/core/plugins/notify-dsh`), which owns DeepSeek Harness's dialect.
 *
 * @module @fluvia/cli/cli/sinks
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { NotificationSink } from '@fluvia/core/types'
import type { NotifyHub } from '@fluvia/core/plugins/notify'
import { renderNotificationLine } from '@fluvia/core/format'
import type { Output } from '@fluvia/core/session'

/** What a sink factory needs from the running CLI. */
export interface SinkDeps {
  /** The session's output channel, for sinks that print. */
  out: Output
  /** Session id, stamped on envelopes. */
  session: string
  /** The hub, so coalescing sinks can report their own delivery times. */
  hub: NotifyHub
}

/**
 * Notifications the agent reads directly. In machine mode the full
 * {@link Notification} is emitted as a `result` record, because a harness
 * wants the fields, not the prose.
 */
export function createStdoutSink(out: Output): NotificationSink {
  return {
    name: 'stdout',
    deliver(batch) {
      for (const notification of batch) {
        out.say(notification.agent, renderNotificationLine(notification), 'notify')
        out.json({ type: 'result', ...notification })
      }
    },
  }
}

/** Append each notification to a JSONL file, one object per line. */
export function createFileSink(path: string): NotificationSink {
  let chain: Promise<unknown> = mkdir(dirname(path), { recursive: true })
  return {
    name: `file:${path}`,
    deliver(batch) {
      const payload = batch.map((notification) => JSON.stringify(notification)).join('\n') + '\n'
      chain = chain.then(() => appendFile(path, payload))
      return chain.then(() => undefined)
    },
    async close() {
      await chain
    },
  }
}

/**
 * Build a sink from a `--notify` spec.
 *
 * `fluvia-dsh` is imported through a computed specifier so the CLI keeps
 * working — with a clear message — in a checkout where the dsh handler has not
 * been installed.
 */
export async function createSink(spec: string, deps: SinkDeps): Promise<NotificationSink> {
  if (spec === 'stdout' || spec === '-') return createStdoutSink(deps.out)
  if (spec.startsWith('file:')) return createFileSink(spec.slice('file:'.length))
  if (spec === 'dsh' || spec.startsWith('dsh:')) {
    const specifier = '@fluvia/core/plugins/notify-dsh'
    let module: typeof import('@fluvia/core/plugins/notify-dsh')
    try {
      module = (await import(specifier)) as typeof import('@fluvia/core/plugins/notify-dsh')
    } catch (error) {
      throw new Error(`--notify ${spec}: the fluvia-dsh handler is unavailable (${(error as Error).message})`)
    }
    const options = module.parseDshSpec(spec, deps.session)
    if (!options) throw new Error(`--notify ${spec}: not a recognised dsh spec`)
    return module.createDshSink({
      ...options,
      onDeliver: (ids: string[], bytes: number) => deps.hub.recordDelivery('fluvia-dsh', ids, bytes),
      onError: (error: Error) => deps.out.say('', `fluvia-dsh delivery failed: ${error.message}`, 'error'),
    })
  }
  throw new Error(`--notify ${spec}: expected stdout, file:<path>, dsh, dsh:file:<path> or dsh:http:<url>`)
}
