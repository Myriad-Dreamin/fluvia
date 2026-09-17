# DeepSeek Harness

fluvia is a standalone CLI, but its whole point is to be driven by an agent — and
a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent
has a turn structure worth respecting. Three pieces wire the two together: the
`fluvia-dsh` notification handler (`@fluvia/core/plugins/notify-dsh`) on fluvia's
side, the `dsh-plugin-fluvia` plugin on dsh's side, and
[the fluvia skill](./skill) in between so the model knows what to type.

## Why a dedicated handler

The default `stdout` sink emits one line per settled call. If the agent is
reading fluvia's stdout directly, eight calls settling in the same second are
eight interruptions — eight turn boundaries, eight re-readings of the same state,
and an attention budget spent on bookkeeping instead of on the work.

`fluvia-dsh` buffers notifications for a short sliding window (`batchMs`, default
120 ms; flushed early at `maxBatch`, default 16, and never held longer than
`4 × batchMs`), splits the buffer per agent, and delivers **one envelope per
agent** in which what is actionable leads. Eight settlements become one
interruption.

## The envelope

The LLM-facing half is a text block, injected verbatim into a turn:

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

Sections appear only when non-empty, and the order is fixed: **ready → failed →
skipped → cancelled → now runnable**. Nothing in it is inferred; every line is
built from a `Notification` (`@fluvia/core/types`).

The `file` and `http` transports carry that text inside a JSON record, so a
forwarder can route or filter without parsing prose:

```jsonc
{
  "v": 1,
  "session": "s-20260915-174233",
  "at": 1789412345678,          // epoch ms at delivery
  "agent": "a0",                // one envelope never mixes agents
  "ids": ["n0", "n1", "n2", "n7"],
  "text": "<fluvia-notify …>…</fluvia-notify>",
  "calls": [                    // the batch, structured
    { "id": "n0", "at": 1204.5, "call": "c0", "fn": "prepareKernel", "outcome": "done",
      "bind": { "value": "kernel0", "error": "err0" },
      "ready": { "name": "kernel0", "kind": "value", "type": "Kernel", "summary": "…" },
      "timing": { "waitedMs": 0, "runMs": 214, "totalMs": 214 },
      "unblocked": ["c3"] }
  ]
}
```

`calls[].at` stays session-relative (milliseconds from the trace origin) so it
lines up with the trace; only the envelope's own `at` is epoch.

## Transports

```
--notify dsh                     # or dsh:stdout
--notify dsh:file:out/notify.jsonl
--notify dsh:http://127.0.0.1:9000/fluvia
```

| transport | what it does | pick it when |
| --- | --- | --- |
| `stdout` | writes the rendered `<fluvia-notify>` block to fluvia's stdout | dsh already owns fluvia's stdout (spawned as a subprocess and read line-wise). Simplest wiring, nothing to configure. |
| `file` | appends one JSON record per envelope to a JSONL file, creating parent directories | the dsh side is a different process that tails the file, or you want the envelopes on disk next to the trace for debugging. Survives a restart of the *reader*, not of fluvia. |
| `http` | POSTs the same JSON record to an endpoint | dsh runs elsewhere, or several dsh deployments subscribe. Needs an endpoint that answers fast; see the limits below. |

`--notify` is repeatable, so `--notify stdout --notify dsh:file:out/notify.jsonl`
gives you a human transcript and machine envelopes at once.

## The dsh plugin

`packages/dsh-plugin-fluvia` is a real dsh plugin that closes the loop: the model
submits calls with a `fluvia` tool and gets handles back instantly, and settled
results come back on their own as `<fluvia-notify>` messages that wake the agent.

It hands each envelope to a live agent through `agent.followup()` (wakes an idle
driver) or `agent.inject()` (queues model-facing context without waking);
`mode: auto` wakes an idle agent and injects into a running one, so a backlog that
flushes at once becomes a single turn that has read every envelope. Envelopes
that arrive before any session exists are queued and flushed in order on
`agent/created`, which is the normal case — the Web UI creates its session only
when a human opens one.

Messages are attributed to the plugin (`{ kind: 'plugin', plugin: 'fluvia' }`),
never to the user: a program must not claim host-attested human authority.
`form: 'notice'` also lets the Web UI collapse the block to its summary line.

## The two-process deployment

The plugin is built for two processes, and that shape is the point.

