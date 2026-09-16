# Seeing fluvia notifications in the dsh Web UI

`docs/dsh-integration.md` explains *why* fluvia coalesces settled calls into
`<fluvia-notify>` envelopes and sketches the dsh-side plugin that would forward
them. This page is the built version of that sketch: `packages/dsh-plugin-fluvia`
is a real DeepSeek Harness plugin you install into a profile, and these are the
exact commands to get envelopes from a `pnpm demo` run into the Web UI
transcript.

Node v24 is required for every shell below:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
```

## What it does

```
fluvia session                         dsh process
──────────────                         ───────────
--notify dsh:http://…/inbox
   │  POST one JSON envelope
   │  per coalesced batch
   ▼
                              ┌─────────────────────────────┐
                              │ dsh-plugin-fluvia           │
                              │  receiver  :7788/inbox      │
                              │     ↓                       │
                              │  courier ── no agent? ──┐   │
                              │     ↓                   │   │
                              │  agent.followup(msg)   queue│
                              │                         │   │
                              │        agent/created ───┘   │
                              └─────────────────────────────┘
                                         ↓
                                  dsh Web UI transcript
```

The envelope's rendered `<fluvia-notify>` block becomes a **user message
attributed to the plugin**, not to the human:

```jsonc
{ "kind": "plugin", "plugin": "fluvia", "form": "notice",
  "summary": "fluvia/tuner: 1 call — 1 failed" }
```

That matters for more than tidiness. An omitted or `{ kind: 'user' }` source
claims host-attested human authority, and permission-sensitive plugins act on
it; fluvia is a program, so it says so. `form: 'notice'` also lets the Web UI
collapse each block to its one-line summary instead of pasting a wall of text
into the transcript.

**Envelopes normally arrive before any agent exists.** The Web UI creates its
session only when you open one, so the plugin queues envelopes (bounded,
default 200, oldest evicted) and replays them in arrival order the moment an
agent appears.

## End to end

### 1. Build the plugin

```bash
cd /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia
pnpm install          # only the first time; installs its own dev/peer deps
pnpm build            # tsc → lib/index.js + lib/types/index.d.ts
```

The dsh profile imports the built JS — `tsx` is not available there — so
`lib/` must exist before the profile loads the plugin.

### 2. Install it into the profile

Run this from **any directory that is not the fluvia repo** (the invoking
directory becomes the agent's workspace root):

```bash
cd ~/scratch
npx dsh plugin --profile web add /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia
```

This is `pnpm add <path>` inside `$DSH_HOME/profiles/web`, so it creates a
symlink and the bare specifier `dsh-plugin-fluvia` resolves from the profile
directory. It prints one warning:

```
dsh: warning: dsh-plugin-fluvia declares no dsh.bundle — installed as a plain
dependency, not a profile layer
```

That is expected and correct. Bundles are whole patch *layers*; this is a
single plugin *row*, mounted by the overlay in step 3.

Installation is **per profile**. Repeat with `--profile acp`, `--profile tui`,
… for any other profile that should receive envelopes.

### 3. Boot dsh with the overlay

The overlay that mounts the row lives at
`packages/dsh-plugin-fluvia/fluvia.yml`. `--patch` is a **launcher** flag, so
it must come before the app's own flags:

```bash
cd ~/scratch
npx dsh --profile web \
  --patch /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia/fluvia.yml \
  --port 3080 --no-open
```

> `dsh web --patch …` does **not** work — the `web` subcommand passes
> everything after it to the app, which rejects `--patch` as unknown.

dsh prints one line you need:

```
dsh web: http://127.0.0.1:3080/?token=…
```

The Web UI returns **401 at `/` without that token**, so open the printed URL
rather than typing the bare host and port.

Confirm the receiver came up:

```bash
curl -s http://127.0.0.1:7788/inbox | head -20
```

### 4. Run fluvia against it

In the fluvia repo, in another shell:

```bash
cd /home/kamiyoru/work/ts/fluvia
FLUVIA_DSH_HTTP=http://127.0.0.1:7788/inbox pnpm demo
```

`src/demo/run.ts` turns that variable into
`--notify dsh:http://127.0.0.1:7788/inbox`. A full demo run posts about 19
envelopes over ~7 seconds.

### 5. Watch it land

- **The Web UI** is the real surface: open the tokenized URL, start a session,
  and each envelope arrives as a collapsed `fluvia/<agent>: N calls — …` notice
  that expands to the full `<fluvia-notify>` block.
