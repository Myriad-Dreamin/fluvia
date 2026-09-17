<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/wordmark-dark.svg">
    <img alt="fluvia" src="docs/public/wordmark-light.svg" width="236">
  </picture>
</p>

<p align="center">
  Record an agent run once. Cut it anywhere. Swap one piece. Score the difference.<br>
  No tokens are spent until you ask for them.
</p>

<p align="center">
  <a href="https://myriad-dreamin.github.io/fluvia/guide/getting-started">Get started</a> ·
  <a href="https://myriad-dreamin.github.io/fluvia/guide/how-it-works">How it works</a> ·
  <a href="https://myriad-dreamin.github.io/fluvia/guide/cases">Writing cases</a> ·
  <a href="https://myriad-dreamin.github.io/fluvia/reference/cli">CLI</a>
</p>

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

Four lines, four instant answers, three of them running at once. Every line
is in the trace, and so is what the agent was reacting to when it typed it.

## Why

**The agent never waits.** fluvia is an asynchronous dataflow runtime. An
agent submits one call per line and is answered at once with two handles: the
value and the error. Later lines pass handles onward, and that is the whole
dependency graph. Results come back as notifications. Nothing is polled, and
recovery is declared up front, since a branch that consumes an error handle
runs only if that error exists.

**A run is a small, replayable record.** Because everything crosses one thin
interface, a session is just its lines, its settlements and its wake-ups. A
trace can be restored to any line, any notification, or any model turn, on a
virtual clock: no real time passes, and thinking time is never charged.

**Change one thing, then score the world.** A benchmark case names a
recording, a cut and exactly one difference: a scheduler setting, an edited
line, a new implementation of one instruction, or a lane handed to another
agent. Judges are predicates over what the world became. The diff against the
recording is one judge among them, not the verdict.

## What you get

- **`fluvia bench .`** finds every `*.bench.ts` in a tree and runs it. Cases
  that only replay cost nothing, and the totals line says so.
- **Cases are TypeScript.** Node strips the types on import; no build step, no
  test framework, and a judge is any function of the world.
- **Slices from the command line.** `fluvia slice replay` cuts a recording,
  edits lines, changes concurrency, and diffs every call against what was
  recorded.
- **Two deployments.** `fluvia cli` for one trusted operator; `fluvia serve`
  puts the instruction set, scheduler and trace on the far side of a boundary
  the model cannot cross.
- **Agents in the loop.** A DeepSeek Harness plugin and a browser app on
  pi-web-ui drive the runtime, export runs as traces, and replay them without
  a model.
- **One runtime, two hosts.** `@fluvia/core` runs the same code in Node and
  in the browser.

## Sixty seconds

```sh
pnpm add -D @fluvia/cli @fluvia/toolbox-default
npx fluvia bench .
```

```
      case                                              subject          same/div/miss  judges  wall
────  ────────────────────────────────────────────────  ───────────────  ─────────────  ──────  ────
packages/toolbox-default/bench/replay.bench.ts
pass  demo · replay from line 9                         replay           16/0/0         2/2     39ms
pass  demo · concurrency 2 reorders, outcomes hold      concurrency 2    16/0/0         2/2     32ms
pass  demo · opt 7 is rejected and recovered from       edit 10          14/2/0         3/3     41ms

5 cases · 5 passed · 5 free (no model) · 0 model runs
```

The default toolbox ships its cases and recordings, so a fresh install has
something to run. Everything else, from the case API to the wire protocol and
the threat model, is in the [documentation](https://myriad-dreamin.github.io/fluvia/).

## Packages

| package | what |
| --- | --- |
| [`@fluvia/core`](packages/core) | the runtime, traces, slicing, replay and the case API |
| [`@fluvia/cli`](packages/cli) | the `fluvia` executable |
| [`@fluvia/toolbox-default`](packages/toolbox-default) | the default toolbox, its recordings and its cases |
| [`dsh-plugin-fluvia`](packages/dsh-plugin-fluvia) | the DeepSeek Harness plugin |
| [`pi-web-fluvia`](packages/pi-web-fluvia) | the browser app on pi-web-ui |

`0.0.1-alpha.1` · Apache-2.0
