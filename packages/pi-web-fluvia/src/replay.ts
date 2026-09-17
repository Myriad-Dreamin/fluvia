/**
 * Watching an exported run again with no model.
 *
 * The recorded model turns are queued, in order, on pi-ai's faux provider, and
 * the agent is given that scripted model. Everything else is real: the fluvia
 * runtime executes each recorded tool call, calls take their time, settle, and
 * notify; the agent loop wakes on those notifications and asks the scripted
 * model for its next turn. So the chat, the tool results and the notifications
 * are produced again, not redrawn from the file.
 *
 * A replay can drift from its recording, for example if two notifications
 * coalesce differently. Before each scripted turn the replay compares the last
 * thing the model is shown with what it was shown in the recording, and lists
 * every mismatch. Timings are masked, since they always differ.
 *
 * DOM-free.
 *
 * @module pi-web-fluvia/replay
 */

import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import { fauxAssistantMessage, registerFauxProvider } from '@mariozechner/pi-ai'
import type { AssistantMessage, Context, FauxContentBlock, FauxProviderRegistration, Model } from '@mariozechner/pi-ai'
import type { FunctionDef } from '@fluvia/core/types'
import { indexTrace } from '@fluvia/core/bench/slice'
import { LiveSession } from './live.ts'
import { assistantTurns, messageText } from './record.ts'
import type { SessionRecord } from './record.ts'
import { SliceDriver } from './slice.ts'
import type { SliceOutcome } from './slice.ts'

export interface Divergence {
  /** 1-based model turn the mismatch was found before. */
  turn: number
  expected: string
  got: string
}

export interface ReplayState {
  phase: 'running' | 'done' | 'stopped' | 'error'
  turnsPlayed: number
  turnsRecorded: number
  divergences: Divergence[]
  detail?: string
  slice?: SliceOutcome
}

export interface ReplayDeps {
  toolbox: FunctionDef[]
  /** Put an agent with this prompt, tools and model in front of the user. */
  installAgent(systemPrompt: string, tools: AgentTool<any>[], model: Model<any>): Promise<Agent>
  /** Streaming speed of the scripted model; omit for instant turns. */
  tokensPerSecond?: number
  onUpdate?(state: ReplayState): void
  /** How long a live replay may sit without progress before giving up on a step. */
  stepTimeoutMs?: number
}

export class Replay {
  readonly state: ReplayState
  readonly done: Promise<ReplayState>
  live?: LiveSession
  driver?: SliceDriver
  agent?: Agent
  private stopped = false
  private readonly faux: FauxProviderRegistration

  private constructor(
    readonly record: SessionRecord,
    private readonly deps: ReplayDeps,
  ) {
    const turns = assistantTurns(record)
    this.state = { phase: 'running', turnsPlayed: 0, turnsRecorded: turns.length, divergences: [] }
    this.faux = registerFauxProvider({
      provider: 'replay',
      models: [{ id: `replay-${record.model.id}`, name: `Replay of ${record.model.id}` }],
      tokensPerSecond: deps.tokensPerSecond,
    })
    this.faux.setResponses([
      ...turns.map((turn, k) => (context: Context) => this.play(k, turn.index, turn.message, context)),
      ...Array.from({ length: 50 }, () => (context: Context) => this.beyond(context)),
    ])
    this.done = this.run()
  }

  static start(record: SessionRecord, deps: ReplayDeps): Replay {
    return new Replay(record, deps)
  }

  stop(): void {
    if (this.state.phase !== 'running') return
    this.stopped = true
    this.driver?.stop()
    this.agent?.abort()
  }

  private get model(): Model<any> {
    return this.faux.getModel() as Model<any>
  }

  private update(): void {
    this.deps.onUpdate?.({ ...this.state, divergences: [...this.state.divergences] })
  }

  private play(k: number, index: number, message: AssistantMessage, context: Context): AssistantMessage {
    const expected = messageText(this.record.messages[index - 1])
    const got = messageText(context.messages.at(-1) as never)
    if (mask(expected) !== mask(got)) {
      this.state.divergences.push({ turn: k + 1, expected: clip(expected), got: clip(got) })
    }
    this.state.turnsPlayed = k + 1
    this.update()
    return fauxAssistantMessage(message.content as FauxContentBlock[], {
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    })
  }

  private beyond(context: Context): AssistantMessage {
    this.state.divergences.push({
      turn: this.state.turnsRecorded + 1,
      expected: '(the recording ends here)',
      got: clip(messageText(context.messages.at(-1) as never)),
    })
    this.update()
    return fauxAssistantMessage('(replay) The recording has no model turn for this; nothing was sent to a model.')
  }

