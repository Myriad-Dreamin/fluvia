# fluvia

Record an agent run once. Cut it anywhere. Swap one piece. Score the difference.
No tokens are spent until you ask for them.

fluvia is an asynchronous dataflow runtime for LLM agents, and a benchmark
harness built on its traces. An agent talks to fluvia one call per line and
gets results back as notifications, so a whole session is a small, replayable
record: what was typed, what settled, what woke the agent. That record can be
restored to any point and continued with one thing changed: a different
scheduler setting, an edited line, a new implementation of one instruction, or
a lane handed to a different agent.

```
prepareKernel({ size: 4096, dtype: "f32" })
→ c0 prepareKernel ⇒ kernel0, err0  [running]
compileKernel(kernel0, { opt: 3 })
→ c1 compileKernel ⇒ kernel1, err1  [waiting: kernel0]
loadDataset({ name: "wikitext-103", shards: 4 })
→ c2 loadDataset ⇒ dataset2, err2  [running]
benchmark(kernel1, dataset2, { iters: 200 })
→ c3 benchmark ⇒ report3, err3  [waiting: kernel1, dataset2]

← c2 loadDataset done (wait 0ms, run 1.2s) ⇒ dataset2 : Dataset wikitext-103/train · 4 shards; err2 void
← c0 prepareKernel done (wait 0ms, run 214ms) ⇒ kernel0 : Kernel 4096x4096 f32 matmul; err0 void
    now runnable: c1
```

Four lines, four instant answers, three of them running at once. Every one of
those lines is in the trace, and so is what the agent was reacting to when it
typed it.

## Sixty seconds

```sh
pnpm add -D @fluvia/cli @fluvia/toolbox-default
npx fluvia run .
```

`fluvia run` discovers every `*.bench.ts` under the tree and runs it. Cases
that only replay a recording cost nothing, and the totals line says so. The
default toolbox ships four cases over two recordings, so a fresh install has
something to run:

```
      case                                              subject                      same/div/miss  judges  wall
────  ────────────────────────────────────────────────  ───────────────────────────  ─────────────  ──────  ────
packages/cli/bench/takeover.bench.ts
pass  demo · planner taken over by a scripted stand-in  takeover planner · scripted  10/0/0         2/2     75ms
packages/toolbox-default/bench/preset.bench.ts
pass  preset · the summary turn, replayed               replay                       1/0/0          5/5     16ms
packages/toolbox-default/bench/replay.bench.ts
pass  demo · replay from line 9                         replay                       16/0/0         2/2     39ms
pass  demo · concurrency 2 reorders, outcomes hold      concurrency 2                16/0/0         2/2     32ms
pass  demo · opt 7 is rejected and recovered from       edit 10                      14/2/0         3/3     41ms

5 cases · 5 passed · 5 free (no model) · 0 model runs
```

## How it works

```
 record ──▶ cut ──▶ swap one piece ──▶ run ──▶ score
 trace      line 9   concurrency         virtual   judges over the world,
            turn 3   an edited line      clock     then a diff against
            notify   a call's impl                 the recording
                     a lane's agent
```

1. **Record.** Any run produces a trace: every line, every settlement, every
   notification, and for a chat-driven run the conversation too. Export one
   from the CLI (`--trace`), from the browser app, or from the dsh plugin.
2. **Cut.** Pick a line, a notification, or a model turn. The runtime is
   restored to the moment before it. Everything earlier is replayed on a
   virtual clock, each line anchored to the result it was reacting to, so
   causal order survives and no real time passes.
3. **Swap one piece.** A case changes exactly one thing. Everything else stays
   as recorded.
4. **Run.** Only the part after the cut executes. A mechanical replay types the
   recorded lines again. A takeover hands one lane to a driver, which may be a
   model, while the other lanes replay around it and consume what it produces.
5. **Score.** Judges are predicates over the resulting world: which calls
   settled how, which handles are ready, what a digest folds. The diff against
   the recording is one judge among them, not the verdict.

## A case

Cases are TypeScript. Node strips the types on import, so there is no build
step and no test framework.

