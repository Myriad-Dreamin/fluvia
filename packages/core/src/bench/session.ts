/**
 * A benchmark slice: a recorded session cut at one line, restored into a fresh
 * runtime, and continued from there in one of two ways.
 *
 * - **Mechanical** (`takeover: null`). Every recorded line of the slice is
 *   typed again on its anchor, and the runtime's answers are diffed against the
 *   recording call by call. Nothing is sampled, so any difference is the
 *   harness's: a scheduling change, a toolbox that reads the wall clock, a
 *   concurrency limit that reorders the queue, a line you edited to test a
 *   hypothesis.
 * - **Agent** (`takeover: "<agent>"`). One lane is handed to a live agent at
 *   the cut. The other lanes keep replaying their recording around it, so the
 *   agent works in the same world the original agent did. The agent sees the
 *   transcript its lane had produced up to the cut and nothing after it.
 *
 * Time is virtual throughout. It advances only while the runtime has work, so
 * an agent's thinking time is never charged to the dataflow, and a replay of a
 * minute-long session finishes in milliseconds.
 *
 * @module @fluvia/core/bench/session
 */

import type { CallRecord, FunctionDef, HandleRecord, Notification, TraceEvent } from '../types.ts'
import { isTerminal } from '../plugins/scheduler.ts'
import { VirtualClock } from './clock.ts'
import { createRuntime } from './runtime.ts'
import type { MemoryRuntime } from './runtime.ts'
import type { IndexedTrace, RecordedCall, RecordedLine } from './slice.ts'

/** How a slice is cut and continued. */
export interface SliceOptions {
  /** First line of the slice: the runtime is restored to the moment before it. */
  from: number
  /** One past the last recorded line replayed; defaults to the end of the session. */
  to?: number
  /** Hand this agent's lane to a live agent at the cut; `null` replays everything. */
  takeover?: string | null
  /** Scheduler concurrency; defaults to the recording's. */
  concurrency?: number
  /** Replacement text for recorded lines, by line index (mechanical debugging). */
  edits?: Record<number, string>
  /** The instruction set; must be the one the recording ran. */
  toolbox: FunctionDef[]
  /** Upper bound on virtual time spent after the last replayed line, in ms. */
  drainLimitMs?: number
}

/** What happened to one recorded line in the replay. */
export interface LineOutcome {
  index: number
  agent: string
  recorded: string
  /** The text actually typed, after edits and handle renaming; absent if not typed. */
  replayed?: string
  edited: boolean
  /** Recorded and replayed offsets from the cut. */
  atRecorded: number
  atReplayed?: number
  outputRecorded: string[]
  outputReplayed: string[]
  status: 'same' | 'different' | 'not-replayed' | 'taken-over'
}

/** Recorded vs replayed facts for one call. */
export interface CallComparison {
  line: number
  agent: string
  fn: string
  recorded: CallFacts
  replayed?: CallFacts
  /** Fields whose values differ, excluding timing. */
  diffs: { field: string; recorded: string; replayed: string }[]
  status: 'same' | 'diverged' | 'missing'
}

/** The comparable facts of a call. */
export interface CallFacts {
  id: string
  bind: string
  outcome: string
  summary: string
  /** Settle offset from the cut. */
  settleAt?: number
  runMs?: number
}

/** A live agent's call during a takeover. */
export interface AgentCall {
  id: string
  fn: string
  line: string
  outcome: string
  summary: string
  settleAt?: number
}

/** The slice's verdict. */
export interface SliceReport {
  from: number
  to: number
  takeover: string | null
  concurrency: number
  /** Recorded and replayed offsets of the cut from each session's origin. */
  cut: { recorded: number; replayed: number }
  lines: LineOutcome[]
  calls: CallComparison[]
  /** Per non-takeover agent: the order notifications arrived in, as `callId fn`. */
  order: { agent: string; recorded: string[]; replayed: string[]; same: boolean }[]
  totals: { same: number; diverged: number; missing: number }
  agent?: AgentScore
}

