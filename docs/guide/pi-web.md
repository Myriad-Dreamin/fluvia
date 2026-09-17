# The browser app

`packages/pi-web-fluvia` is a pi agent (`@mariozechner/pi-web-ui`) driving
`@fluvia/core` entirely in the browser. There is no server: the fluvia
runtime, the toolbox and the trace all live in the page. The agent meets fluvia
in one of two modes — a live runtime it drives from scratch, or a recorded
session resumed from a cut.

It is not published. Run it from a checkout:

```sh
pnpm --filter pi-web-fluvia dev       # vite dev server
pnpm --filter pi-web-fluvia build     # typecheck, then dist/
pnpm --filter pi-web-fluvia preview   # serve dist/
```

`dist/` uses relative asset URLs, so it works from any path.

## Setting up a model

The app talks to the model directly from the page, so you supply the endpoint
and the key. The **Model** panel has two kinds, because they are different
things:

- **Custom endpoint** — any server speaking a known wire format at a base URL you
  give, with whatever model id it accepts. Pick the API format
  (OpenAI-compatible chat completions, or Anthropic messages) and give the base
  URL, e.g. `https://llm.example.com/v1`. It is not filed under a catalogued
  provider; its API key is stored under the endpoint's host. Nothing about
  pricing or thinking parameters is assumed.
- **Known provider** — a provider pi-ai knows, with its endpoint, request quirks
  and pricing. Choose the provider, then a model id from its catalogue or one it
  does not list yet; an unlisted id keeps the provider's request format.

**Use this model** applies the choice and stores it in `localStorage`. Keys and
sessions live in IndexedDB; **Settings** opens pi-web-ui's providers, models and
proxy tabs.

## Live runtime

The **Live runtime** tab starts a fluvia runtime inside the page at the chosen
concurrency, hands the agent a `fluvia` tool over it, and delivers settled calls
back to the agent as coalesced `<fluvia-notify>` messages. Once it is running,
the panel lists the whole instruction set it published, and a progress strip
under the chat counts calls by state — running, queued, waiting, done, failed,
skipped.

### Example prompts

An empty conversation shows three example prompts as a card in the chat; once
the conversation starts they move behind an **Examples** button. Each is written
against the default toolbox and exercises something fluvia is for: parallel
roots, a dependency chain, a failure that feeds a recovery branch, and a join.

| prompt | what it asks for |
| --- | --- |
| Two kernels, one fails | two kernels prepared and compiled in parallel, a dataset loaded alongside, the one that compiles benchmarked, a recovery note for the one that does not, and a summary once everything has settled |
| Quantised variant | a kernel compiled, quantised to 8 bits and recompiled, both variants benchmarked on wikitext-103, and the faster one tuned for latency |
| Interconnect health | three probes, one of which fails by construction, every failure explained and the health summarised once the diagnoses are in |

A fourth entry, **Check workflow using preset trace (zero cost)**, replays a real
recorded run with no model at all. It is the way to see what the app does without
an API key.

## Resume from a slice

The **Resume from a slice** tab loads a recording, cuts it, and hands one lane to
the model while the other lanes replay their recording around it. Load a trace
exported with `pnpm slice export --trace <gz> --out <json>`, or press **Demo
trace** for the one bundled with the app.

Once a trace is loaded the panel shows its session, its line count and its lanes,
and offers:

| control | meaning |
| --- | --- |
| Cut before line (from) | the recorded line the slice begins at; the runtime is restored to the moment before it |
| Replay up to line (to, exclusive) | an upper bound; blank replays to the end |
| Take over lane | which lane the model drives |
| Task | what the lane is told to do — the demo trace's lanes have an example task each, or use the generic one |
| Turn budget (wake-ups) | how many times the agent may be woken before the run stops |

The loop is the same one a takeover case runs: the agent submits lines through
the `fluvia` tool, and when its turn ends, `wake()` moves virtual time until the
lane has notifications, which re-prompt it. Virtual time only moves inside
`wake()`, so the model's thinking is never charged to the dataflow. The run stops
when the lane is idle, when it stalls, when the turn budget is spent, or when you
press **Stop** — and the panel then shows the wake log and the slice scorecard.

## Exporting a trace

Trace export and replay are developer tools, not UI: they live on a `fluvia`
object in the browser console.

```js
fluvia.help()
```

```
fluvia.exportTrace()                  download the current run as trace-*.json (and return it)
fluvia.exportTrace({ download: false }) return it without downloading
fluvia.replayTrace(trace)             replay a trace object, JSON text or URL with no model
fluvia.replayTrace(trace, { speed: 'instant' })
fluvia.replayExample()                replay the bundled scripted example
fluvia.stopReplay()
```

`fluvia.exportTrace()` builds a `trace.json` of the run the chat is showing and
downloads it: the model and system prompt, the whole conversation in order, the
fluvia runtime's event stream, and — for a slice — the setup, the task and the
recorded session it was cut from. That file is a recording a case can name
directly, and the conversation in it is what makes `cut: { turn: n }` work:

```ts
export default defineBench({
  name: 'preset · the summary turn, replayed',
  trace: '../traces/preset-trace.json',
  cut: { turn: 3 },
  judge: [judges.outcomes({ same: true }), judges.settled('summarize', 'done'), judges.handleReady('digest9')],
})
```

## Replaying one

`fluvia.replayTrace(source)` plays a trace again with no model: the recorded
model turns are fed back through pi-ai's faux provider while the fluvia runtime
really executes every call, so the calls, notifications and wake-ups happen again
rather than being redrawn. `source` may be a trace object, its JSON text, or a
URL to fetch. `{ speed: 'instant' }` skips the streaming animation.
`fluvia.replayExample()` does this with the run bundled in the app.

Each replay logs its progress, and any drift from the recording is printed as a
table when it ends — or, when there is none:

```
[fluvia replay] no drift: every model turn saw what it saw in the recording
```

The same machinery runs headless in Node:

```sh
pnpm --filter pi-web-fluvia replay path/to/trace.json [--full]
```

It prints what the trace was recorded with, the replayed conversation, the drift
from the recording, and for a slice the agent's scorecard. `--full` prints whole
messages instead of their first lines. `pnpm --filter pi-web-fluvia verify` is
the headless check that runs in CI; it drives the slice loop from Node with no
DOM.
