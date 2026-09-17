# CLI reference

```sh
npx fluvia --help
```

```
fluvia 0.0.1-alpha.1 — a fully asynchronous dataflow CLI for LLM agents

usage: fluvia <command> [options]

  cli        single-process REPL: the whole runtime in one trusted process
  serve      run the runtime outside the sandbox and listen for clients
  connect    thin client for a running `fluvia serve`
  demo       drive the CLI as a scripted pair of agents and record a trace
  perf       render a trace as a self-contained HTML report and serve it
  dsh-inbox  receive `dsh:http:<url>` envelopes and watch them live
  bench      run every `*.bench.ts` case in a tree and report pass or fail
  slice      cut a recorded session: lines | replay | export | page

Run `fluvia <command> --help` for a command's own options.
```

`fluvia --version` prints the version. An unknown command exits 2 with the usage.

## `fluvia cli`

The single-process REPL: one trusted operator, the whole runtime in one process.
Reads lines from stdin, or from `--script`.

```
fluvia cli [options]
  --agent <id>         default agent for unprefixed lines (default: a0)
  --preload <path>     toolbox module, repeatable (default: @fluvia/toolbox-default)
  --trace <file>       write the gzip JSONL trace (default: none)
  --concurrency <n>    max simultaneously running calls (default: 4)
  --notify <spec>      sink, repeatable (default: stdout)
  --script <file>      read lines from a file instead of stdin
  --session <id>       session id; otherwise derived from --trace
  --proc-dir <dir>     stdout/stderr logs of spawned processes (default: <tmpdir>/fluvia/<session>)
  --json               stdout becomes NDJSON (machine mode) instead of human text
  --quiet              suppress the startup banner (answers are still printed)
```

Sink specs: `stdout`, `file:<path>`, `dsh`, `dsh:stdout`, `dsh:file:<path>`,
`dsh:http:<url>`.

`fluvia cli --help` prints the agent-facing usage instead of the flag list — the
same text `help()` answers with:

```
fluvia — fully asynchronous dataflow CLI

One call per line, JS call syntax, no computation:
  prepareKernel({ size: 4096, dtype: "f32" })   → answers instantly with c0, kernel0, err0
  compileKernel(kernel0, { opt: 3 })            → waits for kernel0, then runs
  @tuner benchmark(kernel2, dataset1)           → submitted as agent "tuner"

Every call binds two handles: <out>N carries the value, errN carries the failure.
Exactly one of them becomes ready; the other becomes void. A call whose handle
turns void is skipped, so recovery paths (explain(err3)) and happy paths can both
be submitted up front.

Results arrive as notifications; do not poll for them.

Built-ins: list, list("all"), cancel(c3), inspect(), inspect(c3), inspect(@agent),
vars, defs, help. Type .exit to close the session.
```

## `fluvia serve`

The runtime on the far side of a trust boundary from the model that drives it.

```
fluvia serve — run the instruction set outside the model's reach

  --listen <addr>          unix:<path> (default) or tcp:<host>:<port>
  --preload <module>       toolbox module, repeatable; this IS the instruction set
  --concurrency <n>        implementations running at once, shared by every agent
  --trace <file>           gzip JSONL trace, written host-side
  --proc-dir <dir>         stdout/stderr logs of spawned processes (default <tmpdir>/fluvia/<session>)
  --token-file <path>      shared secret a client must present (mandatory for tcp:)
  --scope agent|runtime    handle namespace per agent (default) or shared
  --max-connections <n>    live connections (default 32)
  --max-in-flight <n>      unsettled calls per agent (default 32)
  --max-line-bytes <n>     longest submitted line (default 2048)
  --rate <n>               submissions per second per agent (default 20)
  --keep-on-disconnect     leave an agent's calls running when it drops
```

What those limits are worth, and what they do not cover, is
[the threat model](./threat-model).

## `fluvia connect`

The reference client for a running `fluvia serve` — useful for watching the wire
without a harness.

```
usage: fluvia connect [--connect <addr>] [--label <name>] [--token-file <p>] [--script <f>]
```

A client that reconnects with the same label is assigned the same agent id again
while no other connection holds it, so its handles survive the gap.

## `fluvia demo`

Drives the CLI as a scripted pair of agents — `planner` and `tuner` — and records
the session. It spawns the CLI as a real child process and speaks the NDJSON
protocol to it over stdin/stdout, so it exercises the machine mode as well as the
runtime. `fluvia demo --help` describes it; any other invocation runs the demo.

```sh
pnpm demo
```

