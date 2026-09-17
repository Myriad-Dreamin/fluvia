# @fluvia/cli

The `fluvia` executable.

```sh
npx fluvia --help
```

| command | what it does |
| --- | --- |
| `fluvia cli` | single-process REPL: the whole runtime in one trusted process |
| `fluvia serve` | run the runtime outside the sandbox and listen for clients |
| `fluvia connect` | thin client for a running `fluvia serve` |
| `fluvia demo` | drive the CLI as a scripted pair of agents and record a trace |
| `fluvia perf` | render a trace as a self-contained HTML report and serve it |
| `fluvia dsh-inbox` | receive `dsh:http:<url>` envelopes and watch them live |
| `fluvia bench` | cut a recorded session into a slice: `lines`, `replay`, `export` |
| `fluvia bench-page` | build the interactive slice-bench page (needs a checkout) |
| `fluvia run` | run every `*.bench.ts` case in a tree and report pass or fail |

Each command takes `--help`.

`fluvia serve` and `fluvia cli` load
[`@fluvia/toolbox-default`](https://www.npmjs.com/package/@fluvia/toolbox-default)
unless `--preload <module>` says otherwise; that flag is the whole instruction
set, and it is not reachable over the wire.

MIT © 2026 Myriad-Dreamin
