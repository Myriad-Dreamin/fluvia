import * as React from 'react'
import { createRoot } from 'react-dom/client'
import toolbox from '@fluvia/toolbox-default'
import type { TraceEvent } from '@fluvia/core/types'
import { indexTrace } from '@fluvia/core/bench/slice'
import type { IndexedTrace, RecordedLine } from '@fluvia/core/bench/slice'
import { SliceSession } from '@fluvia/core/bench/session'
import type { CallComparison, SliceReport } from '@fluvia/core/bench/session'
import { runAgent } from './agent.ts'
import type { StopReason, Turn } from './agent.ts'
import events from 'bench:trace'

const { useEffect, useMemo, useRef, useState } = React

const trace: IndexedTrace = indexTrace(events as TraceEvent[])
const DEFAULT_FROM = 9
const DEFAULT_TO = trace.lines.findIndex((line) => line.line.includes('# the work is done'))

/** Task prompts for the default cut, written from the scenario each lane was playing. */
const GOALS: Record<string, string> = {
  planner:
    'Finish the main GPU pipeline from where the session stands: a compiled f32 kernel from kernel0 (opt 3, fastMath) benchmarked on imagenet-mini (200 iters, 20 warmup); an int8 quantised variant of that compiled kernel, recompiled at opt 2 so @tuner can benchmark it; the openwebmath dataset (3 shards) loaded for that benchmark; and, once @tuner has produced a latency plan from your benchmark report, one summary titled "gpu pipeline" that also folds in @tuner\'s recovery note and the probe diagnosis.',
  tuner:
    'Take the fp8 kernel on sm80 as far as it goes: compile it at opt 3, benchmark it on wikitext-103 and tune it if that works, and get a recovery note if it does not. Probe the nvlink and hbm3 interconnects. Then turn @planner\'s imagenet-mini benchmark report into a latency tuning plan, benchmark @planner\'s recompiled int8 kernel on the openwebmath dataset, and summarise that branch as "quantised branch".',
}

type Sample = Parameters<typeof runAgent>[0]['sample']

