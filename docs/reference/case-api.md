# Case API

`@fluvia/core/bench/case` — `defineBench`, `judges`, `runCase`: a slice with a
verdict. `@fluvia/core/bench/load` turns a recording into something the slice
engine can cut.

Both are browser-safe: nothing imports `node:` at module scope, and the one
function that reads a file does it behind a lazy `import()`.

```ts
import { defineBench, judges, runCase } from '@fluvia/core/bench/case'
import type { BenchCase, BenchSpec, Judge, World } from '@fluvia/core/bench/case'
```

## `defineBench(spec: BenchSpec): BenchCase`

Declares a case. It checks what a case file gets wrong at a glance — a subject
with two things in it, a `runs` that means nothing — so the mistake is reported
against the file rather than as a confusing result. It throws when `trace` is
missing, when `subject` does not hold exactly one known key, or when `runs < 1`.

```ts
interface BenchSpec {
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

interface BenchCase extends BenchSpec {
  readonly fluviaBench: true
}
```

`isBenchCase(value: unknown): value is BenchCase` is the guard the runner uses to
pick cases out of a module's exports.

## Cuts

```ts
type BenchCut =
  /** Recorded line index, as `fluvia slice lines` prints it. */
  | { line: number }
  /** The first line the `turn`-th assistant turn submitted (pi-web traces). */
  | { turn: number }
  /** The first line typed after this call's notification. */
  | { notify: string }
```

`resolveCut(cut, trace, record?)` turns one into the line index the slice starts
at.

## Subjects

```ts
type BenchSubject =
  | { concurrency: number }
  | { edits: Record<number, string> }
  | { call: Record<string, FunctionDef | FunctionDef['run']> }
  | { takeover: TakeoverSubject }

interface TakeoverSubject {
  lane: string
  driver: TakeoverDriver
  /** The model the driver samples, if any. A scripted stand-in leaves it unset and the case counts as free. */
  model?: string
}
```

`{ call }` swaps implementations by name: a bare function replaces the `run()` of
the registered definition, a full `FunctionDef` replaces it whole. The swap is in
force for the entire replay, restoration included, so it also changes the world
the cut is restored into.

`subjectSummary(subject)` renders the one line the runner's table shows:
`replay`, `concurrency 2`, `edit 10`, `call compileKernel`,
`takeover planner · scripted`.

## Horizons

```ts
type BenchHorizon = 'complete' | { reach: string[] }
```

`'complete'` replays every remaining line and drains the runtime.
`{ reach: [...] }` stops as soon as every predicate holds. A predicate is
`"<what> <state>"`, where *what* is a call id (`c9`), a handle name (`digest9`)
or a function name (`summarize`), and *state* is a call state (`done`, `failed`,
`skipped`, `cancelled`) or a handle state (`ready`, `void`). A horizon that is
never reached fails the case.

## Judges

```ts
interface World {
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

interface JudgeResult {
  pass: boolean
  /** Why it failed — or, for a passing judge, what it saw. */
  reason?: string
  /** Optional 0..1 quality number; never decides pass on its own. */
  score?: number
}

type JudgeVerdict = boolean | string | JudgeResult

interface Judge {
  (world: World): JudgeVerdict
  /** Name shown in the report; `judges` sets it, a plain function need not. */
  judgeName?: string
}
```

Returning a string means failure with that reason. A plain function is reported
under its own name.

### Built-ins

```ts
judges.outcomes(expect?: { same?: boolean; diverged?: number; missing?: number }): Judge
judges.settled(target: string, outcome?: CallState): Judge   // outcome defaults to 'done'
judges.handleReady(name: string): Judge
judges.order(expect: 'unchanged' | 'changed'): Judge
judges.failed(target: string, kind?: string): Judge
judges.count(state: CallState, count: number): Judge
```

