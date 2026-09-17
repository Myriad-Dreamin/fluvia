# Writing cases

A case names a recording, a cut, one thing that is different, and the questions
that decide whether the difference was acceptable. Cases are TypeScript in files
named `*.bench.ts`. Node strips the types on import, so there is no build step
and no test framework: a file is loaded, its cases are run against the recordings
they name, and their judges decide.

```ts
import { defineBench, judges } from '@fluvia/core/bench/case'

export default defineBench({
  name: 'kernel sweep · concurrency 2',
  trace: './traces/demo.jsonl.gz',
  cut: { line: 9 },
  subject: { concurrency: 2 },
  judge: [judges.outcomes({ same: true }), judges.order('changed')],
})
```

A case file is read through its `default` export and a named `cases` export;
either may be one case or an array of them. Anything `defineBench` vouched for is
found, and a file that exports something else is reported as an error against
the file rather than silently skipped.

## The fields

| field | what it takes |
| --- | --- |
| `name` | shown in the report; defaults to the case file's name |
| `trace` | a `.jsonl` or `.jsonl.gz` written by `--trace`, or a `trace.json` exported from the browser app, resolved relative to the case file |
| `cut` | `{ line: 9 }`, `{ notify: 'c7' }` (the line typed after c7 settled), or `{ turn: 3 }` (the first line the third model turn submitted); defaults to the start |
| `to` | exclusive upper line bound |
| `toolbox` | the instruction set the recording ran; the runner fills in its default when omitted |
| `subject` | one of `{ concurrency }`, `{ edits }`, `{ call }`, `{ takeover }`; omit for a plain replay |
| `horizon` | `'complete'`, or `{ reach: ['c9 done', 'digest9 ready'] }` to stop early and fail if never reached |
| `judge` | one judge or an array; defaults to `judges.outcomes({ same: true })` |
| `runs` | repeat count; only a takeover varies between runs |
| `goal` | handed to a takeover driver as the lane's task |

## Cuts

A cut says where the replay begins. Everything before it is restored; everything
after it is what the case actually runs.

```ts
cut: { line: 9 }      // recorded line index, as `fluvia slice lines` prints it
cut: { notify: 'c7' } // the first line typed after c7's notification
cut: { turn: 3 }      // the first line the third assistant turn submitted
```

`{ turn: n }` needs a recording that carries a conversation, which today means a
pi-web `trace.json`. `{ notify }` and `{ line }` work on any recording.

## Subjects

Exactly one thing changes. `defineBench` throws if a subject holds two.

```ts
subject: { concurrency: 2 }
subject: { edits: { 10: '@tuner compileKernel(kernel5, { opt: 7 })' } }
subject: { call: { compileKernel: (args, cx) => ({ /* … */ }) } }
subject: { takeover: { lane: 'planner', driver: scriptedPlanner } }
```

- **`concurrency`** runs the slice under a different scheduler limit.
- **`edits`** replaces recorded lines by index, exactly as
  `fluvia slice replay --edit` does.
- **`call`** swaps instructions' implementations by name. A bare function
  replaces the `run()` of the registered definition; a full `FunctionDef`
  replaces it whole. The swap is in force for the entire replay, restoration
  included, so it also changes the world the cut is restored into.
- **`takeover`** hands one lane to a live driver at the cut and lets the other
  lanes replay around it.

## Horizons

`'complete'` — the default — replays every remaining line and drains the
runtime. `{ reach: [...] }` stops as soon as every predicate holds; a predicate
is `"<what> <state>"`, where *what* is a call id (`c9`), a handle name
(`digest9`) or a function name (`summarize`), and *state* is a call state
(`done`, `failed`, `skipped`, `cancelled`) or a handle state (`ready`, `void`).
A horizon that is never reached fails the case.

Stopping early leaves the rest of the slice untyped, so its recorded calls count
as `missing`. A case with a `reach` horizon should judge what it reached, not
demand `outcomes({ same: true })` over a slice it cut short.

## Judges

A judge is a function of the replayed world that returns `true`, a reason string,
`false`, or a full `{ pass, reason?, score? }`. They are asked in order, cheap
first, and all must pass. The built-ins:

| judge | what it asks |
| --- | --- |
| `judges.outcomes({ same, diverged, missing })` | how the recorded calls of the slice settled this time; `same: true` demands every one settled identically |
| `judges.settled(target, outcome = 'done')` | every call to a function name or call id settled that way, and there was at least one |
| `judges.handleReady(name)` | the handle bound as `name` carries data rather than being void or unbound |
| `judges.order('unchanged' \| 'changed')` | whether every replaying lane was notified in its recorded order |
| `judges.failed(target, kind?)` | a call to `target` failed, optionally with that error `kind` |
| `judges.count(state, n)` | exactly `n` calls settled in that state |

`judges.order('changed')` is the interesting one: it asserts that a harness
change really did reorder the world, so a case that stops reordering stops
passing instead of quietly succeeding.

### Custom judges

Anything the built-ins cannot phrase is a plain function. It is given the `World`
— the slice report, every call, every handle, the replay's own events, and the
recording it was cut from — and it returns `true` or the reason it did not.

```ts
import type { World } from '@fluvia/core/bench/case'

function recoveryNamesTheNewError(world: World): string | true {
  const note = world.handles.find((handle) => handle.name === 'note11')
  if (!note) return 'note11 was never bound'
  if (note.state !== 'ready') return `note11 is ${note.state}: recover() did not run`
  if (!note.summary?.includes('UnsupportedOptLevel')) return `note11 does not mention the new error: ${note.summary}`
  return true
}
```

The full `World` and `Judge` types are in
[the case API reference](../reference/case-api).

