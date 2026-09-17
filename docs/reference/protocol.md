# Protocol

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

## 4. Two deployments

fluvia runs in one of two shapes, and they share every line of the dispatch
path (`@fluvia/core/dispatch`) so that what a line means never depends on which
one you chose.

**One trusted operator** — `fluvia cli`. The terminal owns the runtime, loads
the toolbox and drives every agent; an `@agent` prefix selects which one. This
is what `pnpm demo` exercises.

**A model in a sandbox** — `fluvia serve` outside it, a client inside. The
runtime, the instruction set and the trace live where the model cannot reach
them; the client may submit lines and read its own results, and nothing else.
Identity is assigned by the server, handles are namespaced per agent, and the
limits are the server's. See **[the threat model](./threat-model)**, and
`pnpm test:boundary` for the enforcement checked as attacks.

```
fluvia serve --listen unix:/run/fluvia.sock --preload ./toolbox.ts \
             --concurrency 4 --trace out/serve.jsonl.gz [--token-file f]
fluvia connect --connect unix:/run/fluvia.sock --label planner
```

A client that reconnects with the same label is assigned the same agent id
again (while no other connection holds it), so its handles survive the gap;
the calls that were still running when it dropped are cancelled, because nobody
was left to read them.

Wire: NDJSON both ways, `@fluvia/core/protocol`. Client frames are `hello`,
`submit` and `bye`; server frames are `welcome` (assigned agent, session, the
published ISA, the limits), `ack`, `control`, `error`, `result` and `bye`. A
`submit` carries an `id` the answer echoes, so a notification arriving mid-flight
can never be mistaken for an answer.

## 5. CLI

```
fluvia cli [options]
  --agent <id>         default agent for unprefixed lines (default: a0)
  --preload <path>     toolbox module, repeatable (default: @fluvia/toolbox-default)
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

## 6. Notifications

A `Notification` (see `@fluvia/core/types`) is produced for every terminal call
and handed to every registered sink. Sinks are cordis plugins that call
`ctx.notify.register(sink)`; `ctx.notify` is the hub service.

### Process exits

A call may start a child process through `cx.spawn()` (the process supervisor,
`@fluvia/core/plugins/processes`). Such a call settles as soon as the child has
spawned, with a `Process` value: `{ id, pid, call, command, stdout, stderr }`,
where `stdout` and `stderr` are log files that grow while the child runs. The
child outlives the call. When it exits, the supervisor publishes a second
notification to the same agent, with `event: "processExited"` and a `process`
field carrying `code`, `signal`, both log paths, their byte counts and `runMs`:

```
← c0 exec done (wait 0ms, run 9ms) ⇒ process0 : Process p0 pid 4242 running · sh -c "sleep 2; echo hi"; err0 void
← c0 processExited(process0) p0 pid 4242 exit code 0 after 2.0s · sh -c "sleep 2; echo hi"
    stdout /tmp/fluvia/<session>/p0-c0.stdout.log (3 B)
    stderr /tmp/fluvia/<session>/p0-c0.stderr.log (0 B)
```

Every ordinary notification carries `event: "callSettled"`. A process notice
still fills the call-shaped fields (`fn: "processExited"`, `outcome` is `done`
for exit code 0 and `failed` otherwise, `ready` names the process handle), so a
consumer that predates `event` renders it as a readable line. Handles do not
change on exit. The log directory is `--proc-dir`, by default
`<tmpdir>/fluvia/<session>`. At shutdown the CLI waits for live processes like it
waits for live calls; `serve` sends them SIGTERM.

`@fluvia/toolbox-default/process` is an opt-in toolbox exposing `exec(command, [args],
{ cwd })`. It runs whatever the agent names, so it is never preloaded by
default.

`fluvia-dsh` is the sink built for DeepSeek Harness: it coalesces notifications
that land within a short window into one envelope, so an agent turn is
interrupted once rather than five times, and renders them in dsh's
notification dialect. See [DeepSeek Harness](../guide/dsh) for the envelope and
its transports.

## 7. Trace

`out/<session>.jsonl.gz` — gzip JSONL, one event per line, schema in
`@fluvia/core/types` (`TraceEvent`). First line is always `session.start` with
the `TraceMeta` header. Read it with `readTrace()` from `@fluvia/core/trace`.

Events: `session.start`, `agent.join`, `agent.input`, `cli.output`,
`call.submit`, `call.queued`, `call.start`, `call.progress`, `call.settle`,
`call.cancel`, `handle.settle`, `process.spawn`, `process.exit`, `notify.emit`,
`notify.deliver`, `session.end`.

`call.queued` marks the moment a call's dependencies are all ready and it begins
waiting for a concurrency slot, which is what separates time lost to the
dataflow (`queued.t - submit.t`) from time lost to scheduler pressure
(`start.t - queued.t`). A skipped call is never queued.

An agent id is always a lane that authored something. `cli.output` and
`notify.deliver` carry `agent: ""` when they belong to the CLI itself or to a
coalesced batch spanning several agents; `.exit` is session control and enrols
nobody.

## 8. Deliverables

- `pnpm demo` — drives the CLI as a scripted pair of agents and writes
  `out/<session>.jsonl.gz`.
- `pnpm demo-perf` — renders the newest trace to a self-contained
  `out/perf.html` and serves it on `http://127.0.0.1:<port>`.
