# Trust boundary

The deployment fluvia is built for: **the model runs inside a sandbox, the
instruction set runs outside it.**

```
┌─ sandbox (container) ──────────────┐        ┌─ host ─────────────────────────┐
│  model / dsh / the fluvia tool     │        │  fluvia serve                  │
│                                    │        │    registry  ← --preload       │
│  can: submit lines, read its own   │ ─────▶ │    scheduler ← --concurrency   │
│       results                      │  wire  │    notify                      │
│                                    │ ◀───── │    tracer    ← --trace         │
│  cannot: change what the           │        │    toolbox implementations     │
│          instructions do           │        │                                │
└────────────────────────────────────┘        └────────────────────────────────┘
```

The model is assumed to be able to do **anything inside the sandbox**: read and
rewrite files, edit the harness, patch the client, forge frames. So nothing may
depend on client-side behaviour. Everything below is enforced in
`@fluvia/cli`'s `server/connection.ts` and in the runtime it fronts.

## What the boundary enforces

| Property | How | Checked by |
| --- | --- | --- |
| The instruction set is fixed by the host | `--preload` is a server flag; no frame can load a module. `welcome.isa` publishes the set read-only | `the ISA cannot be extended over the wire` |
| A line cannot compute | the parser accepts a callee plus literals, arrays, objects and handle names — no operators, no nesting, no member access, no functions | `no computation crosses the wire` |
| Identity is assigned, not claimed | `hello.label` is sanitized, length-capped and uniquified by the server; an `@agent` prefix on a submitted line is a protocol error | `server assigns identity`, `an @agent prefix is refused` |
| One agent cannot read another's data | handles are namespaced per agent (`--scope agent`), so another agent's handle name does not resolve at all | `another agent's handle is not nameable` |
| One agent cannot steer another's work | `cancel` and `inspect` refuse calls the caller does not own, and answer as though they do not exist | `another agent's call cannot be cancelled/inspected` |
| Results stay with their owner | notifications are routed by the owning agent's connection, never subscribed to | `notifications go only to the owner` |
| One agent cannot stop the runtime | `.exit` closes that connection only | `.exit closes only that connection` |
| One agent cannot exhaust the runtime | per-agent in-flight cap, token-bucket submission rate, line-length cap, connection cap | `in-flight cap is enforced` |
| The audit trail is out of reach | the trace is written host-side and is not readable over the wire | — |

`pnpm test:boundary` runs each of those as an attempt from a real client against
a real server, and is the file to extend when the protocol grows.

## What it does not protect against

Stated plainly, because a boundary whose limits are vague is worse than none.

- **One sandbox is one trust domain.** Two sessions inside the same container
  can both open connections and either may request any label. Per-session
  isolation between them is best-effort; give each tenant its own token (and its
  own `fluvia serve`) when they genuinely distrust each other.
- **The instruction set is the real attack surface.** A line can only choose an
  instruction and its arguments, but an implementation that shells out, joins
  paths or forwards credentials can still be driven through those arguments.
  Validate arguments inside the toolbox: that code is the security perimeter.
- **Results cross the boundary.** Handle digests (`$type`, `$summary`) and error
  messages are returned by design, so an implementation must not put host
  secrets in either.
- **Cancellation is cooperative.** `cancel()` is immediate from the agent's point
  of view — the call detaches and stops consuming a slot — but an implementation
  that ignores its `AbortSignal` keeps running host-side until it finishes.
- **No transport encryption.** A unix socket is protected by filesystem
  permissions (created `0600`). A `tcp:` endpoint requires a shared secret and
  the server refuses to start without one, but there is no TLS: tunnel it if it
  leaves the host.
- **No replay or persistence.** Handles live in the runtime's memory; a restart
  loses them, and there is no way to hand a handle to a future session. A
  *reconnect* is different: a client returning with the same label is assigned
  the same agent id while no other connection holds it, so its handle namespace
  is still there and still usable — only its unsettled calls were cancelled when
  it dropped. That continuity is what lets a harness reconnect without losing
  the work it already has, and it is also why a label is worth protecting with a
  token when several tenants share one runtime.

## Operator checklist

1. Run `fluvia serve` as a user that owns *only* what the toolbox needs.
2. Prefer `unix:` and bind-mount the socket into the sandbox; use `tcp:` with
   `--token-file` only when the sandbox cannot share a filesystem.
3. Keep `--scope agent` (the default) whenever more than one agent connects.
4. Size `--concurrency`, `--max-in-flight` and `--rate` for the work, not for the
   agent's enthusiasm.
5. Write the trace (`--trace`) somewhere the sandbox cannot reach: it is the only
   record of what was asked for.