## A whole case

```ts
// packages/toolbox-default/bench/replay.bench.ts — one of the three it exports
export default defineBench({
  name: 'demo · opt 7 is rejected and recovered from',
  trace: '../traces/demo.jsonl.gz',
  cut: { line: 9 },
  subject: { edits: { 10: '@tuner compileKernel(kernel5, { opt: 7 })' } },
  judge: [judges.failed('c9', 'UnsupportedOptLevel'), judges.outcomes({ diverged: 2, missing: 0 }), recoveryNamesTheNewError],
})
```

This case edits one recorded line to something the toolbox rejects, then asserts
the whole consequence: the compile fails with that specific error, exactly two
calls diverge from the recording (the compile and the `recover()` downstream of
its error handle), and the note that recovery produced names the new error rather
than the recorded one.

## Takeovers

`subject: { takeover }` hands one lane to a driver at the cut while the other
lanes keep replaying their recording around it. The driver receives a
`TakeoverContext`:

| member | what it gives |
| --- | --- |
| `lane` | the lane handed over |
| `goal` | the case's `goal`, as text for the agent |
| `transcript()` | what the lane had seen up to the cut, as the agent would have read it |
| `state()` | the lane's calls and handles right now |
| `submit(line)` | submit one line as the lane; returns the runtime's synchronous answer |
| `wake()` | let virtual time run until the lane has something to read |
| `isIdle()` | true when no call is live and no recorded line is left |
| `reached()` | whether the case's `horizon` has been reached |
| `charge(tokens)` | report model usage, so the runner can price the case |

A driver that samples a model declares it as `takeover.model`, and the totals
line counts those runs separately. A driver that samples nothing — a scripted
stand-in — leaves it unset and the case counts as free.

```ts
async function scriptedPlanner(ctx: TakeoverContext): Promise<void> {
  const compiled = bind(ctx.submit('compileKernel(kernel0, { opt: 3, fastMath: true })'))
  await waitFor(ctx, compiled.call)
  ctx.submit(`benchmark(${compiled.value}, dataset1, { iters: 200, warmup: 20 })`)
  const quantized = bind(ctx.submit(`quantize(${compiled.value}, { bits: 8 })`))
  ctx.submit('loadDataset({ name: "openwebmath", shards: 3 })')
  await waitFor(ctx, quantized.call)
  ctx.submit(`compileKernel(${quantized.value}, { opt: 2 })`)
}
```

The stand-in reads only what an agent reads — the runtime's answer to each line
and the notifications a wake delivers — and learns its handle names from those
answers rather than from the recording. The `tuner` lane, whose recorded lines
consume the planner's handles, has to keep working against whatever the stand-in
actually produced, which is why `judges.outcomes({ same: true })` is the real
assertion in that case.

There is no takeover driver for a hosted model in the box yet. The agent side of
a takeover is driven today by the browser app; see [the browser app](./pi-web).

## Running them

```sh
npx fluvia bench .                  # every *.bench.ts under the tree
npx fluvia bench . --filter preset  # only files or cases whose path or name contains it
npx fluvia bench . --json           # { cases, errors, summary }
```

```
usage: fluvia bench [dir…] [options]

Run every `*.bench.ts` case under the given directories (default `.`).

  --filter <substr>  only files or cases whose path or name contains it
  --json             print { cases, errors, summary } instead of a table

Exit codes: 0 all passed, 1 a case failed, 2 a file or case could not be loaded.
```

`node_modules`, `lib`, `dist`, `out` and `.git` are never walked: they hold
copies of the cases.

The table names the case, what was different about it, the `same/diverged/missing`
totals, how many judges passed, and the wall time of the run:

```
      case                                              subject                      same/div/miss  judges  wall
────  ────────────────────────────────────────────────  ───────────────────────────  ─────────────  ──────  ────
packages/cli/bench/takeover.bench.ts
pass  demo · planner taken over by a scripted stand-in  takeover planner · scripted  10/0/0         2/2     54ms
packages/toolbox-default/bench/preset.bench.ts
pass  preset · the summary turn, replayed               replay                       1/0/0          5/5     12ms
packages/toolbox-default/bench/replay.bench.ts
pass  demo · replay from line 9                         replay                       16/0/0         2/2     30ms
pass  demo · concurrency 2 reorders, outcomes hold      concurrency 2                16/0/0         2/2     25ms
pass  demo · opt 7 is rejected and recovered from       edit 10                      14/2/0         3/3     26ms

5 cases · 5 passed · 5 free (no model) · 0 model runs
```

Exit code 1 when a case fails, 2 when a file or case could not be loaded. The
other files still run.

### `--json`

```jsonc
{
  "summary": { "files": 3, "cases": 5, "passed": 5, "failed": 0, "free": 5, "modelRuns": 0, "errors": 0 },
  "errors": [],
  "cases": [
    {
      "name": "demo · planner taken over by a scripted stand-in",
      "file": "packages/cli/bench/takeover.bench.ts",
      "subject": "takeover planner · scripted",
      "from": 9,
      "pass": true,
      "passed": 1,
      "runs": 1,
      "ms": 51,
      "cost": { "modelRuns": 0 },
      "verdicts": [
        { "name": "outcomes(same: true)", "pass": true, "reason": "10 same, 0 diverged, 0 missing" },
        { "name": "theLaneDidItsWork", "pass": true }
      ],
      "report": {
        "from": 9,
        "to": 35,
        "takeover": "planner",
        "concurrency": 4,
        "totals": { "same": 10, "diverged": 0, "missing": 0 },
        "order": [{ "agent": "tuner", "same": true }],
        "diverged": []
      }
    }
  ]
}
```
