# How it works

```
 record ──▶ cut ──▶ swap one piece ──▶ run ──▶ score
 trace      line 9   concurrency         virtual   judges over the world,
            turn 3   an edited line      clock     then a diff against
            notify   a call's impl                 the recording
                     a lane's agent
```

## Record

Any run produces a trace: every line, every settlement, every notification, and
for a chat-driven run the conversation too. Export one from the CLI (`--trace`),
from the browser app, or from the dsh plugin. The formats and every event kind
are in [the trace reference](../reference/trace).

The conversation matters for one reason: it is the only place that says which
lines belonged to which model turn. That is what makes `cut: { turn: 3 }`
meaningful on a recording whose lines were all typed by the same lane.

## Cut

Pick a line, a notification, or a model turn. The runtime is restored to the
moment before it. Everything earlier is replayed on a virtual clock, each line
anchored to the result it was reacting to, so causal order survives and no real
time passes.

### The anchored replay

A recorded line is not replayed at the wall-clock moment it was typed. It is
replayed on its **anchor**: the event the agent was reacting to when it typed it,
plus the gap that followed. `fluvia slice lines` prints those anchors:

```
  6  c6       after line 5 +0.974ms  @planner explain(err4, { depth: "short" })
  7  c7       after c3 +1.151ms      @planner explain(err3, { depth: "deep" })
  8  control  after c2 +17.068ms     @planner cancel(c4)
  9  c8       after c6 +0.618ms      @planner compileKernel(kernel0, { opt: 3, fastMath: true })
```

Line 7 was typed 1.151 ms after `c3` was notified, line 9 after `c6` was. When
the replay changes how fast things settle — a different concurrency, a slower
implementation — those lines move with the notifications they were answers to
rather than with a stopwatch. That is what lets a replay under a different
scheduler still mean the same thing.

### The virtual clock

The replayed runtime does not sleep. `@fluvia/core/bench/clock` advances time to
the next scheduled event, so a recording with a nine-second `sleep()` in it
replays in milliseconds — the wall time printed by `fluvia bench` is the cost of
running the harness, not of the session. Virtual time only moves when the slice
asks it to, which is also why an agent taken over mid-slice is never charged for
thinking: time advances inside `wake()`, not while the model is sampling.

## Swap one piece

A case changes exactly one thing. Everything else stays as recorded.

| what changes | what stays |
| --- | --- |
| the scheduler's concurrency | every line, every implementation |
| one recorded line, by index | every other line, the toolbox |
| one instruction's implementation | every line, the scheduler |
| one lane, handed to a live driver | the other lanes, replaying their recording around it |

`defineBench` refuses a subject with two things in it, so "one piece" is checked
rather than merely intended.

## Run

Only the part after the cut executes. A mechanical replay types the recorded
lines again on their anchors. A takeover hands one lane to a driver, which may be
a model, while the other lanes replay around it and consume what it produces —
so a takeover that binds different handle names than the recording did is caught
by the other lanes failing, not by a string comparison.

Where the slice stops is the case's `horizon`: `'complete'` drains the runtime,
`{ reach: [...] }` stops as soon as every predicate holds and fails if one never
does.

## Score

Judges are predicates over the resulting world: which calls settled how, which
handles are ready, what a digest folds. A judge is a function of
`{ report, calls, handles, events, trace }`, so a question that does not fit a
matcher vocabulary is just written out.

The diff against the recording is one judge among them, not the verdict. It is
`judges.outcomes`, and it is the default when a case names no judge at all — but
a case that *expects* divergence asserts it instead:

```ts
judge: [judges.failed('c9', 'UnsupportedOptLevel'), judges.outcomes({ diverged: 2, missing: 0 }), recoveryNamesTheNewError]
```

Two calls diverged and no more; the compile failed with that specific error; and
the note that recovery produced names the new error rather than the recorded one.
See [writing cases](./cases) for the whole vocabulary.
