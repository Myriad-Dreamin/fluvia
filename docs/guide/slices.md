# Slices

`fluvia slice` cuts a recorded session and replays it from the command line,
without a case file. It is the tool for the question a case has not been written
for yet: what did this session actually do, and what changes if I change one
line of it?

```
fluvia slice lines  --trace <file>
fluvia slice replay --trace <file> --from <n> [--to <n>] [--concurrency <n>]
                    [--edit <n>=<line>]... [--json]
fluvia slice export --trace <file> --out <file.json>
fluvia slice page   [--trace <file>] [--out <file.html>]
```

`--trace` is required for `lines`, `replay` and `export`; without it the command
exits 2 with `slice: --trace <file> is required`; `fluvia slice --help` prints the
four subcommands.

## `lines`

Every recorded line, with its index, what it produced, and its **anchor**: the
event the agent was reacting to when it typed it, plus the gap that followed.

```sh
npx fluvia slice lines --trace packages/toolbox-default/traces/demo.jsonl.gz
```

```
  0  c0       +17.576ms              @planner prepareKernel({ size: 4096, dtype: "f32", arch: "sm90" })
  1  c1       after line 0 +6.199ms  @planner loadDataset({ name: "imagenet-mini", shards: 6 })
  2  c2       after line 1 +1.177ms  @tuner loadDataset({ name: "wikitext-103", shards: 4 })
  3  c3       after line 2 +0.866ms  @tuner flakyProbe({ target: "pcie-link", failRate: 1, trials: 3 })
  4  c4       after line 3 +1.127ms  @planner sleep({ ms: 9000, label: "cooldown" })
  5  c5       after line 4 +0.564ms  @tuner prepareKernel({ size: 16384, dtype: "fp8", arch: "sm80" })
  6  c6       after line 5 +0.974ms  @planner explain(err4, { depth: "short" })
  7  c7       after c3 +1.151ms      @planner explain(err3, { depth: "deep" })
  8  control  after c2 +17.068ms     @planner cancel(c4)
  9  c8       after c6 +0.618ms      @planner compileKernel(kernel0, { opt: 3, fastMath: true })
 10  c9       after c5 +0.601ms      @tuner compileKernel(kernel5, { opt: 3 })
 11  c10      after line 10 +0.947ms @tuner benchmark(kernel9, dataset2, { iters: 100 })
 12  c11      after line 11 +0.492ms @tuner recover(err9, { strategy: "auto" })
```

The second column is the call the line submitted, or `control` for a control
call such as `cancel(c4)`, or `noop` for a comment. Those indices are what
`cut: { line: n }` and `--from` mean.

## `replay`

Type the slice's recorded lines again on their anchors and diff the runtime's
answers against the recording, call by call.

```sh
npx fluvia slice replay --trace packages/toolbox-default/traces/demo.jsonl.gz --from 9
```

```
slice lines 9..34 · concurrency 4 · replayed in 59ms wall
calls: 16 same, 0 diverged, 0 missing

  line 33 different: @planner inspect()
  no divergence
```

Sixteen calls settled exactly as recorded. Line 33 is `inspect()`, whose output
reports the session's own timings, so it never reproduces verbatim — it is
reported as a differing line, not a diverged call.

The exit code is 1 when anything diverged or went missing, 0 otherwise, so a
replay is usable directly in a shell check.

### Editing lines

`--edit <n>=<line>` replaces a recorded line by index. Repeat it for more than
one.

```sh
npx fluvia slice replay --trace packages/toolbox-default/traces/demo.jsonl.gz --from 9 \
  --edit '10=@tuner compileKernel(kernel5, { opt: 7 })'
```

```
slice lines 9..34 · concurrency 4 · replayed in 51ms wall
calls: 14 same, 2 diverged, 0 missing

  diverged line 10 tuner compileKernel
      summary: KernelCompileError: compileKernel: fp8 tensor cores are not implemented on sm80 (Ampere)
             → UnsupportedOptLevel: compileKernel: opt 7 is outside the supported range 0..3
  diverged line 12 tuner recover
      summary: Note recovery for KernelCompileError: lower the dtype to one the arch supports, or retarget a newer …
             → Note recovery for UnsupportedOptLevel: recompile at opt 3 (confidence 73%)
  line 27 different: @planner list("all")
  line 28 different: @planner vars()
  line 30 different: @planner inspect(c9)
```

Two calls diverged: the compile the edit broke, and the `recover()` downstream of
its error handle, whose note now names the new error. That consequence is what
`packages/toolbox-default/bench/replay.bench.ts` turns into a case.

An edited line keeps its anchor. Editing a line that binds a differently named
handle changes every later line that consumed it, which is usually what makes a
divergence interesting rather than a mistake.

### Concurrency

`--concurrency <n>` replays the slice under a different scheduler limit; it
defaults to the recording's. Halving it on the demo trace reorders which lane is
notified first without changing a single outcome — the property
`judges.order('changed')` exists to assert.

### `--json`

`--json` prints the whole `SliceReport` instead of the rendered summary: `from`,
`to`, `concurrency`, `takeover`, the `totals`, per-call `diffs`, per-line
statuses and the per-lane notification `order`.

## `export`

```sh
npx fluvia slice export --trace packages/toolbox-default/traces/demo.jsonl.gz --out trace.json
```

```
357 events → trace.json
```

Plain JSON — the trace's events as an array, ungzipped — for a browser, a
notebook or anything that would rather not read gzip JSONL. It is what
`packages/pi-web-fluvia`'s `pnpm demo-trace` uses to refresh the trace the
browser app offers in its slice panel.

## `page`

```sh
pnpm slice page                   # the newest out/*.jsonl.gz
npx fluvia slice page --trace out/<session>.jsonl.gz --out out/bench-page/index.html
```

Builds the interactive slice page into one self-contained HTML file: the fluvia
runtime, the page, its stylesheet and the recorded trace are all inlined, and
only React loads from a CDN. Open it and you can move the cut, change the
concurrency, edit a line and watch the slice re-run in the browser.

It needs a fluvia checkout. esbuild reads the page's own sources from
`src/slice/page/`, and a published package ships only `lib/`, so the command
fails with `bench-page needs the page sources at …; run it from a fluvia
checkout` when those are not there.

For a slice a model continues rather than a replay, see
[the browser app](./pi-web).
