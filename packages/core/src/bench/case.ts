/**
 * A benchmark case: one recording, one cut, one thing changed, and the
 * questions that decide whether the change was acceptable.
 *
 * The slice engine answers "what happened when this session was replayed with
 * X different". A case is the layer above: it names X, says where to stop, and
 * carries the predicates — *judges* — that turn a report into pass or fail. A
 * case file is TypeScript rather than a data format so that a judge can be a
 * function: the interesting questions about a dataflow ("did the recovery note
 * mention the new error?") do not fit in a matcher vocabulary, and inventing
 * one only delays the moment someone needs a real expression.
 *
 * ```ts
 * import { defineBench, judges } from '@fluvia/core/bench/case'
 *
 * export default defineBench({
 *   name: 'kernel sweep · concurrency 2',
 *   trace: './traces/demo.jsonl.gz',
 *   cut: { line: 9 },
 *   subject: { concurrency: 2 },
 *   judge: [judges.outcomes({ same: true }), judges.order('changed')],
 * })
 * ```
 *
 * Browser-safe: nothing here imports `node:` at module scope. The one function
 * that reads a file, {@link loadBenchTrace}, does it behind a lazy `import()`.
 *
 * @module @fluvia/core/bench/case
 */

import type { CallRecord, CallState, FunctionDef, HandleRecord, TraceEvent } from '../types.ts'
import type { IndexedTrace } from './slice.ts'
import { indexTrace } from './slice.ts'
import { SliceSession } from './session.ts'
import type { AgentWake, SliceReport } from './session.ts'
import type { BenchCut, LoadedBenchTrace } from './load.ts'
import { loadBenchTrace, resolveCut, resolveTracePath } from './load.ts'

export type { BenchCut, LoadedBenchTrace, PiWebRecord } from './load.ts'

/* -------------------------------------------------------------------- shapes */

/** What a judge is shown. Everything the replay knows, and nothing it does not. */
export interface World {
  /** The slice engine's verdict: lines, calls, notification order, totals. */
  report: SliceReport
  /** Every call in the replayed runtime, including the ones restored before the cut. */
  calls: CallRecord[]
  /** Every handle bound in the replayed runtime. */
  handles: HandleRecord[]
  /** The replay's own event stream. */
  events: TraceEvent[]
  /** The recording the slice was cut from. */
  trace: IndexedTrace
}

/** A judge's answer in full. */
export interface JudgeResult {
  pass: boolean
  /** Why it failed — or, for a passing judge, what it saw. */
  reason?: string
  /** Optional 0..1 quality number; never decides pass on its own. */
  score?: number
}

/** `true`, or `false`/a reason string, or the full result. */
export type JudgeVerdict = boolean | string | JudgeResult

/** A question asked of the replayed world. */
export interface Judge {
  (world: World): JudgeVerdict
  /** Name shown in the report; {@link judges} sets it, a plain function need not. */
  judgeName?: string
}

/** What a takeover driver is given. The live-agent half of `@fluvia/core/bench/session`. */
export interface TakeoverContext {
  /** The lane handed over at the cut. */
  lane: string
  /** The case's `goal`, as text for the agent. */
  goal: string
  /** What the lane had seen up to the cut, as the agent would have read it. */
  transcript(): string
  /** The lane's calls and handles right now. */
  state(): string
  /** Submit one line as the lane; returns the runtime's synchronous answer. */
  submit(line: string): string
  /** Let virtual time run until the lane has something to read. */
  wake(): Promise<AgentWake>
  /** True when no call is live and no recorded line is left. */
  isIdle(): boolean
  /** Whether the case's `horizon` has been reached. */
  reached(): boolean
  /** Report model usage, so the runner can price the case. */
  charge(tokens: number): void
}

/** A live continuation of one lane. */
export type TakeoverDriver = (ctx: TakeoverContext) => Promise<void>

