# Getting started

fluvia is an asynchronous dataflow runtime for LLM agents, and a benchmark
harness built on its traces. An agent talks to fluvia one call per line and gets
results back as notifications, so a whole session is a small, replayable record:
what was typed, what settled, what woke the agent.

Node 24 or newer is required.

## Install

```sh
pnpm add -D @fluvia/cli @fluvia/toolbox-default
```

`@fluvia/cli` is the `fluvia` executable. `@fluvia/toolbox-default` is the
instruction set a fluvia command loads when `--preload` is not given — a
deterministic GPU-kernel pipeline — plus the recordings it is benchmarked
against and the cases that read them.

## The sixty-second run

```sh
npx fluvia bench .
```

`fluvia bench` discovers every `*.bench.ts` under the tree and runs it. Cases
that only replay a recording cost nothing, and the totals line says so. The
default toolbox ships cases over two recordings, so a fresh install has
something to run:

```
      case                                              subject                      same/div/miss  judges  wall
────  ────────────────────────────────────────────────  ───────────────────────────  ─────────────  ──────  ────
packages/cli/bench/takeover.bench.ts
pass  demo · planner taken over by a scripted stand-in  takeover planner · scripted  10/0/0         2/2     54ms
packages/toolbox-default/bench/preset.bench.ts
pass  preset · the summary turn, replayed               replay                       1/0/0          5/5     12ms
packages/toolbox-default/bench/replay.bench.ts
pass  demo · replay from line 9                         replay                       16/0/0         2/2     30ms
pass  demo · concurrency 2 reorders, outcomes hold      concurrency 2                16/0/0         2/2     25ms
pass  demo · opt 7 is rejected and recovered from       edit 10                      14/2/0         3/3     26ms

5 cases · 5 passed · 5 free (no model) · 0 model runs
```

An installed copy of the toolbox is its own smoke test:

```sh
fluvia bench node_modules/@fluvia/toolbox-default
```

## Talking to the runtime by hand

```sh
npx fluvia cli
```

One call per line, JS call syntax, no computation. Each line is answered
immediately with a call id and two handle names; the result arrives later as a
notification.

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
typed it. `defs` lists the loaded functions, `vars` the bound handles, `help`
the usage, and `.exit` closes the session once in-flight calls settle.

Add `--trace out/session.jsonl.gz` and the session becomes a recording you can
cut. See [the runtime](./runtime) for what the two handles mean and
[the CLI reference](../reference/cli) for every flag.

## Developing from a checkout

`pnpm` comes from corepack.

```sh
pnpm install
pnpm build       # compile every package to lib/, in dependency order
pnpm test        # boundary checks, the dsh plugin, the browser app
npx fluvia bench . # the bench cases
pnpm demo        # drive the CLI as a scripted pair of agents → out/<session>.jsonl.gz
pnpm demo-perf   # render the newest trace to out/perf.html and serve it
pnpm slice page  # build the interactive slice page from the newest trace
```

`pnpm demo` is not an in-process simulation: it spawns the CLI as a real child
process and speaks the NDJSON protocol to it over stdin/stdout.

`pnpm typecheck` runs `tsc --noEmit` across the workspace. The documentation
site is built from this same checkout:

```sh
pnpm docs:dev      # local preview with hot reload
pnpm docs:build    # static site into docs/.vitepress/dist; pnpm site:build assembles demo + docs into site/
pnpm docs:preview  # serve what docs:build produced
```

## Status

`0.0.1-alpha.1`. The runtime, tracing, slicing, replay, cases and `fluvia bench`
work and are covered by the checks above. Not there yet: snapshots at
notifications instead of replay-from-start, cached model judges, `pass^k`
reporting across runs, and a takeover driver for a hosted model in the box.
