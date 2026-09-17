# Packages

Five packages in one pnpm workspace. Three publish to npm; two do not, yet.

| package | what | published |
| --- | --- | --- |
| [`@fluvia/core`](#fluvia-core) | the runtime, traces, slicing, replay and the case API | yes |
| [`@fluvia/cli`](#fluvia-cli) | the `fluvia` executable | yes |
| [`@fluvia/toolbox-default`](#fluvia-toolbox-default) | the default instruction set, its recordings and its cases | yes |
| [`dsh-plugin-fluvia`](#dsh-plugin-fluvia) | the DeepSeek Harness plugin | not yet |
| [`pi-web-fluvia`](#pi-web-fluvia) | the browser app | not yet |

Everything is Apache-2.0 and requires Node >= 24.

## `@fluvia/core`

The fluvia runtime. An agent writes one JS-syntax call per line; the runtime
parses it, binds two variables to the call's two channels, answers immediately,
and delivers the result later as a notification.

Nothing here imports `node:*` at module top except the trace reader/writer, so
the same runtime runs in Node and in a browser.

| subpath | what it is |
| --- | --- |
| `@fluvia/core/types` | the contract: call, handle, notification, trace event |
| `@fluvia/core/parser` | one line → one call |
| `@fluvia/core/dispatch` | the single path every submitted line takes |
| `@fluvia/core/describe` | values → type + summary |
| `@fluvia/core/trace` | gzip JSONL trace writer and reader (Node only) |
| `@fluvia/core/protocol` | the wire types shared by server and client |
| `@fluvia/core/format` | every string an agent reads |
| `@fluvia/core/session` | the read–submit–answer loop |
| `@fluvia/core/plugins/registry` | the functions an agent may call |
| `@fluvia/core/plugins/env` | handle bindings, shared by every agent |
| `@fluvia/core/plugins/scheduler` | dependency resolution, concurrency, cancellation, skips |
| `@fluvia/core/plugins/notify` | the notification hub |
| `@fluvia/core/plugins/notify-dsh` | the DeepSeek Harness envelope handler |
| `@fluvia/core/plugins/processes` | the child-process supervisor |
| `@fluvia/core/plugins/inspect` | the control calls |
| `@fluvia/core/bench/clock` | the virtual clock |
| `@fluvia/core/bench/runtime` | an in-memory runtime with no filesystem |
| `@fluvia/core/bench/slice` | index a recorded trace and cut it at a line |
| `@fluvia/core/bench/session` | replay a slice, or hand one lane to an agent |
| `@fluvia/core/bench/load` | a recording — `.jsonl(.gz)` or a pi-web `trace.json` — as a sliceable trace |
| `@fluvia/core/bench/case` | `defineBench`, `judges`, `runCase`: a slice with a verdict |

Dependencies: `@deepseek-ai/cordis`, `acorn`. Turning a module specifier into
registered functions lives in `@fluvia/cli`, not here.

## `@fluvia/cli`

The `fluvia` executable, and the only package with a `bin`.

| command | what it does |
| --- | --- |
| `fluvia cli` | single-process REPL: the whole runtime in one trusted process |
| `fluvia serve` | run the runtime outside the sandbox and listen for clients |
| `fluvia connect` | thin client for a running `fluvia serve` |
| `fluvia demo` | drive the CLI as a scripted pair of agents and record a trace |
| `fluvia perf` | render a trace as a self-contained HTML report and serve it |
| `fluvia dsh-inbox` | receive `dsh:http:<url>` envelopes and watch them live |
| `fluvia bench` | run every `*.bench.ts` case in a tree and report pass or fail |
| `fluvia slice` | cut a recorded session: `lines`, `replay`, `export`, `page` |

It also exports a little:

| subpath | what it is |
| --- | --- |
| `@fluvia/cli` | `main(argv)`, the subcommand table |
| `@fluvia/cli/client` | the reference client for `fluvia serve` |
| `@fluvia/cli/preload` | turning a module specifier into registered functions |

`fluvia serve` and `fluvia cli` load `@fluvia/toolbox-default` unless
`--preload <module>` says otherwise; that flag is the whole instruction set, and
it is not reachable over the wire. Every command is in [the CLI reference](./cli).

## `@fluvia/toolbox-default`

The toolbox a fluvia command loads when `--preload` is not given: a deterministic
GPU-kernel pipeline — prepare, compile, load, benchmark, summarize — with
realistic latencies and failure modes.

```ts
import toolbox from '@fluvia/toolbox-default'
```

The default export is a `FunctionDef[]`; every function is also a named export.
`@fluvia/toolbox-default/process` is a separate, opt-in toolbox exposing
`exec(command, [args], { cwd })` — it runs whatever the agent names, so it is
never preloaded by default.

The package ships the recordings this toolbox is benchmarked against (`traces/`)
and the cases that read them (`bench/`), so an installed copy is its own smoke
test:

```sh
fluvia bench node_modules/@fluvia/toolbox-default
```

## `dsh-plugin-fluvia`

A DeepSeek Harness plugin: a `fluvia` tool for the model, and envelopes delivered
into its turn, over a socket to a runtime outside the sandbox. It ships
`fluvia.yml`, the patch overlay dsh loads it with.

Peer dependencies on `@deepseek-ai/cordis`, `dsh-agent`, `dsh-llm` and
`dsh-tools`; it is loaded as built JS, so `pnpm build` must have run. Not
published. See [DeepSeek Harness](../guide/dsh).

## `pi-web-fluvia`

A pi agent driving `@fluvia/core` entirely in the browser: a live in-page runtime,
or a benchmark slice resumed from a recording. It records runs as `trace.json`
and replays them without a model.

Not published; run it from a checkout with `pnpm --filter pi-web-fluvia dev`. Its
`pnpm verify` is the headless check CI runs, and `pnpm replay <trace.json>` plays
an exported record back in Node. See [the browser app](../guide/pi-web).

## Workspace checks

```sh
pnpm build       # compile every package to lib/, in dependency order
pnpm typecheck   # tsc --noEmit across the workspace
pnpm test        # boundary checks, the dsh plugin, the browser app
npx fluvia bench . # the bench cases
```

`pnpm test` is `pnpm test:boundary` (a real client attacking a real
`fluvia serve`), then `dsh-plugin-fluvia`'s `verify`, then `pi-web-fluvia`'s.
