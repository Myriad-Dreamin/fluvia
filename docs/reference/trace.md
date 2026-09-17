# Trace format

`--trace out/<session>.jsonl.gz` writes a gzip JSONL stream, one event per line.
The schema is `TraceEvent` in `@fluvia/core/types`, and the first line is always
`session.start` carrying the `TraceMeta` header.

```ts
import { readTrace } from '@fluvia/core/trace'

const { events } = readTrace('out/s-20260915-174233.jsonl.gz')
```

`@fluvia/core/trace` is the one module in the runtime that touches `node:*`; the
reader accepts `.jsonl` and `.jsonl.gz` alike.

## Header

```ts
interface TraceMeta {
  /** Schema version of the event stream. */
  v: 1
  /** Session id, e.g. `s-20260915-174233`. */
  session: string
  /** Epoch ms at `t = 0`; every event's `t` is relative to this. */
  origin: number
  /** Runtime identification for the perf report header. */
  runtime: { node: string; platform: string; fluvia: string }
  /** Scheduler concurrency limit in force. */
  concurrency: number
  /** Toolbox modules preloaded by the CLI. */
  preload: string[]
  /** Notification sink specs in force. */
  sinks: string[]
}
```

## Every event

Every event carries `seq` — a monotonic, 0-based event number — and `t`,
milliseconds since `TraceMeta.origin`. The rest is discriminated by `k`.

| `k` | fields |
| --- | --- |
| `session.start` | `meta: TraceMeta` |
| `agent.join` | `agent` |
| `agent.input` | `agent`, `line` |
| `cli.output` | `agent`, `level: 'info' \| 'error' \| 'notify'`, `text` |
| `call.submit` | `agent`, `call`, `fn`, `args: ArgNode[]`, `deps: DepRef[]`, `bind: { value, error }`, `handles: { value, error }` |
| `call.queued` | `call`, `blockedMs` |
| `call.start` | `call`, `waitedMs` |
| `call.progress` | `call`, `note`, `pct?` |
| `call.settle` | `call`, `outcome`, `runMs`, `totalMs`, `value?: { type?, summary? }`, `error?: CallError`, `skip?: { reason, from }`, `cancel?: { by, reason }` |
| `call.cancel` | `call`, `by`, `reason` |
| `handle.settle` | `handle`, `name`, `call`, `kind: ChannelKind`, `state: 'ready' \| 'void'`, `type?`, `summary?` |
| `process.spawn` | `id`, `call`, `pid`, `command`, `stdout`, `stderr` |
| `process.exit` | `id`, `call`, `code: number \| null`, `signal: string \| null`, `runMs` |
| `notify.emit` | `id`, `call`, `agent`, `outcome`, `event?` |
| `notify.deliver` | `id: string[]`, `sink`, `agent`, `latencyMs`, `bytes` |
| `session.end` | `reason`, `stats: SessionStats` |

### Why `call.queued` is its own event

`call.queued` marks the moment a call's dependencies are all ready and it begins
waiting for a concurrency slot. Splitting it out of `call.start` is what separates
time lost to the dataflow (`queued.t - submit.t`) from time lost to scheduler
pressure (`start.t - queued.t`). A skipped call is never queued.

### Agent ids

An agent id is always a lane that authored something. `cli.output` and
`notify.deliver` carry `agent: ""` when they belong to the CLI itself or to a
coalesced batch spanning several agents. `.exit` is session control and enrols
nobody.

### `session.end`

```ts
interface SessionStats {
  /** Total calls submitted. */
  calls: number
  /** Count per terminal state. */
  outcomes: Record<CallOutcome, number>
  /** Agents seen. */
  agents: number
  /** Notifications emitted. */
  notifications: number
  /** Wall-clock length of the session. */
  wallMs: number
  /** Sum of every call's run time; divided by `wallMs` this is the mean parallelism. */
  busyMs: number
}
```

The perf renderer recomputes these rather than trusting them, so a truncated
trace still reports.

## Lines and anchors

`indexTrace(events)` from `@fluvia/core/bench/slice` turns the event stream into
the line-oriented view a slice cuts. `fluvia slice lines` prints it:

```
  6  c6       after line 5 +0.974ms  @planner explain(err4, { depth: "short" })
  7  c7       after c3 +1.151ms      @planner explain(err3, { depth: "deep" })
  8  control  after c2 +17.068ms     @planner cancel(c4)
```

Each recorded line carries an **anchor** — the event the agent was reacting to
when it typed the line, plus the gap that followed. An anchor is one of three
kinds: `notify` (after a named call's notification), `line` (after another line),
or `start`, for a line typed relative to the start of the session. That is what a replay uses to
decide *when* to type a line again, so a slice replayed under a different
scheduler keeps the causal shape it had.

The second column is the call the line submitted, or the line's own kind when it
submitted none: `control`, `noop` for a comment, `error` for a line the runtime
refused, `exit` for `.exit`.

## The pi-web `trace.json`

The browser app exports a different shape, because it records a whole agent run
rather than just a runtime. `fluvia bench` and `defineBench` accept it wherever a
`.jsonl` would do.

```ts
const RECORD_FORMAT = 'pi-web-fluvia.trace'

interface SessionRecord {
  format: typeof RECORD_FORMAT
  version: 1
  exportedAt: string
  /** Free text, e.g. that a record was scripted rather than produced by a model. */
  note?: string
  mode: 'live' | 'slice'
  /** The model that produced the recorded turns. Replays never contact it. */
  model: { provider: string; id: string; api: string; baseUrl: string }
  systemPrompt: string
  live?: { agent: string; concurrency: number }
  slice?: {
    setup: { from: number; to?: number; takeover: string; concurrency?: number }
    task: string
    maxTurns: number
    traceName: string
    /** The recorded fluvia session the slice was cut from. */
    traceEvents: TraceEvent[]
  }
  /** The conversation, in order, as the agent held it. */
  messages: AgentMessage[]
  /** The fluvia runtime's events during the run. */
  runtime: TraceEvent[]
}
```

`runtime` holds the same `TraceEvent`s as a `.jsonl` trace but **without** a
`session.start` header, because the browser runtime never wrote one;
`traceFromRecord` in `@fluvia/core/bench/load` synthesises it. `messages` is the
part a `.jsonl` trace does not have, and it is what makes `cut: { turn: n }`
meaningful.

A record is rejected on load unless `format` matches, `version` is 1, `messages`
is an array, `mode` is `live` or `slice`, and — for a slice — `slice.traceEvents`
is non-empty.

## Related commands

- `fluvia slice lines --trace <file>` — the line view above.
- `fluvia slice export --trace <file> --out <file.json>` — the events as plain
  JSON, ungzipped.
- `fluvia perf [trace]` — a self-contained HTML report over one trace.