/** How a live agent's continuation compares with the recorded one. */
export interface AgentScore {
  agent: string
  reference: { fn: string; outcome: string }[]
  calls: AgentCall[]
  errors: string[]
  /** Share of reference `done` calls the agent also completed (by function name). */
  coverage: number
  /** Agent calls that failed, were skipped, or were refused. */
  wasted: number
  /** Virtual ms from the cut to the agent's last settled call, and the recorded equivalent. */
  spanMs: { agent: number; recorded: number }
}

/** Something the takeover agent learned when the world moved. */
export interface AgentWake {
  /** Notification lines addressed to the agent, as it would read them. */
  notifications: string[]
  /** Virtual offset from the cut. */
  at: number
  /** Nothing is running and nothing recorded is left to replay. */
  idle: boolean
}

export class SliceSession {
  readonly clock = new VirtualClock()
  readonly takeover: string | null
  readonly from: number
  readonly to: number
  readonly concurrency: number

  private rt!: MemoryRuntime
  private readonly pending: RecordedLine[]
  private readonly submittedAt = new Map<number, number>()
  private readonly typed = new Map<number, string>()
  private readonly answered = new Map<number, string[]>()
  private readonly lineCall = new Map<number, string>()
  private readonly callMap = new Map<string, string>()
  private readonly nameMap = new Map<string, string>()
  private readonly notifiedAt = new Map<string, number>()
  private readonly inbox: Notification[] = []
  private readonly agentLines: { at: number; line: string; call?: string; output: string[] }[] = []
  private cutReplayed = 0
  private readonly cutRecorded: number
  private previousDue = 0

  private constructor(
    readonly trace: IndexedTrace,
    private readonly options: SliceOptions,
  ) {
    this.from = Math.max(0, Math.min(options.from, trace.lines.length))
    this.to = Math.max(this.from, Math.min(options.to ?? trace.lines.length, trace.lines.length))
    this.takeover = options.takeover ?? null
    this.concurrency = options.concurrency ?? trace.meta.concurrency
    this.cutRecorded = trace.lines[this.from]?.t ?? trace.end
    this.pending = trace.lines.filter(
      (line) =>
        line.index < this.to &&
        line.kind !== 'exit' &&
        !(this.takeover !== null && line.index >= this.from && line.agent === this.takeover),
    )
  }

  /** Build the runtime and replay everything before the cut. */
  static async open(trace: IndexedTrace, options: SliceOptions): Promise<SliceSession> {
    const session = new SliceSession(trace, options)
    session.rt = await createRuntime({
      clock: session.clock,
      toolbox: options.toolbox,
      concurrency: session.concurrency,
      onNotify: (notification) => session.onNotify(notification),
    })
    await session.runUntil(() => (session.pending[0]?.index ?? Infinity) >= session.from)
    // The cut is the moment the slice's first line would be typed: after its
    // anchor has happened in this replay, not at its recorded timestamp.
    const first = trace.lines[session.from]
    while (first) {
      const due = session.dueAt(first, false)
      if (due !== undefined || !session.anchorAlive(first)) {
        await session.clock.advanceTo(Math.max(session.clock.now(), due ?? session.dueAt(first, true)!))
        break
      }
      const timer = session.clock.nextAt()
      if (timer === undefined) break
      await session.clock.advanceTo(timer)
    }
    session.cutReplayed = session.clock.now()
    // What was published before the cut is already in the transcript.
    session.inbox.length = 0
    if (session.takeover !== null) {
      // The taken-over lane's recorded calls after the cut will never exist in
      // this replay. Another lane's line naming one of them must fail loudly,
      // not silently bind to whatever call now carries the same number.
      for (const call of trace.calls.values()) {
        if (call.agent !== session.takeover || call.line < session.from) continue
        for (const name of [call.id, call.bind.value, call.bind.error]) session.nameMap.set(name, `unreplayed_${name}`)
      }
    }
    return session
  }

  /** Virtual offset from the cut. */
  get elapsed(): number {
    return round(this.clock.now() - this.cutReplayed)
  }

