# The runtime

fluvia is a fully asynchronous dataflow runtime behind a CLI. An LLM agent writes
one JS-syntax call per line. The runtime parses it, binds two variables to the
call's two channels, and answers immediately — it never blocks on the work.
Results come back later as notifications. Later lines reference earlier handles
by name, which is how a dependency graph gets built without the agent ever
awaiting anything.

## Calls

A submitted call is acknowledged with a call id and two variable names, then
scheduled. When it settles the runtime builds a notification and hands it to
every registered sink. The agent is never asked to wait or to poll.

One call per line, JS call syntax, **no computation**: no operators, no arrow
functions, no member access, no nesting of calls. Only a callee identifier and
arguments made of literals, arrays, objects and handle identifiers.

```
prepareKernel({ size: 4096, dtype: "f32" })    # ok
compileKernel(kernel0, { opt: 3 })             # ok — kernel0 is a handle
runKernel(prepareKernel())                     # rejected: nested call
compileKernel(kernel0, { opt: 1 + 2 })         # rejected: operator
compileKernel(kernel0.source)                  # rejected: member access
```

A line may be prefixed with `@name` to submit as that agent, a zero-arg call may
drop its parentheses, `# text` is a comment (traced but not executed), and
`.exit` closes the session after in-flight calls settle. The full line grammar is
in [the protocol reference](../reference/protocol).

## Two channels per call

Call `seq = n` binds `<out><n>` — the **value channel**, where `out` is declared
by the function — and `err<n>`, the **error channel**. `prepareKernel` declares
`out: "kernel"`, so seq 0 binds `kernel0` and `err0`.

**Exactly one of the two ever becomes `ready`; the other becomes `void`.**
Success fills the value handle and voids the error handle; failure does the
reverse; cancelling and skipping void both.

That is what makes recovery declarative: `explain(err3)` is submitted at the same
time as the happy path and runs only if `c3` failed.

The payload a consumer receives depends on the channel it read. A value handle
delivers whatever the implementation returned; an error handle delivers the
flattened `CallError` (`{ kind, message, detail?, retryable? }`, plus `$type` and
`$summary` for display). So `recover(err3)` is handed the failure itself, not the
call that produced it.

## Skip semantics

Passing a handle makes the consuming call wait for it.

| you passed | producer succeeded | producer failed / cancelled / skipped |
| --- | --- | --- |
| the value handle | consumer runs with the payload | consumer **skipped** (`upstream_failed` / `upstream_cancelled` / `upstream_skipped`) |
| the error handle | consumer **skipped** (`upstream_ok`) | consumer runs with the error payload |

A skipped call's own handles turn void in turn, so skips cascade and a failed
root never leaves dangling work to clean up. Exactly one of a happy path and its
recovery branch runs; the other is skipped for free.

## Control calls

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

Cancellation is cooperative: the call detaches and stops consuming a
concurrency slot immediately, but an implementation that ignores its
`AbortSignal` keeps running host-side until it finishes.

## Notifications

A `Notification` is produced for every terminal call and handed to every
registered sink. Sinks are cordis plugins that call `ctx.notify.register(sink)`;
`ctx.notify` is the hub service. `--notify` is repeatable, so a human transcript
and machine envelopes can run at once.

| spec | what it does |
| --- | --- |
| `stdout` | one rendered line per settled call on fluvia's stdout |
| `file:<path>` | the same, appended to a file |
| `dsh`, `dsh:stdout` | coalesced `<fluvia-notify>` envelopes on stdout |
| `dsh:file:<path>` | one JSON record per envelope, appended to a JSONL file |
| `dsh:http:<url>` | the same record, POSTed to an endpoint |

The `dsh` sinks exist because a raw sink interrupts an agent turn once per
settled call, which wrecks an agent's attention when eight calls land in the same
second. See [DeepSeek Harness](./dsh) for the envelope and its transports.

### Process exits

A call may start a child process through `cx.spawn()` — the process supervisor,
`@fluvia/core/plugins/processes`. Such a call settles as soon as the child has
spawned, with a `Process` value: `{ id, pid, call, command, stdout, stderr }`,
where `stdout` and `stderr` are log files that grow while the child runs. The
child outlives the call.

