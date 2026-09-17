/**
 * `pnpm verify` — headless end-to-end checks with pi-ai's faux provider.
 *
 * a. Live: the in-page runtime (`LiveSession`, the same code the browser runs,
 *    on a wall clock) and a pi `Agent` with its `fluvia` tool. The scripted
 *    model submits prepareKernel; the ack must come back as the tool result,
 *    and the settled call must arrive later as a `fluvia-notify` message that
 *    starts another agent turn. An `@agent` prefix must be refused.
 * b. Slice: the recorded demo trace cut at line 9 (to 25), lane `planner`
 *    taken over; the scripted model submits one line, wake() delivers the
 *    notifications as re-prompts, the loop ends idle and the report scores the
 *    agent.
 *
 * c. Replay: public/preset-trace.json (a real model run) played back through the faux provider
 *    with the in-page runtime really executing; every recorded model turn must
 *    be consumed with no drift, and a tampered copy must report drift.
 *
 * No server, no network, no API key.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai'
import type { Context, Message } from '@mariozechner/pi-ai'
import { readTrace } from '@fluvia/core/trace'
import toolbox from '@fluvia/toolbox-default'
import { LiveSession } from '../src/live.ts'
import { convertToLlmNode, isFluviaNotify } from '../src/messages.ts'
import { DEFAULT_TASK, SliceDriver, loadTrace } from '../src/slice.ts'
import { readFileSync } from 'node:fs'
import { parseRecord } from '../src/record.ts'
import type { SessionRecord } from '../src/record.ts'
import { Replay } from '../src/replay.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const repo = resolve(pkg, '../..')
const TRACE = join(repo, 'out/s-20260915-223018.jsonl.gz')
const PREPARE = 'prepareKernel({ size: 4096, dtype: "f32", arch: "sm90" })'

const cleanups: (() => void | Promise<void>)[] = []
let failures = 0

function check(ok: boolean, what: string, detail?: unknown): void {
  if (ok) console.log(`  ok   ${what}`)
  else {
    failures++
    console.log(`  FAIL ${what}${detail === undefined ? '' : `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

function textOf(message: AgentMessage | Message | undefined): string {
  if (!message || !('content' in message)) return isFluviaNotify(message as AgentMessage) ? (message as { text: string }).text : ''
  const content = message.content
  if (typeof content === 'string') return content
  return content.map((block) => ('text' in block ? block.text : '')).join('')
}

async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/* ----------------------------------------------------------------------- a */

