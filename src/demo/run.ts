/**
 * `pnpm demo` — drives the fluvia CLI the way an agent would.
 *
 * This is not an in-process simulation: it spawns `src/cli/bin.ts` as a real
 * child process, writes lines to its stdin and reads its NDJSON stdout
 * (PROTOCOL §4). Everything the demo proves — that the CLI answers instantly,
 * that notifications arrive out of order, that `cancel()` interrupts work in
 * flight — is proved across a process boundary, over the same interface an LLM
 * agent would use.
 *
 * The scenario itself lives in {@link file://./script.ts}; this module is only
 * the machinery: placeholder substitution, trigger evaluation, response
 * matching, settlement detection, shutdown and the closing summary.
 *
 * Two environment knobs exist so the driver can be exercised without the real
 * CLI (there is a protocol-speaking stub in the test scratchpad):
 *
 * - `FLUVIA_CLI` — path to the CLI entry, default `src/cli/bin.ts`;
 * - `FLUVIA_DEMO_TIMEOUT` — global deadline in ms, default 60000.
 *
 * @module fluvia/demo/run
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'
import type { Notification } from '../core/types.ts'
import { script, type Step, type Trigger } from './script.ts'

/** Project root, derived from this file so the demo runs from any cwd. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** How long the whole scripted session may take before we give up on it. */
const TIMEOUT_MS = Number(process.env.FLUVIA_DEMO_TIMEOUT ?? 60_000)

/** How long we wait for the child to exit after `.exit` before killing it. */
const SHUTDOWN_GRACE_MS = 10_000

/** Scheduler concurrency the demo asks for; the script is written around it. */
const CONCURRENCY = 4

/* ------------------------------------------------------------------ protocol */

/** The CLI's answer to a submitted async call (PROTOCOL §4). */
interface AckEvent {
  type: 'ack'
  call: string
  seq: number
  fn: string
  agent: string
  bind: { value: string; error: string }
  deps?: unknown[]
  state?: string
}

/** Every line the CLI writes on stdout in machine mode. */
type CliEvent =
  | { type: 'ready'; session?: string; agent?: string; functions?: string[] }
  | AckEvent
  | { type: 'error'; message: string; line?: string }
  | { type: 'control'; fn: string; text?: string; rows?: unknown[] }
  | ({ type: 'result' } & Notification)
  | { type: 'bye'; stats?: Record<string, unknown> }
  | { type: string; [key: string]: unknown }

/* -------------------------------------------------------------------- lines */

/** `$label`, `$label.value`, `$label.err` — see the table in `script.ts`. */
const PLACEHOLDER = /\$([A-Za-z_][A-Za-z0-9_]*)(?:\.(value|err|error|call))?/g

