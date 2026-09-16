# Running fluvia inside a dsh deployment

Fluvia is a standalone CLI, but its whole point is to be driven by an agent —
and a DeepSeek Harness agent has a turn structure worth respecting. This is how
the two are wired together: the `fluvia-dsh` notification handler
(`src/plugins/notify-dsh.ts`) on fluvia's side, a small forwarder plugin on
dsh's side, and the `fluvia` skill in between so the model knows what to type.

## Why a dedicated handler

The default `stdout` sink emits one line per settled call. If the agent is
reading fluvia's stdout directly, eight calls settling in the same second are
eight interruptions — eight turn boundaries, eight re-readings of the same
state, and an attention budget spent on bookkeeping instead of on the work.

`fluvia-dsh` buffers notifications for a short sliding window (`batchMs`,
default 120 ms; flushed early at `maxBatch`, default 16, and never held longer
than `4 × batchMs`), splits the buffer per agent, and delivers **one envelope
per agent** in which what is actionable leads. Eight settlements become one
interruption.

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
built from a `Notification` (`src/core/types.ts`).

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

## Forwarding envelopes into an agent turn

A dsh-side plugin turns each record into a user message on the owning agent.
This is the same shape `tool-jobs` uses for background job completions, and the
reasoning carries over: a **busy** agent gets `inject()`, so the notice waits in
its next-step inbox and several envelopes cost one step; an **idle** agent gets
`followup()`, because an unclaimed notice is a completion the model never learns
about.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DshEnvelopeRecord } from 'fluvia/plugins/notify-dsh.ts'

export const name = 'fluvia-notify'
export const inject = ['agents']

export interface Config {
  /** Envelopes, however you get them: a tailed JSONL file or an HTTP handler. */
  source: AsyncIterable<DshEnvelopeRecord>
  /**
   * Map a fluvia `@agent` id to the dsh agent that owns it. Use the dsh session
   * id as the fluvia agent id and this is just `ctx.agents.get`.
   */
  resolve(agentId: string): Agent | undefined
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const abort = new AbortController()
    void (async () => {
      for await (const record of config.source) {
        if (abort.signal.aborted) return
        const agent = config.resolve(record.agent)
        if (!agent) continue
        const message = createUserMessage({
          content: [{ type: 'text', text: record.text }],
          source: {
            kind: 'plugin',
            plugin: 'fluvia-notify',
            form: 'notice',
            summary: `${record.calls.length} fluvia calls settled`,
          },
        })
        if (agent.status === 'idle') agent.followup(message)
        else agent.inject(message)
      }
    })()
    return () => abort.abort()
  }, 'fluvia-notify')
}
```

Wake budgets matter here for the same reason they do for jobs: a woken turn may
submit calls whose settlement wakes it again. Bound the consecutive wakes per
agent and degrade to `inject()` past the budget.

If you would rather register the sink **inside** a dsh application than parse
fluvia's output, `src/plugins/notify-dsh.ts` also exports the cordis plugin:

```ts
import { dshNotifier, parseDshSpec } from 'fluvia/plugins/notify-dsh.ts'

ctx.plugin(dshNotifier, parseDshSpec('dsh:http://127.0.0.1:9000/fluvia', sessionId)!)
```

`dshNotifier` declares `inject = ['notify']`, so it waits for fluvia's
notification hub, registers the sink through `ctx.notify.register()`, and on
unload unregisters it and closes it — flushing whatever is still inside the
coalescing window.

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

The same file works unchanged in Claude Code (`.claude/skills/fluvia/`) — it
describes fluvia, not a harness.

## Several dsh subagents, one fluvia runtime

A line may be prefixed with `@name` to submit as that agent:

```
@planner loadDataset({ name: "wikitext-103", shards: 4 })
@tuner   benchmark(kernel3, dataset0, { iters: 200 })
```

The runtime tracks each agent separately (`AgentRecord`), notifications are
addressed to the agent that submitted the call, and `fluvia-dsh` never puts two
agents in one envelope — so a subagent is only ever interrupted by its own work.
Use the dsh agent id as the fluvia agent id and the forwarder above needs no
mapping table. Handles are shared across agents by design: `@tuner` may pass
`kernel3` even though `@planner` produced it, which is what makes one runtime
per deployment (rather than one per subagent) worth doing.

`inspect(@tuner)` reports one agent's throughput, latency percentiles and
outcome mix; `inspect()` reports the session with a per-agent table.

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

See [PROTOCOL.md](./PROTOCOL.md) for the call syntax, handle semantics and the
trace schema.