/** Exactly one thing changed between the recording and the replay. */
export type BenchSubject =
  /** Run the slice under a different scheduler concurrency. */
  | { concurrency: number }
  /** Replace recorded lines by index, as `fluvia bench replay --edit` does. */
  | { edits: Record<number, string> }
  /**
   * Swap instructions' implementations, by name. A bare function replaces the
   * `run()` of the registered definition; a full {@link FunctionDef} replaces it
   * whole. The swap is in force for the entire replay, restoration included, so
   * it also changes the world the cut is restored into.
   */
  | { call: Record<string, FunctionDef | FunctionDef['run']> }
  /** Hand one lane to a live agent at the cut and let the others replay around it. */
  | { takeover: TakeoverSubject }

/** A lane handed to a live agent. */
export interface TakeoverSubject {
  lane: string
  driver: TakeoverDriver
  /**
   * The model the driver samples, if any. A driver that samples nothing — a
   * scripted stand-in — leaves it unset and the case counts as free.
   */
  model?: string
}

/**
 * Where the slice stops.
 *
 * `'complete'` replays every remaining line and drains the runtime.
 * `{ reach: [...] }` stops as soon as every predicate holds; a predicate is
 * `"<what> <state>"`, where *what* is a call id (`c9`), a handle name
 * (`digest9`) or a function name (`summarize`), and *state* is a call state
 * (`done`, `failed`, `skipped`, `cancelled`) or a handle state (`ready`,
 * `void`). A horizon that is never reached fails the case.
 *
 * Stopping early leaves the rest of the slice untyped, so its recorded calls
 * count as `missing`: a case with a `reach` horizon should judge what it
 * reached, not demand `outcomes({ same: true })` over a slice it cut short.
 */
export type BenchHorizon = 'complete' | { reach: string[] }

/** A case, as a case file writes it. */
export interface BenchSpec {
  /** Defaults to the case file's name. */
  name?: string
  /** The recording, relative to the case file: `.jsonl`, `.jsonl.gz`, or a pi-web `trace.json`. */
  trace: string
  /** Where to cut; defaults to the start of the recording. */
  cut?: BenchCut
  /** Exclusive upper line bound, as in `SliceOptions`. */
  to?: number
  /** The instruction set the recording ran. The runner fills in its default when omitted. */
  toolbox?: FunctionDef[]
  /** What is different this time; omitted means a plain mechanical replay. */
  subject?: BenchSubject
  /** Where the slice stops; `'complete'` by default. */
  horizon?: BenchHorizon
  /** Asked in order, cheap first; all must pass. Defaults to `judges.outcomes({ same: true })`. */
  judge?: Judge | Judge[]
  /** Repeat count; only a takeover varies between runs. */
  runs?: number
  /** Handed to a takeover driver as the lane's task. */
  goal?: string
}

/** A case, after {@link defineBench} has vouched for it. */
export interface BenchCase extends BenchSpec {
  readonly fluviaBench: true
}

/** One judge's verdict on one run. */
export interface Verdict extends JudgeResult {
  name: string
}

/** What one execution of a case produced. */
export interface CaseRun {
  pass: boolean
  verdicts: Verdict[]
  report: SliceReport
  ms: number
  tokens?: number
}

/** A case's result. */
export interface CaseResult {
  name: string
  /** The case file, when the runner knows it. */
  file?: string
  /** True when every judge passed in every run. */
  pass: boolean
  /** The first failing run's verdicts, or the first run's. */
  verdicts: Verdict[]
  /** The report those verdicts were read from. */
  report: SliceReport
  /** Wall time for every run together. */
  ms: number
  cost: { tokens?: number; modelRuns: number }
  /** One entry per run; a single-run case has one. */
  runs: CaseRun[]
  /** How many runs passed, of `runs.length`. */
  passed: number
  /** One line naming what was different, for the runner's table. */
  subject: string
  /** The line the slice was cut at. */
  from: number
}

/** What {@link runCase} needs besides the case. */
export interface RunCaseOptions {
  /** Directory `trace` is resolved against; defaults to `.`. */
  dir?: string
  /** The case file, carried into the result. */
  file?: string
  /** The instruction set used when the case omits `toolbox`. */
  toolbox?: FunctionDef[]
  /** Overrides how a recording is read — a browser has no filesystem. */
  load?(spec: string): Promise<LoadedBenchTrace>
}

