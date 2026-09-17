/**
 * `fluvia-dsh` — the notification handler built for DeepSeek Harness.
 *
 * A raw sink interrupts an agent turn once per settled call. That is fine when
 * one call settles a minute; it wrecks an agent's attention when eight land in
 * the same second, because each interruption costs a turn boundary and the
 * agent re-reads its own state eight times. This handler therefore does three
 * things a raw sink does not:
 *
 * 1. **Coalesce** — notifications that arrive inside a short window are held
 *    and delivered as one envelope, so the turn is interrupted once.
 * 2. **Rank** — inside an envelope, what is now actionable leads: ready values
 *    first, then failures (which carry a live error handle to recover from),
 *    then skips and cancellations (which carry only dead handles), then the
 *    calls the batch just unblocked.
 * 3. **Render** — the batch becomes one `<fluvia-notify agent="…" session="…">`
 *    block, the shape a dsh plugin injects verbatim into an agent turn.
 *
 * Everything rendered here comes off {@link Notification}; this module never
 * reaches back into the runtime and never invents a field.
 *
 * @module @fluvia/core/plugins/notify-dsh
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Notification, NotificationSink } from '../types.ts'

/** Coalescing window when {@link DshSinkOptions.batchMs} is not given. */
const DEFAULT_BATCH_MS = 120

/** Early-flush threshold when {@link DshSinkOptions.maxBatch} is not given. */
const DEFAULT_MAX_BATCH = 16

/**
 * The window slides — every arrival restarts it — so a burst is delivered as
 * one envelope rather than one per straggler. A steadily dripping stream would
 * then be held forever, so the oldest buffered notification is never held
 * longer than `batchMs * HOLD_FACTOR`. `maxBatch` caps the size, this caps the
 * latency; together they bound both axes without a third knob to tune.
 */
const HOLD_FACTOR = 4

/** Per-attempt timeout of the `http` transport. Short: a sink must not stall shutdown. */
const HTTP_TIMEOUT_MS = 2000

/** Pause before the single `http` retry, enough to ride out a socket hiccup. */
const HTTP_RETRY_MS = 100

/** Longest `error.detail` rendering allowed into an envelope, in characters. */
const DETAIL_BUDGET = 120

/** How a {@link createDshSink} sink is configured. */
export interface DshSinkOptions {
  /** Where envelopes go: the CLI's own stdout, an appended JSONL file, or an HTTP endpoint. */
  transport: 'stdout' | 'file' | 'http'
  /** Destination file for `transport: 'file'`; parent directories are created. */
  path?: string
  /** Destination endpoint for `transport: 'http'`; receives one JSON record per envelope. */
  url?: string
  /** Coalescing window in milliseconds; defaults to {@link DEFAULT_BATCH_MS}. */
  batchMs?: number
  /** Flush early once this many notifications are buffered; defaults to {@link DEFAULT_MAX_BATCH}. */
  maxBatch?: number
  /** Session id stamped on every envelope, so a dsh side can correlate turns with a trace. */
  session: string
  /**
   * Called after each successful delivery with the notification ids it carried
   * and its byte size — exactly the payload of a `notify.deliver` trace event.
   */
  onDeliver?(ids: string[], bytes: number): void
  /**
   * Called when a delivery fails. A sink never throws into the scheduler: a
   * broken notification endpoint must not take down the calls it reports on.
   */
  onError?(err: Error): void
}

/** One settled call inside a {@link DshEnvelopeRecord}; a {@link Notification} minus what the envelope already says. */
export interface DshEnvelopeCall {
  /** Notification id, matching an entry of {@link DshEnvelopeRecord.ids}. */
  id: string
  /** Session-relative settle time, in milliseconds. */
  at: number
  /** The settled call. */
  call: string
  /** Its function name. */
  fn: string
  /** Its terminal state. */
  outcome: Notification['outcome']
  /** The two variables bound at submission. */
  bind: Notification['bind']
  /** The variable that now carries data, or `null` when both channels are void. */
  ready: Notification['ready']
  /** Failure detail when `outcome === 'failed'`. */
  error?: Notification['error']
  /** Skip detail when `outcome === 'skipped'`. */
  skip?: Notification['skip']
  /** Wall-clock breakdown. */
  timing: Notification['timing']
  /** Calls this settlement unblocked. */
  unblocked: string[]
}

