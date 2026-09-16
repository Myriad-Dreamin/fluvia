/**
 * Folds a fluvia trace into the one structure the report draws from.
 *
 * The trace is a flat, append-only event stream: a call's story is spread over
 * `call.submit`, `call.start`, zero or more `call.progress`, and `call.settle`,
 * and the handles it binds settle in separate `handle.settle` events. Nothing
 * downstream should have to re-derive that join, so this module does it once
 * and hands the renderer a value that is already shaped like the picture:
 * calls with an explicit `[submit, start, settle]` geometry, dependency edges
 * as `(producer, consumer)` pairs, notifications with their emit→deliver lag
 * resolved, and the derived tables the stats section prints.
 *
 * Two rules drive the defensive code here. First, a trace may be **truncated**
 * — a session killed mid-write loses its tail, so calls can lack `call.start`
 * or `call.settle` and the `session.end` roll-up may never arrive. Second, the
 * renderer must never divide by zero: an empty session has `wallMs === 0`.
 * Everything below therefore treats missing events as "still open" rather than
 * as corruption, and recomputes {@link SessionStats} from the events instead of
 * trusting the header, so a partial trace still renders honestly.
 *
 * @module fluvia/perf/model
 */

import type {
  ArgNode,
  CallError,
  CallOutcome,
  CallState,
  ChannelKind,
  DepRef,
  RelMillis,
  SessionStats,
  SkipReason,
  TraceMeta,
} from '../core/types.ts'
import type { LoadedTrace } from '../core/trace.ts'

/* ------------------------------------------------------------------ pieces */

/**
 * One of the two variables a call binds, merged with the `handle.settle` event
 * that resolved it. Stays `pending` when the producing call never settled,
 * which is exactly what a truncated trace looks like.
 */
export interface HandleView {
  /** Variable name as bound at submission, e.g. `kernel0` or `err0`. */
  name: string
  /** Which channel this variable carries. */
  kind: ChannelKind
  /** `pending` until the call settles, then `ready` (carries data) or `void`. */
  state: 'pending' | 'ready' | 'void'
  /** Handle id, known only once a `handle.settle` event mentions it. */
  id?: string
  /** Short type label for display. */
  type?: string
  /** One-line human summary of the payload. */
  summary?: string
}

/** A call as the timeline draws it: an identity, a geometry and an outcome. */
export interface CallView {
  /** Stable call id, e.g. `c3`. */
  id: string
  /** Submission order, 0-based; derived from the call id (see {@link callOrdinal}). */
  seq: number
  /** The agent that submitted it; decides which lane the row lands in. */
  agent: string
  /** Registered function name. */
  fn: string
  /** Argument tree, handle references left symbolic so the panel can link them. */
  args: ArgNode[]
  /** Dependency edges in argument order, as recorded at submission. */
  deps: DepRef[]
  /** The two variables bound at submission. */
  bind: { value: string; error: string }
  /** Those two variables with their final states folded in. */
  handles: HandleView[]
  /** Terminal state, or the last state we can prove from the events. */
  state: CallState
  /** The handle ids for the two channels, as allocated at submission. */
  handleIds?: { value: string; error: string }
  /** When the CLI accepted the line. Always known: the call exists because of it. */
  submit: RelMillis
  /**
   * When every dependency was ready and the call began waiting for a
   * concurrency slot. Absent for a call that was skipped (it never became
   * eligible) and for traces written before `call.queued` existed.
   */
  queued?: RelMillis
  /** When the implementation started running; absent for skipped and unstarted calls. */
  start?: RelMillis
  /** When it reached a terminal state; absent for calls the trace never saw finish. */
  settle?: RelMillis
  /** submit→start, i.e. dependency wait plus slot wait. */
  waitedMs: number
  /**
   * submit→queued: time lost to the *dataflow* — this call was waiting for a
   * producer, not for the scheduler.
   */
  depWaitMs?: number
  /**
   * queued→start: time lost to *scheduler pressure* — dependencies were ready
   * and the only thing missing was a concurrency slot. This is the number that
   * says whether `--concurrency` is the bottleneck.
   */
  slotWaitMs?: number
  /** start→settle. Zero for calls that never ran. */
  runMs: number
  /** submit→settle, or submit→end-of-trace for open calls. */
  totalMs: number
  /** Terminal outcome once settled. */
  outcome?: CallOutcome
  /** Digest of the value channel payload, from `call.settle`. */
  value?: { type?: string; summary?: string }
  /** Failure detail when `outcome === 'failed'`. */
  error?: CallError
  /** Why it never ran, when `outcome === 'skipped'`. */
  skip?: { reason: SkipReason; from: string }
  /** Who cancelled it and why, when `outcome === 'cancelled'`. */
  cancel?: { by: string; reason: string }
  /** Progress notes emitted while running. */
  progress: { at: RelMillis; note: string; pct?: number }[]
  /**
   * True when the trace ends before this call settles. The timeline draws these
   * as open-ended bars running to the session end rather than dropping them.
   */
  open: boolean
  /** Calls this one waits on (deduplicated producer ids). */
  upstream: string[]
  /** Calls that wait on this one. */
  downstream: string[]
}