/* ------------------------------------------------------------------- defining */

/**
 * Declare a case. It checks what a case file gets wrong at a glance — a subject
 * with two things in it, a `runs` that means nothing — so the mistake is
 * reported against the file rather than as a confusing result.
 */
export function defineBench(spec: BenchSpec): BenchCase {
  if (!spec.trace) throw new Error('defineBench: `trace` is required')
  if (spec.subject) {
    const keys = Object.keys(spec.subject)
    if (keys.length !== 1) throw new Error(`defineBench: \`subject\` takes exactly one of concurrency, edits, call, takeover (got ${keys.join(', ') || 'nothing'})`)
    if (!['concurrency', 'edits', 'call', 'takeover'].includes(keys[0]!)) throw new Error(`defineBench: unknown subject ${keys[0]}`)
  }
  if (spec.runs !== undefined && spec.runs < 1) throw new Error('defineBench: `runs` must be at least 1')
  return { ...spec, fluviaBench: true }
}

export function isBenchCase(value: unknown): value is BenchCase {
  return !!value && typeof value === 'object' && (value as BenchCase).fluviaBench === true
}

/* --------------------------------------------------------------------- judges */

/** The judges worth having ready-made. Anything else is a function. */
export const judges = {
  /**
   * How the recorded calls of the slice settled this time. `same: true` — the
   * default question — demands that every one of them settled identically.
   */
  outcomes(expect: { same?: boolean; diverged?: number; missing?: number } = { same: true }): Judge {
    return named(`outcomes(${describe(expect)})`, (world) => {
      const { same, diverged, missing } = world.report.totals
      const seen = `${same} same, ${diverged} diverged, ${missing} missing`
      if (expect.same === true && (diverged || missing)) return `expected every call to settle as recorded; got ${seen}`
      if (expect.same === false && !diverged && !missing) return `expected at least one call to diverge; got ${seen}`
      if (expect.diverged !== undefined && diverged !== expect.diverged) return `expected ${expect.diverged} diverged; got ${seen}`
      if (expect.missing !== undefined && missing !== expect.missing) return `expected ${expect.missing} missing; got ${seen}`
      return { pass: true, reason: seen }
    })
  },

  /**
   * Every call to `target` — a function name or a call id — settled `outcome`,
   * and there was at least one.
   */
  settled(target: string, outcome: CallState = 'done'): Judge {
    return named(`settled(${target}, ${outcome})`, (world) => {
      const matched = world.calls.filter((call) => call.fn === target || call.id === target)
      if (!matched.length) return `no call to ${target} was made`
      const wrong = matched.filter((call) => call.state !== outcome)
      if (wrong.length) return `${wrong.map((call) => `${call.id} ${call.fn} is ${call.state}`).join(', ')}, expected ${outcome}`
      return { pass: true, reason: `${matched.length} × ${target} ${outcome}` }
    })
  },

  /** The handle bound as `name` carries data. */
  handleReady(name: string): Judge {
    return named(`handleReady(${name})`, (world) => {
      const handle = world.handles.find((entry) => entry.name === name)
      if (!handle) return `no handle named ${name} was bound`
      if (handle.state !== 'ready') return `${name} is ${handle.state}`
      return { pass: true, reason: `${name} : ${handle.type ?? ''} ${handle.summary ?? ''}`.trim() }
    })
  },

  /**
   * Whether every replaying lane was notified in the order it was recorded in.
   * `'changed'` is the interesting one: it asserts that a harness change really
   * did reorder the world, so a case that stops reordering stops passing.
   */
  order(expect: 'unchanged' | 'changed'): Judge {
    return named(`order(${expect})`, (world) => {
      const moved = world.report.order.filter((lane) => !lane.same)
      if (expect === 'unchanged' && moved.length) return `notification order changed for ${moved.map((lane) => lane.agent).join(', ')}`
      if (expect === 'changed' && !moved.length) return 'notification order was unchanged for every lane'
      const lanes = world.report.order.length
      return { pass: true, reason: expect === 'changed' ? `${moved.length} of ${lanes} lanes reordered` : `${lanes} lanes in recorded order` }
    })
  },

  /** A call to `target` failed, optionally with this error `kind`. */
  failed(target: string, kind?: string): Judge {
    return named(`failed(${target}${kind ? `, ${kind}` : ''})`, (world) => {
      const matched = world.calls.filter((call) => call.fn === target || call.id === target)
      if (!matched.length) return `no call to ${target} was made`
      const failures = matched.filter((call) => call.state === 'failed')
      if (!failures.length) return `${target} did not fail (${matched.map((call) => call.state).join(', ')})`
      if (kind && !failures.some((call) => call.error?.kind === kind)) {
        return `${target} failed with ${failures.map((call) => call.error?.kind ?? '?').join(', ')}, expected ${kind}`
      }
      return { pass: true, reason: failures.map((call) => `${call.id} ${call.error?.kind ?? 'failed'}`).join(', ') }
    })
  },

  /** Exactly `count` calls settled in `state`. */
  count(state: CallState, count: number): Judge {
    return named(`count(${state}, ${count})`, (world) => {
      const matched = world.calls.filter((call) => call.state === state)
      if (matched.length !== count) return `${matched.length} calls are ${state} (${matched.map((call) => `${call.id} ${call.fn}`).join(', ') || 'none'}), expected ${count}`
      return { pass: true, reason: matched.map((call) => `${call.id} ${call.fn}`).join(', ') || `no ${state} calls` }
    })
  },
}