function App() {
  const [from, setFrom] = useState(DEFAULT_FROM)
  const [to, setTo] = useState(DEFAULT_TO > 0 ? DEFAULT_TO : trace.lines.length)
  const [mode, setMode] = useState<'agent' | 'mechanical'>('mechanical')

  const setCut = (index: number) => {
    setFrom(index)
    if (to <= index) setTo(Math.min(trace.lines.length, index + 1))
  }
  const setEnd = (index: number) => {
    if (index < from) return
    setTo(index + 1)
  }

  return (
    <div className="wrap">
      <header className="top">
        <span className="eyebrow">fluvia · benchmark method</span>
        <h1>Cut a recorded session, then continue it two ways</h1>
        <p className="lede">
          A fluvia session is recorded line by line. Choose a slice of it. The runtime is restored to the moment before
          the slice's first line, on a virtual clock. From there, an agent can take over one lane and carry on, or every
          recorded line can be replayed mechanically and diffed against what happened, to debug the harness itself.
        </p>
      </header>

      <section className="method" aria-label="The method">
        <div>
          <span className="eyebrow">1 · record</span>
          <b>Every line, answer and settlement</b>
          <span className="muted">
            This page holds session <span className="mono">{trace.meta.session}</span>: {trace.lines.length} lines from{' '}
            {trace.agents.join(' and ')}, {trace.calls.size} calls, {(trace.end / 1000).toFixed(1)}s.
          </span>
        </div>
        <div>
          <span className="eyebrow">2 · slice</span>
          <b>Restore the runtime at the cut</b>
          <span className="muted">
            Lines before the cut are replayed on their anchors, the result each line was typed after, so causal order
            survives without real time passing.
          </span>
        </div>
        <div>
          <span className="eyebrow">3 · continue</span>
          <b>Agent resumes, or replay mechanically</b>
          <span className="muted">
            The agent's thinking time is never charged to the dataflow. A mechanical replay involves no model, so every
            difference it reports comes from the harness.
          </span>
        </div>
      </section>

      <SliceCard from={from} to={to} onCut={setCut} onEnd={setEnd} />

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Continue the slice">
          <button type="button" aria-pressed={mode === 'mechanical'} onClick={() => setMode('mechanical')}>
            Debug the harness
          </button>
          <button type="button" aria-pressed={mode === 'agent'} onClick={() => setMode('agent')}>
            Agent resumes here
          </button>
        </div>
        <span className="muted">
          Slice: lines {from}–{to - 1}
        </span>
      </div>

      {mode === 'mechanical' ? <Mechanical from={from} to={to} /> : <AgentMode from={from} to={to} />}

      <footer className="note">
        <p>
          Everything on this page runs the real fluvia runtime in your browser: the parser, scheduler, notification hub
          and default toolbox from the repository, driven by <code>SliceSession</code>. The same engine runs from a terminal
          as <code>pnpm bench replay</code>, and the pi web app uses it to hand a slice to a pi agent.
        </p>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------------ slice */

function SliceCard(props: { from: number; to: number; onCut(i: number): void; onEnd(i: number): void }) {
  const { from, to } = props
  return (
    <section className="card">
      <div className="card-head">
        <div className="title">
          <h2>Recording</h2>
          <span className="muted">Click a line to cut there. Use “end” to close the slice.</span>
        </div>
        <div className="stats">
          <span className="chip green"><i className="dot" />done</span>
          <span className="chip red"><i className="dot" />failed</span>
          <span className="chip orange"><i className="dot" />skipped or cancelled</span>
        </div>
      </div>
      <div className="card-body">
        <Timeline from={from} to={to} />
        <LinesTable from={from} to={to} onCut={props.onCut} onEnd={props.onEnd} />
      </div>
    </section>
  )
}

function Timeline({ from, to }: { from: number; to: number }) {
  const span = Math.ceil(trace.end / 500) * 500
  const pct = (t: number) => `${(Math.max(0, Math.min(t, span)) / span) * 100}%`
  const cutT = trace.lines[from]?.t ?? trace.end
  const endT = to < trace.lines.length ? trace.lines[to]!.t : trace.end
  const ticks = [0, span * 0.25, span * 0.5, span * 0.75, span]
  return (
    <div className="timeline" aria-label="Calls over time, one lane per agent">
      {trace.agents.map((agent) => {
        const calls = [...trace.calls.values()].filter((call) => call.agent === agent)
        return (
          <div className="lane" key={agent}>
            <span className="lane-name">@{agent}</span>
            <div className="track">
              <div className="shade" style={{ left: pct(cutT), width: `calc(${pct(endT)} - ${pct(cutT)})` }} />
              {trace.lines
                .filter((line) => line.agent === agent)
                .map((line) => (
                  <div key={line.index} className="tick" style={{ left: pct(line.t) }} title={`line ${line.index}: ${line.line}`} />
                ))}
              {calls.map((call, i) => (
                <div
                  key={call.id}
                  className={`bar ${call.outcome ?? ''}`}
                  title={`${call.id} ${call.fn} ${call.outcome ?? ''}`}
                  style={{
                    left: pct(call.submitT),
                    width: `max(3px, calc(${pct(call.settleT ?? trace.end)} - ${pct(call.submitT)}))`,
                    top: 4 + (i % 3) * 8,
                  }}
                />
              ))}
            </div>
          </div>
        )
      })}
      <div className="axis">
        <span />
        <div className="axis-row num">
          {ticks.map((t, i) => (
            <span key={i} style={{ left: pct(t) }}>
              {(t / 1000).toFixed(1)}s
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function LinesTable(props: { from: number; to: number; onCut(i: number): void; onEnd(i: number): void }) {
  const { from, to } = props
  return (
    <div className="table-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>at</th>
            <th>agent</th>
            <th>typed after</th>
            <th>line</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {trace.lines.map((line) => {
            const inSlice = line.index >= from && line.index < to
            return (
              <tr
                key={line.index}
                className={`clickable ${inSlice ? 'in-slice' : ''} ${line.index === from ? 'cut' : ''}`}
                onClick={() => props.onCut(line.index)}
              >
                <td className="num faint">{line.index}</td>
                <td className="num muted">{Math.round(line.t)}ms</td>
                <td className="muted">{line.agent ? `@${line.agent}` : ''}</td>
                <td className="muted">{anchorText(line)}</td>
                <td className="code">{line.line.replace(/^@[\w-]+\s*/, '')}</td>
                <td>
                  {line.index === from ? (
                    <span className="chip accent">cut</span>
                  ) : line.index >= from ? (
                    <button
                      type="button"
                      className="row-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        props.onEnd(line.index)
                      }}
                    >
                      {line.index === to - 1 ? 'last' : 'end'}
                    </button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function anchorText(line: RecordedLine): string {
  if (line.anchor.kind === 'notify') {
    const call = trace.calls.get(line.anchor.call)
    return `${line.anchor.call} ${call?.fn ?? ''} settled`
  }
  if (line.anchor.kind === 'line') return `line ${line.anchor.index}`
  return 'session start'
}

/* ------------------------------------------------------------- mechanical */

function Mechanical({ from, to }: { from: number; to: number }) {
  const [concurrency, setConcurrency] = useState(trace.meta.concurrency)
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [report, setReport] = useState<SliceReport | null>(null)
  const [wall, setWall] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const token = useRef(0)

  useEffect(() => {
    const mine = ++token.current
    setBusy(true)
    const started = performance.now()
    const scoped = Object.fromEntries(Object.entries(edits).filter(([index]) => Number(index) >= from && Number(index) < to))
    SliceSession.open(trace, { from, to, toolbox, concurrency, edits: scoped })
      .then((session) => session.finish())
      .then((result) => {
        if (mine !== token.current) return
        setReport(result)
        setWall(performance.now() - started)
        setBusy(false)
      })
  }, [from, to, concurrency, edits])

  const sliceLines = trace.lines.slice(from, to).filter((line) => line.kind !== 'exit')
  const orderChanged = report?.order.filter((order) => !order.same) ?? []
  const lineDiffs = report?.lines.filter((line) => line.status !== 'same') ?? []

  return (
    <section className="card">
      <div className="card-head">
        <div className="title">
          <h2>Mechanical replay</h2>
          <span className="muted">No model involved: the recorded lines are typed again and every answer is compared.</span>
        </div>
        <div className="toolbar">
          <span className="label">Concurrency</span>
          <div className="stepper">
            <button type="button" aria-label="Lower concurrency" onClick={() => setConcurrency((c) => Math.max(1, c - 1))}>−</button>
            <span className="num">{concurrency}</span>
            <button type="button" aria-label="Raise concurrency" onClick={() => setConcurrency((c) => Math.min(8, c + 1))}>+</button>
          </div>
          <span className="faint">recorded at {trace.meta.concurrency}</span>
        </div>
      </div>
      <div className="card-body">
        <div className="stats">
          {report ? (
            <>
              <span className={`chip ${report.totals.diverged ? 'red' : 'green'}`}>
                <i className="dot" />
                {report.totals.same} of {report.calls.length} calls identical
              </span>
              {report.totals.diverged ? <span className="chip red">{report.totals.diverged} diverged</span> : null}
              {report.totals.missing ? <span className="chip orange">{report.totals.missing} missing</span> : null}
              <span className={`chip ${orderChanged.length ? 'orange' : 'green'}`}>
                notification order {orderChanged.length ? `changed for ${orderChanged.map((o) => '@' + o.agent).join(', ')}` : 'unchanged'}
              </span>
              <span className={`chip ${lineDiffs.length ? 'orange' : ''}`}>{lineDiffs.length} answers differ</span>
              <span className="faint num">
                {busy ? 'replaying…' : `restored and replayed in ${Math.round(wall)}ms`}
              </span>
            </>
          ) : (
            <span className="muted">Replaying…</span>
          )}
          {Object.keys(edits).length ? (
            <button type="button" className="btn small" onClick={() => setEdits({})}>
              Clear {Object.keys(edits).length} edit{Object.keys(edits).length === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>agent</th>
                <th>line as replayed</th>
                <th>recorded result</th>
                <th>replayed result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sliceLines.map((line) => {
                const call = report?.calls.find((c) => c.line === line.index)
                const outcome = report?.lines.find((l) => l.index === line.index)
                return (
                  <tr key={line.index}>
                    <td className="num faint">{line.index}</td>
                    <td className="muted">@{line.agent}</td>
                    <td className="code">
                      {editing === line.index ? (
                        <LineEditor
                          initial={(edits[line.index] ?? line.line).replace(/^@[\w-]+\s*/, '')}
                          onCancel={() => setEditing(null)}
                          onSave={(text) => {
                            setEditing(null)
                            const full = `@${line.agent} ${text}`
                            setEdits((current) => {
                              const next = { ...current }
                              if (full === line.line) delete next[line.index]
                              else next[line.index] = full
                              return next
                            })
                          }}
                        />
                      ) : (
                        <>
                          {edits[line.index] ? (
                            <>
                              <span className="diff-old">{line.line.replace(/^@[\w-]+\s*/, '')}</span>
                              {'\n'}
                              <span className="diff-new">{edits[line.index]!.replace(/^@[\w-]+\s*/, '')}</span>
                            </>
                          ) : (
                            (outcome?.replayed ?? line.line).replace(/^@[\w-]+\s*/, '')
                          )}
                        </>
                      )}
                    </td>
                    <td>{call ? <Facts call={call} side="recorded" /> : <span className="faint">{line.output[0]?.split('\n')[0] ?? line.kind}</span>}</td>
                    <td>
                      {call ? (
                        <Facts call={call} side="replayed" />
                      ) : outcome ? (
                        <span className={outcome.status === 'same' ? 'faint' : 'st-skipped'}>
                          {outcome.status === 'same' ? 'same answer' : outcome.outputReplayed[0]?.split('\n')[0] ?? 'different'}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {editing !== line.index ? (
                        <button type="button" className="row-btn" onClick={() => setEditing(line.index)}>
                          edit
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {orderChanged.length ? (
          <div className="order">
            <h3>Notification order</h3>
            {orderChanged.map((order) => (
              <OrderDiff key={order.agent} agent={order.agent} recorded={order.recorded} replayed={order.replayed} />
            ))}
          </div>
        ) : null}

        <p className="faint">
          Try it: lower concurrency to 1 or 2 and watch queue order change while outcomes hold. Or edit{' '}
          <code>compileKernel(kernel5, {'{ opt: 3 }'})</code> to <code>opt: 7</code>, and the failure and the recovery that
          depends on it both diverge.
        </p>
      </div>
    </section>
  )
}

function Facts({ call, side }: { call: CallComparison; side: 'recorded' | 'replayed' }) {
  const facts = side === 'recorded' ? call.recorded : call.replayed
  if (!facts) return <span className="chip orange">not scheduled</span>
  const changed = side === 'replayed' && call.diffs.length > 0
  const tone = facts.outcome === 'done' ? 'green' : facts.outcome === 'failed' ? 'red' : 'orange'
  return (
    <div style={{ display: 'grid', gap: 3 }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`chip ${tone}`}>
          <i className="dot" />
          {facts.outcome}
        </span>
        <span className="mono faint">{facts.id}</span>
        {facts.runMs !== undefined ? <span className="faint num">{Math.round(facts.runMs)}ms</span> : null}
        {changed ? <span className="chip red">diverged</span> : null}
      </span>
      <span className={changed && call.diffs.some((d) => d.field !== 'outcome') ? 'diff-new' : 'muted'} style={{ fontSize: 12 }}>
        {facts.summary}
      </span>
    </div>
  )
}

function LineEditor(props: { initial: string; onSave(text: string): void; onCancel(): void }) {
  const [text, setText] = useState(props.initial)
  return (
    <form
      style={{ display: 'grid', gap: 6 }}
      onSubmit={(event) => {
        event.preventDefault()
        props.onSave(text.trim())
      }}
    >
      <input id="line-editor" className="field mono" value={text} autoFocus onChange={(event) => setText(event.target.value)} />
      <span style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="btn small primary">Replay with edit</button>
        <button type="button" className="btn small" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  )
}

function OrderDiff({ agent, recorded, replayed }: { agent: string; recorded: string[]; replayed: string[] }) {
  return (
    <>
      <div className="order-row">
        <span className="lane-name">recorded</span>
        <div className="seq">
          {recorded.map((item, i) => (
            <span key={i} className={`chip ${replayed[i] === item ? '' : 'orange'}`}>{item}</span>
          ))}
          <span className="faint">@{agent}</span>
        </div>
      </div>
      <div className="order-row">
        <span className="lane-name">replayed</span>
        <div className="seq">
          {replayed.map((item, i) => (
            <span key={i} className={`chip ${recorded[i] === item ? '' : 'orange'}`}>{item}</span>
          ))}
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ agent */

function AgentMode({ from, to }: { from: number; to: number }) {
  const [lane, setLane] = useState(trace.agents[0]!)
  const [goal, setGoal] = useState(GOALS[trace.agents[0]!] ?? '')
  const [tier, setTier] = useState<'quick' | 'default'>('default')
  const [budget, setBudget] = useState(6)
  const [preview, setPreview] = useState<{ transcript: string; state: string } | null>(null)
  const [sample, setSample] = useState<Sample | null | undefined>(undefined)
  const [turns, setTurns] = useState<Turn[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ reason: StopReason; report: SliceReport } | null>(null)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const claude = (window as unknown as { claude?: { use(name: string): Promise<unknown> } }).claude
    if (!claude?.use) {
      setSample(null)
      return
    }
    claude.use('sample').then((fn) => setSample((fn as Sample) ?? null), () => setSample(null))
  }, [])

  useEffect(() => {
    let live = true
    SliceSession.open(trace, { from, to, toolbox, takeover: lane }).then((session) => {
      if (live) setPreview({ transcript: session.transcript(), state: session.state() })
    })
    return () => {
      live = false
    }
  }, [from, to, lane])

  const reference = useMemo(
    () => [...trace.calls.values()].filter((call) => call.agent === lane && call.line >= from && call.line < to),
    [lane, from, to],
  )

  const start = async () => {
    if (!sample) return
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    setResult(null)
    setTurns([])
    const session = await SliceSession.open(trace, { from, to, toolbox, takeover: lane })
    const { reason } = await runAgent({ session, sample, toolbox, goal, tier, budget, signal: abort.signal, onUpdate: setTurns })
    setResult({ reason, report: session.report() })
    setRunning(false)
  }

  return (
    <section className="card">
      <div className="card-head">
        <div className="title">
          <h2>Agent resumes from the cut</h2>
          <span className="muted">Claude takes over one lane. The other lane keeps replaying its recording and consumes what the agent produces.</span>
        </div>
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Lane to take over">
            {trace.agents.map((agent) => (
              <button
                key={agent}
                type="button"
                aria-pressed={lane === agent}
                disabled={running}
                onClick={() => {
                  setLane(agent)
                  setGoal(GOALS[agent] ?? '')
                  setTurns([])
                  setResult(null)
                }}
              >
                @{agent}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="card-body">
        <div className="split">
          <div className="panel">
            <h3>What the agent is given</h3>
            <label className="label" htmlFor="goal">Goal</label>
            <textarea id="goal" className="field" rows={6} value={goal} disabled={running} onChange={(event) => setGoal(event.target.value)} />
            <details>
              <summary>Lane transcript up to the cut</summary>
              <pre className="transcript">{preview?.transcript || 'Restoring…'}</pre>
            </details>
          </div>
          <div className="panel">
            <h3>State at the cut</h3>
            <div className="tasks">
              {(preview?.state ?? '').split('\n').filter(Boolean).map((row) => {
                const match = /^(c\d+) (\w+) \[(\w+)\] (.*)$/.exec(row)
                if (!match) return <span key={row} className="faint">{row}</span>
                return (
                  <div className="task" key={row}>
                    <i className={`dot st-${match[3]}`} />
                    <span className="mono faint">{match[1]}</span>
                    <span>
                      <b style={{ fontWeight: 500 }}>{match[2]}</b> <span className={`st-${match[3]}`}>{match[3]}</span>
                      <span className="muted"> · {match[4]}</span>
                    </span>
                  </div>
                )
              })}
            </div>
            <details>
              <summary>Recorded continuation, hidden from the agent ({reference.length} calls)</summary>
              <div className="seq" style={{ marginTop: 6 }}>
                {reference.map((call) => (
                  <span key={call.id} className={`chip ${call.outcome === 'done' ? 'green' : call.outcome === 'failed' ? 'red' : 'orange'}`}>
                    {call.fn}
                  </span>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className="toolbar">
          {running ? (
            <button type="button" className="btn" onClick={() => controller.current?.abort()}>Stop</button>
          ) : (
            <button type="button" className="btn primary" disabled={!sample || !goal.trim()} onClick={start}>
              Run agent from line {from}
            </button>
          )}
          <span className="sep" />
          <span className="label">Model</span>
          <div className="seg" role="group" aria-label="Model tier">
            <button type="button" aria-pressed={tier === 'default'} disabled={running} onClick={() => setTier('default')}>Default</button>
            <button type="button" aria-pressed={tier === 'quick'} disabled={running} onClick={() => setTier('quick')}>Quick</button>
          </div>
          <span className="label">Turns</span>
          <div className="stepper">
            <button type="button" aria-label="Fewer turns" disabled={running} onClick={() => setBudget((b) => Math.max(1, b - 1))}>−</button>
            <span className="num">{budget}</span>
            <button type="button" aria-label="More turns" disabled={running} onClick={() => setBudget((b) => Math.min(12, b + 1))}>+</button>
          </div>
        </div>

        {sample === null ? (
          <p className="notice">
            Agent runs use Claude through the claude.ai viewer, which this view cannot reach. Open the page in claude.ai to
            run one. Each turn is one request on your own Claude usage.
          </p>
        ) : sample === undefined ? (
          <p className="notice info">Checking whether this view can run an agent…</p>
        ) : !turns.length ? (
          <p className="notice info">
            Each turn is one request on your Claude usage, and a default-tier turn usually takes 10 to 60 seconds. Virtual
            time stays frozen while Claude thinks.
          </p>
        ) : null}

        {turns.length ? (
          <div className="log">
            {turns.map((turn) => (
              <TurnView key={turn.n} turn={turn} />
            ))}
          </div>
        ) : null}

        {result?.report.agent ? <Scorecard reason={result.reason} report={result.report} /> : null}
      </div>
    </section>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="turn">
      <div className="turn-head">
        <span className="chip accent">turn {turn.n}</span>
        {turn.status === 'thinking' ? (
          <span className="thinking" aria-label="Thinking"><i /><i /><i /></span>
        ) : null}
        {turn.error ? <span className="chip red">{turn.error}</span> : null}
        <span>{turn.tools.reduce((n, tool) => n + tool.lines.length, 0)} lines submitted</span>
      </div>
      {turn.tools.map((tool, i) => (
        <div className="tool" key={i}>
          <span className="faint" style={{ fontSize: 11.5 }}>fluvia</span>
          <pre className="transcript" style={{ maxHeight: 'none', color: 'var(--ink)' }}>{tool.answer}</pre>
        </div>
      ))}
      {turn.text.trim() ? <p className="muted">{turn.text.trim()}</p> : null}
      {turn.wake ? (
        <div className="wake">
          <span className="num">
            woke at +{(turn.wake.at / 1000).toFixed(2)}s virtual{turn.wake.idle ? ' · nothing left running' : ''}
          </span>
          {turn.wake.notifications.length ? (
            <pre className="transcript" style={{ maxHeight: 'none' }}>{turn.wake.notifications.join('\n')}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Scorecard({ reason, report }: { reason: StopReason; report: SliceReport }) {
  const score = report.agent!
  const reasons: Record<StopReason, string> = {
    done: 'the agent declared the goal done',
    idle: 'nothing was left running and nothing new arrived',
    budget: 'the turn budget ran out',
    stopped: 'you stopped the run',
    error: 'a request failed',
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <h3>Scorecard <span className="muted" style={{ fontWeight: 400 }}>· stopped because {reasons[reason]}</span></h3>
      <div className="score">
        <div>
          <span className="label">Recorded work reproduced</span>
          <span className="v">{Math.round(score.coverage * 100)}%</span>
          <div className="meter"><i style={{ width: `${score.coverage * 100}%` }} /></div>
        </div>
        <div>
          <span className="label">Wasted calls and refused lines</span>
          <span className="v">{score.wasted}</span>
        </div>
        <div>
          <span className="label">Virtual time to last result</span>
          <span className="v">{(score.spanMs.agent / 1000).toFixed(2)}s</span>
          <span className="faint num">recorded {(score.spanMs.recorded / 1000).toFixed(2)}s</span>
        </div>
        <div>
          <span className="label">Other lane’s calls unaffected</span>
          <span className="v">{report.totals.same}/{report.calls.length}</span>
          <span className="faint">{report.totals.diverged} diverged · {report.totals.missing} missing</span>
        </div>
      </div>
      <div className="seq">
        {score.calls.map((call) => (
          <span key={call.id} className={`chip ${call.outcome === 'done' ? 'green' : call.outcome === 'failed' ? 'red' : 'orange'}`} title={call.summary}>
            {call.id} {call.fn}
          </span>
        ))}
      </div>
      {score.errors.length ? <pre className="transcript">{score.errors.join('\n')}</pre> : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
