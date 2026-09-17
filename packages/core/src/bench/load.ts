/**
 * Turning a recording into something {@link indexTrace} can slice.
 *
 * Two shapes reach a benchmark. A fluvia trace is already the event stream the
 * slice engine wants — gzip JSONL with a `session.start` header. A pi-web
 * `trace.json` is a whole agent run: the conversation, the model that produced
 * it, and the runtime's events *without* a header, because the browser runtime
 * never wrote one. This module synthesises that header, so a recording made in
 * a browser page slices exactly like one made by `fluvia cli`.
 *
 * The conversation is worth keeping for one reason: it is the only place that
 * says which lines belonged to which model turn. That is what makes
 * `cut: { turn: 3 }` meaningful — "resume where the third turn started" — on a
 * recording whose lines were all typed by the same lane.
 *
 * Browser-safe: everything that touches the filesystem is behind a lazy
 * `import()` inside the function that needs it.
 *
 * @module @fluvia/core/bench/load
 */

import type { TraceEvent, TraceMeta } from '../types.ts'
import type { IndexedTrace } from './slice.ts'

/** `format` of a pi-web `trace.json`. */
export const PI_WEB_FORMAT = 'pi-web-fluvia.trace'

/** The part of a pi-web `trace.json` a benchmark reads. */
export interface PiWebRecord {
  format: string
  version?: number
  exportedAt?: string
  mode?: string
  live?: { agent?: string; concurrency?: number }
  /** The conversation, in order, as the agent held it. */
  messages?: unknown[]
  /** The fluvia runtime's events during the run — no `session.start`. */
  runtime?: TraceEvent[]
}

/** Where a slice is cut. */
export type BenchCut =
  /** Recorded line index, as `fluvia bench lines` prints it. */
  | { line: number }
  /** The first line the `turn`-th assistant turn submitted (pi-web traces). */
  | { turn: number }
  /** The first line typed after this call's notification. */
  | { notify: string }

/** A recording loaded for a benchmark. */
export interface LoadedBenchTrace {
  /** Where it came from, as given. */
  path: string
  /** The event stream, header first. */
  events: TraceEvent[]
  /** Present when the recording was a pi-web `trace.json`. */
  record?: PiWebRecord
}

export function isPiWebRecord(value: unknown): value is PiWebRecord {
  return !!value && typeof value === 'object' && (value as PiWebRecord).format === PI_WEB_FORMAT
}

/**
 * A pi-web record's runtime events as a sliceable fluvia trace.
 *
 * The header is synthesised rather than guessed at: the session id is the one
 * the page put in every `<fluvia-notify>` block it delivered, the concurrency
 * is the one the page's runtime ran with, and `preload` is empty because the
 * page registers its toolbox in process rather than loading a module. The
 * header is stamped at the first event's offset, so the first line's anchor
 * gap stays the gap the agent actually took rather than the age of the page.
 */
export function traceFromRecord(json: unknown): TraceEvent[] {
  if (!isPiWebRecord(json)) throw new Error(`not a pi-web trace (expected "format": "${PI_WEB_FORMAT}")`)
  const runtime = json.runtime ?? []
  if (!runtime.length) throw new Error('pi-web trace has no runtime events')
  const last = runtime[runtime.length - 1]!.t
  const exported = Date.parse(json.exportedAt ?? '')
  const meta: TraceMeta = {
    v: 1,
    session: sessionOf(json),
    origin: Number.isFinite(exported) ? Math.round(exported - last) : 0,
    runtime: { node: 'browser', platform: 'web', fluvia: 'pi-web-fluvia' },
    concurrency: json.live?.concurrency ?? 4,
    preload: [],
    sinks: ['stdout'],
  }
  const header: TraceEvent = { seq: 0, t: runtime[0]!.t, k: 'session.start', meta }
  return [header, ...runtime.map((event, i) => ({ ...event, seq: i + 1 }))]
}

/**
 * The lines each assistant turn submitted, in turn order.
 *
 * A turn submits through the `fluvia` tool; its argument carries the calls as
 * plain text, one per line. The older `lines` / `line` arguments are read too,
 * so a recording made before the plain-text form still counts correctly.
 */
