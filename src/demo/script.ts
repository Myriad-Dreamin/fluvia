/**
 * The scripted demo session: what two agents type at the fluvia CLI, and what
 * each of them waits for before typing the next line.
 *
 * The script is data, not code, so the scenario can be read and edited without
 * touching the driver ({@link file://./run.ts}). Each {@link Step} says *who*
 * types, *what* they type, and *when* — immediately, after a delay, or, most
 * often, reactively, when a specific earlier call notifies. That last form is
 * the whole point of fluvia: an agent never awaits, it reacts.
 *
 * Steps refer to each other by label rather than by call id, because call ids
 * (`c7`) and handle names (`kernel7`) depend on submission order and would have
 * to be renumbered by hand every time a line is inserted. The driver
 * substitutes the placeholders below just before it writes the line:
 *
 * | placeholder | becomes | example |
 * | --- | --- | --- |
 * | `$label` | the call id of that step | `c4` |
 * | `$label.value` | its value-channel variable | `kernel4` |
 * | `$label.err` | its error-channel variable | `err4` |
 *
 * A step that mentions `$other` implicitly waits for `other` to be acked, so
 * placeholders can never resolve to nothing.
 *
 * The scenario is built to exercise every outcome the protocol defines and to
 * make a trace worth looking at in the perf report:
 *
 * - **parallelism** — six independent calls open the session at once, against
 *   `--concurrency 4`, so two of them visibly wait in the queue;
 * - **a dependency chain** — `prepareKernel → compileKernel → benchmark → tune`,
 *   plus a second branch through `quantize → compileKernel → benchmark`;
 * - **failure and skip cascade** — a `fp8` kernel on an `sm80` arch fails to
 *   compile, its `benchmark` is skipped (`upstream_failed`) and the `tune`
 *   behind that is skipped in turn (`upstream_skipped`);
 * - **the error channel as a recovery path** — `recover(errN)` and
 *   `explain(errN)` run *because* their producers failed, while an
 *   `explain(errN)` on a call that succeeded is skipped (`upstream_ok`);
 * - **cancellation** — a nine-second `sleep` is cancelled mid-flight and its
 *   dependent is skipped (`upstream_cancelled`);
 * - **inspection** — `list`, `inspect(cN)`, `inspect(@agent)` and `inspect()`
 *   close the session.
 *
 * @module fluvia/demo/script
 */

/** What a step waits for before its line is written to the CLI. */
export type Trigger =
  /** Wait for the settle notification of the labelled step's call. */
  | { notify: string }
  /** Wait only for the labelled step to be acked — i.e. submit into its shadow. */
  | { ack: string }
  /** Wait a fixed delay after the previous step was sent. */
  | { ms: number }

/** One line typed by one agent, with the condition that releases it. */
export interface Step {
  /** Agent id used as the `@agent` line prefix. */
  agent: string
  /** The line, with `$label`, `$label.value` and `$label.err` placeholders. */
  line: string
  /** Label other steps use to refer to this one's call and handles. */
  id?: string
  /** Release condition; omitted means "send as soon as the previous step is sent". */
  after?: Trigger
  /** Why this step is in the scenario — printed by the driver while it runs. */
  why?: string
}

/** The agents this scenario multiplexes over the one runtime. */
export const AGENTS = ['planner', 'tuner'] as const

/**
 * The session, in the order the lines are typed.
 *
 * Arguments are chosen so that every outcome is *decided*, not gambled on: the
 * toolbox seeds its PRNG from the call's arguments, `flakyProbe({ failRate: 1 })`
 * always fails, `failRate: 0` never does, and `fp8` on `sm80` is a compile
 * error by the architecture table. Re-running the demo reproduces the trace.
 */