/** A producer→consumer edge, drawn from the producer's settle to the consumer's start. */
export interface DepEdge {
  /** Producing call id. */
  from: string
  /** Consuming call id. */
  to: string
  /** The variable the consumer wrote, e.g. `kernel0`. */
  name: string
  /** Value edges feed data; error edges feed recovery paths. */
  kind: ChannelKind
}

/** One `notify.deliver` event, as it applies to a single notification id. */
export interface NotifyDelivery {
  /** When the sink received the batch. */
  at: RelMillis
  /** Sink name, as it appeared in `--notify`. */
  sink: string
  /** Latency the runtime measured for the batch. */
  latencyMs: number
  /** Envelope size in bytes. */
  bytes: number
  /** How many notifications shared this envelope; > 1 means the sink coalesced. */
  coalesced: number
}

/** A notification, joined from its `notify.emit` to the deliveries that carried it. */
export interface NotifyView {
  /** Stable notification id, e.g. `n4`. */
  id: string
  /** The settled call it reports. */
  call: string
  /** The agent it is delivered to. */
  agent: string
  /** The call's terminal state. */
  outcome: CallOutcome
  /** When the runtime emitted it — effectively the call's settle time. */
  emitAt: RelMillis
  /** Every delivery that included this id, in time order. */
  deliveries: NotifyDelivery[]
  /** emit→first delivery, the number the stats table reports as notification lag. */
  lagMs?: number
}

/** One line of the interleaved agent/CLI transcript. */
export interface TranscriptLine {
  /** When it was written. */
  t: RelMillis
  /** The agent that typed it, or that the CLI answered. */
  agent: string
  /** `agent` lines are input the agent typed; `cli` lines are what came back. */
  source: 'agent' | 'cli'
  /** Severity for CLI output; agent input is always `input`. */
  level: 'input' | 'info' | 'error' | 'notify'
  /** The rendered text, exactly as the trace recorded it. */
  text: string
  /** Call ids mentioned in the text, so clicking the line can select one. */
  calls: string[]
}

/** An agent lane in the timeline, plus the counters the header needs. */
export interface AgentView {
  /** Agent id as written in the `@agent` line prefix. */
  id: string
  /** When the runtime first saw it. */
  joinedAt: RelMillis
  /** Lines it submitted. */
  lines: number
  /** Call ids it submitted, in submission order. */
  calls: string[]
}