async function verifyLive(): Promise<void> {
  console.log('\na. live runtime in the page')
  const faux = registerFauxProvider({ provider: 'faux-live' })
  cleanups.push(() => faux.unregister())
  const live = await LiveSession.start({
    toolbox,
    onError: (error) => check(false, 'delivery raised no error', error.message),
  })
  cleanups.push(() => live.close())
  console.log(`  runtime: agent ${live.agent}, session ${live.session}, ${live.isa.length} ISA entries`)
  check(live.isa.some((entry) => entry.name === 'prepareKernel'), 'ISA derived from the loaded toolbox lists prepareKernel')
  check(live.systemPrompt.includes('prepareKernel') && live.tool.description.includes('prepareKernel'), 'system prompt and tool description are built from the ISA')
  const refused = live.submit('@tuner vars()')
  check(refused.t === 'error' && /@agent prefix is not accepted/.test(refused.message), 'an @agent prefix is refused', refused)

  const contexts: Context[] = []
  faux.setResponses([
    fauxAssistantMessage([fauxText('Submitting the kernel.'), fauxToolCall('fluvia', { calls: PREPARE })], { stopReason: 'toolUse' }),
    (context) => {
      contexts.push(context)
      return fauxAssistantMessage('Submitted; I will react when it settles.')
    },
    (context) => {
      contexts.push(context)
      return fauxAssistantMessage('kernel0 is ready.')
    },
  ])

  const agent = new Agent({
    initialState: { systemPrompt: live.systemPrompt, model: faux.getModel(), thinkingLevel: 'off', messages: [], tools: [live.tool] },
    convertToLlm: convertToLlmNode,
  })
  live.attach(agent)
  let runs = 0
  agent.subscribe((event) => {
    if (event.type === 'agent_start') runs++
  })

  const t0 = Date.now()
  await agent.prompt('Prepare a 4096 f32 kernel for sm90.')
  const first = [...agent.state.messages]
  const toolResult = first.find((m) => m.role === 'toolResult')
  const ackText = textOf(toolResult)
  console.log(`  tool result after ${Date.now() - t0}ms: ${ackText}`)
  check(/^c\d+ prepareKernel ⇒ kernel\d+, err\d+ \[(running|queued)\]/.test(ackText), 'the ack arrives as the tool result', ackText)
  check(!first.some(isFluviaNotify), 'no notification yet when the first run ends')

  await until(() => agent.state.messages.some(isFluviaNotify), 10_000, 'the fluvia-notify message')
  await until(() => faux.state.callCount >= 3 && !agent.state.isStreaming, 10_000, 'the woken turn')
  await agent.waitForIdle()
  const notify = agent.state.messages.find(isFluviaNotify)!
  console.log(`  fluvia-notify after ${notify.timestamp - t0}ms:\n${notify.text.replace(/^/gm, '    | ')}`)
  check(/prepareKernel done/.test(notify.text) && notify.text.startsWith('<fluvia-notify'), 'the settled call arrives as a <fluvia-notify> block')
  check(notify.timestamp >= (toolResult?.timestamp ?? Infinity), 'the notification comes after the tool result')
  check(runs === 2, 'the notification started a second agent run', { runs })
  const lastUser = contexts[1]?.messages.filter((m) => m.role === 'user').at(-1)
  check(textOf(lastUser).includes('<fluvia-notify'), 'convertToLlm turns fluvia-notify into a user message for the model')
  const last = agent.state.messages.at(-1)
  check(last?.role === 'assistant' && textOf(last) === 'kernel0 is ready.', 'the woken turn produced the scripted reply', textOf(last))

  live.close()
  faux.unregister()
}

/* ----------------------------------------------------------------------- b */

async function verifySlice(): Promise<void> {
  console.log('\nb. resume from a benchmark slice')
  const { events } = readTrace(TRACE)
  const driver = await SliceDriver.open(loadTrace(events), { from: 9, to: 25, takeover: 'planner' }, toolbox)
  const firstMessage = driver.firstMessage()
  check(firstMessage.includes('<transcript>') && firstMessage.includes('kernel0') && firstMessage.includes('<state>'), 'first message carries the lane transcript and state at the cut')

  const faux = registerFauxProvider({ provider: 'faux-slice' })
  cleanups.push(() => faux.unregister())
  const prompts: string[] = []
  const reply = (text: string) => (context: Context) => {
    prompts.push(textOf(context.messages.filter((m) => m.role === 'user').at(-1)))
    return fauxAssistantMessage(text)
  }
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('fluvia', { line: 'compileKernel(kernel0, { opt: 3, fastMath: true })' })], { stopReason: 'toolUse' }),
    reply('Compiling; waiting for the notification.'),
    ...Array.from({ length: 12 }, (_, i) => reply(`Noted (${i + 1}).`)),
  ])
  const agent = new Agent({
    initialState: { systemPrompt: driver.systemPrompt, model: faux.getModel(), thinkingLevel: 'off', messages: [], tools: [driver.tool] },
    convertToLlm: convertToLlmNode,
  })
  const wakes: string[] = []
  const outcome = await driver.run(agent, DEFAULT_TASK, {
    maxTurns: 10,
    onWake: (message, wake) => wakes.push(`+${Math.round(wake.at)}ms ${message ? `${message.count} notification(s)` : 'nothing'}${wake.idle ? ' idle' : ''}`),
  })

  const toolResult = agent.state.messages.find((m) => m.role === 'toolResult')
  console.log(`  tool result: ${textOf(toolResult)}`)
  check(/c\d+ compileKernel ⇒ kernel\d+, err\d+/.test(textOf(toolResult)), 'session.submit answer is the tool result')
  console.log(`  wakes: ${wakes.join(' · ')}`)
  const notifies = agent.state.messages.filter(isFluviaNotify)
  check(notifies.some((m) => /compileKernel done/.test(m.text)), 'wake() delivered the compileKernel notification as fluvia-notify')
  check(prompts.slice(1).every((p) => p.startsWith('<fluvia-notify')), 'each wake re-prompted the agent with the block')
  check(outcome.reason === 'idle', 'the loop ended with the world idle and nothing left to deliver', outcome)
  const score = outcome.report.agent
  check(!!score, 'the report scores the agent')
  if (score) {
    console.log(`  score: coverage ${score.coverage}, wasted ${score.wasted}, span ${score.spanMs.agent}ms (recorded ${score.spanMs.recorded}ms), calls ${score.calls.map((c) => `${c.fn}:${c.outcome}`).join(', ')}`)
    check(score.calls.some((c) => c.fn === 'compileKernel' && c.outcome === 'done'), 'the agent call is scored done')
  }
  faux.unregister()
}