export const script: Step[] = [
  /* — opening burst: six independent calls against concurrency 4 — */
  {
    id: 'kernA',
    agent: 'planner',
    line: 'prepareKernel({ size: 4096, dtype: "f32", arch: "sm90" })',
    why: 'root of the main chain',
  },
  {
    id: 'dsA',
    agent: 'planner',
    line: 'loadDataset({ name: "imagenet-mini", shards: 6 })',
    why: 'independent of the kernel: runs in parallel with it',
  },
  {
    id: 'dsB',
    agent: 'tuner',
    line: 'loadDataset({ name: "wikitext-103", shards: 4 })',
    why: 'second agent, same runtime',
  },
  {
    id: 'probe',
    agent: 'tuner',
    line: 'flakyProbe({ target: "pcie-link", failRate: 1, trials: 3 })',
    why: 'fails on purpose: gives the error channel something to carry',
  },
  {
    id: 'cooldown',
    agent: 'planner',
    line: 'sleep({ ms: 9000, label: "cooldown" })',
    why: 'long call, cancelled later while still running',
  },
  {
    id: 'kernB',
    agent: 'tuner',
    line: 'prepareKernel({ size: 16384, dtype: "fp8", arch: "sm80" })',
    why: 'sixth ready call at concurrency 4: two of these queue',
  },

  /* — reactive wave: each line is written when its input notifies — */
  {
    id: 'whyCooldown',
    agent: 'planner',
    line: 'explain($cooldown.err, { depth: "short" })',
    after: { ack: 'cooldown' },
    why: 'waits on a call that will be cancelled, so it skips with upstream_cancelled',
  },
  {
    id: 'whyProbe',
    agent: 'planner',
    line: 'explain($probe.err, { depth: "deep" })',
    after: { notify: 'probe' },
    why: 'error handle is ready, so the diagnosis actually runs',
  },
  {
    agent: 'planner',
    line: 'cancel($cooldown)',
    after: { ms: 400 },
    why: 'aborts the sleep mid-flight and cascades to its dependent',
  },
  {
    id: 'compA',
    agent: 'planner',
    line: 'compileKernel($kernA.value, { opt: 3, fastMath: true })',
    after: { notify: 'kernA' },
    why: 'link 2 of the main chain',
  },
  {
    id: 'compB',
    agent: 'tuner',
    line: 'compileKernel($kernB.value, { opt: 3 })',
    after: { notify: 'kernB' },
    why: 'fp8 on sm80: a deterministic compile failure',
  },
  {
    id: 'benchB',
    agent: 'tuner',
    line: 'benchmark($compB.value, $dsB.value, { iters: 100 })',
    after: { ack: 'compB' },
    why: 'submitted while its producer is still running; skipped as upstream_failed',
  },
  {
    id: 'fixB',
    agent: 'tuner',
    line: 'recover($compB.err, { strategy: "auto" })',
    after: { ack: 'compB' },
    why: 'the recovery path: runs precisely because compB fails',
  },
  {
    id: 'tuneB',
    agent: 'tuner',
    line: 'tune($benchB.value, { budget: 4 })',
    after: { ack: 'benchB' },
    why: 'second-order skip: upstream_skipped cascading from benchB',
  },

  /* — main chain continues; extra load keeps the queue non-empty — */
  {
    id: 'benchA',
    agent: 'planner',
    line: 'benchmark($compA.value, $dsA.value, { iters: 200, warmup: 20 })',
    after: { notify: 'compA' },
    why: 'join node: two handles from two different roots',
  },
  {
    id: 'quantA',
    agent: 'planner',
    line: 'quantize($compA.value, { bits: 8 })',
    after: { ack: 'benchA' },
    why: 'second branch off the same compiled kernel',
  },
  {
    id: 'probeOk',
    agent: 'tuner',
    line: 'flakyProbe({ target: "nvlink", failRate: 0, trials: 4 })',
    why: 'filler load, and the success side of the same flaky function',
  },
  {
    id: 'dsC',
    agent: 'planner',
    line: 'loadDataset({ name: "openwebmath", shards: 3 })',
    why: 'more ready calls than slots: queue wait becomes visible',
  },
  {
    id: 'probeHbm',
    agent: 'tuner',
    line: 'flakyProbe({ target: "hbm3", failRate: 0, trials: 3 })',
    why: 'and one more, so the scheduler is oversubscribed for a while',
  },
  {
    id: 'whyBenchA',
    agent: 'tuner',
    line: 'explain($benchA.err)',
    after: { ack: 'benchA' },
    why: 'asks about an error that will never exist: skipped as upstream_ok',
  },
  {
    id: 'compQ',
    agent: 'planner',
    line: 'compileKernel($quantA.value, { opt: 2 })',
    after: { notify: 'quantA' },
    why: 'the quantised branch has to be recompiled before it can be timed',
  },
  {
    id: 'planA',
    agent: 'tuner',
    line: 'tune($benchA.value, { budget: 6, target: "latency" })',
    after: { notify: 'benchA' },
    why: 'end of the main chain, on the other agent',
  },
  {
    id: 'benchQ',
    agent: 'tuner',
    line: 'benchmark($compQ.value, $dsC.value, { iters: 120 })',
    after: { notify: 'compQ' },
    why: 'closes the quantised branch against a third dataset',
  },

  /* — folding everything back into two digests — */
  {
    id: 'digest',
    agent: 'planner',
    line: 'summarize($compA.value, $benchA.value, $planA.value, $fixB.value, $whyProbe.value, { title: "gpu pipeline" })',
    after: { notify: 'planA' },
    why: 'sink node: five handles from four different branches, including two recovered ones',
  },
  {
    id: 'digestQ',
    agent: 'tuner',
    line: 'summarize($benchQ.value, $probeOk.value, { title: "quantised branch" })',
    after: { notify: 'benchQ' },
    why: 'the other agent folds its own branch',
  },

  /* — inspection: what the agents ask once the work has settled — */
  {
    agent: 'planner',
    line: '# the work is done; look at what the session actually did',
    after: { notify: 'digestQ' },
    why: 'comments are traced but not executed',
  },
  { agent: 'planner', line: 'list', why: 'running + waiting calls (should be nearly empty by now)' },
  { agent: 'planner', line: 'list("all")', why: '…including everything that already settled' },
  { agent: 'planner', line: 'vars()', why: 'the handle table: which channel of each call carries data' },
  { agent: 'planner', line: 'inspect($benchA)', why: 'one call: args, deps, timings, progress notes' },
  { agent: 'planner', line: 'inspect($compB)', why: 'the failed call, with its error detail' },
  { agent: 'planner', line: 'inspect(@planner)', why: 'per-agent throughput, latency, wait/run split' },
  { agent: 'tuner', line: 'inspect(@tuner)', why: 'the same for the second agent' },
  { agent: 'planner', line: 'inspect()', why: 'the whole session: concurrency profile and notification lag' },
]

export default script