/** Per-agent row of the stats table. */
export interface AgentStats {
  /** Agent id. */
  agent: string
  /** Calls submitted. */
  calls: number
  /** Count per terminal state; open calls are counted nowhere. */
  outcomes: Record<CallOutcome, number>
  /** Median total latency (submit→settle) in ms. */
  p50TotalMs: number
  /** 95th percentile total latency in ms. */
  p95TotalMs: number
  /** Mean submit→start across settled calls. */
  meanWaitMs: number
  /** Mean submit→queued: how long this agent's calls waited on their producers. */
  meanDepWaitMs: number
  /** Mean queued→start: how long they then sat behind the concurrency limit. */
  meanSlotWaitMs: number
  /** Mean start→settle across calls that ran. */
  meanRunMs: number
  /** Median emit→deliver lag of this agent's notifications. */
  notifyP50Ms: number
  /** 95th percentile emit→deliver lag. */
  notifyP95Ms: number
}

/** Per-function row of the stats table. */
export interface FnStats {
  /** Function name. */
  fn: string
  /** How many times it was called. */
  count: number
  /** Median run time across the invocations that ran. */
  p50RunMs: number
  /** 95th percentile run time. */
  p95RunMs: number
  /** Total time spent inside this function. */
  busyMs: number
  /** Mean queued→start for this function: does it habitually sit in the queue? */
  meanSlotWaitMs: number
  /** Count per terminal state. */
  outcomes: Record<CallOutcome, number>
}

/** A step in the concurrency profile: `n` calls are running from `t` onwards. */
export interface ConcurrencySample {
  /** Start of the step, ms from session origin. */
  t: RelMillis
  /** How many calls are running during it. */
  n: number
}

/** Everything the report renders, computed once. */
export interface PerfModel {
  /** Absolute path of the trace this was folded from. */
  source: string
  /** The `session.start` header. */
  meta: TraceMeta
  /** Wall-clock length of the session; at least 1ms so scales never collapse. */
  wallMs: RelMillis
  /** True when no `session.end` event was found — a killed or still-running session. */
  truncated: boolean
  /** Why the session ended, when it ended cleanly. */
  endReason?: string
  /** Calls in submission order. */
  calls: CallView[]
  /** Agents in join order; the timeline draws one lane group per entry. */
  agents: AgentView[]
  /** Notifications with their deliveries resolved. */
  notifications: NotifyView[]
  /** Agent input and CLI output interleaved in time order. */
  transcript: TranscriptLine[]
  /** Dependency edges between calls. */
  edges: DepEdge[]
  /** Session roll-up, recomputed from the events rather than read from the tail. */
  stats: SessionStats
  /** Per-agent table. */
  agentStats: AgentStats[]
  /** Per-function table, busiest first. */
  fnStats: FnStats[]
  /** Concurrency profile as a step function. */
  concurrency: ConcurrencySample[]
  /** Highest simultaneous running count observed. */
  peakConcurrency: number
  /** `busyMs / wallMs` — how many calls ran at once on average. */
  meanParallelism: number
  /**
   * Whether the trace carries `call.queued` events at all. Traces written
   * before that event existed cannot have their wait split, so the report
   * falls back to one undivided WAIT segment rather than guessing.
   */
  hasQueueEvents: boolean
  /** Median queued→start across every call that reached the queue. */
  slotWaitP50Ms: number
  /** 95th percentile queued→start — the tail of scheduler pressure. */
  slotWaitP95Ms: number
}

/* ------------------------------------------------------------------- utils */

/** Nearest-rank percentile over an unsorted sample; `0` for an empty sample. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!
}

/** Arithmetic mean; `0` for an empty sample. */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** A zeroed outcome histogram, so tables never have to test for `undefined`. */
function emptyOutcomes(): Record<CallOutcome, number> {
  return { done: 0, failed: 0, cancelled: 0, skipped: 0 }
}

/**
 * Submission ordinal of a call.
 *
 * `call.submit` does not carry an ordinal of its own — the base event `seq` is
 * the *event* number, not the call number — so the ordinal is read back out of
 * the call id, which the runtime allocates as `c<n>`. `fallback` (the position
 * of the submission in the stream) covers any id that does not follow the
 * convention, because file order is submission order either way.
 */