/**
 * The JSON record the `file` and `http` transports emit — one per envelope.
 * `text` is the rendered block a dsh plugin injects; `calls` is the same
 * information structured, so a consumer can route or filter without parsing it.
 */
export interface DshEnvelopeRecord {
  /** Record schema version. */
  v: 1
  /** Session id from {@link DshSinkOptions.session}. */
  session: string
  /** Epoch milliseconds at delivery (the calls' own times stay session-relative). */
  at: number
  /** The agent to interrupt; one envelope never mixes agents. */
  agent: string
  /** Notification ids carried, in render order. */
  ids: string[]
  /** The rendered `<fluvia-notify>` block. */
  text: string
  /** The batch, structured. */
  calls: DshEnvelopeCall[]
}

/* ----------------------------------------------------------------- parsing */

/**
 * Parse a `--notify` spec into sink options.
 *
 * Accepted: `dsh` and `dsh:stdout` (stdout), `dsh:file:<path>`,
 * `dsh:http:<url>` and the more natural `dsh:http://host/path`. A spec that is
 * not dsh's returns `undefined`, so the CLI can try its other sink parsers. A
 * spec that *is* dsh's but malformed throws, because silently falling through
 * to "unknown sink" would hide the real mistake (a typo'd path or URL).
 *
 * @param spec — one `--notify` argument.
 * @param session — session id to stamp on the resulting options.
 * @returns the options, or `undefined` when `spec` is not a dsh spec.
 * @throws {Error} when `spec` names the dsh sink but its payload is unusable.
 */
export function parseDshSpec(spec: string, session: string): DshSinkOptions | undefined {
  const trimmed = spec.trim()
  if (trimmed !== 'dsh' && !trimmed.startsWith('dsh:')) return undefined

  const rest = trimmed === 'dsh' ? '' : trimmed.slice('dsh:'.length).trim()
  if (rest === '' || rest === 'stdout') return { transport: 'stdout', session }

  if (rest.startsWith('file:')) {
    const path = rest.slice('file:'.length).trim()
    if (!path) throw new Error(`notify spec "${spec}": dsh:file: needs a path, e.g. dsh:file:out/notify.jsonl`)
    return { transport: 'file', path, session }
  }

  if (rest.startsWith('http:') || rest.startsWith('https:')) {
    return { transport: 'http', url: normalizeUrl(rest, spec), session }
  }

  throw new Error(
    `notify spec "${spec}": unknown dsh transport "${rest}" — use dsh, dsh:stdout, dsh:file:<path> or dsh:http:<url>`,
  )
}

/**
 * Turn the tail of a dsh http spec into an absolute URL.
 *
 * Both `dsh:http://host/x` (already a URL) and `dsh:http:host:9000/x` (the
 * `<transport>:<target>` shape the other specs use) reach here, so the scheme
 * is only defaulted when the tail does not carry one.
 *
 * @param rest — the spec with its `dsh:` prefix removed.
 * @param spec — the original spec, for the error message.
 * @returns an absolute URL string.
 * @throws {Error} when no URL can be made of `rest`.
 */
function normalizeUrl(rest: string, spec: string): string {
  let candidate = rest
  if (!/^https?:\/\//.test(rest)) {
    const tail = rest.slice(rest.indexOf(':') + 1).trim()
    candidate = /^https?:\/\//.test(tail) ? tail : `http://${tail}`
  }
  try {
    return new URL(candidate).toString()
  } catch {
    throw new Error(`notify spec "${spec}": "${candidate}" is not a usable URL`)
  }
}

