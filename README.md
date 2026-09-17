# fluvia

A fully asynchronous **dataflow CLI for LLM agents**. An agent writes one
JS-syntax call per line; the CLI parses it, binds two variables to the call's
two channels, and answers immediately — it never blocks on the work. Results
come back later as notifications. Later lines reference earlier handles by name,
which is how a dependency graph gets built without the agent ever awaiting
anything.

It is built on [cordis](https://github.com/cordiverse/cordis) — the
`@deepseek-ai/cordis` build — and follows the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
plugin architecture: everything is a plugin
over a shared `Context`, services are injected by name, and each plugin owns
exactly one concern.

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

Four lines, four instant answers, three of them running at once.

## The design in brief

**Calls → handles → notifications.** A submitted call is acknowledged with a
call id and two variable names, then scheduled. When it settles the runtime
builds a `Notification` and hands it to every registered sink. The agent is
never asked to wait or to poll.

**Two channels per call.** Call `seq = n` binds `<out><n>` (the value channel,
where `out` is declared by the function) and `err<n>` (the error channel).
Exactly one of the two ever becomes `ready`; the other becomes `void`. That is
what makes recovery declarative: `explain(err3)` is submitted at the same time
as the happy path and runs only if `c3` failed.

**Skip semantics.** Passing a handle makes the consuming call wait for it. If
the handle turns `void` instead of `ready`, the consumer is **skipped** with a
reason — `upstream_failed`, `upstream_ok`, `upstream_cancelled` or
`upstream_skipped` — and its own handles turn void in turn. Skips cascade, so a
failed root never leaves dangling work and the agent never cleans up by hand.

**Two deployments.** `fluvia cli` gives one trusted operator the whole runtime.
`fluvia serve` puts the runtime — the instruction set, the scheduler and the
trace — on the far side of a trust boundary from the model that drives it: the
sandboxed side may submit lines and read its own results, and nothing else. The
second shape is the one that matters when the model can rewrite everything
around it.

```sh
# outside the sandbox: the instruction set and the work
fluvia serve --listen unix:/run/fluvia.sock --preload @fluvia/toolbox-default --trace out/serve.jsonl.gz
# inside it: a client that can only ask
fluvia connect --connect unix:/run/fluvia.sock --label planner
```

Full contract: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**. What the boundary is
worth, and what it is not: **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)**
(`pnpm test:boundary` checks each property as an attempted attack).

## Quickstart

> **Node >= 24 is required** — the packages are compiled with `tsc` before they
> run, and the runtime uses the global `fetch` and modern `AbortSignal` APIs. On
> this machine `pnpm` comes from corepack on node v24:
> `export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"`.

```sh
pnpm install
pnpm build       # compile every package to lib/, in dependency order
pnpm demo        # drive the CLI as a scripted pair of agents → out/<session>.jsonl.gz
pnpm demo-perf   # render the newest trace to out/perf.html and serve it
pnpm dsh-inbox   # optional: receive `fluvia-dsh` envelopes over http and watch them live
```

To watch the notification side while a session runs, start the inbox first and
point the demo at it — the same envelopes then go to the file sink *and* over
http, which is the transport a real dsh deployment uses:

```sh
pnpm dsh-inbox --port 7788 --log out/inbox.jsonl     # http://127.0.0.1:7788/
FLUVIA_DSH_HTTP=http://127.0.0.1:7788/inbox pnpm demo
```

`pnpm demo` is not an in-process simulation: it spawns the CLI as a real child
process and speaks the NDJSON protocol to it over stdin/stdout, so everything it
proves is proved across a process boundary. `pnpm demo-perf` reads the trace the
demo wrote and serves a self-contained report on `http://127.0.0.1:<port>`.

To drive it yourself:

```sh
pnpm cli --notify dsh --trace out/session.jsonl.gz
```

## CLI

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
`dsh:http:<url>`.

## The `fluvia-dsh` handler

A raw sink interrupts an agent turn once per settled call, which wrecks an
agent's attention when eight calls land in the same second. `fluvia-dsh`
(`@fluvia/core/plugins/notify-dsh`) coalesces notifications inside a short sliding
window, splits them per agent, ranks them by what is now actionable, and renders
**one** envelope:

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

It ships three transports — `stdout`, JSONL `file` and `http` — and is also a
cordis plugin (`dshNotifier`, `inject: ['notify']`) for deployments that wire
the hub themselves. See **[docs/dsh-integration.md](docs/dsh-integration.md)**
for the transports, the JSON record shape, how a dsh plugin forwards envelopes
into an agent turn, and the MVP limits.

## The skill