export function turnLines(record: PiWebRecord): string[][] {
  const turns: string[][] = []
  for (const message of record.messages ?? []) {
    const m = message as { role?: string; content?: unknown }
    if (m.role !== 'assistant') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const lines: string[] = []
    for (const block of blocks) {
      const b = block as { type?: string; name?: string; arguments?: unknown }
      if (b.type === 'toolCall' && b.name === 'fluvia') lines.push(...callsOf(b.arguments))
    }
    turns.push(lines)
  }
  return turns
}

/** The calls one `fluvia` tool invocation carries, one per line. */
export function callsOf(params: unknown): string[] {
  const p = (params ?? {}) as { calls?: unknown; lines?: unknown; line?: unknown }
  const chunks: string[] = []
  for (const value of [p.calls, p.lines, p.line]) {
    if (typeof value === 'string') chunks.push(value)
    else if (Array.isArray(value)) chunks.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  return chunks
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The line index a cut falls on.
 *
 * `{ turn: k }` is the number of lines the turns before it submitted, which is
 * where the k-th turn's first line lands whether or not that turn submitted
 * anything itself: a turn that only read its notifications still marks a
 * moment the agent was in.
 */
export function resolveCut(cut: BenchCut, trace: IndexedTrace, record?: PiWebRecord): number {
  if ('line' in cut) return cut.line
  if ('notify' in cut) {
    const line = trace.lines.find((entry) => entry.anchor.kind === 'notify' && entry.anchor.call === cut.notify)
    if (!line) throw new Error(`cut { notify: ${JSON.stringify(cut.notify)} }: no line was typed after that call's notification`)
    return line.index
  }
  if (!record) throw new Error('cut { turn } needs a pi-web trace.json: only it records which lines belonged to which model turn')
  const turns = turnLines(record)
  if (cut.turn < 1 || cut.turn > turns.length) throw new Error(`cut { turn: ${cut.turn} }: the recording has ${turns.length} assistant turns`)
  let before = 0
  for (let i = 0; i < cut.turn - 1; i++) before += turns[i]!.length
  return before
}

/* ------------------------------------------------------------------- reading */

/**
 * Read a recording from disk: `.jsonl`, `.jsonl.gz`, or a pi-web `trace.json`.
 *
 * The format is sniffed rather than taken from the extension — traces get
 * copied, renamed and snapshotted — and the gzip stream is decoded with
 * `Z_SYNC_FLUSH` so a session still being written reads back as far as it got.
 */
export async function loadBenchTrace(path: string): Promise<LoadedBenchTrace> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(path)
  let text: string
  if (raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b) {
    const { gunzipSync, constants } = await import('node:zlib')
    text = gunzipSync(raw, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8')
  } else {
    text = raw.toString('utf8')
  }
  let whole: unknown
  try {
    whole = JSON.parse(text)
  } catch {
    whole = undefined
  }
  if (isPiWebRecord(whole)) return { path, events: traceFromRecord(whole), record: whole as PiWebRecord }
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as TraceEvent)
    } catch {
      // A truncated tail is expected from a session killed mid-write.
    }
  }
  if (!events.some((event) => event.k === 'session.start')) {
    throw new Error(`${path}: neither a fluvia trace (no session.start) nor a pi-web ${PI_WEB_FORMAT}`)
  }
  return { path, events }
}

/** Resolve a case's `trace` against the directory the case file lives in. */
export async function resolveTracePath(dir: string, spec: string): Promise<string> {
  const { resolve } = await import('node:path')
  return resolve(dir, spec)
}

function sessionOf(record: PiWebRecord): string {
  for (const message of record.messages ?? []) {
    const m = message as { role?: string; text?: unknown }
    if (m.role !== 'fluvia-notify' || typeof m.text !== 'string') continue
    const found = /session="([^"]+)"/.exec(m.text)
    if (found) return found[1]!
  }
  const stamp = (record.exportedAt ?? '').replace(/[-:T]/g, '').slice(0, 14)
  return `web-${stamp || 'unrecorded'}`
}
