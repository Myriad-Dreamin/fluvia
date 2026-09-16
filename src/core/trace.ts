/**
 * The trace is the session's whole truth: every line an agent typed, every
 * state a call passed through and every notification delivered, in one
 * gzip-compressed JSONL stream. `pnpm demo` writes one; `pnpm demo-perf` reads
 * it back and renders it. Nothing else is persisted, so anything the perf
 * report needs has to be an event here.
 *
 * @module fluvia/core/trace
 */

import { constants, createGzip, gunzipSync } from 'node:zlib'
import { createWriteStream, readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { once } from 'node:events'
import type { TraceEvent, TraceMeta } from './types.ts'

/** How long a write waits for company before the gzip stream is sync-flushed. */
const FLUSH_DEBOUNCE_MS = 250

/** Payload of an event minus the fields {@link Tracer} fills in. */
type EventBody<K extends TraceEvent['k']> = Omit<Extract<TraceEvent, { k: K }>, 'seq' | 't' | 'k'>

/**
 * Appends events to a gzip JSONL file, stamping each with a sequence number and
 * a millisecond offset from the session origin.
 */
export class Tracer {
  private seq = 0
  private readonly gzip = createGzip({ level: 9 })
  private closed?: Promise<void>
  /** Pending sync-flush, so a burst of events costs one flush rather than many. */
  private flushTimer?: NodeJS.Timeout

  /** Epoch ms at `t = 0`. */
  readonly origin = Date.now()
  private readonly hr = process.hrtime.bigint()

  /**
   * @param path — destination file, created with its parent directories. When
   * `undefined` the tracer is a no-op, so the CLI can run untraced.
   */
  constructor(readonly path?: string) {
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    this.gzip.pipe(createWriteStream(path))
  }

  /** Milliseconds since the session origin, sub-millisecond precision. */
  now(): number {
    return Number(process.hrtime.bigint() - this.hr) / 1e6
  }

  /** Append one event. Returns the offset it was stamped with. */
  emit<K extends TraceEvent['k']>(k: K, body: EventBody<K>): number {
    const t = this.now()
    if (!this.path) return t
    const event = { seq: this.seq++, t: Math.round(t * 1000) / 1000, k, ...body }
    this.gzip.write(JSON.stringify(event) + '\n')
    this.scheduleFlush()
    return t
  }

  /**
   * Flush what has been written so a reader sees it before the session ends.
   *
   * Without this the deflate stream holds everything in its window and a live
   * trace reads as an empty file, so a report cannot be rendered for a session
   * that is still running — which is exactly when an agent wants to look at it.
   * The flush is debounced because a sync flush costs compression ratio, and a
   * burst of settlements should pay for one boundary rather than ten.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.gzip.flush(constants.Z_SYNC_FLUSH)
    }, FLUSH_DEBOUNCE_MS)
    // The flush must never be the reason a process stays alive.
    this.flushTimer.unref?.()
  }

  /** Flush the gzip stream and close the file. Safe to call more than once. */
  close(): Promise<void> {
    if (!this.path) return Promise.resolve()
    this.closed ??= (async () => {
      if (this.flushTimer) clearTimeout(this.flushTimer)
      this.gzip.end()
      await once(this.gzip, 'end').catch(() => {})
    })()
    return this.closed
  }
}

/** A trace loaded back from disk. */
export interface LoadedTrace {
  /** The file it came from. */
  path: string
  /** The header from the `session.start` event. */
  meta: TraceMeta
  /** Every event, in file order. */
  events: TraceEvent[]
}

/**
 * Read a trace written by {@link Tracer}. Accepts both `.jsonl.gz` and plain
 * `.jsonl`, and tolerates a truncated tail — both a half-written final line and
 * a gzip stream with no end marker.
 *
 * The second case is the interesting one: a session that is still running has
 * an unterminated gzip stream, and the default `finishFlush` treats that as
 * corruption and throws. Decoding with `Z_SYNC_FLUSH` instead yields everything
 * written so far, which is what makes it possible to render a report for a
 * session while its agent is still working.
 */
export function readTrace(path: string): LoadedTrace {
  const raw = readFileSync(path)
  // Sniff the gzip magic rather than trusting the extension: traces get copied,
  // renamed and snapshotted, and a misnamed file should still render.
  const gzipped = raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b
  const text = (gzipped ? gunzipSync(raw, { finishFlush: constants.Z_SYNC_FLUSH }) : raw).toString('utf8')
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as TraceEvent)
    } catch {
      // A truncated tail is expected when a session was killed mid-write.
    }
  }
  const head = events.find((event) => event.k === 'session.start')
  if (!head) throw new Error(`${path}: no session.start event; not a fluvia trace`)
  return { path, meta: head.meta, events }
}
