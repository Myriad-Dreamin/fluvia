/**
 * The agent half of "resume from a cut": Claude, reached through the artifact
 * viewer's `sample` capability, takes over one lane of a restored
 * {@link SliceSession}.
 *
 * Each turn is one `sample` call. Claude reads the lane's transcript up to the
 * cut, what it has done since, and the notifications that woke it, and submits
 * lines through a `fluvia` page tool that calls `session.submit`. When the turn
 * ends, `session.wake()` advances virtual time until the lane has something new
 * to read. The runtime never moves while Claude thinks, so the benchmark
 * measures the dataflow the agent built, not the latency of the model.
 *
 * @module fluvia/bench/page/agent
 */

import type { FunctionDef } from '../../core/types.ts'
import type { AgentWake, SliceSession } from '../session.ts'

type SampleFn = (
  input: string,
  options: {
    tools: { name: string; description: string; inputSchema: object; execute(input: Record<string, unknown>): unknown }[]
    modelTier: 'quick' | 'default' | 'complex'
    signal: AbortSignal
    onText(update: { text: string }): void
  },
) => Promise<{ text: string; truncated: boolean }>

export interface ToolUse {
  lines: string[]
  answer: string
}

export interface Turn {
  n: number
  text: string
  status: 'thinking' | 'writing' | 'done' | 'error'
  tools: ToolUse[]
  wake?: AgentWake
  error?: string
}

export interface AgentRunOptions {
  session: SliceSession
  sample: SampleFn
  toolbox: FunctionDef[]
  goal: string
  tier: 'quick' | 'default' | 'complex'
  budget: number
  signal: AbortSignal
  onUpdate(turns: Turn[]): void
}

export type StopReason = 'done' | 'idle' | 'budget' | 'stopped' | 'error'

export async function runAgent(options: AgentRunOptions): Promise<{ turns: Turn[]; reason: StopReason }> {
  const { session, sample, signal } = options
  const turns: Turn[] = []
  const agent = session.takeover!
  const transcript = session.transcript()
  const publish = () => options.onUpdate(turns.map((turn) => ({ ...turn, tools: [...turn.tools] })))
  let said = false

  for (let n = 1; n <= options.budget; n++) {
    const turn: Turn = { n, text: '', status: 'thinking', tools: [] }
    turns.push(turn)
    publish()
    const prompt = buildPrompt({ agent, goal: options.goal, isa: isaText(options.toolbox), transcript, turns: turns.slice(0, -1), state: session.state() })
    try {
      const result = await sample(prompt, {
        modelTier: options.tier,
        signal,
        onText: ({ text }) => {
          turn.text = text
          turn.status = 'writing'
          publish()
        },
        tools: [
          {
            name: 'fluvia',
            description:
              'Submit one or more fluvia lines as this agent. Each line is one call, e.g. compileKernel(kernel0, { opt: 3 }), or a control such as vars() or list("all"). Returns the runtime\'s immediate answer for each line: the call id and the two handle names it bound, or an error. Results are NOT returned here; they arrive as notifications after your turn ends.',
            inputSchema: {
              type: 'object',
              properties: { lines: { type: 'array', items: { type: 'string' }, description: 'Lines to submit, in order.' } },
              required: ['lines'],
            },
            execute(input) {
              const lines = Array.isArray(input.lines) ? input.lines.map(String) : [String(input.lines ?? '')]
              const answer = lines.map((line) => `> ${line}\n${session.submit(line)}`).join('\n')
              turn.tools.push({ lines, answer })
              publish()
              return answer
            },
          },
        ],
      })
      turn.text = result.text
      turn.status = 'done'
    } catch (error) {
      const e = error as { code?: string; message?: string; text?: string }
      turn.text = e.text ?? turn.text
      turn.status = 'error'
      turn.error = e.code ?? 'error'
      publish()
      return { turns, reason: e.code === 'cancelled' ? 'stopped' : 'error' }
    }
    said = /\bDONE\b/.test(turn.text)

    turn.wake = await session.wake()
    publish()
    if (said) break
    if (turn.wake.idle && !turn.wake.notifications.length) {
      publish()
      return { turns, reason: 'idle' }
    }
  }
  // Whatever the agent left running still settles, so the report is complete.
  while (!session.isIdle()) {
    const wake = await session.wake()
    const last = turns[turns.length - 1]
    if (last && wake.notifications.length) {
      last.wake = {
        notifications: [...(last.wake?.notifications ?? []), ...wake.notifications],
        at: wake.at,
        idle: wake.idle,
      }
      publish()
    }
    if (wake.idle || !wake.notifications.length) break
  }
  return { turns, reason: said ? 'done' : 'budget' }
}

export function isaText(toolbox: FunctionDef[]): string {
  const rows = toolbox
    .filter((def) => def.kind !== 'control')
    .map((def) => `${def.name}${def.params ?? ''}  →  binds ${def.out}N, errN  — ${def.summary}`)
  rows.push(
    'vars()  — control: the handle table (which variable is ready and what it holds)',
    'list("all")  — control: every call and its state',
    'inspect(cN)  — control: one call in detail',
    'cancel(cN)  — control: abort a call; its dependents are skipped',
  )
  return rows.join('\n')
}

function buildPrompt(input: {
  agent: string
  goal: string
  isa: string
  transcript: string
  turns: Turn[]
  state: string
}): string {
  const since = input.turns
    .map((turn) => {
      const parts = [`Turn ${turn.n}:`]
      for (const tool of turn.tools) parts.push(tool.answer)
      if (turn.text.trim()) parts.push(`(you said) ${turn.text.trim().slice(0, 400)}`)
      if (turn.wake?.notifications.length) parts.push(...turn.wake.notifications)
      return parts.join('\n')
    })
    .join('\n\n')
  return [
    `You are the agent "@${input.agent}" in a fluvia session, and you are resuming its work in the middle of the session.`,
    '',
    'How fluvia works:',
    '- You submit calls, one per line, in JavaScript call syntax: literals, arrays, objects and handle names only.',
    '- Every call is answered immediately with an id (cN) and two handles: a value handle (e.g. kernelN) and an error handle (errN). Exactly one becomes ready.',
    '- Pass handles to later calls to build a dependency graph. A call runs when its inputs are ready. If an input handle turns void, the call is skipped.',
    '- Passing errN to a call makes it run only if cN fails, which is how you recover.',
    '- Results are never returned inline. They arrive as notifications ("← cN fn done ⇒ name : summary") after your turn ends.',
    '- Handle names are numbered by submission order across ALL agents, so read the answer to learn the name you got. Use vars() when unsure.',
    '- Other agents keep working in the same runtime. They may consume your handles, and you may consume theirs.',
    '',
    'Instruction set:',
    input.isa,
    '',
    'Your goal:',
    input.goal,
    '',
    'Your lane so far, as you saw it (> is what you typed, ← a notification):',
    input.transcript || '(nothing yet)',
    '',
    since ? `Since you resumed:\n${since}` : 'You have not submitted anything since resuming.',
    '',
    `Your calls right now:\n${input.state}`,
    '',
    'Now use the fluvia tool to submit every line that is useful right now; you can submit lines whose inputs are still pending. Do not wait for results within this turn: you will be woken with notifications. End your turn with one short sentence about what you are waiting for. If the goal is fully complete, end with the single word DONE.',
  ].join('\n')
}
