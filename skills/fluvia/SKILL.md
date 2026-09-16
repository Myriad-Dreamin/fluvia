---
name: fluvia
description: Drive long-running, parallel or dependent async work from a turn without waiting for it. Use fluvia when a task has several independent slow steps (compile, load, benchmark, probe), when later steps depend on earlier ones, or when work should keep running while you answer the user. Calls return instantly as handles; results arrive later as notifications.
---

# fluvia

A CLI that accepts one call per line and **never blocks**. Each line is
acknowledged instantly with two variable names, the work runs in the background,
and a notification arrives when it settles. Lines that mention earlier variables
build a dependency graph, so a whole pipeline — happy path and recovery path —
can be submitted in one burst and then forgotten about.

## Start it

```
tsx src/cli/bin.ts --notify dsh --trace out/session.jsonl.gz --concurrency 4
```

`--notify dsh` gives coalesced envelopes; `--json` makes stdout NDJSON if you
parse rather than read. `defs` lists the loaded functions and their signatures.

## One call per line

JS call syntax, **no computation**: a callee identifier and arguments made of
literals, arrays, objects and handle names. Nothing else.

```
prepareKernel({ size: 4096, dtype: "f32" })      ok
compileKernel(kernel0, { opt: 3 })               ok — kernel0 is a handle
benchmark(kernel2, dataset1, { iters: 200 })     ok
loadDataset(prepareKernel())                     rejected: nested call
compileKernel(kernel0, { opt: 1 + 2 })           rejected: operator
compileKernel(kernel0.source)                    rejected: member access
```

`# text` is a comment, `.exit` closes the session after in-flight calls settle,
and a zero-arg call may drop its parentheses (`list`, `vars`).

## Two handles per call

Call `seq = n` binds `<out><n>` (value channel) and `err<n>` (error channel).
`prepareKernel` declares `out: "kernel"`, so seq 0 binds `kernel0` and `err0`;
the acknowledgement names both. **Read the names off the acknowledgement** —
never assume the suffix. When the runtime is shared (several agents, or a
`fluvia serve` others connect to), your first call may well be `c7 ⇒ kernel7`. **Exactly one of the two ever becomes `ready`;
the other becomes `void`.** Success fills the value handle and voids the error
handle, failure does the reverse, cancelling and skipping void both.

## Chain by passing handles

Pass a handle and the consumer waits for it — you do not. What happens when the
producer settles depends on which channel you consumed:

| you passed | producer succeeded | producer failed / cancelled / skipped |
| --- | --- | --- |
| the value handle | consumer runs with the payload | consumer **skipped** (`upstream_failed` / `upstream_cancelled` / `upstream_skipped`) |
| the error handle | consumer **skipped** (`upstream_ok`) | consumer runs with the error payload |

So recovery is just another call, submitted up front alongside the happy path.
Exactly one of the two branches runs, the other is skipped for free, and skips
cascade — a failed root never leaves dangling work to clean up.

```
flakyProbe({ target: "nvlink", failRate: 0.4 })  # binds probe2, err2
summarize(probe2, { title: "link health" })      # runs only if it succeeded
recover(err2, { strategy: "auto" })              # runs only if it failed
```

## Notifications

They arrive on their own — never ask for them. With `--notify dsh`, settlements
landing inside a short window arrive as **one** `<fluvia-notify>` envelope (see
the worked example) laid out as: a headline count, then `ready` (handles you can
now pass on), `failed` (kind, message, whether a retry is worth it, and the live
`err` handle), `skipped (never ran)` with the upstream that voided it,
`cancelled`, and finally `now runnable` — what the scheduler just picked up.

React by **submitting the next lines**, not by re-reading state. `now runnable`
already covers everything that was merely waiting on these handles; you act only
on `ready` handles you have further plans for and on failures worth recovering.

## Control calls

Answer synchronously, bind nothing.

```
list / list("all")      running + waiting calls; "all" includes settled ones
cancel(c5)              abort a call; cascades to its dependents
inspect(c5)             one call: args, deps, state transitions, timings, progress
inspect(@tuner)         one agent: throughput, latency percentiles, outcome mix
inspect()               the session: concurrency profile, notification lag
vars / defs / help      bound handles · loaded functions · usage
```

## Several agents, one runtime

Prefix a line with `@name` to submit as that agent — notifications are addressed
to the submitter, so subagents sharing one fluvia process do not read each
other's mail.

```
@planner loadDataset({ name: "wikitext-103" })
@tuner   benchmark(kernel3, dataset0, { iters: 200 })
```

## Working habits

Without these, fluvia is just a slow synchronous CLI.

1. **Fire independent calls in one burst.** Three lines back to back run
   concurrently; three lines one notification apart run in series and cost
   three turns.
2. **Never poll.** No `list` loop, no "let me check if it finished". `list` is
   for deciding what to cancel, not for waiting.
3. **Pass handles, not values.** Never wait for `kernel0` in order to call
   `compileKernel(kernel0, …)` — submit it now and let the runtime substitute.
4. **Submit recovery paths up front**, on the error channel.
5. **Cancel work you no longer need.** A superseded branch still holds a
   concurrency slot.
6. **Let one envelope be one thought**: read it whole, then submit one burst.

## Worked example

```
# everything independent goes out at once
prepareKernel({ size: 4096, dtype: "f32", arch: "sm90" })
→ c0 prepareKernel ⇒ kernel0, err0  [running]
loadDataset({ name: "wikitext-103", shards: 4 })
→ c1 loadDataset ⇒ dataset1, err1  [running]
flakyProbe({ target: "nvlink", trials: 3 })
→ c2 flakyProbe ⇒ probe2, err2  [running]

# past the concurrency limit an ack reads [queued] instead of [running];
# either way the line is answered instantly
# the dependent pipeline is submitted now too — it waits on its own handles
compileKernel(kernel0, { opt: 3 })
→ c3 compileKernel ⇒ kernel3, err3  [waiting: kernel0]
benchmark(kernel3, dataset1, { iters: 200 })
→ c4 benchmark ⇒ report4, err4  [waiting: kernel3, dataset1]
tune(report4, { budget: 8, target: "latency" })
→ c5 tune ⇒ plan5, err5  [waiting: report4]

# …and both branches off the call that is known to be flaky
explain(err2, { depth: "long" })
→ c6 explain ⇒ note6, err6  [waiting: err2]
summarize(probe2, { title: "link health" })
→ c7 summarize ⇒ digest7, err7  [waiting: probe2]

# …answer the user about something else; the turn is not blocked…

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

# c3 → c4 → c5 and c6 are already moving: nothing to re-submit, nothing to poll.
# The only new information is "retryable".
flakyProbe({ target: "nvlink", trials: 5 })
→ c8 flakyProbe ⇒ probe8, err8  [running]

<fluvia-notify agent="a0" session="s-20260915-174233">
3 calls settled within 3.1s — 3 ready.

ready
  c3 compileKernel → kernel3 : Kernel gemm_4096_f32 compiled · opt 3 · 71% occupancy (wait 0ms, run 890ms)
  c4 benchmark → report4 : Report gemm_4096_f32 on wikitext-103: 12.4 ms/iter · 5.4 TFLOP/s (wait 890ms, run 2.1s)
  c6 explain → note6 : Note why ProbeError: transient link contention, retry with more trials (wait 0ms, run 120ms)

now runnable
  c4 unblocked c5
</fluvia-notify>

.exit
```

Three real dependencies, eight concurrent calls, two turns of attention.