```ts
// packages/toolbox-default/bench/replay.bench.ts — one of the three it exports
import { defineBench, judges } from '@fluvia/core/bench/case'
import type { World } from '@fluvia/core/bench/case'

function recoveryNamesTheNewError(world: World): string | true {
  const note = world.handles.find((handle) => handle.name === 'note11')
  if (!note) return 'note11 was never bound'
  if (note.state !== 'ready') return `note11 is ${note.state}: recover() did not run`
  if (!note.summary?.includes('UnsupportedOptLevel')) return `note11 does not mention the new error: ${note.summary}`
  return true
}

export default defineBench({
  name: 'demo · opt 7 is rejected and recovered from',
  trace: '../traces/demo.jsonl.gz',
  cut: { line: 9 },
  subject: { edits: { 10: '@tuner compileKernel(kernel5, { opt: 7 })' } },
  judge: [judges.failed('c9', 'UnsupportedOptLevel'), judges.outcomes({ diverged: 2, missing: 0 }), recoveryNamesTheNewError],
})
```

This case edits one recorded line to something the toolbox rejects, then
asserts the whole consequence: the compile fails with that specific error,
exactly two calls diverge from the recording (the compile and the `recover()`
downstream of its error handle), and the note that recovery produced names the
new error rather than the recorded one.

| field | what it takes |
| --- | --- |
| `trace` | a `.jsonl` or `.jsonl.gz` written by `--trace`, or a `trace.json` exported from the browser app |
| `cut` | `{ line: 9 }`, `{ notify: 'c7' }` (the line typed after c7 settled), or `{ turn: 3 }` (the first line the third model turn submitted) |
| `subject` | one of `{ concurrency }`, `{ edits }`, `{ call: { name: impl } }`, `{ takeover: { lane, driver } }`; omit for a plain replay |
| `horizon` | `'complete'`, or `{ reach: ['c9 done', 'digest9 ready'] }` to stop early and fail if never reached |
| `judge` | `judges.outcomes`, `settled`, `handleReady`, `order`, `failed`, `count`, or any function of `{ report, calls, handles, events, trace }` |
| `runs` | repeat a takeover and report how many passed |

A takeover driver receives `{ transcript, state, submit, wake, goal }`: what
the lane saw up to the cut, what it can submit, and a `wake()` that advances
virtual time until the lane has notifications. The shipped takeover case uses
a scripted stand-in and spends nothing; a driver that samples a model declares
it, and the totals line counts those runs separately.

```sh
npx fluvia run .                  # every *.bench.ts under the tree
npx fluvia run . --filter preset  # only files or cases whose name contains it
npx fluvia run . --json           # { cases, errors, summary }
```

Exit code 1 when a case fails, 2 when a file could not be loaded. The other
files still run.

## The runtime

**Calls, handles, notifications.** A submitted call is acknowledged with a
call id and two variable names, then scheduled. When it settles the runtime
builds a notification and hands it to every registered sink. The agent is
never asked to wait or to poll.

**Two channels per call.** Call `seq = n` binds `<out><n>` (the value channel,
where `out` is declared by the function) and `err<n>` (the error channel).
Exactly one of the two ever becomes `ready`; the other becomes `void`. That is
what makes recovery declarative: `explain(err3)` is submitted at the same time
as the happy path and runs only if `c3` failed.

**Skip semantics.** Passing a handle makes the consuming call wait for it. If
the handle turns `void` instead of `ready`, the consumer is skipped with a
reason (`upstream_failed`, `upstream_ok`, `upstream_cancelled` or
`upstream_skipped`) and its own handles turn void in turn. Skips cascade, so a
failed root never leaves dangling work.

**Two deployments.** `fluvia cli` gives one trusted operator the whole runtime.
`fluvia serve` puts the runtime (the instruction set, the scheduler, the trace)
on the far side of a trust boundary from the model that drives it: the
sandboxed side may submit lines and read its own results, and nothing else.
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) says what that boundary is worth.

**Plugins.** The runtime is built on [cordis](https://github.com/cordiverse/cordis)
(the `@deepseek-ai/cordis` build) in the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) style:
one plugin per concern over a shared `Context`, services injected by name.

## Developing

Node >= 24. `pnpm` comes from corepack.

```sh
pnpm install
pnpm build       # compile every package to lib/, in dependency order
pnpm test        # boundary checks, the dsh plugin, the browser app
npx fluvia run . # the bench cases
pnpm demo        # drive the CLI as a scripted pair of agents → out/<session>.jsonl.gz
pnpm demo-perf   # render the newest trace to out/perf.html and serve it
pnpm bench:page  # build the interactive slice page from the newest trace
```

`pnpm demo` is not an in-process simulation: it spawns the CLI as a real child
process and speaks the NDJSON protocol to it over stdin/stdout.

### `fluvia cli`

