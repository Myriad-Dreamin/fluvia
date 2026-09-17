# @fluvia/core

The fluvia runtime. An agent writes one JS-syntax call per line; the runtime
parses it, binds two variables to the call's two channels, answers immediately,
and delivers the result later as a notification.

Nothing here imports `node:*` at module top except the trace reader/writer, so
the same runtime runs in Node and in a browser.

```ts
import type { FunctionDef, Notification } from '@fluvia/core/types'
import { createRuntime } from '@fluvia/core/bench/runtime'
```

## Exports

| subpath | what it is |
| --- | --- |
| `@fluvia/core/types` | the contract: call, handle, notification, trace event |
| `@fluvia/core/parser` | one line → one call |
| `@fluvia/core/dispatch` | the single path every submitted line takes |
| `@fluvia/core/describe` | values → type + summary |
| `@fluvia/core/trace` | gzip JSONL trace writer and reader (Node only) |
| `@fluvia/core/protocol` | the wire types shared by server and client |
| `@fluvia/core/format` | every string an agent reads |
| `@fluvia/core/session` | the read–submit–answer loop |
| `@fluvia/core/plugins/registry` | the functions an agent may call |
| `@fluvia/core/plugins/env` | handle bindings, shared by every agent |
| `@fluvia/core/plugins/scheduler` | dependency resolution, concurrency, cancellation, skips |
| `@fluvia/core/plugins/notify` | the notification hub |
| `@fluvia/core/plugins/notify-dsh` | the DeepSeek Harness envelope handler |
| `@fluvia/core/plugins/inspect` | the control calls |
| `@fluvia/core/bench/clock` | the virtual clock |
| `@fluvia/core/bench/runtime` | an in-memory runtime with no filesystem |
| `@fluvia/core/bench/slice` | index a recorded trace and cut it at a line |
| `@fluvia/core/bench/session` | replay a slice, or hand one lane to an agent |

Turning a module specifier into registered functions lives in
[`@fluvia/cli`](https://www.npmjs.com/package/@fluvia/cli), not here.

MIT © 2026 Myriad-Dreamin
