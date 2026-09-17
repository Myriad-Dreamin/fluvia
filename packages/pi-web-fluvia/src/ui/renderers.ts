/**
 * How fluvia shows up in the chat: compact on purpose. A pipeline is many
 * small calls and many small settlements, and the chat has to stay readable
 * while they stream in.
 *
 * - The `fluvia` tool call is one row per submitted call, with its ack beside it.
 * - A `fluvia-notify` message is one row per settled call, with its outcome.
 *   The model still reads the full `<fluvia-notify>` block.
 * - A collapsed thinking block previews its latest line.
 *
 * @module pi-web-fluvia/ui/renderers
 */

import { registerMessageRenderer, registerToolRenderer, ThinkingBlock } from '@mariozechner/pi-web-ui'
import { html, nothing } from 'lit'
import type { TemplateResult } from 'lit'
import type { FluviaNotifyMessage } from '../messages.ts'
import { callsOf } from '../tool.ts'
import type { FluviaToolDetails } from '../tool.ts'

/** Rows shown before a long batch folds. */
const VISIBLE_ROWS = 6

const CHEVRON = html`<svg class="fv-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>`

/* ------------------------------------------------------------------ tool */

interface Ack {
  text: string
  tone: 'ok' | 'error' | 'muted'
}

/** `c3 compileKernel ⇒ kernel3, err3 [waiting on kernel0] — …` → `c3 ⇒ kernel3, err3 · waiting on kernel0`. */
function compactAck(answer: string | undefined): Ack | undefined {
  if (answer === undefined) return undefined
  const first = answer.replace(/^→\s*/, '').split('\n')[0]!.trim()
  const ack = /^(c\d+) \S+ ⇒ (\S+), (\S+)\s+\[([^\]]+)\]/.exec(first)
  if (ack) return { text: `${ack[1]} ⇒ ${ack[2]}, ${ack[3]} · ${ack[4]!.replace(/^waiting: /, 'waiting on ')}`, tone: 'ok' }
  if (/^(Rejected: |✗ )/.test(first)) return { text: first.replace(/^(Rejected: |✗ )/, ''), tone: 'error' }
  return { text: first, tone: 'muted' }
}

function row(line: string, ack: Ack | undefined): TemplateResult {
  return html`<li class="fv-row">
    <code class="fv-call">${line}</code>
    ${ack ? html`<span class="fv-ack fv-${ack.tone}">${ack.text}</span>` : nothing}
  </li>`
}

function rows(entries: [string, Ack | undefined][]): TemplateResult {
  const head = entries.slice(0, VISIBLE_ROWS)
  const rest = entries.slice(VISIBLE_ROWS)
  return html`
    <ol class="fv-rows">${head.map(([line, ack]) => row(line, ack))}</ol>
    ${rest.length
      ? html`<details class="fv-more">
          <summary>${CHEVRON}${rest.length} more</summary>
          <ol class="fv-rows">${rest.map(([line, ack]) => row(line, ack))}</ol>
        </details>`
      : nothing}
  `
}

function toolTitle(state: 'running' | 'done' | 'error', count: number): TemplateResult {
  return html`<div class="fv-head">
    <span class="fv-dot fv-dot-${state}"></span>
    <span class="fv-name">fluvia</span>
    <span class="fv-meta">${count ? `${count} call${count === 1 ? '' : 's'}` : 'writing calls…'}</span>
  </div>`
}

/* ---------------------------------------------------------------- notify */

interface Settled {
  call: string
  fn: string
  outcome: string
  detail: string
  run?: string
}

/** Pull one row per settled call out of a `<fluvia-notify>` block. */
function settledRows(text: string): Settled[] {
  const out: Settled[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^← /, '').trim()
    const match = /^(c\d+) (\S+) (done|failed|skipped|cancelled)\b(.*)$/.exec(line)
    if (!match) continue
    let rest = match[4]!.trim()
    const run = /run ([\d.]+\s?(?:µs|ms|s))/.exec(rest)?.[1]
    rest = rest.replace(/^\([^)]*\)\s*/, '').replace(/^after [^;]*;?\s*/, '')
    let detail = rest
    if (match[3] === 'done') detail = rest.replace(/^⇒\s*/, '').replace(/;\s*err\S* void$/, '')
    else if (match[3] === 'failed') detail = rest.replace(/^⇒\s*/, '').replace(/;\s*\S+ void$/, '')
    else if (match[3] === 'skipped') detail = rest.replace(/^—\s*/, '')
    out.push({ call: match[1]!, fn: match[2]!, outcome: match[3]!, detail, run })
  }
  return out
}

/* --------------------------------------------------------------- register */

export function registerFluviaRenderers(): void {
  registerToolRenderer('fluvia', {
    render(params: unknown, result: { isError?: boolean; details?: FluviaToolDetails; content?: { type: string; text?: string }[] } | undefined) {
      const lines = callsOf(params)
      const answers = result?.details?.answers ?? []
      const state = !result ? 'running' : result.isError ? 'error' : 'done'
      const errorText = result?.isError ? result.content?.map((c) => c.text ?? '').join('\n') : undefined
      return {
        isCustom: true,
        content: html`<div class="fv-card">
          ${toolTitle(state, lines.length)}
          ${lines.length ? rows(lines.map((line, i) => [line, compactAck(answers[i])])) : nothing}
          ${errorText ? html`<p class="fv-error">${errorText}</p>` : nothing}
        </div>`,
      }
    },
  })

  registerMessageRenderer('fluvia-notify', {
    render: (message: FluviaNotifyMessage) => {
      const settled = settledRows(message.text)
      const when = message.source === 'slice' && message.at !== undefined ? `+${Math.round(message.at)}ms virtual` : new Date(message.timestamp).toLocaleTimeString()
      return html`<div class="fv-card fv-notify">
        <div class="fv-head">
          <span class="fv-dot fv-dot-notify"></span>
          <span class="fv-name">${settled.length || message.count} settled</span>
          <span class="fv-meta">${when}</span>
        </div>
        <ol class="fv-rows">
          ${settled.map(
            (s) => html`<li class="fv-row">
              <span class="fv-outcome fv-outcome-${s.outcome}">${s.outcome}</span>
              <code class="fv-call">${s.call} ${s.fn}</code>
              <span class="fv-ack fv-muted">${s.detail}${s.run ? html` <span class="fv-run">${s.run}</span>` : nothing}</span>
            </li>`,
          )}
        </ol>
      </div>`
    },
  })

  // Collapsed thinking shows its latest line, so a long think reads as progress.
  const proto = ThinkingBlock.prototype as unknown as {
    render(this: { content?: string; isStreaming: boolean; isExpanded: boolean; toggleExpanded(): void }): TemplateResult
  }
  proto.render = function () {
    const lines = (this.content ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    const preview = lines.at(-1)?.replace(/^[#>*\-\s]+/, '') ?? ''
    return html`<div class="fv-thinking ${this.isExpanded ? 'open' : ''}">
      <button class="fv-thinking-head" @click=${() => this.toggleExpanded()}>
        ${CHEVRON}<span class="fv-thinking-label ${this.isStreaming ? 'fv-shimmer' : ''}">Thinking</span>
        ${!this.isExpanded && preview ? html`<span class="fv-thinking-preview">${preview}</span>` : nothing}
      </button>
      ${this.isExpanded ? html`<markdown-block .content=${this.content} .isThinking=${true}></markdown-block>` : nothing}
    </div>`
  }
}
