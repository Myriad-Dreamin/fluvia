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

The package also ships the recordings this toolbox is benchmarked against
(`traces/`) and the cases that read them (`bench/`), so an installed copy is its
own smoke test:

```sh
fluvia run node_modules/@fluvia/toolbox-default
```

MIT © 2026 Myriad-Dreamin