  /** Every event the replay has produced so far. */
  get events(): TraceEvent[] {
    return this.rt.tracer.events
  }

  /** Every call in the replayed runtime, in submission order. */
  calls(): CallRecord[] {
    return this.rt.ctx.calls.list()
  }

  /** The runtime's own snapshot of a call. */
  call(id: string): CallRecord | undefined {
    return this.rt.ctx.calls.get(id)
  }

  /** Every handle bound in the replayed runtime, in binding order. */
  handles(): HandleRecord[] {
    return this.rt.ctx.env.handles()
  }

  /* --------------------------------------------------------------- mechanical */

  /**
   * Replay the rest of the slice and let every call settle.
   *
   * `stop` is checked between steps, so a benchmark that only cares about
   * reaching a state can end the slice there instead of draining work the
   * question does not depend on. When it fires, live calls are left live.
   */
  async finish(stop?: () => boolean): Promise<SliceReport> {
    let stopped = false
    await this.runUntil(() => {
      if (stop?.()) stopped = true
      return stopped || this.pending.length === 0
    })
    if (!stopped) await this.drain(stop)
    return this.report()
  }

  /* -------------------------------------------------------------------- agent */

  /** What the takeover lane had seen up to the cut, as the agent would have read it. */
  transcript(): string {
    const agent = this.requireTakeover()
    const out: string[] = []
    for (const event of this.rt.tracer.events) {
      if (event.t > this.cutReplayed) break
      if (event.k === 'agent.input' && event.agent === agent) out.push(`> ${event.line.replace(/^@[\w-]+\s*/, '')}`)
      else if (event.k === 'cli.output' && event.agent === agent) out.push(event.text)
    }
    return out.join('\n')
  }

  /** The takeover lane's calls and handles at this moment. */
  state(): string {
    const agent = this.requireTakeover()
    const rows: string[] = []
    for (const call of this.rt.ctx.calls.list()) {
      if (call.agent !== agent) continue
      const value = this.rt.ctx.env.handle(call.handles.value)
      const error = this.rt.ctx.env.handle(call.handles.error)
      const ready = value?.state === 'ready' ? value : error?.state === 'ready' ? error : undefined
      const detail = ready ? `${ready.name} : ${ready.type ?? ''} ${ready.summary ?? ''}`.trim() : `${call.bind.value}, ${call.bind.error}`
      rows.push(`${call.id} ${call.fn} [${call.state}] ${detail}`)
    }
    return rows.join('\n') || '(no calls yet)'
  }

  /** Submit a line as the takeover agent. Returns the CLI's synchronous answer. */
  submit(line: string): string {
    const agent = this.requireTakeover()
    const body = line.trim().replace(/^@[\w-]+\s*/, '')
    const before = this.rt.tracer.events.length
    const calls = this.rt.ctx.calls.list().length
    this.rt.session.handle(`@${agent} ${body}`)
    const output = syncOutput(this.rt.tracer.events.slice(before))
    const created = this.rt.ctx.calls.list()[calls]
    this.agentLines.push({ at: this.elapsed, line: body, call: created?.id, output })
    if (created) this.adopt(created)
    return output.join('\n') || '(no answer)'
  }

  /**
   * Let the world move until the takeover agent has something to read: at
   * least one notification for it (plus any others published at that same
   * instant), or nothing left that could ever produce one.
   */
  async wake(limitMs = 600_000): Promise<AgentWake> {
    const agent = this.requireTakeover()
    const limit = this.clock.now() + limitMs
    await this.clock.settle()
    for (;;) {
      if (this.inbox.some((n) => n.agent === agent)) break
      const moved = await this.step(limit)
      if (!moved) break
    }
    const mine = this.inbox.filter((n) => n.agent === agent)
    this.inbox.length = 0
    return { notifications: mine.map((n) => n.text), at: this.elapsed, idle: this.isIdle() }
  }