  private async run(): Promise<ReplayState> {
    try {
      if (this.record.mode === 'slice') await this.runSlice()
      else await this.runLive()
      this.state.phase = this.stopped ? 'stopped' : 'done'
    } catch (error) {
      this.state.phase = 'error'
      this.state.detail = (error as Error).message
    } finally {
      this.faux.unregister()
      this.update()
    }
    return this.state
  }

  /**
   * A live replay walks the recording. Prompts are typed when the conversation
   * reaches the point where the user typed them. Notifications are held as
   * calls settle and delivered where the recording delivered them, once the
   * conversation has reached that point and those same calls have settled.
   * The shape of the conversation therefore follows the recording, whatever
   * the runtime's or the scripted model's timing.
   */
  private async runLive(): Promise<void> {
    const live = await LiveSession.start({
      toolbox: this.deps.toolbox,
      agent: this.record.live?.agent ?? 'pi',
      concurrency: this.record.live?.concurrency ?? 4,
      holdNotifications: true,
    })
    this.live = live
    const agent = await this.deps.installAgent(this.record.systemPrompt, [live.tool], this.model)
    this.agent = agent
    live.attach(agent)
    this.update()
    const timeout = this.deps.stepTimeoutMs ?? 120_000
    const report = (expected: string, got: string) => {
      this.state.divergences.push({ turn: this.state.turnsPlayed + 1, expected, got })
      this.update()
    }

    for (const [index, message] of this.record.messages.entries()) {
      const role = (message as { role: string }).role
      const human = role === 'user' || role === 'user-with-attachments'
      if (!human && role !== 'fluvia-notify') continue
      const reached = await until(() => this.stopped || (agent.state.messages.length >= index && (!human || !agent.state.isStreaming)), timeout)
      if (this.stopped) return
      if (!reached) report(`the conversation reaches message ${index + 1}`, `it stopped at ${agent.state.messages.length} messages`)

      if (human) {
        agent.prompt({ ...message, timestamp: Date.now() } as never).catch((error: Error) => report('the prompt runs', error.message))
        continue
      }
      const calls = settledCalls(messageText(message))
      const settled = await until(() => this.stopped || calls.every((call) => live.heldCalls().includes(call)), timeout)
      if (this.stopped) return
      const batch = live.take(calls)
      if (!settled) report(`calls ${calls.join(', ')} settle`, `only ${batch.map((n) => n.call).join(', ') || 'none'} did`)
      live.deliverNow(batch)
    }

    // The last recorded notification has gone out; let the final turn finish.
    await quiet(() => (this.stopped ? -1 : agent.state.isStreaming ? NaN : agent.state.messages.length), 1_000, timeout)
    const extra = live.heldCalls()
    if (extra.length) report('no further settlements', `calls ${extra.join(', ')} settled but the recording never delivered them`)
  }

  private async runSlice(): Promise<void> {
    const slice = this.record.slice!
    const driver = await SliceDriver.open(indexTrace(slice.traceEvents), slice.setup, this.deps.toolbox)
    this.driver = driver
    const agent = await this.deps.installAgent(this.record.systemPrompt, [driver.tool], this.model)
    this.agent = agent
    this.update()
    this.state.slice = await driver.run(agent, slice.task, { maxTurns: slice.maxTurns })
  }
}

/** Call ids a `<fluvia-notify>` block reports, in its order. */
function settledCalls(text: string): string[] {
  return [...text.matchAll(/^(?:← )?(c\d+) \S+ (?:done|failed|skipped|cancelled)\b/gm)].map((match) => match[1]!)
}

/** Timings and sizes always differ between runs; compare the words. */
function mask(text: string): string {
  return text
    .replace(/\d+(\.\d+)?\s?(µs|ms|s|KiB|MB|GB|B)?/g, '#')
    .replace(/session="[^"]*"/g, 'session=""')
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

/**
 * Resolve once `probe` has returned the same number for `stableMs`. `NaN` means
 * busy (never stable); a negative number means stop now.
 */
async function quiet(probe: () => number, stableMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = NaN
  let since = Date.now()
  while (Date.now() < deadline) {
    const value = probe()
    if (value < 0) return
    if (Number.isNaN(value) || value !== last) {
      last = value
      since = Date.now()
    } else if (Date.now() - since >= stableMs) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