function named(name: string, judge: (world: World) => JudgeVerdict): Judge {
  const wrapped: Judge = (world) => judge(world)
  wrapped.judgeName = name
  return wrapped
}

function describe(expect: Record<string, unknown>): string {
  return Object.entries(expect)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ')
}

/* -------------------------------------------------------------------- running */

/** Execute one case: open the slice with its subject applied, then judge it. */
export async function runCase(bench: BenchCase, options: RunCaseOptions = {}): Promise<CaseResult> {
  const name = bench.name ?? options.file?.split('/').pop()?.replace(/\.bench\.[cm]?[jt]s$/, '') ?? 'case'
  const toolbox = bench.toolbox ?? options.toolbox
  if (!toolbox) throw new Error(`${name}: no toolbox — pass one in the case, or let the runner supply its default`)

  // A custom reader gets the spec exactly as the case wrote it: only the
  // filesystem reader needs it turned into a path.
  const spec = options.load ? bench.trace : await resolveTracePath(options.dir ?? '.', bench.trace)
  const loaded = await (options.load ?? loadBenchTrace)(spec)
  const trace = indexTrace(loaded.events)
  const from = resolveCut(bench.cut ?? { line: 0 }, trace, loaded.record)
  const judgeList = bench.judge === undefined ? [judges.outcomes({ same: true })] : Array.isArray(bench.judge) ? bench.judge : [bench.judge]

  const runs: CaseRun[] = []
  const total = bench.runs ?? 1
  const started = performance.now()
  for (let i = 0; i < total; i++) runs.push(await runOnce(bench, { trace, from, toolbox, judgeList }))
  const ms = Math.round(performance.now() - started)

  const failing = runs.find((run) => !run.pass)
  const headline = failing ?? runs[0]!
  const tokens = runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0)
  const model = bench.subject && 'takeover' in bench.subject ? bench.subject.takeover.model : undefined
  return {
    name,
    file: options.file,
    pass: runs.every((run) => run.pass),
    verdicts: headline.verdicts,
    report: headline.report,
    ms,
    cost: { modelRuns: model ? total : 0, tokens: tokens || undefined },
    runs,
    passed: runs.filter((run) => run.pass).length,
    subject: subjectSummary(bench.subject),
    from,
  }
}

/** One line naming what a case changed, for a report's table. */
export function subjectSummary(subject: BenchSubject | undefined): string {
  if (!subject) return 'replay'
  if ('concurrency' in subject) return `concurrency ${subject.concurrency}`
  if ('edits' in subject) return `edit ${Object.keys(subject.edits).join(',')}`
  if ('call' in subject) return `call ${Object.keys(subject.call).join(',')}`
  return `takeover ${subject.takeover.lane}${subject.takeover.model ? ` · ${subject.takeover.model}` : ' · scripted'}`
}