/* --------------------------------------------------------------- rendering */

/**
 * Render a batch as the LLM-facing envelope.
 *
 * The reader is an agent that fired several calls and then did something else
 * for a second; it needs to know, in this order, what it can now use, what
 * broke and whether retrying is worth it, what silently will not happen, and
 * what the runtime picked up as a consequence. A batch spanning several agents
 * produces one block per agent, because a block is injected into one agent's
 * turn and its `agent` attribute has to be true.
 *
 * @param batch — notifications to render; may be empty, may span agents.
 * @param session — session id for the block attribute.
 * @returns the block text, or `''` for an empty batch.
 */
export function renderDshEnvelope(batch: Notification[], session: string): string {
  return [...groupByAgent(batch)]
    .map(([agent, list]) => renderBlock(agent, list, session))
    .join('\n')
}

/** Render one agent's block. See {@link renderDshEnvelope} for the ordering rationale. */
function renderBlock(agent: string, list: Notification[], session: string): string {
  const sorted = [...list].sort((a, b) => a.at - b.at)
  const out: string[] = [`<fluvia-notify agent="${attr(agent)}" session="${attr(session)}">`, headline(sorted)]

  const done = sorted.filter((n) => n.outcome === 'done')
  if (done.length) {
    out.push('', 'ready')
    for (const n of done) out.push(`  ${renderDone(n)}`)
  }

  const failed = sorted.filter((n) => n.outcome === 'failed')
  if (failed.length) {
    out.push('', 'failed')
    for (const n of failed) out.push(...renderFailed(n))
    // Said once per envelope rather than per call: the recovery move is always
    // the same, and repeating it would bury the failures themselves.
    out.push('  → recover by passing a ready err handle to another call; work waiting on the value handle is already skipped.')
  }

  const skipped = sorted.filter((n) => n.outcome === 'skipped')
  if (skipped.length) {
    out.push('', 'skipped (never ran)')
    for (const n of skipped) out.push(`  ${renderSkipped(n)}`)
  }

  const cancelled = sorted.filter((n) => n.outcome === 'cancelled')
  if (cancelled.length) {
    out.push('', 'cancelled')
    for (const n of cancelled) out.push(`  ${renderCancelled(n)}`)
  }

  out.push('', ...renderRunnable(sorted))
  out.push('</fluvia-notify>')
  return out.join('\n')
}

