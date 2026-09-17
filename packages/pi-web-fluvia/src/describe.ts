/**
 * Everything the model is told about fluvia: the system prompt, the tool
 * description (built from the instruction set the runtime published, never
 * from a list in this package), and the rendering of each answer.
 *
 * @module pi-web-fluvia/describe
 */

import type { FunctionDef } from '@fluvia/core/types'
import type { IsaEntry, ServerFrame } from '@fluvia/core/protocol'

/** Instructions listed before the prompt stops enumerating. */
const ISA_BUDGET = 40

/** The control instructions every fluvia runtime answers. */
const CONTROL = ['list', 'cancel', 'inspect', 'vars', 'defs', 'help']

const SYNTAX_REMINDER =
  'fluvia takes one plain call per line — a function name plus literal, array, object or handle arguments. No nested calls, operators, member access or statements. Run `defs` to see the loaded signatures.'

/** The fluvia contract, briefly. */
const CONTRACT = [
  'You drive fluvia, an asynchronous dataflow runtime, through the `fluvia` tool.',
  '',
  '- Submit one JS-syntax call per line: `prepareKernel({ size: 4096, dtype: "f32" })`. Arguments are literals, arrays, objects and handle names only — no nested calls, operators or member access.',
  '- Calls never block. Each async call is acknowledged at once with a call id and TWO handles: a value handle (`kernel0`) and an error handle (`err0`). Exactly one becomes ready; the other becomes void.',
  '- Chain by passing handles: `compileKernel(kernel0, { opt: 3 })` waits for `kernel0` by itself. Pass an error handle to submit a recovery branch up front (`explain(err0)`); a branch whose input turns void is skipped for free.',
  '- Results arrive later, on their own, as a `<fluvia-notify>` message. Do not poll and do not wait: submit everything that is already possible in one burst, then end your turn. You will be woken when calls settle.',
  '- Control instructions answer immediately and bind nothing: `list`, `cancel(c5)`, `inspect(c5)`, `vars()`, `defs()`, `help()`.',
].join('\n')

/** Published ISA from a toolbox's definitions, the way `fluvia serve` derives it. */
export function isaFromToolbox(defs: readonly FunctionDef[]): IsaEntry[] {
  const entries: IsaEntry[] = defs.map((def) => ({
    name: def.name,
    kind: def.kind === 'control' ? 'control' : 'async',
    out: def.out,
    params: def.params ?? (def.positional?.length ? `(${def.positional.join(', ')}, { … })` : '({ … })'),
    summary: def.summary,
  }))
  for (const name of CONTROL) {
    if (!entries.some((entry) => entry.name === name)) entries.push({ name, kind: 'control', out: '', params: '()', summary: '' })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function listIsa(isa: readonly IsaEntry[]): string[] {
  const async_ = isa.filter((entry) => entry.kind === 'async')
  const listed = async_.slice(0, ISA_BUDGET)
  const lines = [
    `Instructions loaded by the host (${async_.length}); each binds <out>N and errN:`,
    ...listed.map((entry) => `  ${entry.name}${entry.params} → ${entry.out}N, errN — ${entry.summary}`),
  ]
  if (async_.length > listed.length) lines.push(`  …and ${async_.length - listed.length} more; run \`defs\` for the full list.`)
  const control = isa.filter((entry) => entry.kind === 'control').map((entry) => entry.name)
  if (control.length) lines.push(`Control instructions: ${control.join(', ')}.`)
  return lines
}

/** System prompt: the contract plus the instruction set from the welcome frame. */
export function renderSystemPrompt(isa: readonly IsaEntry[], identity: { agent: string; session: string }): string {
  return [
    CONTRACT,
    '',
    `You are fluvia agent \`${identity.agent}\` in session \`${identity.session}\`. Your identity is fixed; never write an \`@agent\` prefix.`,
    '',
    ...listIsa(isa),
    '',
    'The instruction set is fixed by the host running the runtime. You cannot add to it or change it.',
  ].join('\n')
}

/** Tool description, from the published instruction set. */
export function renderToolDescription(isa: readonly IsaEntry[]): string {
  return [
    'Submit calls to the fluvia async dataflow runtime and get the instant acknowledgements back. Put the calls in `calls` as plain text, one per line; they are submitted in order, so a later line may use handles bound by an earlier one.',
    'Results do NOT come back here: each settled call arrives later as a `<fluvia-notify>` message. Do not poll.',
    '',
    ...listIsa(isa),
  ].join('\n')
}

type Answer = Extract<ServerFrame, { t: 'ack' | 'control' | 'error' }>

/** One live-runtime answer as the model reads it. */
export function renderAnswer(answer: Answer): string {
  if (answer.t === 'ack') {
    const blocked = [...new Set(answer.deps.map((dep) => dep.name))]
    const status = answer.state === 'waiting' && blocked.length ? `waiting on ${blocked.join(', ')}` : answer.state
    return `${answer.call} ${answer.fn} ⇒ ${answer.bind.value}, ${answer.bind.error} [${status}] — result arrives as a fluvia notification`
  }
  if (answer.t === 'control') return answer.text
  return `Rejected: ${answer.message}\n${SYNTAX_REMINDER}`
}