function callOrdinal(id: string, fallback: number): number {
  const digits = /(\d+)$/.exec(id)
  return digits ? Number(digits[1]) : fallback
}

/** Call ids mentioned in a line of transcript text, e.g. `c3` inside `inspect(c3)`. */
function mentionedCalls(text: string, known: Set<string>): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/\bc\d+\b/g)) {
    if (known.has(match[0])) found.add(match[0])
  }
  return [...found]
}

/* -------------------------------------------------------------------- fold */

/**
 * Fold a loaded trace into the render model.
 *
 * Events are visited once, in file order, and written into per-call mutable
 * state; the derived tables are computed afterwards so they see complete calls.
 * The function is total: any event stream containing a `session.start` header
 * produces a model, including one with no calls at all.
 */
export function buildModel(trace: LoadedTrace): PerfModel {
  const byId = new Map<string, CallView>()
  const agents = new Map<string, AgentView>()
  const notifications = new Map<string, NotifyView>()
  const transcript: TranscriptLine[] = []
  const edges: DepEdge[] = []
  // Handle settlements are indexed twice. `call.submit` now carries the handle
  // ids, so `byHandleId` is the direct join; `byCallChannel` is the fallback
  // for traces written before that field existed, where `(call, kind)` was the
  // only key both events shared.
  const byHandleId = new Map<string, HandleView>()
  const byCallChannel = new Map<string, HandleView>()
  // Transcript text is scanned for call ids, but a line may mention a call that
  // is submitted later in the stream, so the scan is deferred to a second pass.
  const rawLines: { t: RelMillis; agent: string; source: 'agent' | 'cli'; level: TranscriptLine['level']; text: string }[] = []

  let lastT = 0
  let endReason: string | undefined
  let truncated = true
  let submissions = 0
  let hasQueueEvents = false

  /**
   * Register a lane for an agent.
   *
   * Only events an agent *authors* may create one: `agent.join`, `agent.input`
   * and `call.submit`. Everything else merely mentions an agent, and two of
   * those mentions are not agent identities at all — `cli.output` uses `''`
   * for CLI-level text (the banner, parse errors, the session close) and
   * `notify.deliver` uses `''` when a coalescing sink batched notifications
   * belonging to more than one agent. Treating those as lanes inflated the
   * agent count and drew empty rows, so `''` is rejected here, once, for every
   * caller.
   */
  const touchAgent = (id: string, t: RelMillis): AgentView | undefined => {
    if (!id) return undefined
    let agent = agents.get(id)
    if (!agent) {
      agent = { id, joinedAt: t, lines: 0, calls: [] }
      agents.set(id, agent)
    }
    return agent
  }

  for (const event of trace.events) {
    if (event.t > lastT) lastT = event.t
    switch (event.k) {
      case 'session.start':
        break
      case 'agent.join':
        touchAgent(event.agent, event.t)
        break
      case 'agent.input': {
        const agent = touchAgent(event.agent, event.t)
        if (agent) agent.lines++
        rawLines.push({ t: event.t, agent: event.agent, source: 'agent', level: 'input', text: event.line })
        break
      }
      case 'cli.output': {
        // Deliberately does not touch the roster: `agent` is the addressee, and
        // it is `''` for output the CLI writes on its own behalf.
        rawLines.push({ t: event.t, agent: event.agent, source: 'cli', level: event.level, text: event.text })
        break
      }
      case 'call.submit': {
        const agent = touchAgent(event.agent, event.t)
        agent?.calls.push(event.call)
        const call: CallView = {
          id: event.call,
          seq: callOrdinal(event.call, submissions++),
          agent: event.agent,
          fn: event.fn,
          args: event.args ?? [],
          deps: event.deps ?? [],
          bind: event.bind,
          handleIds: event.handles,
          handles: [
            { name: event.bind.value, kind: 'value', state: 'pending' },
            { name: event.bind.error, kind: 'error', state: 'pending' },
          ],
          // A call with dependencies starts out `waiting`; one without is
          // immediately eligible and therefore `queued`. Later events overwrite
          // this, but a truncated trace may leave it as the last known truth.
          state: (event.deps ?? []).length > 0 ? 'waiting' : 'queued',
          submit: event.t,
          waitedMs: 0,
          runMs: 0,
          totalMs: 0,
          progress: [],
          open: true,
          upstream: [],
          downstream: [],
        }
        byId.set(call.id, call)
        for (const dep of event.deps ?? []) {
          edges.push({ from: dep.from, to: call.id, name: dep.name, kind: dep.kind })
        }
        break
      }
      case 'call.queued': {
        const call = byId.get(event.call)
        if (!call) break
        hasQueueEvents = true
        call.queued = event.t
        call.state = 'queued'
        // Prefer the runtime's own measurement over the difference of two
        // event timestamps: the runtime measured the interval, we only see
        // when it got around to writing about it.
        call.depWaitMs = event.blockedMs
        break
      }
      case 'call.start': {
        const call = byId.get(event.call)
        if (!call) break
        call.start = event.t
        call.state = 'running'
        call.waitedMs = event.waitedMs
        if (call.queued !== undefined) {
          call.slotWaitMs = Math.max(0, event.t - call.queued)
          // `waitedMs` is authoritative for the total, so let the dependency
          // half absorb the sub-millisecond disagreement between the two
          // measurements rather than letting the halves out-sum the whole.
          call.depWaitMs = Math.max(0, event.waitedMs - call.slotWaitMs)
        }
        break
      }
      case 'call.progress': {
        byId.get(event.call)?.progress.push({ at: event.t, note: event.note, pct: event.pct })
        break
      }
      case 'call.settle': {
        const call = byId.get(event.call)
        if (!call) break
        call.settle = event.t
        call.state = event.outcome
        call.outcome = event.outcome
        call.runMs = event.runMs
        call.totalMs = event.totalMs
        call.open = false
        if (event.value) call.value = event.value
        if (event.error) call.error = event.error
        if (event.skip) call.skip = event.skip
        if (event.cancel) call.cancel = event.cancel
        break
      }
      case 'call.cancel': {
        const call = byId.get(event.call)
        // `call.cancel` records the request; the matching `call.settle` records
        // the effect. Keep the request even if the settle never arrived.
        if (call && !call.cancel) call.cancel = { by: event.by, reason: event.reason }
        break
      }
      case 'handle.settle': {
        const handle: HandleView = {
          name: event.name,
          kind: event.kind,
          state: event.state,
          id: event.handle,
          type: event.type,
          summary: event.summary,
        }
        byHandleId.set(event.handle, handle)
        byCallChannel.set(`${event.call}:${event.kind}`, handle)
        break
      }
      case 'notify.emit': {
        // The addressee again, not a roster event: a notification can only
        // exist because the agent that submitted the call already joined.
        notifications.set(event.id, {
          id: event.id,
          call: event.call,
          agent: event.agent,
          outcome: event.outcome,
          emitAt: event.t,
          deliveries: [],
        })
        break
      }
      case 'notify.deliver': {
        const ids = Array.isArray(event.id) ? event.id : [event.id as unknown as string]
        for (const id of ids) {
          const notification = notifications.get(id)
          if (!notification) continue
          notification.deliveries.push({
            at: event.t,
            sink: event.sink,
            latencyMs: event.latencyMs,
            bytes: event.bytes,
            coalesced: ids.length,
          })
        }
        break
      }
      case 'session.end':
        truncated = false
        endReason = event.reason
        break
    }
  }

  // A session with no events beyond the header still needs a non-zero span, or
  // every x-scale in the report divides by zero.
  const wallMs = Math.max(lastT, 1)

  for (const call of byId.values()) {
    call.handles = call.handles.map((handle) => {
      const id = call.handleIds?.[handle.kind]
      return (id ? byHandleId.get(id) : undefined) ?? byCallChannel.get(`${call.id}:${handle.kind}`) ?? { ...handle, id }
    })
    // Derive the timings the trace did not get to write. An open call is
    // measured against the end of the trace, which is what the bar shows.
    if (call.settle === undefined) {
      call.totalMs = Math.max(0, wallMs - call.submit)
      if (call.start !== undefined) {
        call.waitedMs = call.start - call.submit
        call.runMs = Math.max(0, wallMs - call.start)
      } else {
        call.waitedMs = call.totalMs
        // Queued but never started: everything after the queue point is slot
        // wait that was still accruing when the trace stopped.
        if (call.queued !== undefined) call.slotWaitMs = Math.max(0, wallMs - call.queued)
      }
    }
    const seen = new Set<string>()
    for (const dep of call.deps) {
      if (!seen.has(dep.from)) {
        seen.add(dep.from)
        call.upstream.push(dep.from)
      }
    }
  }
  for (const edge of edges) {
    const producer = byId.get(edge.from)
    if (producer && !producer.downstream.includes(edge.to)) producer.downstream.push(edge.to)
  }

  const calls = [...byId.values()].sort((a, b) => a.submit - b.submit || a.seq - b.seq)
  const knownCalls = new Set(calls.map((call) => call.id))
  for (const line of rawLines) {
    transcript.push({ ...line, calls: mentionedCalls(line.text, knownCalls) })
  }
  transcript.sort((a, b) => a.t - b.t)

  for (const notification of notifications.values()) {
    notification.deliveries.sort((a, b) => a.at - b.at)
    const first = notification.deliveries[0]
    if (first) notification.lagMs = Math.max(0, first.at - notification.emitAt)
  }

  const notificationList = [...notifications.values()].sort((a, b) => a.emitAt - b.emitAt)
  const agentList = [...agents.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))

  const stats = sessionStats(calls, agentList, notificationList, wallMs)
  const concurrency = concurrencyProfile(calls, wallMs)
  const slotWaits = calls.filter((call) => call.slotWaitMs !== undefined).map((call) => call.slotWaitMs!)

  return {
    source: trace.path,
    meta: trace.meta,
    wallMs,
    truncated,
    endReason,
    calls,
    agents: agentList,
    notifications: notificationList,
    transcript,
    // Drop edges whose producer never made it into the trace; the timeline
    // cannot draw an edge to a row that does not exist.
    edges: edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)),
    stats,
    agentStats: agentStats(calls, agentList, notificationList),
    fnStats: fnStats(calls),
    concurrency,
    peakConcurrency: concurrency.reduce((max, sample) => Math.max(max, sample.n), 0),
    meanParallelism: stats.busyMs / wallMs,
    hasQueueEvents,
    slotWaitP50Ms: percentile(slotWaits, 50),
    slotWaitP95Ms: percentile(slotWaits, 95),
  }
}

