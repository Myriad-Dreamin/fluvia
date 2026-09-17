/**
 * Reading a recorded session as a benchmark. A trace is indexed into the
 * lines agents typed, the calls those lines scheduled, and — for every line —
 * its **anchor**: the thing the agent was evidently reacting to when it typed.
 *
 * Anchors are what make a slice replayable. Absolute timestamps are not: they
 * carry the recording host's jitter, and a replay whose calls take a slightly
 * different time would type a reactive line before the result it reacted to.
 * Anchoring each line to the most recent notification (or to the line before
 * it, whichever came later) keeps the causal order and replays only the gap.
 *
 * @module @fluvia/core/bench/slice
 */

import type { ArgNode, CallError, CallOutcome, DepRef, TraceEvent, TraceMeta } from '../types.ts'

/** What an agent was reacting to when it typed a line. */
export type Anchor =
  /** The first line: timed from the start of the session. */
  | { kind: 'start'; gapMs: number }
  /** Typed right after an earlier line, with no result in between. */
  | { kind: 'line'; index: number; gapMs: number }
  /** Typed after a call's notification was published. */
  | { kind: 'notify'; call: string; gapMs: number }

/** One line an agent typed, as recorded. */
export interface RecordedLine {
  /** 0-based position among the session's input lines. */
  index: number
  /** Recorded offset from the session origin. */
  t: number
  agent: string
  /** The line exactly as typed, `@agent` prefix included. */
  line: string
  kind: 'call' | 'control' | 'noop' | 'error' | 'exit'
  /** The call it scheduled, when `kind === 'call'`. */
  call?: string
  /** What the CLI answered synchronously. */
  output: string[]
  anchor: Anchor
}

/** One call, as recorded from its submit to its settlement. */
export interface RecordedCall {
  id: string
  fn: string
  agent: string
  /** The line that scheduled it. */
  line: number
  args: ArgNode[]
  deps: DepRef[]
  bind: { value: string; error: string }
  submitT: number
  startT?: number
  settleT?: number
  notifyT?: number
  outcome?: CallOutcome
  value?: { type?: string; summary?: string }
  error?: CallError
  skip?: { reason: string; from: string }
  cancel?: { by: string; reason: string }
}

/** A trace, indexed for slicing. */
export interface IndexedTrace {
  meta: TraceMeta
  events: TraceEvent[]
  lines: RecordedLine[]
  calls: Map<string, RecordedCall>
  /** Agents that typed at least one line, in first-seen order. */
  agents: string[]
  /** Offset of the last event. */
  end: number
}

type Event<K extends TraceEvent['k']> = Extract<TraceEvent, { k: K }>

export function indexTrace(events: TraceEvent[]): IndexedTrace {
  const head = events.find((event): event is Event<'session.start'> => event.k === 'session.start')
  if (!head) throw new Error('not a fluvia trace: no session.start event')

  const lines: RecordedLine[] = []
  const calls = new Map<string, RecordedCall>()
  const agents: string[] = []
  let current: RecordedLine | undefined
  let lastNotify: { call: string; t: number } | undefined

  for (const event of events) {
    switch (event.k) {
      case 'agent.input': {
        const previous = lines[lines.length - 1]
        let anchor: Anchor
        if (lastNotify && (!previous || lastNotify.t >= previous.t)) {
          anchor = { kind: 'notify', call: lastNotify.call, gapMs: round(event.t - lastNotify.t) }
        } else if (previous) {
          anchor = { kind: 'line', index: previous.index, gapMs: round(event.t - previous.t) }
        } else {
          anchor = { kind: 'start', gapMs: round(event.t - head.t) }
        }
        const body = event.line.replace(/^@[A-Za-z_][\w-]*\s*/, '').trim()
        current = {
          index: lines.length,
          t: event.t,
          agent: event.agent,
          line: event.line,
          kind: body === '.exit' || body === '.quit' ? 'exit' : 'noop',
          output: [],
          anchor,
        }
        lines.push(current)
        if (event.agent && current.kind !== 'exit' && !agents.includes(event.agent)) agents.push(event.agent)
        break
      }
      case 'call.submit': {
        if (current && current.kind === 'noop' && current.agent === event.agent) {
          current.kind = 'call'
          current.call = event.call
        }
        calls.set(event.call, {
          id: event.call,
          fn: event.fn,
          agent: event.agent,
          line: current?.index ?? -1,
          args: event.args,
          deps: event.deps,
          bind: event.bind,
          submitT: event.t,
        })
        break
      }
      case 'cli.output': {
        // Answers are synchronous, so every non-notification output before the
        // next input belongs to the current line.
        if (!current || event.level === 'notify' || event.agent !== current.agent) break
        current.output.push(event.text)
        if (current.kind === 'noop') current.kind = event.level === 'error' ? 'error' : 'control'
        break
      }
      case 'call.start': {
        const call = calls.get(event.call)
        if (call) call.startT = event.t
        break
      }
      case 'call.settle': {
        const call = calls.get(event.call)
        if (!call) break
        call.settleT = event.t
        call.outcome = event.outcome
        call.value = event.value
        call.error = event.error
        call.skip = event.skip
        call.cancel = event.cancel
        break
      }
      case 'notify.emit': {
        const call = calls.get(event.call)
        if (call && call.notifyT === undefined) call.notifyT = event.t
        lastNotify = { call: event.call, t: event.t }
        break
      }
    }
  }

  return { meta: head.meta, events, lines, calls, agents, end: events[events.length - 1]?.t ?? 0 }
}

/** Parse a JSONL trace body (already decompressed). Tolerates a truncated tail. */
export function parseTraceText(text: string): TraceEvent[] {
  const events: TraceEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as TraceEvent)
    } catch {
      // A truncated tail is expected from a session killed mid-write.
    }
  }
  return events
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