| judge | passes when |
| --- | --- |
| `outcomes` | the slice's recorded calls settled as the expectation says. `{ same: true }` (the default) demands no divergence and nothing missing; `{ same: false }` demands at least one; `diverged` and `missing` demand exact counts. |
| `settled` | every call whose `fn` or `id` matches `target` is in state `outcome`, and there is at least one. |
| `handleReady` | a handle bound as `name` exists and is `ready`. |
| `order` | `'unchanged'`: every replaying lane was notified in its recorded order. `'changed'`: at least one lane was not. |
| `failed` | at least one call matching `target` is `failed`, and — with `kind` — one of them failed with that error kind. |
| `count` | exactly `count` calls in the replayed runtime are in state `state`. |

`target` matches a function name or a call id, so `judges.failed('c9', …)` and
`judges.failed('compileKernel', …)` are both legal and mean different things.

## Takeover drivers

```ts
type TakeoverDriver = (ctx: TakeoverContext) => Promise<void>

interface TakeoverContext {
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
```

Virtual time only moves inside `wake()`, so a driver that samples a model is
never charged for thinking.

## Running a case

```ts
async function runCase(bench: BenchCase, options?: RunCaseOptions): Promise<CaseResult>

interface RunCaseOptions {
  /** Directory `trace` is resolved against; defaults to `.`. */
  dir?: string
  /** The case file, carried into the result. */
  file?: string
  /** The instruction set used when the case omits `toolbox`. */
  toolbox?: FunctionDef[]
  /** Overrides how a recording is read — a browser has no filesystem. */
  load?(spec: string): Promise<LoadedBenchTrace>
}
```

`runCase` throws when neither the case nor the options supply a toolbox. Without
`load`, it resolves `trace` against `dir` and reads it from the filesystem.

```ts
interface CaseResult {
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

interface CaseRun {
  pass: boolean
  verdicts: Verdict[]
  report: SliceReport
  ms: number
  tokens?: number
}

interface Verdict extends JudgeResult {
  name: string
}
```

`cost.modelRuns` counts the runs of a takeover whose `model` was declared; a case
with no model in it reports 0 and the runner calls it free.

## `@fluvia/core/bench/load`

```ts
const PI_WEB_FORMAT = 'pi-web-fluvia.trace'

interface LoadedBenchTrace {
  /** Where it came from, as given. */
  path: string
  /** The event stream, header first. */
  events: TraceEvent[]
  /** Present when the recording was a pi-web `trace.json`. */
  record?: PiWebRecord
}

async function loadBenchTrace(path: string): Promise<LoadedBenchTrace>
async function resolveTracePath(dir: string, spec: string): Promise<string>
function isPiWebRecord(value: unknown): value is PiWebRecord
function traceFromRecord(json: unknown): TraceEvent[]
function turnLines(record: PiWebRecord): string[][]
function callsOf(params: unknown): string[]
function resolveCut(cut: BenchCut, trace: IndexedTrace, record?: PiWebRecord): number
```

Two shapes reach a benchmark. A fluvia trace is already the event stream the slice
engine wants — gzip JSONL with a `session.start` header. A pi-web `trace.json` is
a whole agent run: the conversation, the model that produced it, and the runtime's
events *without* a header, because the browser runtime never wrote one.
`traceFromRecord` synthesises that header, so a recording made in a browser page
slices exactly like one made by `fluvia cli`.

The conversation is worth keeping for one reason: it is the only place that says
which lines belonged to which model turn. `turnLines` extracts that mapping,
which is what makes `cut: { turn: 3 }` meaningful on a recording whose lines were
all typed by the same lane.

```ts
interface PiWebRecord {
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
```

## Related modules

| module | what it is |
| --- | --- |
| `@fluvia/core/bench/slice` | index a recorded trace and cut it at a line (`indexTrace`, `IndexedTrace`) |
| `@fluvia/core/bench/session` | `SliceSession`: replay a slice, or hand one lane to an agent; produces the `SliceReport` |
| `@fluvia/core/bench/runtime` | an in-memory runtime with no filesystem |
| `@fluvia/core/bench/clock` | the virtual clock |
