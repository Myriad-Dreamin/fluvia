<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/wordmark-dark.svg">
    <img alt="fluvia" src="docs/public/wordmark-light.svg" width="236">
  </picture>
</p>

fluvia is an asynchronous dataflow runtime for LLM agents, and a benchmark
harness built on its recordings. The agent submits calls one line at a time
and never waits for results. Every session is recorded, can be cut at any
point, replayed on a virtual clock with one thing changed, and scored.

[Demo](https://myriad-dreamin.github.io/fluvia/) ·
[Documentation](https://myriad-dreamin.github.io/fluvia/docs/) ·
[Getting started](https://myriad-dreamin.github.io/fluvia/docs/guide/getting-started) ·
[Writing cases](https://myriad-dreamin.github.io/fluvia/docs/guide/cases) ·
[CLI reference](https://myriad-dreamin.github.io/fluvia/docs/reference/cli)

## Install

```sh
pnpm add -D @fluvia/cli @fluvia/toolbox-default   # Node >= 24
```

`@fluvia/toolbox-default` is a deterministic GPU-kernel pipeline used by the
examples below. Real deployments load their own toolbox with `--preload`.

## The runtime

An agent types JS call syntax, one call per line. Each line is acknowledged
immediately with a call id and two handles; the work runs in the background,
and the result arrives later as a notification.

```sh
fluvia cli --script pipeline.fl
```

```
→ c0 prepareKernel ⇒ kernel0, err0  [running]
→ c1 loadDataset ⇒ dataset1, err1  [running]
→ c2 compileKernel ⇒ kernel2, err2  [waiting: kernel0]
→ c3 benchmark ⇒ report3, err3  [waiting: kernel2, dataset1]
→ c4 explain ⇒ note4, err4  [waiting: err2]
← c0 prepareKernel done (wait 409µs, run 455ms) ⇒ kernel0 : Kernel 4096x4096 f32 matmul · 64x64 tiles · source (690 lines); err0 void
    now runnable: c2
← c1 loadDataset done (wait 94µs, run 608ms) ⇒ dataset1 : Dataset wikitext-103/train · 4 shards · 1800k rows · 0.92 GB; err1 void
← c2 compileKernel done (wait 457ms, run 1.4s) ⇒ kernel2 : Kernel gemm_4096_f32 compiled · opt 3 · 19.5 KiB cubin · 94% occupancy; err2 void
    now runnable: c3
← c4 explain skipped — c2 succeeded, so the error handle it consumes is void
← c3 benchmark done (wait 1.9s, run 1.7s) ⇒ report3 : Report gemm_4096_f32 on wikitext-103: 2.464 ms/iter · 55779 GFLOP/s · occ 94%; err3 void
```

| | |
| --- | --- |
| `→ c2 … ⇒ kernel2, err2 [waiting: kernel0]` | the ack: call `c2` binds a value handle and an error handle; it starts when `kernel0` is ready |
| `[running]` on `c0` and `c1` | independent calls start at once, up to `--concurrency` |
| `← c0 … done (wait 409µs, run 455ms)` | the notification: time queued and time executing, and what the handle now holds |
| `now runnable: c2` | what this settlement unblocked |
| `c4 explain skipped` | `c4` consumed `err2`; `c2` succeeded, so `err2` is void and `c4` never ran |

Exactly one of a call's two handles ever becomes ready. That is what makes
recovery declarative: `explain(err2)` is submitted next to the happy path and
runs only if `c2` fails. Control calls (`list`, `vars()`, `inspect(c2)`,
`cancel(c2)`) answer synchronously. `fluvia serve` runs the same runtime
behind a socket, so a sandboxed model can submit lines and read its own
results but cannot change the instruction set, see other agents' handles, or
stop the runtime.

## Recording and replay

`--trace out/session.jsonl.gz` records every line, acknowledgement,
settlement and notification. The recording shipped with the default toolbox
is one `fluvia demo` session:

| | |
| --- | --- |
| agents | 2 (`planner`, `tuner`) |
| lines typed | 35 |
| calls | 24: 17 done, 2 failed, 1 cancelled, 4 skipped |
| wall time | 6.6 s |
| trace | 357 events, 12 KB gzipped |

Each recorded line is stored with its anchor: the notification or earlier line
it was typed after. That is what makes a recording replayable without its
timestamps.

```
$ fluvia slice lines --trace packages/toolbox-default/traces/demo.jsonl.gz
  7  c7       after c3 +1.151ms      @planner explain(err3, { depth: "deep" })
  8  control  after c2 +17.068ms     @planner cancel(c4)
  9  c8       after c6 +0.618ms      @planner compileKernel(kernel0, { opt: 3, fastMath: true })
 10  c9       after c5 +0.601ms      @tuner compileKernel(kernel5, { opt: 3 })
```

`fluvia slice replay` restores a fresh runtime to the moment before a chosen
line and types the rest of the recording again on a virtual clock. The 6.6 s
session replays in about 45 ms. Every call is then compared with the
recording. Two things can be changed on the way:

```
$ fluvia slice replay --trace demo.jsonl.gz --from 9 --to 25 --concurrency 2
calls: 16 same, 0 diverged, 0 missing
  notification order for tuner changed:
      recorded … c15 flakyProbe, c17 flakyProbe, c18 explain, c20 tune …
      replayed … c15 flakyProbe, c18 explain, c17 flakyProbe, c20 tune …
```

Halving the scheduler's concurrency changes the order the agents were notified
in but no outcome. Editing a line does change outcomes, and the report shows
exactly which:

```
$ fluvia slice replay --trace demo.jsonl.gz --from 9 --to 25 \
    --edit '10=@tuner compileKernel(kernel5, { opt: 7 })'
calls: 14 same, 2 diverged, 0 missing
  diverged line 10 tuner compileKernel
      summary: KernelCompileError: compileKernel: fp8 tensor cores are not implemented on sm80 (Ampere)
             → UnsupportedOptLevel: compileKernel: opt 7 is outside the supported range 0..3
  diverged line 12 tuner recover
      summary: Note recovery for KernelCompileError: lower the dtype to one the arch supports, …
             → Note recovery for UnsupportedOptLevel: recompile at opt 3 (confidence 73%)
```

The second divergence is `recover(err9)`, which consumed the edited call's
error handle and therefore produced a different note. No model is involved in
a replay, so every divergence it reports comes from the harness, the toolbox
or the edit.

## Benchmark cases

A case is a `*.bench.ts` file: a recording, a cut, one change, and judges
that decide whether the result is acceptable. Node strips the types on
import, so there is no build step.

```ts
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

```
$ fluvia bench .
      case                                              subject                      same/div/miss  judges  wall
────  ────────────────────────────────────────────────  ───────────────────────────  ─────────────  ──────  ────
packages/cli/bench/takeover.bench.ts
pass  demo · planner taken over by a scripted stand-in  takeover planner · scripted  10/0/0         2/2     49ms
packages/toolbox-default/bench/preset.bench.ts
pass  preset · the summary turn, replayed               replay                       1/0/0          5/5     12ms
packages/toolbox-default/bench/replay.bench.ts
pass  demo · replay from line 9                         replay                       16/0/0         2/2     28ms
pass  demo · concurrency 2 reorders, outcomes hold      concurrency 2                16/0/0         2/2     26ms
pass  demo · opt 7 is rejected and recovered from       edit 10                      14/2/0         3/3     27ms

5 cases · 5 passed · 5 free (no model) · 0 model runs
```

| field | values |
| --- | --- |
| `trace` | a `.jsonl` / `.jsonl.gz` written by `--trace`, or a `trace.json` exported from the browser app |
| `cut` | `{ line: 9 }`, `{ notify: 'c7' }` (the line typed after `c7` settled), `{ turn: 3 }` (a model turn, for browser traces) |
| `subject` | `{ concurrency }`, `{ edits }`, `{ call: { compileKernel: impl } }` to swap an implementation, `{ takeover: { lane, driver } }` to hand one lane to an agent while the others replay |
| `horizon` | `'complete'`, or `{ reach: ['c9 done', 'digest9 ready'] }` to stop early |
| `judge` | `judges.outcomes`, `settled`, `handleReady`, `order`, `failed`, `count`, or any function of `{ report, calls, handles, events, trace }` |

`same/div/miss` counts the recorded calls of the slice: settled as recorded,
settled differently, never made. Exit code 1 if a case fails, 2 if a file
fails to load. `--json` prints the results and `--filter` selects by name.

A takeover driver receives the lane's transcript up to the cut, submits lines,
and is woken with notifications; virtual time advances only between its
turns, so model latency is never measured. The shipped takeover case uses a
scripted stand-in and costs nothing. A driver that samples a model is yours
to supply; the totals line counts those runs separately.

## Browser app

`packages/pi-web-fluvia` is a chat UI on [pi-web-ui](https://github.com/badlogic/pi-mono)
whose agent drives `@fluvia/core` inside the page: a live runtime, or a
recording cut at a line with one lane handed to the model. A run exports as
`trace.json` from the console and replays without a model, in the browser or
with `pnpm replay`. The DeepSeek Harness plugin in
`packages/dsh-plugin-fluvia` does the same over a socket to `fluvia serve`.

## Packages

| package | contents |
| --- | --- |
| [`@fluvia/core`](packages/core) | parser, scheduler, handles, notifications, trace format, slicing, replay, case API; Node and browser |
| [`@fluvia/cli`](packages/cli) | `fluvia bench`, `slice`, `cli`, `serve`, `connect`, `demo`, `perf` |
| [`@fluvia/toolbox-default`](packages/toolbox-default) | the example toolbox, its recordings and its cases |
| [`dsh-plugin-fluvia`](packages/dsh-plugin-fluvia) | DeepSeek Harness plugin (not published yet) |
| [`pi-web-fluvia`](packages/pi-web-fluvia) | the browser app (not published) |

## Development

```sh
pnpm install && pnpm build
pnpm test            # boundary checks, dsh plugin, browser app
npx fluvia bench .   # the cases
pnpm demo            # record a session into out/
pnpm docs:dev        # the documentation site
```

Apache-2.0