async function runOnce(
  bench: BenchCase,
  input: { trace: IndexedTrace; from: number; toolbox: FunctionDef[]; judgeList: Judge[] },
): Promise<CaseRun> {
  const { trace, from, judgeList } = input
  const subject = bench.subject
  const takeover = subject && 'takeover' in subject ? subject.takeover : undefined
  const started = performance.now()
  const session = await SliceSession.open(trace, {
    from,
    to: bench.to,
    takeover: takeover?.lane ?? null,
    concurrency: subject && 'concurrency' in subject ? subject.concurrency : undefined,
    edits: subject && 'edits' in subject ? subject.edits : undefined,
    toolbox: subject && 'call' in subject ? swapCalls(input.toolbox, subject.call) : input.toolbox,
  })

  const horizon = bench.horizon ?? 'complete'
  const targets = typeof horizon === 'object' ? horizon.reach : []
  const reached = () => targets.length > 0 && targets.every((target) => holds(session, target))

  let tokens = 0
  let report: SliceReport
  if (takeover) {
    await takeover.driver({
      lane: takeover.lane,
      goal: bench.goal ?? '',
      transcript: () => session.transcript(),
      state: () => session.state(),
      submit: (line) => session.submit(line),
      wake: () => session.wake(),
      isIdle: () => session.isIdle(),
      reached,
      charge: (n) => {
        tokens += n
      },
    })
    // Whatever the driver left running still settles, so the report is complete.
    while (!session.isIdle()) {
      if (targets.length && reached()) break
      const wake = await session.wake()
      if (wake.idle || !wake.notifications.length) break
    }
    report = session.report()
  } else {
    report = await session.finish(targets.length ? reached : undefined)
  }

  const world: World = { report, calls: session.calls(), handles: session.handles(), events: session.events, trace }
  const verdicts: Verdict[] = []
  if (targets.length) {
    const missed = targets.filter((target) => !holds(session, target))
    verdicts.push({ name: `horizon(${targets.join(', ')})`, pass: !missed.length, reason: missed.length ? `never reached: ${missed.join(', ')}` : targets.join(', ') })
  }
  for (const [i, judge] of judgeList.entries()) verdicts.push(ask(judge, world, i))
  return { pass: verdicts.every((verdict) => verdict.pass), verdicts, report, ms: Math.round(performance.now() - started), tokens: tokens || undefined }
}

function ask(judge: Judge, world: World, index: number): Verdict {
  const name = judge.judgeName ?? (judge.name || `judge ${index + 1}`)
  try {
    const answer = judge(world)
    if (answer === true) return { name, pass: true }
    if (answer === false) return { name, pass: false }
    if (typeof answer === 'string') return { name, pass: false, reason: answer }
    return { name, pass: answer.pass, reason: answer.reason, score: answer.score }
  } catch (error) {
    return { name, pass: false, reason: `judge threw: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Whether one horizon predicate holds right now. */
function holds(session: SliceSession, predicate: string): boolean {
  const [what, want = 'done'] = predicate.trim().split(/\s+/)
  if (!what) return false
  const calls = session.calls()
  const call = calls.find((entry) => entry.id === what)
  if (call) return call.state === want
  const handle = session.handles().find((entry) => entry.name === what)
  if (handle) return handle.state === want
  const byFn = calls.filter((entry) => entry.fn === what)
  return byFn.length > 0 && byFn.some((entry) => entry.state === want)
}

/** The toolbox with some implementations replaced. The original array is untouched. */
function swapCalls(toolbox: FunctionDef[], swaps: Record<string, FunctionDef | FunctionDef['run']>): FunctionDef[] {
  const out = [...toolbox]
  for (const [name, swap] of Object.entries(swaps)) {
    const at = out.findIndex((def) => def.name === name)
    if (at < 0) throw new Error(`subject { call }: the toolbox has no function named ${name}`)
    out[at] = typeof swap === 'function' ? { ...out[at]!, run: swap } : swap
  }
  return out
}