/** Labels a line refers to; a step implicitly waits for all of them to ack. */
function referencedLabels(line: string): string[] {
  return [...line.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

/** The function name a line calls, used to sanity-check response matching. */
function fnOf(line: string): string {
  return line.trim().split(/[\s(]/, 1)[0] ?? ''
}

/** A line with no call in it: traced by the CLI, but never answered. */
function isComment(line: string): boolean {
  return line.trim().startsWith('#')
}

/** Format a duration the way the closing summary and the live log want it. */
function ms(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`
}

/** Human-readable file size for the trace line of the summary. */
function bytes(value: number): string {
  if (value >= 1 << 20) return `${(value / (1 << 20)).toFixed(1)} MiB`
  if (value >= 1 << 10) return `${(value / (1 << 10)).toFixed(1)} KiB`
  return `${value} B`
}

/** Session id of the shape the protocol uses for trace names: `s-YYYYMMDD-HHMMSS`. */
function sessionId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `s-${date}-${time}`
}

/* ------------------------------------------------------------------- driver */

/**
 * One demo run: owns the child process, the state accumulated from its output
 * and the waiters that make the script reactive.
 */
class Demo {
  /** Label → the ack the CLI returned for that step's line. */
  private readonly acks = new Map<string, AckEvent>()
  /** Call id → the label that submitted it, for readable logging. */
  private readonly labelOf = new Map<string, string>()
  /** Every call the CLI acked, labelled or not: the settlement set. */
  private readonly submitted = new Set<string>()
  /** Call id → its settle notification, once it arrives. */
  private readonly results = new Map<string, Notification>()
  /** Lines sent and not yet answered, in send order. */
  private readonly outstanding: { step: Step; fn: string }[] = []
  /** Conditions the script is currently blocked on; re-tested on every event. */
  private readonly waiters: { test: () => boolean; resolve: () => void }[] = []
  /** Unparseable stdout lines, reported but not fatal. */
  private readonly junk: string[] = []
  /** Lines the CLI rejected outright (`{"type":"error"}`). */
  private readonly rejected: { message: string; line?: string }[] = []
  /** Steps never sent because a placeholder could not be resolved. */
  private readonly dropped: { step: Step; unresolved: string[] }[] = []

  private child?: ReturnType<typeof spawn>
  private childExit?: { code: number | null; signal: NodeJS.Signals | null }
  private sawBye = false
  private startedAt = Date.now()
  private reportedSession?: string

  constructor(
    readonly session: string,
    readonly tracePath: string,
    readonly notifyPath: string,
    readonly cliPath: string,
  ) {}

  /* ------------------------------------------------------------- lifecycle */

  /** Spawn the CLI and start consuming its output. Resolves once it is up. */
  async start(): Promise<void> {
    const args = [
      '--import',
      'tsx',
      this.cliPath,
      '--json',
      '--trace',
      this.tracePath,
      '--preload',
      'src/toolbox/default.ts',
      '--concurrency',
      String(CONCURRENCY),
      '--notify',
      `dsh:file:${relative(ROOT, this.notifyPath)}`,
      '--notify',
      'stdout',
    ]
    // With an inbox running (`pnpm dsh-inbox`), the same envelopes are also
    // posted over http — the transport a real dsh deployment would use.
    if (process.env.FLUVIA_DSH_HTTP) args.push('--notify', `dsh:http:${process.env.FLUVIA_DSH_HTTP}`)
    // `--import tsx` rather than a build step: the demo must run straight from
    // a fresh checkout, and process.execPath keeps us on the same Node.
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.startedAt = Date.now()

    // Writing to a CLI that has already died is EPIPE, which is information,
    // not a reason for the driver to abort mid-report.
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') console.error(`[demo] stdin: ${err.message}`)
    })

    child.on('error', (err) => {
      console.error(`[demo] failed to spawn CLI: ${err.message}`)
      this.childExit = { code: -1, signal: null }
      this.flushWaiters()
    })
    child.on('exit', (code, signal) => {
      this.childExit = { code, signal }
      this.flushWaiters()
    })
    // The child's stderr is the only place a crash explains itself, so forward
    // it verbatim rather than swallowing it.
    createInterface({ input: child.stderr! }).on('line', (line) => console.error(`[cli:stderr] ${line}`))
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))

    // Wait for the banner, but do not insist on it: a CLI that starts emitting
    // acks without a `ready` line is still usable.
    await this.waitUntil(() => this.reportedSession !== undefined || this.dead, 5_000)
  }

  /** True once the child has exited, however it exited. */
  private get dead(): boolean {
    return this.childExit !== undefined
  }

  /** Parse one stdout line and fold it into the session state. */
  private onLine(raw: string): void {
    const text = raw.trim()
    if (!text) return
    let event: CliEvent
    try {
      event = JSON.parse(text) as CliEvent
    } catch {
      // Robustness rule: a CLI that prints a stray line must not kill the demo.
      this.junk.push(text)
      console.error(`[demo] unparseable stdout line: ${text.slice(0, 160)}`)
      return
    }

    switch (event.type) {
      case 'ready':
        this.reportedSession = typeof event.session === 'string' ? event.session : this.session
        console.log(
          `[cli] ready · session ${this.reportedSession} · ${(event.functions as string[] | undefined)?.length ?? '?'} functions preloaded`,
        )
        break
      case 'ack': {
        const ack = event as AckEvent
        this.submitted.add(ack.call)
        const step = this.claim(ack.fn)
        if (step?.id) {
          this.acks.set(step.id, ack)
          this.labelOf.set(ack.call, step.id)
        }
        console.log(
          `  ack ${ack.call.padEnd(4)} ${ack.fn} → ${ack.bind?.value}/${ack.bind?.error}` +
            `${ack.deps?.length ? ` deps=${ack.deps.length}` : ''} [${ack.state ?? 'queued'}]`,
        )
        break
      }
      case 'control': {
        this.claim(event.fn as string)
        const body = String((event as { text?: string }).text ?? '').split('\n')
        console.log(`  ${event.fn} →`)
        for (const line of body.slice(0, 24)) console.log(`    ${line}`)
        if (body.length > 24) console.log(`    … ${body.length - 24} more lines`)
        break
      }
      case 'error': {
        const err = event as { message: string; line?: string }
        this.claim(fnOf(err.line ?? ''))
        this.rejected.push(err)
        console.error(`  !! rejected: ${err.message}${err.line ? ` (${err.line})` : ''}`)
        break
      }
      case 'result': {
        const note = event as { type: 'result' } & Notification
        this.results.set(note.call, note)
        const label = this.labelOf.get(note.call)
        const detail =
          note.outcome === 'done'
            ? `${note.ready?.name ?? ''} = ${note.ready?.summary ?? ''}`
            : note.outcome === 'failed'
              ? `${note.error?.kind}: ${note.error?.message}`
              : note.outcome === 'skipped'
                ? `${note.skip?.reason} from ${note.skip?.from}`
                : 'cancelled'
        console.log(
          `  <- ${note.call.padEnd(4)} ${note.outcome.padEnd(9)} ${note.fn}${label ? ` (${label})` : ''} ` +
            `· wait ${ms(note.timing?.waitedMs ?? 0)} run ${ms(note.timing?.runMs ?? 0)} · ${detail}`,
        )
        break
      }
      case 'bye':
        this.sawBye = true
        break
      case 'log': {
        // CLI-level messages (a failed preload, a bad sink spec) travel as
        // their own event in machine mode; an error here explains everything
        // that goes wrong afterwards, so never swallow it.
        const log = event as { level?: string; text?: string; message?: string }
        const text = log.text ?? log.message ?? ''
        if (log.level === 'error') console.error(`[cli] ${text}`)
        else console.log(`[cli] ${text}`)
        break
      }
      default:
        // Unknown event types are forward-compatible, not errors.
        break
    }
    this.flushWaiters()
  }

  /**
   * Match a response to the line that caused it. The CLI answers in order, so
   * the queue head is normally right; when it is not (an event we did not
   * anticipate), skip forward to the first line that called this function
   * rather than silently mis-labelling every later call.
   */
  private claim(fn: string): Step | undefined {
    if (this.outstanding.length === 0) return undefined
    if (this.outstanding[0]!.fn === fn || !fn) return this.outstanding.shift()!.step
    const index = this.outstanding.findIndex((entry) => entry.fn === fn)
    if (index < 0) return this.outstanding.shift()!.step
    const dropped = this.outstanding.splice(0, index + 1)
    for (const entry of dropped.slice(0, -1)) {
      console.error(`[demo] no response matched for: ${entry.step.agent} ${entry.step.line}`)
    }
    return dropped[dropped.length - 1]!.step
  }

  /* --------------------------------------------------------------- waiting */

  /** Resolve every waiter whose condition now holds. */
  private flushWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.test()) this.waiters.splice(i, 1)[0]!.resolve()
    }
  }

  /**
   * Block until `test` holds, the child dies, or `limit` elapses. Returns
   * whether the condition actually became true — callers decide what a
   * timeout means.
   */
  private waitUntil(test: () => boolean, limit: number): Promise<boolean> {
    // Waiters are only re-tested when an event arrives, so a condition that is
    // already decided — or a child that is already gone — must short-circuit
    // here; otherwise it would sit out its whole timeout with nothing left to
    // wake it.
    if (test() || this.dead) return Promise.resolve(test())
    return new Promise((resolveWait) => {
      const entry = {
        test: () => test() || this.dead,
        resolve: () => {
          clearTimeout(timer)
          resolveWait(test())
        },
      }
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(entry)
        if (at >= 0) this.waiters.splice(at, 1)
        resolveWait(test())
      }, limit)
      this.waiters.push(entry)
    })
  }

  /** The call id behind a script label, or the label itself if it is an id. */
  private callOf(label: string): string | undefined {
    const ack = this.acks.get(label)
    if (ack) return ack.call
    return /^c\d+$/.test(label) ? label : undefined
  }

  /** Evaluate a step's release condition. */
  private async release(trigger: Trigger | undefined, budget: number): Promise<void> {
    if (!trigger) return
    if ('ms' in trigger) {
      await new Promise((r) => setTimeout(r, Math.min(trigger.ms, budget)))
      return
    }
    const label = 'notify' in trigger ? trigger.notify : trigger.ack
    const wanted = 'notify' in trigger ? 'notify' : 'ack'
    const ok = await this.waitUntil(() => {
      const call = this.callOf(label)
      if (!call) return false
      return wanted === 'ack' ? true : this.results.has(call)
    }, budget)
    if (!ok && !this.dead) console.error(`[demo] timed out waiting for ${wanted} of '${label}'`)
  }

  /**
   * Write one line to the CLI, substituting handle placeholders first.
   *
   * An unresolved placeholder would go out as literal `$label.err`, which is
   * member-access syntax the parser rightly refuses — a confusing way to learn
   * that an ack never arrived. So the step is dropped instead, loudly, and the
   * run is marked unsuccessful.
   */
  private send(step: Step): void {
    const unresolved: string[] = []
    const line = step.line.replace(PLACEHOLDER, (whole, label: string, field?: string) => {
      const ack = this.acks.get(label)
      if (!ack) {
        unresolved.push(whole)
        return whole
      }
      if (field === 'value') return ack.bind.value
      if (field === 'err' || field === 'error') return ack.bind.error
      return ack.call
    })
    if (unresolved.length > 0) {
      this.dropped.push({ step, unresolved })
      console.error(
        `\n[demo] skipping ${step.agent}'s line — no ack recorded for ${unresolved.join(', ')}: ${step.line}`,
      )
      return
    }
    const wire = `@${step.agent} ${line}\n`
    console.log(`\n${step.agent} > ${line}${step.why ? `\n        # ${step.why}` : ''}`)
    if (!isComment(line)) this.outstanding.push({ step, fn: fnOf(line) })
    this.child?.stdin?.write(wire)
  }

  /** Run the script to the end (or to the deadline). */
  async play(): Promise<void> {
    const deadline = this.startedAt + TIMEOUT_MS
    for (const step of script) {
      if (this.dead) {
        console.error('[demo] CLI exited early; abandoning the rest of the script')
        return
      }
      const budget = Math.max(0, deadline - Date.now())
      if (budget === 0) {
        console.error('[demo] global timeout reached; abandoning the rest of the script')
        return
      }
      await this.release(step.after, budget)
      // Placeholders can only be substituted once the referenced lines have
      // been acked, so a step implicitly waits for what it mentions.
      const missing = referencedLabels(step.line).filter((label) => !this.acks.has(label))
      if (missing.length > 0) {
        await this.waitUntil(
          () => referencedLabels(step.line).every((label) => this.acks.has(label)),
          Math.max(0, deadline - Date.now()),
        )
      }
      this.send(step)
    }
  }

  /** Call ids that were acked but never notified. */
  pending(): string[] {
    return [...this.submitted].filter((call) => !this.results.has(call))
  }

  /**
   * Wait for every submitted call to settle. The outstanding queue is drained
   * first: a line written microseconds ago has not been acked yet, so its call
   * would not be in the pending set and we would declare victory too early.
   */
  async settle(): Promise<boolean> {
    const budget = () => Math.max(0, this.startedAt + TIMEOUT_MS - Date.now())
    const acked = await this.waitUntil(() => this.outstanding.length === 0, budget())
    if (!acked && !this.dead) console.error(`[demo] ${this.outstanding.length} line(s) were never answered`)
    console.log(`\n[demo] waiting for ${this.pending().length} in-flight call(s) to settle…`)
    return this.waitUntil(() => this.pending().length === 0, budget())
  }

  /** Send `.exit` and wait for the child to go away, killing it if it will not. */
  async shutdown(): Promise<void> {
    console.log('\nplanner > .exit')
    this.child?.stdin?.write('.exit\n')
    this.child?.stdin?.end()
    const gone = await this.waitUntil(() => this.dead, SHUTDOWN_GRACE_MS)
    if (!gone) {
      console.error('[demo] CLI did not exit after .exit; sending SIGTERM')
      this.child?.kill('SIGTERM')
      await this.waitUntil(() => this.dead, 2_000)
      this.child?.kill('SIGKILL')
    }
  }

  /* --------------------------------------------------------------- summary */

  /**
   * Print the closing report and decide the exit code. The demo is only "green"
   * if the CLI exited cleanly, every call settled, and the trace is on disk with
   * something in it — the perf step has nothing to render otherwise.
   */
  report(settled: boolean): number {
    const wall = Date.now() - this.startedAt
    const outcomes = new Map<string, number>()
    for (const note of this.results.values()) outcomes.set(note.outcome, (outcomes.get(note.outcome) ?? 0) + 1)
    const perAgent = new Map<string, number>()
    for (const note of this.results.values()) perAgent.set(note.agent, (perAgent.get(note.agent) ?? 0) + 1)

    let traceSize = -1
    try {
      traceSize = statSync(this.tracePath).size
    } catch {
      traceSize = -1
    }

    const crashed = this.childExit ? this.childExit.code !== 0 && this.childExit.signal === null : true
    const pending = this.pending()
    const order = ['done', 'failed', 'cancelled', 'skipped']
    const mix = order
      .filter((outcome) => outcomes.has(outcome))
      .map((outcome) => `${outcomes.get(outcome)} ${outcome}`)
      .join(' · ')

    console.log('\n' + '─'.repeat(72))
    const reported = this.reportedSession && this.reportedSession !== this.session ? ` (cli reports ${this.reportedSession})` : ''
    console.log(`session   ${this.session}${reported}`)
    console.log(
      `trace     ${relative(ROOT, this.tracePath)}${traceSize >= 0 ? `  (${bytes(traceSize)})` : '  — MISSING'}`,
    )
    let notifySize = -1
    try {
      notifySize = statSync(this.notifyPath).size
    } catch {
      notifySize = -1
    }
    console.log(
      `notify    ${relative(ROOT, this.notifyPath)}${notifySize >= 0 ? `  (${bytes(notifySize)}, dsh envelopes)` : '  — MISSING'}`,
    )
    console.log(`calls     ${this.submitted.size} submitted · ${mix || 'none settled'}`)
    console.log(
      `agents    ${[...perAgent].map(([agent, n]) => `${agent} ${n}`).join(' · ') || 'none'} · concurrency ${CONCURRENCY}`,
    )
    console.log(`wall      ${ms(wall)}`)
    if (this.junk.length) console.log(`warnings  ${this.junk.length} unparseable stdout line(s)`)
    if (this.rejected.length) console.log(`rejected  ${this.rejected.length} line(s) the CLI refused`)
    if (pending.length) console.log(`pending   ${pending.join(', ')} never settled`)
    if (this.dropped.length) {
      console.log(`dropped   ${this.dropped.length} step(s) with unresolved handles: ${this.dropped.map((d) => d.unresolved.join('/')).join(', ')}`)
    }
    if (crashed) {
      console.log(`exit      CLI exited with code ${this.childExit?.code} signal ${this.childExit?.signal}`)
    }
    console.log(`next      pnpm demo-perf`)
    console.log('─'.repeat(72))

    if (crashed) return 1
    if (traceSize <= 0) return 1
    if (!settled || pending.length > 0) return 1
    // A rejected line means the script and the CLI disagree about the language
    // — a broken demo even though every call that did run succeeded.
    if (this.rejected.length > 0) return 1
    if (this.dropped.length > 0) return 1
    if (!this.sawBye) console.error('[demo] note: the CLI never sent a bye event')
    return 0
  }
}

/* --------------------------------------------------------------------- main */

/** Entry point: spawn, play, settle, shut down, report. */
async function main(): Promise<void> {
  const session = sessionId()
  const tracePath = resolve(ROOT, 'out', `${session}.jsonl.gz`)
  // Per session, because `file:` sinks append: a shared out/notify.jsonl would
  // mix several runs' envelopes into one file that belongs to none of them.
  const notifyPath = resolve(ROOT, 'out', `${session}.notify.jsonl`)
  const cliPath = process.env.FLUVIA_CLI ?? 'src/cli/bin.ts'
  mkdirSync(resolve(ROOT, 'out'), { recursive: true })

  console.log(`[demo] fluvia session ${session}`)
  console.log(`[demo] cli ${cliPath} · concurrency ${CONCURRENCY} · trace ${relative(ROOT, tracePath)}\n`)

  const demo = new Demo(session, tracePath, notifyPath, cliPath)
  await demo.start()
  await demo.play()
  const settled = await demo.settle()
  if (!settled) console.error(`[demo] still pending at the deadline: ${demo.pending().join(', ') || '(none)'}`)
  await demo.shutdown()
  process.exitCode = demo.report(settled)
}

await main()