```
fluvia cli [options]
  --agent <id>         default agent for unprefixed lines (default: a0)
  --preload <path>     toolbox module, repeatable (default: @fluvia/toolbox-default)
  --trace <file>       write the gzip JSONL trace (default: none)
  --concurrency <n>    max simultaneously running calls (default: 4)
  --notify <spec>      sink, repeatable (default: stdout)
  --script <file>      read lines from a file instead of stdin
  --session <id>       session id; otherwise derived from --trace
  --json               stdout becomes NDJSON (machine mode) instead of human text
  --quiet              suppress the startup banner (answers are still printed)
```

Sink specs: `stdout`, `file:<path>`, `dsh`, `dsh:stdout`, `dsh:file:<path>`,
`dsh:http:<url>`. `fluvia bench lines|replay|export` cuts and replays a trace
from the command line without a case file; `fluvia --help` lists the rest.

### The `fluvia-dsh` handler

A raw sink interrupts an agent turn once per settled call, which wrecks an
agent's attention when eight calls land in the same second. `fluvia-dsh`
(`@fluvia/core/plugins/notify-dsh`) coalesces notifications inside a short
sliding window, splits them per agent, ranks them by what is now actionable,
and renders one envelope:

```
<fluvia-notify agent="a0" session="s-20260915-174233">
4 calls settled within 1.2s — 2 ready, 1 failed, 1 skipped.

ready
  c0 prepareKernel → kernel0 : Kernel 4096x4096 f32 matmul · 32x32 tiles (wait 0ms, run 214ms)
  c1 loadDataset → dataset1 : Dataset wikitext-103/train · 4 shards · 1.8 GB (wait 1ms, run 1.2s)

failed
  c2 flakyProbe → err2 : ProbeError — nvlink trial 2/3 tripped the threshold [retryable] (wait 0ms, run 310ms)
  → recover by passing a ready err handle to another call; work waiting on the value handle is already skipped.

skipped (never ran)
  c7 summarize — upstream_failed from c2; digest7 and err7 are both void.

now runnable
  c0 unblocked c3
  c2 unblocked c6
</fluvia-notify>
```

See [docs/dsh-integration.md](docs/dsh-integration.md) for the transports, the
JSON record shape and how the dsh plugin forwards envelopes into an agent turn.

### The trace

`--trace out/<session>.jsonl.gz` writes a gzip JSONL stream, one event per
line, schema in `@fluvia/core/types` (`TraceEvent`). The first line is
`session.start` with the `TraceMeta` header; read it back with `readTrace()`
from `@fluvia/core/trace`. Events: `session.start`, `agent.join`,
`agent.input`, `cli.output`, `call.submit`, `call.queued`, `call.start`,
`call.progress`, `call.settle`, `call.cancel`, `handle.settle`,
`process.spawn`, `process.exit`, `notify.emit`, `notify.deliver`,
`session.end`.

### The skill

`skills/fluvia/SKILL.md` teaches an agent to use fluvia: the call syntax and
its restrictions, the two handles, chaining, error-channel recovery, the
control calls, and the habits that make the async model pay off. It works
unchanged in dsh (`.dsh/skills/fluvia/`) and in Claude Code
(`.claude/skills/fluvia/`).

## Packages

| package | what |
| --- | --- |
| [`@fluvia/core`](packages/core) | the runtime (parser, scheduler, handles, notifications), traces, slicing, replay and the case API; runs in Node and in the browser |
| [`@fluvia/cli`](packages/cli) | the `fluvia` executable: `run`, `bench`, `cli`, `serve`, `connect`, `demo`, `perf`, `dsh-inbox`, `bench-page` |
| [`@fluvia/toolbox-default`](packages/toolbox-default) | the toolbox loaded when `--preload` is not given: a deterministic GPU-kernel pipeline with realistic latencies and failures, its recordings and its cases |
| [`dsh-plugin-fluvia`](packages/dsh-plugin-fluvia) | the DeepSeek Harness plugin: a `fluvia` tool for the model and envelopes delivered into its turn, over a socket to a runtime outside the sandbox |
| [`pi-web-fluvia`](packages/pi-web-fluvia) | a pi agent driving `@fluvia/core` entirely in the browser; records runs as `trace.json` and replays them without a model |

The last two are not published yet.

## Status

`0.0.1-alpha.1`. The runtime, tracing, slicing, replay, cases and `fluvia run`
work and are covered by the checks above. Not there yet: snapshots at
notifications instead of replay-from-start, cached model judges, `pass^k`
reporting across runs, and a takeover driver for a hosted model in the box.
