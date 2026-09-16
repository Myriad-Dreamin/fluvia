# Driving fluvia from the dsh Web UI

`packages/dsh-plugin-fluvia` is a DeepSeek Harness plugin that closes the loop
between a model and a fluvia runtime: the model submits calls with a `fluvia`
tool and gets handles back instantly, and settled results come back on their own
as `<fluvia-notify>` messages that wake the agent.

It is built for a **two-process deployment**, and that shape is the point.

Node v24 is required for every shell below:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
```

## The two processes

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
render results well. Not safety.

## End to end

### 1. Start the runtime (outside)

```bash
cd /home/kamiyoru/work/ts/fluvia
pnpm serve --listen unix:/tmp/fluvia.sock --concurrency 4 --trace out/serve.jsonl.gz
```

It prints what it published:

```
fluvia serve — session srv-20260916073220
  listening   unix:/tmp/fluvia-dsh-e2e.sock
  instruction set  11 functions: benchmark, compileKernel, explain, flakyProbe, …
  preloaded   /home/kamiyoru/work/ts/fluvia/src/toolbox/default.ts
  concurrency 4 · handle scope agent · 32 in flight/agent · 20/s
```

A unix socket keeps the endpoint inside the filesystem's permission model. A
`tcp:<host>:<port>` address is reachable by anything that can route to it, so the
server refuses to start on one without `--token-file`.

### 2. Build and install the plugin (inside)

```bash
cd /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia
pnpm install          # first time only
pnpm build            # tsc → lib/index.js + lib/types/index.d.ts

cd ~/scratch          # any directory that is NOT the fluvia repo
npx dsh plugin --profile web add /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia
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
  --patch /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia/fluvia.yml \
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

The message carries `{ kind: 'plugin', plugin: 'fluvia', form: 'notice' }`, never
a user source: an omitted or user-shaped source claims host-attested human
authority that permission-sensitive plugins act on, and fluvia is a program.
`form: 'notice'` also lets the Web UI collapse the block to its summary line.

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
  --patch /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia/fluvia.yml \
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

## Relationship to the other entry points

- `pnpm cli` is the single-process REPL: no boundary, everything in one process.
  Good for exploring the toolbox by hand.
- `pnpm connect` is the reference client for the same protocol this plugin
  speaks — useful for watching the wire without a harness.
- `pnpm dsh-inbox` is a standalone HTTP receiver for the older `transport: http`
  arrangement. It and `transport: connect` are alternatives, not layers.