```
        OUTSIDE the sandbox                 INSIDE the sandbox
  ┌──────────────────────────────┐   ┌──────────────────────────────────┐
  │  pnpm serve                  │   │  dsh + dsh-plugin-fluvia         │
  │                              │   │                                  │
  │  • the instruction set       │   │  • the `fluvia` tool             │
  │    (--preload)               │   │  • the courier (notify → turn)   │
  │  • the scheduler             │◀──┤  • a socket, and nothing else    │
  │    (--concurrency)           │   │                                  │
  │  • the trace (--trace)       │──▶│  • the model                     │
  │  • the limits                │   │                                  │
  └──────────────────────────────┘   └──────────────────────────────────┘
              one NDJSON socket: submit lines in, results out
```

### What the boundary buys

Everything that decides what an instruction *does* lives on the far side of the
socket, and every rule is enforced there — not in this plugin, which is code the
model could in principle rewrite.

A model that fully owned the sandbox still **cannot**:

- **change the instruction set.** `--preload` is a flag on `pnpm serve`. There is
  no frame that adds, replaces or reloads an instruction, and the plugin's config
  schema deliberately has no `preload` or `concurrency` key — putting them there
  would hand the instruction set to the process the model runs in.
- **reach the implementations or the trace.** Both live in the runtime's process
  and filesystem. The model sees names, signatures and summaries; it never sees
  or touches code, and the trace is written host-side.
- **see another session's handles.** With the server's default `--scope agent`,
  handles are per-agent. A second session asking for `kernel0` gets
  `unknown handle: kernel0`, not somebody else's kernel.
- **impersonate another session.** Identity is assigned by the server from the
  connection's `hello`, and an `@agent` prefix on a submitted line is a protocol
  error: *"an @agent prefix is not accepted here; this connection submits as
  @dsh-…"*.
- **stop the runtime.** `.exit` closes that one connection. Other sessions keep
  running and the runtime stays up.

The plugin's job is liveness and ergonomics — stay connected, correlate answers,
render results well. Not safety. [The threat model](../reference/threat-model)
states the whole boundary, including what it does not protect against.

## End to end

Node v24 is required for every shell below:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
```

### 1. Start the runtime (outside)

```bash
cd /path/to/fluvia
pnpm serve --listen unix:/tmp/fluvia.sock --concurrency 4 --trace out/serve.jsonl.gz
```

It prints what it published:

```
fluvia serve — session srv-20260916073220
  listening   unix:/tmp/fluvia-dsh-e2e.sock
  instruction set  11 functions: benchmark, compileKernel, explain, flakyProbe, …
  preloaded   @fluvia/toolbox-default
  concurrency 4 · handle scope agent · 32 in flight/agent · 20/s
```

A unix socket keeps the endpoint inside the filesystem's permission model. A
`tcp:<host>:<port>` address is reachable by anything that can route to it, so the
server refuses to start on one without `--token-file`.

### 2. Build and install the plugin (inside)

```bash
cd /path/to/fluvia/packages/dsh-plugin-fluvia
pnpm install          # first time only
pnpm build            # tsc → lib/index.js + lib/types/index.d.ts

cd ~/scratch          # any directory that is NOT the fluvia repo
npx dsh plugin --profile web add /path/to/fluvia/packages/dsh-plugin-fluvia
```

The profile loads the built JS — `tsx` is not available there — so `lib/` must
exist first. One warning is expected and correct:

```
dsh: warning: dsh-plugin-fluvia declares no dsh.bundle — installed as a plain
dependency, not a profile layer
```

Bundles are whole patch *layers*; this is a single plugin *row*. Installation is
per profile, so repeat with `--profile acp`, `--profile tui`, … as needed.

### 3. Boot dsh with the overlay

`--patch` is a **launcher** flag and must come before the app's own flags:

```bash
cd ~/scratch
npx dsh --profile web \
  --patch /path/to/fluvia/packages/dsh-plugin-fluvia/fluvia.yml \
  --port 3080 --no-open
```

> `dsh web --patch …` does **not** work — the `web` subcommand passes everything
> after it to the app, which rejects `--patch` as unknown.

dsh prints one line you need; the Web UI returns **401 without the token**, so
open the printed URL rather than the bare host and port:

```
dsh web: http://127.0.0.1:3080/?token=…
```

**Start the runtime first.** At load the plugin opens a short-lived connection to
read the published instruction set, retrying for 15 s. If the runtime is
unreachable the plugin fails the boot with the address it tried — deliberately,
because a `fluvia` tool that cannot name a single real instruction is worse than
no tool.

### 4. Try it in the Web UI

Open a session and paste:

> Use the `fluvia` tool to build and measure a kernel. Submit
> `prepareKernel({ size: 4096, dtype: "f32" })` and, without waiting, submit
> `loadDataset({ name: "wikitext-103" })` too. When the notifications tell you
> the handles are ready, submit `compileKernel(kernel0, { opt: 3 })` and then
> `benchmark(kernel2, dataset1, { iters: 200 })`. Never wait for a result —
> submit what you can and react to the notifications. Tell me the numbers at
> the end.

Run `defs` through the tool first if you want to see the instruction set.

## What actually happens

**What the model types** — one line per call, JS call syntax, no computation:

```
prepareKernel({ size: 4096, dtype: "f32" })
```

**What comes back immediately** (milliseconds, not seconds):

```
c0 prepareKernel ⇒ kernel0, err0 [running] — result arrives as a fluvia
notification; do not poll, submit dependent calls now by passing kernel0
(or err0 for the recovery branch)
```

The turn can end here. Nothing is blocked.

**What arrives later**, on its own, as a user message attributed to the plugin —
which opens a new turn under the default `mode: followup`:

```
<fluvia-notify agent="dsh-67f190b4-…" session="srv-20260916073220">
1 call settled — 1 ready.