`skills/fluvia/SKILL.md` teaches an agent to *use* fluvia: the call syntax and
its restrictions, the two handles, chaining, error-channel recovery, the control
calls, the `@agent` prefix — and the working habits that make the async model
pay off (fire independent calls immediately, never poll, pass handles rather
than values, cancel work you no longer need). It works unchanged in dsh
(`.dsh/skills/fluvia/`) and in Claude Code (`.claude/skills/fluvia/`).

## Benchmark slices

A recorded trace doubles as a benchmark. `@fluvia/core/bench` cuts it at a line,
restores a fresh runtime to the moment before that line on a virtual clock, and
continues the slice one of two ways:

- **Mechanical replay.** Every recorded line is typed again on its anchor, the
  notification or line it was typed after, and each call is diffed against the
  recording. No model is involved, so any divergence belongs to the harness:
  concurrency, scheduling, a toolbox that reads the wall clock, or a line you
  edited on purpose.
- **Agent resumes.** One agent's lane is handed to a live agent at the cut,
  while the other lanes keep replaying and consume what it produces. Virtual
  time only moves between the agent's turns.

```sh
pnpm bench lines  --trace out/<session>.jsonl.gz
pnpm bench replay --trace out/<session>.jsonl.gz --from 9 --to 25 --concurrency 2 \
                  --edit '10=@tuner compileKernel(kernel5, { opt: 7 })'
pnpm bench:page   # builds out/bench-page/index.html, the interactive demo of both modes
```

## The trace

`--trace out/<session>.jsonl.gz` writes a gzip JSONL stream, one event per line,
schema in `@fluvia/core/types` (`TraceEvent`). The first line is always
`session.start` carrying the `TraceMeta` header; read it back with `readTrace()`
from `@fluvia/core/trace`.

Events: `session.start`, `agent.join`, `agent.input`, `cli.output`,
`call.submit`, `call.queued`, `call.start`, `call.progress`, `call.settle`,
`call.cancel`, `handle.settle`, `notify.emit`, `notify.deliver`, `session.end`.
`call.queued` fires when a call's dependencies are ready and it starts waiting
for a concurrency slot, which is what separates dataflow wait from scheduler
pressure in the report.

The trace records the **human** rendering of every output even in `--json` mode,
so the perf report always has a readable transcript alongside the timings.

## Layout

| package | concern |
| --- | --- |
| `packages/core/` | **`@fluvia/core`** — the runtime, in Node and in the browser alike: `types.ts` (call, handle, notification, trace), `parser.ts` (one line → one call), `dispatch.ts` (the one path every line takes), `describe.ts` (values → type + summary), `trace.ts` (gzip JSONL writer and reader), `protocol.ts` (the wire types), `format.ts` (every string an agent reads), `session.ts` (the read–submit–answer loop) |
| `packages/core/src/plugins/` | one cordis plugin per concern: `registry` (the functions an agent may call), `env` (handle bindings, shared by every agent in the runtime), `scheduler` (dependency resolution, concurrency, cancellation, skip cascade), `notify` (the hub), `notify-dsh` (the dsh handler), `inspect` (the control calls) |
| `packages/core/src/bench/` | `fluvia bench`: trace slicing, the virtual clock, an in-memory runtime, and agent takeover |
| `packages/cli/` | **`@fluvia/cli`** — the `fluvia` executable: `cli/` (the REPL and `--notify` wiring), `server/` (`fluvia serve`: the runtime on the far side of the boundary — wire protocol, per-connection identity, admission and limits), `client/` (`fluvia connect`: the thin, untrusted client and its REPL), `demo/` (drives the CLI as two agents over the NDJSON protocol), `perf/` (trace → model → self-contained HTML report, plus the local server), `dsh-inbox/` (a standalone receiving end of `dsh:http:<url>`), `bench/` (the slice commands and the demo page in `page/`), `preload.ts` (module specifier → registered functions) |
| `packages/toolbox-default/` | **`@fluvia/toolbox-default`** — the toolbox loaded when `--preload` is not given: a deterministic GPU-kernel pipeline with realistic latencies and failures |
| `packages/dsh-plugin-fluvia/` | the real dsh plugin: receives the same envelopes inside a dsh process and delivers them into an agent turn, so they land in the dsh Web UI ([docs/dsh-ui.md](docs/dsh-ui.md)) |
| `packages/pi-web-fluvia/` | a pi agent driving `@fluvia/core` entirely in the browser: a live in-page runtime, or a benchmark slice resumed from a recording |
| `skills/fluvia/` | the agent-facing skill |
| `docs/` | the protocol and the dsh integration guide |