/* ----------------------------------------------------------------------- c */

async function verifyReplay(): Promise<void> {
  console.log('\nc. replay an exported trace without a model')
  const record = parseRecord(JSON.parse(readFileSync(join(pkg, 'public/preset-trace.json'), 'utf8')))
  const play = async (input: SessionRecord) => {
    let agent: Agent | undefined
    const replay = Replay.start(input, {
      toolbox,
      stepTimeoutMs: 20_000,
      installAgent: async (systemPrompt, tools, model) => {
        agent = new Agent({ initialState: { systemPrompt, model, thinkingLevel: 'off', messages: [], tools }, convertToLlm: convertToLlmNode })
        return agent
      },
    })
    const state = await replay.done
    replay.live?.close()
    return { state, agent: agent! }
  }
  const { state, agent } = await play(record)
  console.log(`  played ${state.turnsPlayed}/${state.turnsRecorded} turns, phase ${state.phase}, ${state.divergences.length} drift`)
  check(state.phase === 'done' && state.turnsPlayed === state.turnsRecorded, 'every recorded model turn was played', state)
  check(state.divergences.length === 0, 'no drift from the recording', state.divergences)
  check(agent.state.messages.filter(isFluviaNotify).length === record.messages.filter((m) => m.role === 'fluvia-notify').length, 'the runtime produced the recorded number of notifications')
  check(textOf(agent.state.messages.at(-1)) === textOf(record.messages.at(-1)), 'the conversation ends where the recording ends')

  const tampered = JSON.parse(JSON.stringify(record)) as SessionRecord
  const first = tampered.messages.find((m) => m.role === 'assistant') as { content: { type: string; arguments?: { calls?: string } }[] }
  let altered = false
  for (const block of first.content) {
    if (block.type !== 'toolCall' || typeof block.arguments?.calls !== 'string') continue
    const before = block.arguments.calls
    block.arguments.calls = before.replace('compileKernel(kernel1, { opt: 3 })', 'compileKernel(kernel1, { opt: 7 })')
    altered ||= block.arguments.calls !== before
  }
  check(altered, 'the tamper changed a recorded call')
  const replayedTamper = await play(tampered)
  console.log(`  tampered: ${replayedTamper.state.divergences.length} drift, first before turn ${replayedTamper.state.divergences[0]?.turn}`)
  check(replayedTamper.state.divergences.length > 0, 'a tampered trace reports drift')
}

try {
  await verifyLive()
  await verifySlice()
  await verifyReplay()
} catch (error) {
  failures++
  console.log(`  FAIL ${(error as Error).stack}`)
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch {
      // best effort
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