/** The one-line summary that opens a block: how many, over how long, in what mix. */
function headline(sorted: Notification[]): string {
  // Fixed order, matching the sections below, so the headline and the body
  // read in the same sequence however the settlements happened to arrive.
  const order: [Notification['outcome'], string][] = [
    ['done', 'ready'],
    ['failed', 'failed'],
    ['skipped', 'skipped'],
    ['cancelled', 'cancelled'],
  ]
  const mix = order
    .map(([outcome, label]) => [sorted.filter((n) => n.outcome === outcome).length, label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(', ')
  const span = sorted.length > 1 ? sorted[sorted.length - 1]!.at - sorted[0]!.at : 0
  const window = span >= 1 ? ` within ${ms(span)}` : ''
  return `${sorted.length} call${sorted.length === 1 ? '' : 's'} settled${window} — ${mix}.`
}

/** `c2 compileKernel → bin2 : Binary 4.1 MB (wait 12ms, run 840ms)` */
function renderDone(n: Notification): string {
  const name = n.ready?.name ?? n.bind.value
  const what = [n.ready?.type, n.ready?.summary].filter(Boolean).join(' ') || 'ok'
  return `${n.call} ${n.fn} → ${name} : ${what} ${timing(n)}`
}

/** The failure head line plus, when the toolbox attached one, a trimmed detail line. */
function renderFailed(n: Notification): string[] {
  const name = n.ready?.name ?? n.bind.error
  const kind = n.error?.kind ?? 'Error'
  const message = n.error?.message ?? 'failed'
  const retry
    = n.error?.retryable === true ? ' [retryable]'
      : n.error?.retryable === false ? ' [not retryable]'
        : ''
  const lines = [`  ${n.call} ${n.fn} → ${name} : ${kind} — ${message}${retry} ${timing(n)}`]
  const detail = digest(n.error?.detail)
  if (detail) lines.push(`      detail: ${detail}`)
  return lines
}

/** `c5 report — skipped: upstream_failed from c3; bin5 and err5 are both void.` */
function renderSkipped(n: Notification): string {
  const reason = n.skip ? `${n.skip.reason} from ${n.skip.from}` : 'upstream did not produce the channel it consumes'
  return `${n.call} ${n.fn} — ${reason}; ${n.bind.value} and ${n.bind.error} are both void.`
}

/** Cancellations carry no reason on {@link Notification}, so state only what is true. */
function renderCancelled(n: Notification): string {
  return `${n.call} ${n.fn} — cancelled after ${ms(n.timing.totalMs)}; ${n.bind.value} and ${n.bind.error} are both void.`
}

/**
 * Close the block with the scheduler's reaction, grouped by the call that
 * caused it, so the agent can tell which of its settlements moved the graph.
 */
function renderRunnable(sorted: Notification[]): string[] {
  // A call that settled inside this very batch is not "now runnable" — it is
  // already reported above, and listing it twice would read as pending work.
  const settled = new Set(sorted.map((n) => n.call))
  const lines: string[] = ['now runnable']
  let any = false
  for (const n of sorted) {
    const moved = n.unblocked.filter((call) => !settled.has(call))
    if (!moved.length) continue
    any = true
    lines.push(`  ${n.call} unblocked ${moved.join(', ')}`)
  }
  if (!any) lines.push('  nothing else was waiting on these handles.')
  return lines
}

/** `(wait 12ms, run 840ms)`, the split that tells queueing apart from real work. */
function timing(n: Notification): string {
  return `(wait ${ms(n.timing.waitedMs)}, run ${ms(n.timing.runMs)})`
}

/** Durations at agent-readable precision: milliseconds below a second, then seconds. */
function ms(value: number): string {
  if (!Number.isFinite(value)) return '?'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
}

/** One-line, budgeted rendering of an arbitrary `error.detail`. */
function digest(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  let text: string
  try {
    text = typeof detail === 'string' ? detail : JSON.stringify(detail) ?? String(detail)
  } catch {
    return undefined
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > DETAIL_BUDGET ? `${text.slice(0, DETAIL_BUDGET - 1)}…` : text
}

/** Escape a value for an XML-ish attribute of the envelope tag. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/** Split a batch per agent, preserving first-seen order. One envelope, one agent. */
function groupByAgent(batch: Notification[]): Map<string, Notification[]> {
  const groups = new Map<string, Notification[]>()
  for (const n of batch) {
    const list = groups.get(n.agent)
    if (list) list.push(n)
    else groups.set(n.agent, [n])
  }
  return groups
}

/** Strip a {@link Notification} down to what a {@link DshEnvelopeRecord} carries. */
function toEnvelopeCall(n: Notification): DshEnvelopeCall {
  const call: DshEnvelopeCall = {
    id: n.id,
    at: n.at,
    call: n.call,
    fn: n.fn,
    outcome: n.outcome,
    bind: n.bind,
    ready: n.ready,
    timing: n.timing,
    unblocked: n.unblocked,
  }
  if (n.error) call.error = n.error
  if (n.skip) call.skip = n.skip
  return call
}

/* ------------------------------------------------------------------- sinks */

/** The sink this module builds: a {@link NotificationSink} the hub knows buffers. */
export type DshSink = NotificationSink & {
  /**
   * Marks the sink as buffering. The hub uses it to skip its own delivery
   * accounting, because `deliver()` returning here only means "coalesced", and
   * timing that as a delivery would understate notification lag.
   */
  coalescing: true
}

/**
 * Build the coalescing sink.
 *
 * `deliver()` returns as soon as the batch is buffered — the scheduler must
 * never wait on a notification endpoint. The actual deliveries run on a single
 * promise chain, so envelopes cannot interleave on a stream and `close()` has
 * one thing to await. `close()` flushes whatever is still buffered and resolves
 * only once the tail of that chain has settled, which is what makes shutdown
 * lossless.
 *
 * @param options — transport and coalescing configuration.
 * @returns a {@link DshSink} named `fluvia-dsh`.
 */
export function createDshSink(options: DshSinkOptions): DshSink {
  const batchMs = Math.max(0, options.batchMs ?? DEFAULT_BATCH_MS)
  const maxBatch = Math.max(1, options.maxBatch ?? DEFAULT_MAX_BATCH)
  const holdMs = batchMs * HOLD_FACTOR

  let buffer: Notification[] = []
  let window: NodeJS.Timeout | undefined
  let hold: NodeJS.Timeout | undefined
  let chain: Promise<void> = Promise.resolve()
  let closed = false
  /** `mkdir -p` for the file transport, done once per sink rather than per envelope. */
  let dirReady: Promise<unknown> | undefined

  /**
   * Restart the sliding window, and start the hold timer if this is the first
   * notification in the buffer. Both timers are unref'd: a coalescing window
   * is not a reason to keep the process alive, and `close()` flushes anyway.
   */
  function arm(): void {
    if (window) clearTimeout(window)
    window = setTimeout(flush, batchMs)
    window.unref?.()
    if (!hold) {
      hold = setTimeout(flush, holdMs)
      hold.unref?.()
    }
  }

  /** Hand the buffer to the delivery chain and disarm both timers. */
  function flush(): void {
    if (window) clearTimeout(window)
    if (hold) clearTimeout(hold)
    window = undefined
    hold = undefined
    if (!buffer.length) return
    const batch = buffer
    buffer = []
    // `.then(…, report)` on both settlements, never a bare `.catch`: a chain
    // left rejected would re-report the same failure on every later flush and
    // would make `close()` throw at shutdown.
    chain = chain.then(() => send(batch), report).then(undefined, report)
  }

  /** Render and transmit one batch, one envelope per agent, strictly in order. */
  async function send(batch: Notification[]): Promise<void> {
    for (const [agent, list] of groupByAgent(batch)) {
      const sorted = [...list].sort((a, b) => a.at - b.at)
      const text = renderDshEnvelope(sorted, options.session)
      const record: DshEnvelopeRecord = {
        v: 1,
        session: options.session,
        at: Date.now(),
        agent,
        ids: sorted.map((n) => n.id),
        text,
        calls: sorted.map(toEnvelopeCall),
      }
      try {
        // Transmit first, then notify: `onDeliver?.(…, await transmit(…))`
        // would short-circuit the whole call — arguments included — whenever no
        // callback is configured, and nothing would ever be written.
        const bytes = await transmit(record)
        options.onDeliver?.(record.ids, bytes)
      } catch (error) {
        report(error)
      }
    }
  }

  /** Write one record through the configured transport; returns the bytes it produced. */
  async function transmit(record: DshEnvelopeRecord): Promise<number> {
    if (options.transport === 'stdout') return writeStdout(record.text)
    if (options.transport === 'file') {
      const path = options.path
      if (!path) throw new Error('fluvia-dsh: transport "file" needs a path')
      dirReady ??= mkdir(dirname(path), { recursive: true })
      await dirReady
      const line = `${JSON.stringify(record)}\n`
      await appendFile(path, line, 'utf8')
      return Buffer.byteLength(line)
    }
    const url = options.url
    if (!url) throw new Error('fluvia-dsh: transport "http" needs a url')
    return postRecord(url, record)
  }

  /** Surface a delivery failure without throwing into the scheduler or the chain. */
  function report(error: unknown): void {
    try {
      options.onError?.(asError(error))
    } catch {
      // A reporter that throws is not worth taking the session down for.
    }
  }

  return {
    name: 'fluvia-dsh',

    // The hub reads this: `deliver()` returning means "buffered", not
    // "delivered", so this sink accounts for its own deliveries through
    // `onDeliver` and the hub must not time them itself.
    coalescing: true,

    deliver(batch: Notification[]): void {
      if (!batch.length) return
      buffer.push(...batch)
      // Past close() the window is meaningless — anything still arriving is
      // delivered at once rather than dropped, even though close() has already
      // resolved for its caller.
      if (closed || buffer.length >= maxBatch) flush()
      else arm()
    },

    async close(): Promise<void> {
      closed = true
      flush()
      // A delivery in flight may append to the chain while we await it, so keep
      // awaiting until the chain stops moving. Idempotent: a second close()
      // finds an empty buffer and a settled chain.
      let seen: Promise<void> | undefined
      while (seen !== chain) {
        seen = chain
        await chain
      }
    },
  }
}

/** Write an envelope block to stdout, resolving only once the stream accepted it. */
async function writeStdout(text: string): Promise<number> {
  const payload = text.endsWith('\n') ? text : `${text}\n`
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(payload, (error) => (error ? reject(error) : resolve()))
  })
  return Buffer.byteLength(payload)
}

/**
 * POST one record as JSON, with a short timeout and exactly one retry.
 *
 * Delivery is at-most-once by design: fluvia does not queue envelopes to disk,
 * so a receiver that stays down loses the notices rather than stalling the
 * session. The single retry only covers a dropped socket or a restarting peer.
 *
 * @param url — endpoint from {@link DshSinkOptions.url}.
 * @param record — the envelope record.
 * @returns the number of bytes posted.
 * @throws {Error} when both attempts fail; the caller reports it via `onError`.
 */
async function postRecord(url: string, record: DshEnvelopeRecord): Promise<number> {
  const body = JSON.stringify(record)
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, HTTP_RETRY_MS).unref?.())
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      // Drain even on success so the socket goes back to the agent's pool
      // instead of being held open until GC.
      await response.arrayBuffer().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
      return Buffer.byteLength(body)
    } catch (error) {
      last = error
    }
  }
  throw new Error(`fluvia-dsh: POST ${url} failed after 2 attempts — ${asError(last).message}`)
}