```
[demo] fluvia session s-20260917-042103
[demo] cli /path/to/fluvia/packages/cli/bin/fluvia.js · concurrency 4 · trace out/s-20260917-042103.jsonl.gz

[cli] ready · session s-20260917-042103 · 17 functions preloaded

planner > prepareKernel({ size: 4096, dtype: "f32", arch: "sm90" })
        # root of the main chain

planner > loadDataset({ name: "imagenet-mini", shards: 6 })
        # independent of the kernel: runs in parallel with it

tuner > loadDataset({ name: "wikitext-103", shards: 4 })
        # second agent, same runtime

tuner > flakyProbe({ target: "pcie-link", failRate: 1, trials: 3 })
        # fails on purpose: gives the error channel something to carry

planner > sleep({ ms: 9000, label: "cooldown" })
        # long call, cancelled later while still running

tuner > prepareKernel({ size: 16384, dtype: "fp8", arch: "sm80" })
        # sixth ready call at concurrency 4: two of these queue
  ack c0   prepareKernel → kernel0/err0 [running]
  ack c1   loadDataset → dataset1/err1 [running]
  ack c2   loadDataset → dataset2/err2 [running]
  ack c3   flakyProbe → probe3/err3 [running]
  ack c4   sleep → tick4/err4 [queued]
```

It writes `out/<session>.jsonl.gz`, which is what `fluvia perf` and
`fluvia slice` read next.

## `fluvia perf`

```
fluvia perf — render a session trace as a self-contained HTML report

usage: fluvia perf [trace] [options]

  trace            path to a .jsonl.gz or .jsonl trace.
                   Default: the newest out/*.jsonl.gz (then out/*.jsonl).

  --port <n>       preferred port; incremented while busy (default: 7777)
  --no-open        do not try to launch a browser
  -h, --help       show this message

The report is written to out/perf.html and served until Ctrl-C.
```

## `fluvia dsh-inbox`

A standalone HTTP receiver for `--notify dsh:http:<url>` envelopes, which shows
them as they land.

```
usage: fluvia dsh-inbox [--port 7788] [--host 127.0.0.1] [--path /inbox] [--log <file>]
```

It is an alternative to the dsh plugin's `transport: connect`, not a layer under
it. See [DeepSeek Harness](../guide/dsh).

## `fluvia bench`

```
usage: fluvia bench [dir…] [options]

Run every `*.bench.ts` case under the given directories (default `.`).

  --filter <substr>  only files or cases whose path or name contains it
  --json             print { cases, errors, summary } instead of a table

Exit codes: 0 all passed, 1 a case failed, 2 a file or case could not be loaded.
```

A case file is any file matching `*.bench.{ts,mts,cts,js,mjs,cjs}`.
`node_modules`, `lib`, `dist`, `out` and `.git` are never walked. See
[writing cases](../guide/cases).

## `fluvia slice`

```
fluvia slice lines  --trace <file>
fluvia slice replay --trace <file> --from <n> [--to <n>] [--concurrency <n>]
                    [--edit <n>=<line>]... [--json]
fluvia slice export --trace <file> --out <file.json>
fluvia slice page   [--trace <file>] [--out <file.html>]
```

`fluvia slice --help` prints the four subcommands. Without
`--trace` it exits 2 with `slice: --trace <file> is required`.

| option | applies to | meaning |
| --- | --- | --- |
| `--trace <file>` | `lines`, `replay`, `export` | the recording: `.jsonl` or `.jsonl.gz` |
| `--from <n>` | `replay` | first recorded line of the slice (default 0) |
| `--to <n>` | `replay` | exclusive upper line bound (default: the end) |
| `--concurrency <n>` | `replay` | scheduler limit (default: the recording's) |
| `--edit <n>=<line>` | `replay` | replace a recorded line; repeatable |
| `--json` | `replay` | print the whole `SliceReport` instead of the summary |
| `--out <file>` | `export`, `page` | where to write |

`replay` exits 1 when anything diverged or went missing. `page` needs a fluvia
checkout, because it builds the page from sources a published package does not
ship. See [slices](../guide/slices).

## Machine mode (`--json`)

`fluvia cli --json` makes stdout NDJSON — one JSON object per line. This is what
the demo driver reads.

```jsonc
{"type":"ready","session":"s-…","agent":"a0","functions":["prepareKernel",…]}
{"type":"ack","call":"c0","seq":0,"fn":"prepareKernel","agent":"planner",
 "bind":{"value":"kernel0","error":"err0"},"deps":[],"state":"queued"}
{"type":"error","message":"unknown function: prepareKernl","line":"…"}
{"type":"control","fn":"list","text":"…","rows":[…]}
{"type":"log","level":"error","agent":"","text":"✗ preload …"}  // CLI-level notice
{"type":"result", …Notification }     // one per settled call, any agent
{"type":"bye","stats":{…}}
```

Human mode prints the same information as terminal text. **Either way the trace
records the human rendering**, so the perf report always has a readable
transcript.

## Workspace scripts

A checkout wires the same commands to `pnpm` scripts:

| script | command |
| --- | --- |
| `pnpm cli` | `fluvia cli` |
| `pnpm serve` | `fluvia serve` |
| `pnpm connect` | `fluvia connect` |
| `pnpm demo` | `fluvia demo` |
| `pnpm demo-perf` | `fluvia perf` |
| `pnpm dsh-inbox` | `fluvia dsh-inbox` |
| `pnpm bench` | `fluvia bench` |
| `pnpm slice` | `fluvia slice` |
