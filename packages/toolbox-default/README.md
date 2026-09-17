# @fluvia/toolbox-default

The toolbox a fluvia command loads when `--preload` is not given: a
deterministic GPU-kernel pipeline — prepare, compile, load, benchmark,
summarize — with realistic latencies and failure modes.

```ts
import toolbox from '@fluvia/toolbox-default'
```

The default export is a `FunctionDef[]` from
[`@fluvia/core`](https://www.npmjs.com/package/@fluvia/core); every function is
also a named export.

MIT © 2026 Myriad-Dreamin