/** Normalize an unknown rejection into an `Error`, keeping the original message. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/* ------------------------------------------------------------------ plugin */

/**
 * The context `fluvia-dsh` needs: a cordis context that carries the notify hub.
 *
 * The hub's service declaration lives with the hub (`src/plugins/notify.ts`),
 * so this module states the one method it calls instead of importing — that
 * keeps the handler loadable in a dsh application that wires the hub itself.
 */
export type NotifyContext = Context & {
  /** The notification hub service; `register` adds a sink for the session. */
  notify: { register(sink: NotificationSink): void }
}

/**
 * cordis plugin: register a `fluvia-dsh` sink on the notify hub for as long as
 * this plugin is loaded.
 *
 * Teardown goes through `ctx.effect`, so unloading the plugin unregisters the
 * sink (when the hub hands back a disposer) and always closes it, flushing any
 * envelope still inside the coalescing window.
 *
 * @param ctx — a context providing `notify`.
 * @param config — sink options, e.g. from {@link parseDshSpec}.
 */
export function dshNotifier(ctx: NotifyContext, config: DshSinkOptions): void {
  const sink = createDshSink(config)

  const attach = (): (() => Promise<void>) => {
    // Typed as void by the hub's contract; some hubs return an unregister
    // function, and honoring it is what makes an unload actually detach.
    const handle: unknown = ctx.notify.register(sink)
    return async () => {
      if (typeof handle === 'function') await (handle as () => unknown)()
      await sink.close?.()
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(attach, 'fluvia-dsh')
  else attach()
}

/** Wait for the notify hub before loading; the dsh convention for service edges. */
dshNotifier.inject = ['notify']
