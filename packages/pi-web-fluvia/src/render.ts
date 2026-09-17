/**
 * Rendering settled calls as the `<fluvia-notify>` block a model reads.
 *
 * The runtime already renders every notification's `text` (one call, with its
 * handles, timings and what it unblocked). This groups a coalesced batch into
 * one block, actionable outcomes first — ready values, then failures (which
 * carry a live error handle), then skips and cancellations — the same order
 * dsh-plugin-fluvia uses.
 *
 * @module pi-web-fluvia/render
 */

import type { Notification } from '../../../src/core/types.ts'

const RANK: Record<string, number> = { done: 0, failed: 1, skipped: 2, cancelled: 3 }

/** A settled call as either transport hands it over. */
export type Settled = Pick<Notification, 'text'> & Partial<Pick<Notification, 'outcome' | 'at'>>

export function renderNotifyBlock(batch: readonly Settled[], attrs: { agent: string; session: string; at?: number }): string {
  const sorted = [...batch].sort((a, b) => (RANK[a.outcome ?? ''] ?? 9) - (RANK[b.outcome ?? ''] ?? 9) || (a.at ?? 0) - (b.at ?? 0))
  const counts = new Map<string, number>()
  for (const n of sorted) if (n.outcome) counts.set(n.outcome, (counts.get(n.outcome) ?? 0) + 1)
  const mix = [...counts].map(([outcome, count]) => `${count} ${outcome === 'done' ? 'ready' : outcome}`).join(', ')
  const at = attrs.at === undefined ? '' : ` at="+${Math.round(attrs.at)}ms"`
  return [
    `<fluvia-notify agent="${attr(attrs.agent)}" session="${attr(attrs.session)}"${at}>`,
    `${sorted.length} call${sorted.length === 1 ? '' : 's'} settled${mix ? ` — ${mix}` : ''}.`,
    '',
    ...sorted.map((n) => n.text.replace(/^← /, '')),
    '</fluvia-notify>',
  ].join('\n')
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