  /** True when no call is live and no recorded line is left. */
  isIdle(): boolean {
    return this.pending.length === 0 && this.rt.ctx.calls.live().length === 0
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * Treat an agent's call as the counterpart of the lane's next unmatched
   * recorded call to the same function. From then on the other lanes' recorded
   * lines name the agent's handles and wait on the agent's notifications, so the
   * world reacts to what the agent actually did rather than to the recording.
   */
  private adopt(call: CallRecord): void {
    const agent = this.takeover!
    for (const recorded of this.trace.calls.values()) {
      if (recorded.agent !== agent || recorded.line < this.from || recorded.line >= this.to) continue
      if (recorded.fn !== call.fn || this.callMap.has(recorded.id)) continue
      this.callMap.set(recorded.id, call.id)
      this.nameMap.set(recorded.id, call.id)
      this.nameMap.set(recorded.bind.value, call.bind.value)
      this.nameMap.set(recorded.bind.error, call.bind.error)
      return
    }
  }

  private requireTakeover(): string {
    if (!this.takeover) throw new Error('this slice has no takeover agent')
    return this.takeover
  }

  private onNotify(notification: Notification): void {
    if (!this.notifiedAt.has(notification.call)) this.notifiedAt.set(notification.call, this.clock.now())
    this.inbox.push(notification)
  }

  /**
   * When a recorded line should be typed in this replay, or `undefined` while
   * its anchor has not happened yet. `fallback` resolves an anchor that can no
   * longer happen to the recorded offset from the cut.
   */
  private dueAt(line: RecordedLine, fallback: boolean): number | undefined {
    const anchor = line.anchor
    let base: number | undefined
    if (anchor.kind === 'start') base = 0
    else if (anchor.kind === 'line') base = this.submittedAt.get(anchor.index)
    else {
      const replayed = this.callMap.get(anchor.call)
      base = replayed !== undefined ? this.notifiedAt.get(replayed) : undefined
    }
    if (base === undefined) {
      if (!fallback) return undefined
      return Math.max(this.previousDue, this.cutReplayed + (line.t - this.cutRecorded))
    }
    return Math.max(this.previousDue, base + anchor.gapMs)
  }

  /** Whether the anchor of `line` can still happen in this replay. */
  private anchorAlive(line: RecordedLine): boolean {
    const anchor = line.anchor
    if (anchor.kind === 'start') return true
    if (anchor.kind === 'line') return this.submittedAt.has(anchor.index) || this.pending.some((p) => p.index === anchor.index)
    const replayed = this.callMap.get(anchor.call)
    if (replayed === undefined) return false
    const call = this.rt.ctx.calls.get(replayed)
    return !!call && (!isTerminal(call.state) || this.notifiedAt.has(replayed))
  }

  /**
   * Make one unit of progress: type the next recorded line if it is due before
   * the next timer, otherwise fire the next timer.
   *
   * @returns false when nothing can move any more (or `limit` was reached).
   */
  private async step(limit: number): Promise<boolean> {
    const next = this.pending[0]
    const timer = this.clock.nextAt()
    let due = next ? this.dueAt(next, false) : undefined
    if (next && due === undefined && !this.anchorAlive(next)) due = this.dueAt(next, true)
    if (next && due !== undefined && (timer === undefined || due <= timer)) {
      if (due > limit) return false
      await this.clock.advanceTo(Math.max(this.clock.now(), due))
      this.type(next)
      await this.clock.settle()
      return true
    }
    if (timer !== undefined) {
      if (timer > limit) return false
      await this.clock.advanceTo(timer)
      return true
    }
    if (next) {
      // No timer can fire and the anchor is not due: fall back rather than hang.
      const fallback = this.dueAt(next, true)!
      if (fallback > limit) return false
      await this.clock.advanceTo(Math.max(this.clock.now(), fallback))
      this.type(next)
      await this.clock.settle()
      return true
    }
    return false
  }

  private async runUntil(done: () => boolean): Promise<void> {
    const limit = Number.MAX_SAFE_INTEGER
    while (!done()) {
      if (!(await this.step(limit))) break
    }
  }

  private async drain(stop?: () => boolean): Promise<void> {
    const limit = this.clock.now() + (this.options.drainLimitMs ?? 600_000)
    while (this.rt.ctx.calls.live().length) {
      if (stop?.()) return
      const timer = this.clock.nextAt()
      if (timer === undefined || timer > limit) break
      await this.clock.advanceTo(timer)
    }
  }

  /** Type a recorded line, renamed onto this replay's call ids and handle names. */
  private type(line: RecordedLine): void {
    this.pending.shift()
    const source = this.options.edits?.[line.index] ?? line.line
    const text = this.rename(source)
    const due = this.clock.now()
    this.previousDue = due
    this.submittedAt.set(line.index, due)
    this.typed.set(line.index, text)
    const calls = this.rt.ctx.calls.list().length
    const before = this.rt.tracer.events.length
    this.rt.session.handle(text)
    this.answered.set(line.index, syncOutput(this.rt.tracer.events.slice(before)))
    const created = this.rt.ctx.calls.list()[calls]
    if (!created) return
    this.lineCall.set(line.index, created.id)
    const recorded = line.call ? this.trace.calls.get(line.call) : undefined
    if (!recorded) return
    this.callMap.set(recorded.id, created.id)
    this.nameMap.set(recorded.id, created.id)
    this.nameMap.set(recorded.bind.value, created.bind.value)
    this.nameMap.set(recorded.bind.error, created.bind.error)
  }

  /** Rewrite identifiers outside string literals through the recorded→replayed name map. */
  private rename(line: string): string {
    let out = ''
    let quote: string | undefined
    let i = 0
    while (i < line.length) {
      const ch = line[i]!
      if (quote) {
        out += ch
        if (ch === '\\') out += line[++i] ?? ''
        else if (ch === quote) quote = undefined
        i++
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        out += ch
        i++
        continue
      }
      const match = /^[A-Za-z_$][\w$]*/.exec(line.slice(i))
      if (match && (i === 0 || !/[\w$@-]/.test(line[i - 1]!))) {
        out += this.nameMap.get(match[0]) ?? match[0]
        i += match[0].length
        continue
      }
      out += ch
      i++
    }
    return out
  }

  /* ------------------------------------------------------------------- report */

  report(): SliceReport {
    const events = this.rt.tracer.events
    const lines: LineOutcome[] = []
    for (const line of this.trace.lines.slice(this.from, this.to)) {
      if (line.kind === 'exit') continue
      const takenOver = this.takeover !== null && line.agent === this.takeover
      const at = this.submittedAt.get(line.index)
      const outputReplayed = this.answered.get(line.index) ?? []
      const edited = this.options.edits?.[line.index] !== undefined
      let status: LineOutcome['status']
      if (takenOver) status = 'taken-over'
      else if (at === undefined) status = 'not-replayed'
      else status = sameOutput(line.output, outputReplayed) ? 'same' : 'different'
      lines.push({
        index: line.index,
        agent: line.agent,
        recorded: line.line,
        replayed: this.typed.get(line.index),
        edited,
        atRecorded: round(line.t - this.cutRecorded),
        atReplayed: at === undefined ? undefined : round(at - this.cutReplayed),
        outputRecorded: line.output,
        outputReplayed,
        status,
      })
    }

    const calls: CallComparison[] = []
    for (const recorded of this.trace.calls.values()) {
      if (recorded.line < this.from || recorded.line >= this.to) continue
      if (this.takeover !== null && recorded.agent === this.takeover) continue
      calls.push(this.compare(recorded))
    }

    const order: SliceReport['order'] = []
    for (const agent of this.trace.agents) {
      if (agent === this.takeover) continue
      // Only calls the slice itself submitted: a call from before the cut can
      // settle on either side of it depending on host jitter.
      const inSlice = (line: number | undefined) => line !== undefined && line >= this.from && line < this.to
      const recorded = this.trace.events
        .filter((e): e is Extract<TraceEvent, { k: 'notify.emit' }> => e.k === 'notify.emit' && e.agent === agent)
        .filter((e) => inSlice(this.trace.calls.get(e.call)?.line))
        .map((e) => `${e.call} ${this.trace.calls.get(e.call)?.fn ?? '?'}`)
      const reverse = new Map([...this.callMap].map(([rec, rep]) => [rep, rec]))
      const replayLine = new Map([...this.lineCall].map(([line, id]) => [id, line]))
      const replayed = events
        .filter((e): e is Extract<TraceEvent, { k: 'notify.emit' }> => e.k === 'notify.emit' && e.agent === agent)
        .filter((e) => inSlice(replayLine.get(e.call)))
        .map((e) => `${reverse.get(e.call) ?? e.call} ${this.rt.ctx.calls.get(e.call)?.fn ?? '?'}`)
      order.push({ agent, recorded, replayed, same: recorded.join('|') === replayed.join('|') })
    }

    const totals = { same: 0, diverged: 0, missing: 0 }
    for (const call of calls) totals[call.status === 'same' ? 'same' : call.status === 'diverged' ? 'diverged' : 'missing']++

    return {
      from: this.from,
      to: this.to,
      takeover: this.takeover,
      concurrency: this.concurrency,
      cut: { recorded: round(this.cutRecorded), replayed: round(this.cutReplayed) },
      lines,
      calls,
      order,
      totals,
      agent: this.takeover ? this.score() : undefined,
    }
  }

  private compare(recorded: RecordedCall): CallComparison {
    const facts = (call: { id: string; bind: string; outcome?: string; summary?: string; settle?: number; start?: number }, cut: number): CallFacts => ({
      id: call.id,
      bind: call.bind,
      outcome: call.outcome ?? 'unsettled',
      summary: call.summary ?? '',
      settleAt: call.settle === undefined ? undefined : round(call.settle - cut),
      runMs: call.settle !== undefined && call.start !== undefined ? round(call.settle - call.start) : undefined,
    })
    const rec = facts(
      {
        id: recorded.id,
        bind: `${recorded.bind.value}, ${recorded.bind.error}`,
        outcome: recorded.outcome,
        summary: summaryOf(recorded.outcome, recorded.value, recorded.error, recorded.skip),
        settle: recorded.settleT,
        start: recorded.startT,
      },
      this.cutRecorded,
    )
    const id = this.lineCall.get(recorded.line)
    const live = id ? this.rt.ctx.calls.get(id) : undefined
    if (!live) {
      return { line: recorded.line, agent: recorded.agent, fn: recorded.fn, recorded: rec, diffs: [], status: 'missing' }
    }
    const reverse = new Map([...this.nameMap].map(([a, b]) => [b, a]))
    const skipFrom = live.skip ? { ...live.skip, from: reverse.get(live.skip.from) ?? live.skip.from } : undefined
    const rep = facts(
      {
        id: live.id,
        bind: `${reverse.get(live.bind.value) ?? live.bind.value}, ${reverse.get(live.bind.error) ?? live.bind.error}`,
        outcome: isTerminal(live.state) ? live.state : 'unsettled',
        summary: summaryOf(
          isTerminal(live.state) ? (live.state as RecordedCall['outcome']) : undefined,
          live.state === 'done' ? digestOf(this.rt, live) : undefined,
          live.error,
          skipFrom,
        ),
        settle: live.at.settle,
        start: live.at.start,
      },
      this.cutReplayed,
    )
    const diffs: CallComparison['diffs'] = []
    if (live.fn !== recorded.fn) diffs.push({ field: 'fn', recorded: recorded.fn, replayed: live.fn })
    for (const field of ['bind', 'outcome', 'summary'] as const) {
      if (rec[field] !== rep[field]) diffs.push({ field, recorded: rec[field], replayed: rep[field] })
    }
    return {
      line: recorded.line,
      agent: recorded.agent,
      fn: recorded.fn,
      recorded: rec,
      replayed: rep,
      diffs,
      status: diffs.length ? 'diverged' : 'same',
    }
  }

  private score(): AgentScore {
    const agent = this.takeover!
    const reference = [...this.trace.calls.values()]
      .filter((call) => call.agent === agent && call.line >= this.from && call.line < this.to)
      .map((call) => ({ fn: call.fn, outcome: call.outcome ?? 'unsettled', settleT: call.settleT }))
    const calls: AgentCall[] = []
    const errors: string[] = []
    for (const entry of this.agentLines) {
      if (!entry.call) {
        const error = entry.output.find((text) => text.startsWith('✗'))
        if (error) errors.push(`${entry.line} → ${error}`)
        continue
      }
      const call = this.rt.ctx.calls.get(entry.call)
      if (!call) continue
      calls.push({
        id: call.id,
        fn: call.fn,
        line: entry.line,
        outcome: call.state,
        summary: summaryOf(
          isTerminal(call.state) ? (call.state as RecordedCall['outcome']) : undefined,
          call.state === 'done' ? digestOf(this.rt, call) : undefined,
          call.error,
          call.skip,
        ),
        settleAt: call.at.settle === undefined ? undefined : round(call.at.settle - this.cutReplayed),
      })
    }
    const wanted = reference.filter((ref) => ref.outcome === 'done').map((ref) => ref.fn)
    const got = calls.filter((call) => call.outcome === 'done').map((call) => call.fn)
    let hit = 0
    for (const fn of wanted) {
      const index = got.indexOf(fn)
      if (index >= 0) {
        hit++
        got.splice(index, 1)
      }
    }
    const lastAgent = Math.max(0, ...calls.map((call) => call.settleAt ?? 0))
    const lastRecorded = Math.max(0, ...reference.map((ref) => (ref.settleT === undefined ? 0 : ref.settleT - this.cutRecorded)))
    return {
      agent,
      reference: reference.map(({ fn, outcome }) => ({ fn, outcome })),
      calls,
      errors,
      coverage: wanted.length ? round(hit / wanted.length) : 1,
      wasted: calls.filter((call) => call.outcome === 'failed' || call.outcome === 'skipped').length + errors.length,
      spanMs: { agent: round(lastAgent), recorded: round(lastRecorded) },
    }
  }
}

/** The CLI's synchronous answer among the events a `handle()` call just emitted. */
function syncOutput(events: TraceEvent[]): string[] {
  return events
    .filter((e): e is Extract<TraceEvent, { k: 'cli.output' }> => e.k === 'cli.output' && e.level !== 'notify')
    .map((e) => e.text)
}

/**
 * Answers are compared with every number masked. Call ids and handle suffixes
 * shift when a replay schedules differently, and control output (`list`,
 * `inspect`) embeds live timings; what has to match is what was said.
 */
function sameOutput(recorded: string[], replayed: string[]): boolean {
  if (recorded.length !== replayed.length) return false
  // Numbers change width (`712ms` vs `1.9s`), which re-aligns whole tables.
  const mask = (text: string) =>
    text
      .replace(/\d+(\.\d+)?(µs|ms|s)?/g, '#')
      .replace(/[ ─]+/g, ' ')
      .trim()
  return recorded.every((text, i) => mask(text) === mask(replayed[i]!))
}

function summaryOf(
  outcome: string | undefined,
  value: { type?: string; summary?: string } | undefined,
  error: { kind: string; message: string } | undefined,
  skip: { reason: string; from: string } | undefined,
): string {
  switch (outcome) {
    case 'done':
      return `${value?.type ?? ''} ${value?.summary ?? ''}`.trim()
    case 'failed':
      return `${error?.kind}: ${error?.message}`
    case 'skipped':
      return `${skip?.reason} from ${skip?.from}`
    case 'cancelled':
      return 'cancelled'
    default:
      return ''
  }
}

function digestOf(rt: MemoryRuntime, call: CallRecord): { type?: string; summary?: string } {
  const handle = rt.ctx.env.handle(call.handles.value)
  return { type: handle?.type, summary: handle?.summary }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
