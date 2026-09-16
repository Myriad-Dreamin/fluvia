# Fluvia protocol (MVP)

Fluvia is a **fully asynchronous dataflow runtime behind a CLI**. An LLM agent
writes one JS-syntax call per line. The CLI parses it, binds two variables to
the call's two channels, and answers immediately — it never blocks on the work.
Results come back later as **notifications**. Later lines reference earlier
handles by name, which is how a dependency graph gets built without the agent
ever awaiting anything.

Architecture follows DeepSeek Harness (`dsh`): everything is a cordis plugin
over a shared `Context`, services are injected by name, and each plugin owns one
concern.

## 1. Call syntax

One call per line, JS call syntax, **no computation**: no operators, no arrow
functions, no member access, no nesting of calls. Only a callee identifier and
arguments made of literals, arrays, objects and handle identifiers.

```
prepareKernel({ size: 4096, dtype: "f32" })    # ok
compileKernel(kernel0, { opt: 3 })             # ok — kernel0 is a handle
runKernel(prepareKernel())                     # rejected: nested call
compileKernel(kernel0, { opt: 1 + 2 })         # rejected: operator
```

Line prefixes:

| form | meaning |
| --- | --- |
| `fn(args)` | call submitted by the CLI's default agent (`--agent`, default `a0`) |
| `@planner fn(args)` | call submitted by agent `planner` (multiplexing: several agents, one runtime) |
| `list` | a zero-arg call may drop its parentheses |
| `# text` | comment, traced but not executed |
| `.exit` | close the session after in-flight calls settle |

## 2. Handles

Every async call `seq = n` binds exactly two variables:

- `<out><n>` — the **value channel**, where `out` is declared by the function
  (`prepareKernel` declares `out: "kernel"`, so seq 0 binds `kernel0`).
- `err<n>` — the **error channel**.

Exactly one of the two ever becomes `ready`; the other becomes `void`.

Passing a handle makes the consuming call wait for it:

- value handle ready → consumer runs with the payload substituted;
- value handle void (producer failed/cancelled/skipped) → consumer is
  **skipped** (`upstream_failed` / `upstream_cancelled` / `upstream_skipped`);
- error handle ready → consumer runs with the error payload — this is how
  recovery paths are written: `explain(err3)`;
- error handle void (producer succeeded) → consumer is **skipped**
  (`upstream_ok`).

Skips cascade, so a failed root never leaves dangling work.

The payload a consumer receives depends on the channel it read: a value handle
delivers whatever the implementation returned, and an error handle delivers the
flattened `CallError` (`{ kind, message, detail?, retryable? }`, plus `$type` and
`$summary` for display). So `recover(err3)` is handed the failure itself, not the
call that produced it.

## 3. Built-in control functions

Control calls answer synchronously and bind no handles.

| call | meaning |
| --- | --- |
| `list` / `list("all")` | running + waiting calls; `"all"` includes settled ones |
| `cancel(c5)` | abort a call; cascades to its dependents |
| `inspect(c5)` | one call: args, deps, state transitions, timings, progress notes |
| `inspect(@planner)` | one agent: throughput, latency percentiles, wait/run split, outcome mix |
| `inspect()` | the session: concurrency profile, notification lag, per-agent table |
| `defs()` | preloaded functions |
| `vars()` | bound handles and their states |
| `help()` | usage |

## 4. CLI

```
tsx src/cli/bin.ts [options]
  --agent <id>         default agent for unprefixed lines (default: a0)
  --preload <path>     toolbox module, repeatable (default: src/toolbox/default.ts)
  --trace <file>       write the gzip JSONL trace (default: none)
  --concurrency <n>    max simultaneously running calls (default: 4)
  --notify <spec>      sink, repeatable (default: stdout)
  --script <file>      read lines from a file instead of stdin
  --json               stdout becomes NDJSON (machine mode) instead of human text
  --session <id>       session id; otherwise derived from --trace
  --quiet              suppress the startup banner (answers are still printed)
```

Sink specs: `stdout`, `file:<path>`, `dsh`, `dsh:file:<path>`, `dsh:http:<url>`.

### Machine mode (`--json`)

One JSON object per line on stdout. This is what the demo driver reads.

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

Human mode prints the same information as terminal text. **Either way the
trace records the human rendering**, so the perf report always has a readable
transcript.

## 5. Notifications

A `Notification` (see `src/core/types.ts`) is produced for every terminal call
and handed to every registered sink. Sinks are cordis plugins that call
`ctx.notify.register(sink)`; `ctx.notify` is the hub service.

`fluvia-dsh` is the sink built for DeepSeek Harness: it coalesces notifications
that land within a short window into one envelope, so an agent turn is
interrupted once rather than five times, and renders them in dsh's
notification dialect.

## 6. Trace

`out/<session>.jsonl.gz` — gzip JSONL, one event per line, schema in
`src/core/types.ts` (`TraceEvent`). First line is always `session.start` with
the `TraceMeta` header. Read it with `readTrace()` from `src/core/trace.ts`.

Events: `session.start`, `agent.join`, `agent.input`, `cli.output`,
`call.submit`, `call.queued`, `call.start`, `call.progress`, `call.settle`,
`call.cancel`, `handle.settle`, `notify.emit`, `notify.deliver`, `session.end`.

`call.queued` marks the moment a call's dependencies are all ready and it begins
waiting for a concurrency slot, which is what separates time lost to the
dataflow (`queued.t - submit.t`) from time lost to scheduler pressure
(`start.t - queued.t`). A skipped call is never queued.

An agent id is always a lane that authored something. `cli.output` and
`notify.deliver` carry `agent: ""` when they belong to the CLI itself or to a
coalesced batch spanning several agents; `.exit` is session control and enrols
nobody.

## 7. Deliverables

- `pnpm demo` — drives the CLI as a scripted pair of agents and writes
  `out/<session>.jsonl.gz`.
- `pnpm demo-perf` — renders the newest trace to a self-contained
  `out/perf.html` and serves it on `http://127.0.0.1:<port>`.