/* ----------------------------------------------------------------- derived */

/** Recompute the session roll-up from the calls, ignoring the header's copy. */
function sessionStats(
  calls: CallView[],
  agents: AgentView[],
  notifications: NotifyView[],
  wallMs: number,
): SessionStats {
  const outcomes = emptyOutcomes()
  let busyMs = 0
  for (const call of calls) {
    if (call.outcome) outcomes[call.outcome]++
    if (call.start !== undefined) busyMs += call.runMs
  }
  return {
    calls: calls.length,
    outcomes,
    agents: agents.length,
    notifications: notifications.length,
    wallMs,
    busyMs,
  }
}

/** Build the per-agent table, including that agent's notification lag spread. */
function agentStats(calls: CallView[], agents: AgentView[], notifications: NotifyView[]): AgentStats[] {
  return agents.map((agent) => {
    const own = calls.filter((call) => call.agent === agent.id)
    const outcomes = emptyOutcomes()
    for (const call of own) if (call.outcome) outcomes[call.outcome]++
    const totals = own.filter((call) => !call.open).map((call) => call.totalMs)
    const waits = own.filter((call) => !call.open).map((call) => call.waitedMs)
    const runs = own.filter((call) => call.start !== undefined).map((call) => call.runMs)
    // Only calls that actually reached the queue have a split to average; a
    // skipped call never became eligible, so counting it as zero slot wait
    // would flatter the scheduler.
    const depWaits = own.filter((call) => call.depWaitMs !== undefined).map((call) => call.depWaitMs!)
    const slotWaits = own.filter((call) => call.slotWaitMs !== undefined).map((call) => call.slotWaitMs!)
    const lags = notifications
      .filter((notification) => notification.agent === agent.id && notification.lagMs !== undefined)
      .map((notification) => notification.lagMs!)
    return {
      agent: agent.id,
      calls: own.length,
      outcomes,
      p50TotalMs: percentile(totals, 50),
      p95TotalMs: percentile(totals, 95),
      meanWaitMs: mean(waits),
      meanDepWaitMs: mean(depWaits),
      meanSlotWaitMs: mean(slotWaits),
      meanRunMs: mean(runs),
      notifyP50Ms: percentile(lags, 50),
      notifyP95Ms: percentile(lags, 95),
    }
  })
}