ready
  c0 prepareKernel → kernel0 : Kernel 4096x4096 f32 matmul · 64x64 tiles (wait 0ms, run 454ms)

now runnable
  nothing else was waiting on these handles.
</fluvia-notify>
```

A real run from one human prompt produces this, in the durable session log:

```
turn 1  tool/call fluvia      {"line": "prepareKernel({ size: 4096, dtype: \"f32\" })"}
turn 1  tool/result           c0 prepareKernel ⇒ kernel0, err0 [running]
turn 2  user/message (fluvia) <fluvia-notify> … c0 prepareKernel ready
turn 2  tool/call fluvia      {"line": "compileKernel(kernel0, { opt: 3 })"}
turn 2  tool/result           c1 compileKernel ⇒ kernel1, err1 [running]
turn 3  user/message (fluvia) <fluvia-notify> … c1 compileKernel ready
```

Three turns, two calls, no waiting anywhere.

## Configuration

Every key below is in `fluvia.yml` at its default.

| key | default | meaning |
| --- | --- | --- |
| `transport` | `connect` | `connect`: socket to a runtime outside the sandbox. `http`: receive envelope POSTs locally (no isolation). |
| `connect` | `unix:/tmp/fluvia.sock` | Runtime address: `unix:<path>` or `tcp:<host>:<port>`. |
| `tokenFile` | `''` | File holding the shared secret, when the runtime runs with `--token-file`. |
| `label` | `''` | Label prefix requested per session; empty derives `dsh-<session id>`. The runtime assigns the final id. |
| `mode` | `followup` | `followup` wakes the agent; `inject` waits for the next pre-step; `auto` picks per agent status. |
| `target` | `newest` | *Fallback only*, for an envelope with no identifiable owner. |
| `queueLimit` | `200` | Envelopes held while no agent owns them; oldest evicted past this. |
| `host` / `port` / `path` | `127.0.0.1` / `7788` / `/inbox` | The local status endpoint; also the envelope intake under `transport: http`. |

There is deliberately **no `preload` and no `concurrency`** — see
[What the boundary buys](#what-the-boundary-buys).

Check what the launcher composed:

```bash
npx dsh --profile web --dump-config \
  --patch /path/to/fluvia/packages/dsh-plugin-fluvia/fluvia.yml \
  | grep -A20 fluvia
```

### Choosing a mode

`followup` is the default because an idle agent has to actually wake up: a
notification nobody reads until the human types again is a log file. The cost is
that each envelope becomes its own turn. For live streaming that is right;
notifications are already coalesced into one envelope per burst.

Set `mode: auto` when a large backlog might flush at once — it wakes an idle
agent and injects into a running one, so the first envelope opens a turn and the
rest ride along at its step boundaries. `mode: inject` never wakes at all.

### Identity and routing

Each dsh session gets **its own connection**, and therefore its own
server-assigned agent id, its own handle namespace and its own notification
stream. The plugin requests `dsh-<session id>` (sanitized into fluvia's agent
grammar — a UUID starting with a digit is not a legal `@agent`), and the runtime
assigns the final id.

Because the transport knows which socket a result arrived on, routing does not
depend on name matching at all: a notification goes to the session that submitted
the call. `target` is consulted only for an envelope with no identifiable owner,
and an envelope owned by a session that is not live is **held**, never redirected
to another session.

### The status endpoint

`GET http://127.0.0.1:7788/` is a small page (envelopes received, queued,
delivered, target agent) and `GET …/inbox` is the same as JSON. It is bound under
both transports, because "is anything arriving?" is the first question when the
UI looks quiet. Under `transport: connect` the POST route answers 409: results
arrive on each session's socket, and accepting POSTs there would open a second,
unauthenticated path into an agent's turn.

## Several dsh subagents, one fluvia runtime

A line may be prefixed with `@name` to submit as that agent:

```
@planner loadDataset({ name: "wikitext-103", shards: 4 })
@tuner   benchmark(kernel3, dataset0, { iters: 200 })
```

The runtime tracks each agent separately (`AgentRecord`), notifications are
addressed to the agent that submitted the call, and `fluvia-dsh` never puts two
agents in one envelope — so a subagent is only ever interrupted by its own work.
Use the dsh agent id as the fluvia agent id and the forwarder needs no mapping
table. Handles are shared across agents by design under `fluvia cli`: `@tuner`
may pass `kernel3` even though `@planner` produced it, which is what makes one
runtime per deployment (rather than one per subagent) worth doing.

`inspect(@tuner)` reports one agent's throughput, latency percentiles and outcome
mix; `inspect()` reports the session with a per-agent table.

## Registering the skill

`skills/fluvia/SKILL.md` teaches the model the call syntax, the two handles, the
notification shape and the working habits that make the async model pay off. It
is a standard directory-bundle skill, so any of these work:

- copy or symlink it to `<project>/.dsh/skills/fluvia/SKILL.md`;
- add its parent to `customSkillDirs` on `@deepseek-ai/dsh-skill-filesystem`:
  ```ts
  ctx.plugin(skillFilesystem, { customSkillDirs: ['/path/to/fluvia/skills'] })
  ```
- or ship it in the deployment's bundled skill root.

See [the skill](./skill) for what it teaches.

## Verifying without a model

```bash
cd packages/dsh-plugin-fluvia
pnpm typecheck && pnpm verify
```

- `verify:unit` — 30 checks with no external process: queueing, ordered flush,
  plugin attribution, every mode and target, ownership routing, the rendered
  `<fluvia-notify>` block, address parsing, and that the tool description is
  built from a published instruction set rather than a hardcoded list.
- `verify:loop` — starts a **real** `pnpm serve` on its own socket and drives it
  as two sessions: instant acks, a dependent call accepted while its producer
  runs, correlation surviving a rejected line, notifications reaching only the
  submitting session, the runtime refusing an `@agent` prefix, and one session
  failing to name another's handle.

## Troubleshooting

| symptom | cause |
| --- | --- |
| Boot fails with `cannot reach the fluvia runtime at unix:…` | The runtime is not listening. Start `pnpm serve` first. |
| `error: unknown option '--patch'` | `--patch` came after `web`. Use `dsh --profile web --patch … --port …`. |
| `Cannot find package 'dsh-plugin-fluvia'` | Installed into a different profile. `dsh plugin --profile <name> add <path>`. |
| Web UI returns 401 | Open the tokenized URL dsh printed at startup. |
| Tool returns `an @agent prefix is not accepted here` | The model wrote a prefix. Identity is the connection's; the parameter description says so. |
| Tool returns `unknown handle: …` | That handle belongs to another session. Handles are per-agent by default. |
| Status shows `queued` climbing, `delivered` at 0 | No agent owns those envelopes. Open a session, or check `targetAgents`. |
| `ENAMETOOLONG` binding a socket | Unix socket paths cap near 107 bytes. Use a shorter path. |

## MVP limits

Be aware of these before wiring fluvia into anything that matters.

- **No auth on the `http` transport.** No token, no TLS pinning, no signature on
  the record. Bind the receiver to loopback or a private network; do not POST
  envelopes across a trust boundary.
- **No persistence or replay of handles.** Handles live in the CLI process. When
  the CLI restarts, every handle is gone and in-flight calls are cancelled —
  there is no reattach, no resume and no way to reconstruct `kernel0` from the
  trace. The trace is for analysis, not recovery.
- **At-most-once delivery.** Envelopes are not queued to disk. The `http`
  transport retries once after a short timeout and then reports the failure
  through `onError` (the CLI prints it) rather than blocking the session or
  re-queuing. A receiver that is down loses those notices permanently. The
  `stdout` and `file` transports are as reliable as the stream and the disk.
- **Envelopes delivered after `close()`** — a notification that arrives during
  shutdown — are flushed immediately rather than coalesced, and may not survive
  process exit. `close()` itself is lossless for everything already buffered.
- **No backpressure.** A slow receiver does not slow the scheduler; deliveries
  are serialized on one chain and the buffer grows.

## Relationship to the other entry points

- `pnpm cli` is the single-process REPL: no boundary, everything in one process.
  Good for exploring the toolbox by hand.
- `pnpm connect` is the reference client for the same protocol this plugin
  speaks — useful for watching the wire without a harness.
- `pnpm dsh-inbox` is a standalone HTTP receiver for the older `transport: http`
  arrangement. It and `transport: connect` are alternatives, not layers.