- **The status page** at <http://127.0.0.1:7788/> answers the plumbing
  question — bound? received? queued? which agent? — and refreshes every two
  seconds.
- **`GET http://127.0.0.1:7788/inbox`** returns the same thing as JSON.

Envelopes posted before you open a session are held, and the whole queue drains
into the session the moment it is created.

## Configuration

Every key below is in `fluvia.yml` at its default. The loader validates them
through the plugin's schemastery `Config`, so `--dump-config` renders them and
any `--patch` overlay can override them.

| key | default | meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Interface to bind. Loopback only unless you mean it — this endpoint queues text straight into an agent's turn. |
| `port` | `7788` | TCP port. |
| `path` | `/inbox` | `POST` here to deliver; `GET` here for JSON status. |
| `mode` | `followup` | `followup` wakes an idle agent; `inject` waits for the next pre-step without waking; `auto` picks per agent status. |
| `target` | `newest` | `newest` (the session you just opened), `all`, or a literal session id. |
| `queueLimit` | `200` | Envelopes held while no agent matches `target`; oldest evicted past this. |

Check what the launcher composed:

```bash
npx dsh --profile web --dump-config \
  --patch /home/kamiyoru/work/ts/fluvia/packages/dsh-plugin-fluvia/fluvia.yml \
  | grep -A10 fluvia
```

### Choosing a mode

`followup` is the default because an idle agent has to actually wake up:
a notification nobody reads until the human types again is a log file.

The cost is that **each envelope becomes its own turn** — that is what
`followup()` means in dsh. For live streaming that is right; a coalesced
envelope arrives roughly once a second at most. But when a large backlog
flushes at once (you opened the UI after a long run), 200 held envelopes become
200 queued turns.

Set `mode: auto` when that is a concern. It wakes an idle agent and injects
into a running one, so the first held envelope opens a turn and the rest ride
along at its step boundaries. `mode: inject` never wakes at all, which suits a
deployment where fluvia's output should only ever accompany work the human
already started.

### Targeting

`newest` is the last agent in the registry's registration order, which is the
session a human just opened. `all` broadcasts. Anything else is matched
literally against `agent.id`, so pinning to one session is:

```yaml
- insert:
    - id: fluvia
      name: dsh-plugin-fluvia
      config:
        target: 8c8f0b70-0656-49f3-9471-08fd8122e648
```

`newest` and `all` are reserved words: a session whose id is literally one of
them cannot be pinned by id.

## Verifying without an API key

The plugin's own harness covers the whole delivery path against an agent double
typed as `Pick<Agent, 'id' | 'status' | 'followup' | 'inject'>`, so the calls it
asserts are the calls a live agent receives:

```bash
cd packages/dsh-plugin-fluvia
pnpm typecheck && pnpm verify
```

It drives the real receiver over real HTTP on an ephemeral port and checks
queueing, ordered flush, plugin attribution, every mode and target, bounded
eviction, malformed input, and that `close()` releases the port.

To exercise a **real** `Agent` without a model call, drive the ACP profile:
`session/new` calls `ctx.agents.create()`, which emits `agent/created` and
drains the queue. The turn then reaches `assistant/attempt` and stops with
`MISSING_CREDENTIAL` — everything up to the model request is exercised.

## Troubleshooting

| symptom | cause |
| --- | --- |
| `error: unknown option '--patch'` | `--patch` came after `web`. Use `dsh --profile web --patch … --port …`. |
| `Cannot find package 'dsh-plugin-fluvia'` | The plugin is installed into a different profile. `dsh plugin --profile <name> add <path>`. |
| Plugin load fails with `cannot bind 127.0.0.1:7788` | Something else holds the port — for example `pnpm dsh-inbox`, the standalone receiver this plugin replaces. Stop it, or set another `port`. |
| Web UI returns 401 | Open the tokenized URL dsh printed at startup, not the bare host:port. |
| Status shows `queued` climbing and `delivered` at 0 | No agent matches `target`. Open a session in the UI, or check `targetAgents` on the status page. |

## Relationship to `src/dsh-inbox/`

`pnpm dsh-inbox` is a standalone receiver that renders envelopes on its own
page. It is a development tool: it shows you the envelope stream when there is
no harness. This plugin replaces it as the *dsh-side* receiver — same wire
format, but the envelopes end up in an agent's turn instead of on a page of
their own. Both bind 7788 by default, so run one or the other.