/** Build the per-function table, busiest function first. */
function fnStats(calls: CallView[]): FnStats[] {
  const groups = new Map<string, CallView[]>()
  for (const call of calls) {
    const group = groups.get(call.fn)
    if (group) group.push(call)
    else groups.set(call.fn, [call])
  }
  const rows: FnStats[] = []
  for (const [fn, group] of groups) {
    const runs = group.filter((call) => call.start !== undefined).map((call) => call.runMs)
    const outcomes = emptyOutcomes()
    for (const call of group) if (call.outcome) outcomes[call.outcome]++
    rows.push({
      fn,
      count: group.length,
      p50RunMs: percentile(runs, 50),
      p95RunMs: percentile(runs, 95),
      busyMs: runs.reduce((sum, ms) => sum + ms, 0),
      meanSlotWaitMs: mean(group.filter((call) => call.slotWaitMs !== undefined).map((call) => call.slotWaitMs!)),
      outcomes,
    })
  }
  return rows.sort((a, b) => b.busyMs - a.busyMs || b.count - a.count || a.fn.localeCompare(b.fn))
}

/**
 * Turn the run intervals into a step function of "how many calls were running".
 *
 * Deltas are sorted with settles (`-1`) before starts (`+1`) at an identical
 * timestamp, so a call that hands its slot to the next one does not read as a
 * one-sample spike above the concurrency limit.
 */
function concurrencyProfile(calls: CallView[], wallMs: number): ConcurrencySample[] {
  const deltas: { t: number; d: number }[] = []
  for (const call of calls) {
    if (call.start === undefined) continue
    deltas.push({ t: call.start, d: 1 })
    deltas.push({ t: call.settle ?? wallMs, d: -1 })
  }
  if (deltas.length === 0) {
    return [
      { t: 0, n: 0 },
      { t: wallMs, n: 0 },
    ]
  }
  deltas.sort((a, b) => a.t - b.t || a.d - b.d)
  const samples: ConcurrencySample[] = [{ t: 0, n: 0 }]
  let level = 0
  for (let i = 0; i < deltas.length; i++) {
    level += deltas[i]!.d
    const t = deltas[i]!.t
    // Collapse simultaneous deltas into one sample: the chart only cares about
    // the level that actually held for some interval.
    if (i + 1 < deltas.length && deltas[i + 1]!.t === t) continue
    const last = samples[samples.length - 1]!
    if (last.t === t) last.n = level
    else samples.push({ t, n: level })
  }
  const last = samples[samples.length - 1]!
  if (last.t < wallMs) samples.push({ t: wallMs, n: last.n })
  return samples
}