When it exits, the supervisor publishes a second notification to the same agent,
with `event: "processExited"`:

```
← c0 exec done (wait 0ms, run 9ms) ⇒ process0 : Process p0 pid 4242 running · sh -c "sleep 2; echo hi"; err0 void
← c0 processExited(process0) p0 pid 4242 exit code 0 after 2.0s · sh -c "sleep 2; echo hi"
    stdout /tmp/fluvia/<session>/p0-c0.stdout.log (3 B)
    stderr /tmp/fluvia/<session>/p0-c0.stderr.log (0 B)
```

Handles do not change on exit. Every ordinary notification carries
`event: "callSettled"`; a process notice still fills the call-shaped fields, so a
consumer that predates `event` renders it as a readable line. The log directory
is `--proc-dir`, by default `<tmpdir>/fluvia/<session>`. At shutdown the CLI
waits for live processes like it waits for live calls; `serve` sends them
SIGTERM.

`@fluvia/toolbox-default/process` is an opt-in toolbox exposing
`exec(command, [args], { cwd })`. It runs whatever the agent names, so it is
never preloaded by default.

## Two deployments

fluvia runs in one of two shapes, and they share every line of the dispatch path
(`@fluvia/core/dispatch`), so what a line means never depends on which one you
chose.

**One trusted operator** — `fluvia cli`. The terminal owns the runtime, loads the
toolbox and drives every agent; an `@agent` prefix selects which one. This is
what `pnpm demo` exercises.

**A model in a sandbox** — `fluvia serve` outside it, a client inside. The
runtime, the instruction set and the trace live where the model cannot reach
them; the client may submit lines and read its own results, and nothing else.
Identity is assigned by the server, handles are namespaced per agent, and the
limits are the server's.

```sh
fluvia serve --listen unix:/run/fluvia.sock --preload ./toolbox.ts \
             --concurrency 4 --trace out/serve.jsonl.gz [--token-file f]
fluvia connect --connect unix:/run/fluvia.sock --label planner
```

A client that reconnects with the same label is assigned the same agent id again
(while no other connection holds it), so its handles survive the gap; the calls
that were still running when it dropped are cancelled, because nobody was left to
read them.

The wire is NDJSON both ways (`@fluvia/core/protocol`), and
[the threat model](../reference/threat-model) says what the boundary is worth —
including what it does not protect against. `pnpm test:boundary` runs each
enforced property as an attempt from a real client against a real server.

## Several agents, one runtime

```
@planner loadDataset({ name: "wikitext-103", shards: 4 })
@tuner   benchmark(kernel3, dataset0, { iters: 200 })
```

The runtime tracks each agent separately, and notifications are addressed to the
agent that submitted the call, so subagents sharing one process do not read each
other's mail. Under `fluvia cli` handles are shared across agents by design:
`@tuner` may pass `kernel3` even though `@planner` produced it, which is what
makes one runtime per deployment worth doing. Under `fluvia serve` the default
`--scope agent` namespaces handles per agent instead, and another agent's handle
name does not resolve at all.

## Plugins on cordis

The runtime is built on [cordis](https://github.com/cordiverse/cordis) (the
`@deepseek-ai/cordis` build) in the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) style: one
plugin per concern over a shared `Context`, services injected by name.

| plugin | concern |
| --- | --- |
| `@fluvia/core/plugins/registry` | the functions an agent may call |
| `@fluvia/core/plugins/env` | handle bindings |
| `@fluvia/core/plugins/scheduler` | dependency resolution, concurrency, cancellation, skips |
| `@fluvia/core/plugins/notify` | the notification hub |
| `@fluvia/core/plugins/notify-dsh` | the DeepSeek Harness envelope handler |
| `@fluvia/core/plugins/processes` | the child-process supervisor |
| `@fluvia/core/plugins/inspect` | the control calls |

Nothing in `@fluvia/core` imports `node:*` at module top except the trace
reader/writer, so the same runtime runs in Node and in a browser — which is what
lets [the browser app](./pi-web) execute real calls in a page.
