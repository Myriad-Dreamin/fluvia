/**
 * Slice mode: a recorded session cut at a line, one lane handed to the agent.
 *
 * `SliceSession` owns the world (a fluvia runtime on a virtual clock, the other
 * lanes replaying their recording). This owns the conversation: the first
 * message (the lane's transcript and state at the cut, plus the task), the
 * `fluvia` tool over `session.submit`, and the loop — each time an agent run
 * ends, `session.wake()` moves virtual time until the lane has notifications,
 * and those re-prompt the agent. Virtual time only moves inside `wake()`, so
 * the agent's thinking is never charged.
 *
 * DOM-free; the headless verification drives it from Node.
 *
 * @module pi-web-fluvia/slice
 */

import type { Agent, AgentTool } from '@mariozechner/pi-agent-core'
import type { FunctionDef, TraceEvent } from '../../../src/core/types.ts'
import { SliceSession } from '../../../src/bench/session.ts'
import type { SliceReport } from '../../../src/bench/session.ts'
import { indexTrace } from '../../../src/bench/slice.ts'
import type { IndexedTrace } from '../../../src/bench/slice.ts'
import { isaFromToolbox, renderSystemPrompt } from './describe.ts'
import type { FluviaNotifyMessage } from './messages.ts'
import { renderNotifyBlock } from './render.ts'
import { createFluviaTool } from './tool.ts'

export interface SliceSetup {
  from: number
  to?: number
  takeover: string
  concurrency?: number
}

export type StopReason = 'idle' | 'stalled' | 'turn budget' | 'agent error' | 'stopped'

export interface SliceOutcome {
  reason: StopReason
  detail?: string
  wakes: number
  report: SliceReport
}

export interface RunOptions {
  /** Maximum number of wake-ups delivered to the agent. */
  maxTurns?: number
  /** Called after each wake, with what it delivered. */
  onWake?(message: FluviaNotifyMessage | undefined, wake: { at: number; idle: boolean }): void
}

export const DEFAULT_TASK =
  'Continue this lane from the cut. Work toward what the lane was evidently doing, using the handles that already exist. Submit everything that is already possible in one burst, react to notifications, and when there is nothing useful left to do, end your turn without calling the tool.'

export function loadTrace(events: TraceEvent[]): IndexedTrace {
  return indexTrace(events)
}

export class SliceDriver {
  readonly tool: AgentTool<any>
  private agent: Agent | undefined
  private unsubscribe: (() => void) | undefined
  private active = false
  private busy = false
  private wakes = 0
  private options: RunOptions = {}
  private resolveDone: ((outcome: SliceOutcome) => void) | undefined
  private outcome: SliceOutcome | undefined
  private stopRequested = false

  private constructor(
    readonly session: SliceSession,
    readonly trace: IndexedTrace,
    readonly setup: SliceSetup,
    readonly toolbox: FunctionDef[],
  ) {
    this.tool = createFluviaTool((line) => session.submit(line), isaFromToolbox(toolbox))
  }

  static async open(trace: IndexedTrace, setup: SliceSetup, toolbox: FunctionDef[]): Promise<SliceDriver> {
    if (!trace.agents.includes(setup.takeover)) throw new Error(`no lane named ${setup.takeover}; lanes: ${trace.agents.join(', ')}`)
    const session = await SliceSession.open(trace, {
      from: setup.from,
      to: setup.to,
      takeover: setup.takeover,
      concurrency: setup.concurrency,
      toolbox,
    })
    return new SliceDriver(session, trace, setup, toolbox)
  }

  get systemPrompt(): string {
    return renderSystemPrompt(isaFromToolbox(this.toolbox), { agent: this.setup.takeover, session: this.trace.meta.session })
  }

  /** The first user message: what the lane saw, where it stands, and the task. */
  firstMessage(task = DEFAULT_TASK): string {
    const s = this.session
    return [
      `You are taking over fluvia lane \`${s.takeover}\` of recorded session \`${this.trace.meta.session}\` at line ${s.from}. Other lanes keep running as recorded around you, and handle names from the transcript are live.`,
      '',
      '<transcript>',
      s.transcript() || '(this lane had not typed anything yet)',
      '</transcript>',
      '',
      '<state>',
      s.state(),
      '</state>',
      '',
      `Task: ${task}`,
    ].join('\n')
  }

  /**
   * Start the loop and resolve when it stops: the world is idle with nothing
   * left to tell the agent, the turn budget is spent, the agent run errored, or
   * {@link stop} was called.
   */
  run(agent: Agent, task = DEFAULT_TASK, options: RunOptions = {}): Promise<SliceOutcome> {
    if (this.active || this.outcome) throw new Error('this slice has already been run')
    this.agent = agent
    this.options = options
    this.active = true
    const done = new Promise<SliceOutcome>((resolve) => (this.resolveDone = resolve))
    // Every run that ends — the ones this loop starts and any the user starts
    // by typing — hands control back to the world.
    this.unsubscribe = agent.subscribe((event) => {
      if (event.type !== 'agent_end' || !this.active) return
      void agent.waitForIdle().then(() => this.afterRun())
    })
    agent.prompt(this.firstMessage(task)).catch((error: Error) => this.finish('agent error', error.message))
    return done
  }

  /** Stop after the current step. */
  stop(): void {
    this.stopRequested = true
    if (this.active && this.agent && !this.agent.state.isStreaming && !this.busy) this.finish('stopped')
  }

  report(): SliceReport {
    return this.session.report()
  }

  private async afterRun(): Promise<void> {
    const agent = this.agent!
    if (!this.active || this.busy || agent.state.isStreaming) return
    if (this.stopRequested) return this.finish('stopped')
    if (agent.state.errorMessage) return this.finish('agent error', agent.state.errorMessage)
    this.busy = true
    try {
      const wake = await this.session.wake()
      if (!wake.notifications.length) {
        this.options.onWake?.(undefined, wake)
        return this.finish(wake.idle ? 'idle' : 'stalled')
      }
      const message: FluviaNotifyMessage = {
        role: 'fluvia-notify',
        text: renderNotifyBlock(
          wake.notifications.map((text) => ({ text })),
          { agent: this.setup.takeover, session: this.trace.meta.session, at: wake.at },
        ),
        count: wake.notifications.length,
        source: 'slice',
        at: wake.at,
        timestamp: Date.now(),
      }
      this.options.onWake?.(message, wake)
      if (this.wakes >= (this.options.maxTurns ?? 12)) {
        // Still show what arrived, but do not spend another turn on it.
        agent.state.messages = [...agent.state.messages, message]
        return this.finish('turn budget')
      }
      if (this.stopRequested) return this.finish('stopped')
      this.wakes++
      agent.prompt(message).catch((error: Error) => this.finish('agent error', error.message))
    } catch (error) {
      this.finish('agent error', (error as Error).message)
    } finally {
      this.busy = false
    }
  }

  private finish(reason: StopReason, detail?: string): void {
    if (!this.active) return
    this.active = false
    this.unsubscribe?.()
    this.outcome = { reason, detail, wakes: this.wakes, report: this.session.report() }
    this.resolveDone?.(this.outcome)
  }
}

