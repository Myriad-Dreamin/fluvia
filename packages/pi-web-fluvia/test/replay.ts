/**
 * `pnpm replay <trace.json>` — play an exported pi × fluvia run in Node with no
 * model, and print what happened.
 *
 * Same machinery as `fluvia.replayTrace` in the browser console: the recorded
 * model turns are fed back through pi-ai's faux provider while the fluvia
 * runtime really executes every call. Prints the replayed conversation, the
 * drift from the recording, and for a slice the agent's scorecard.
 *
 *   pnpm replay path/to/trace.json [--full]
 *
 * `--full` prints whole messages instead of their first lines.
 */

import { readFileSync } from 'node:fs'
import { Agent } from '@mariozechner/pi-agent-core'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import toolbox from '@fluvia/toolbox-default'
import { convertToLlmNode } from '../src/messages.ts'
import { messageText, parseRecord } from '../src/record.ts'
import { Replay } from '../src/replay.ts'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--'))
const full = args.includes('--full')
if (!file) {
  console.error('usage: pnpm replay <trace.json> [--full]')
  process.exit(2)
}

const record = parseRecord(JSON.parse(readFileSync(file, 'utf8')))
const assistantTurns = record.messages.filter((m) => m.role === 'assistant').length
console.log(`trace: ${record.mode} · recorded with ${record.model.provider}/${record.model.id} · ${record.messages.length} messages · ${assistantTurns} model turns · exported ${record.exportedAt}`)
if (record.note) console.log(`note: ${record.note}`)
if (record.slice) console.log(`slice: ${record.slice.traceName} · lane ${record.slice.setup.takeover} · lines ${record.slice.setup.from}..${record.slice.setup.to ?? 'end'}`)

let agent: Agent | undefined
const replay = Replay.start(record, {
  toolbox,
  installAgent: async (systemPrompt, tools, model) => {
    agent = new Agent({ initialState: { systemPrompt, model, thinkingLevel: 'off', messages: [], tools }, convertToLlm: convertToLlmNode })
    return agent
  },
})
const started = Date.now()
const state = await replay.done
replay.live?.close()

console.log(`\nreplayed in ${((Date.now() - started) / 1000).toFixed(1)}s · ${state.phase} · model turn ${state.turnsPlayed}/${state.turnsRecorded}${state.detail ? ` · ${state.detail}` : ''}\n`)
for (const message of agent?.state.messages ?? []) console.log(render(message))

if (state.divergences.length) {
  console.log(`\ndrift from the recording (${state.divergences.length}):`)
  for (const d of state.divergences) console.log(`  before turn ${d.turn}\n    expected: ${d.expected}\n    got:      ${d.got}`)
} else if (state.phase === 'done') {
  console.log('\nno drift: every model turn saw what it saw in the recording')
}
const score = state.slice?.report.agent
if (score) {
  console.log(`\nscorecard (${score.agent}): coverage ${Math.round(score.coverage * 100)}% · wasted ${score.wasted} · span ${score.spanMs.agent}ms vs ${score.spanMs.recorded}ms recorded`)
  console.log(`  agent calls: ${score.calls.map((c) => `${c.id} ${c.fn} ${c.outcome}`).join(', ') || 'none'}`)
}
process.exit(state.phase === 'done' && !state.divergences.length ? 0 : 1)

function render(message: AgentMessage): string {
  const role = (message as { role: string }).role
  let body = messageText(message)
  if (role === 'assistant') {
    const calls = ((message as { content: { type: string; name?: string; arguments?: unknown }[] }).content ?? [])
      .filter((block) => block.type === 'toolCall')
      .map((block) => `    → ${block.name} ${JSON.stringify(block.arguments)}`)
    const text = ((message as { content: { type: string; text?: string }[] }).content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    body = [text, ...calls].filter(Boolean).join('\n')
  }
  const lines = body.split('\n')
  const shown = full ? lines : lines.slice(0, role === 'fluvia-notify' || role === 'toolResult' ? 6 : 3)
  const more = shown.length < lines.length ? `\n    … ${lines.length - shown.length} more lines` : ''
  return `[${role}]\n${shown.map((line) => `    ${line}`).join('\n')}${more}`
}
