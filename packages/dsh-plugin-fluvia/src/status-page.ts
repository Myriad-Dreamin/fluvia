/**
 * The status page served at `GET /` on the receiver's own port.
 *
 * The primary surface for a delivered envelope is the dsh Web UI — that is the
 * whole point of the plugin. This page answers a different and much narrower
 * question, the one an operator asks when nothing shows up in the UI: *is the
 * endpoint even bound, and did anything arrive?* So it reports plumbing
 * (counts, target resolution, the configured route) and deliberately does not
 * reproduce envelope text, which would turn a health check into a second,
 * competing transcript.
 *
 * It is a single self-contained string with no external assets: the page must
 * render on a LAN host with no internet, and a plugin has no business adding a
 * CDN dependency to someone else's harness process.
 *
 * @module dsh-plugin-fluvia/status-page
 */

import type { CourierStats, DeliveryMode, TargetSelector } from './courier.js'

/** Everything the page shows; assembled by the receiver on each request. */
export interface StatusView {
  /** Host the receiver is bound to. */
  host: string
  /** Port the receiver is bound to. */
  port: number
  /** Path that accepts envelope POSTs. */
  path: string
  /** Configured delivery mode. */
  mode: DeliveryMode
  /** Configured target selector. */
  target: TargetSelector
  /** Maximum envelopes held while no agent is live. */
  queueLimit: number
  /** Counters from the courier. */
  stats: CourierStats
  /** Ids of every live agent, in registration order. */
  liveAgents: string[]
  /** Ids the target selector currently resolves to. */
  targetAgents: string[]
  /** Epoch ms at which the receiver bound its port. */
  startedAt: number
}

/**
 * Render the status view as JSON.
 *
 * Served at `GET <path>` (the same route that accepts POSTs) so the endpoint
 * is checkable by a script as well as by a browser — and so a test can assert
 * on the delivery counters without parsing HTML.
 *
 * @param view — the current view.
 * @returns a JSON document.
 */
export function renderStatusJson(view: StatusView): string {
  return JSON.stringify(view, null, 2)
}

/**
 * Render the status view as a standalone HTML page.
 *
 * @param view — the current view.
 * @returns a complete HTML document.
 */
export function renderStatusPage(view: StatusView): string {
  const { stats } = view
  const endpoint = `http://${view.host}:${view.port}${view.path}`
  // The two states an operator actually cares about: waiting for an agent, or
  // wired up. Anything else is detail, so the banner says only which one.
  const waiting = view.targetAgents.length === 0
  const banner = waiting
    ? `No live agent matches target <code>${escapeHtml(view.target)}</code> — envelopes are being held (${stats.queued} of ${view.queueLimit}).`
    : `Delivering to ${view.targetAgents.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')} by <code>${view.mode}</code>.`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>fluvia → dsh</title>
<style>
  :root {
    --bg: #f7f7f8; --panel: #fff; --ink: #16161a; --muted: #6b6b76;
    --border: #e3e3e8; --accent: #4f46e5; --warn: #a16207; --ok: #15803d;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e0e11; --panel: #17171c; --ink: #ececf1; --muted: #9a9aa6;
      --border: #26262e; --accent: #8b87f5; --warn: #fbbf24; --ok: #4ade80;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.55; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 16px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h1 span { color: var(--muted); font-weight: 400; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 28px 0 8px; }
  code { font-family: var(--mono); font-size: 12.5px; background: var(--panel); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
  .banner { margin: 16px 0 0; padding: 11px 13px; border-radius: 9px; border: 1px solid var(--border); background: var(--panel); border-left: 3px solid ${waiting ? 'var(--warn)' : 'var(--ok)'}; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
  .cell { background: var(--panel); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; }
  .cell b { display: block; font-family: var(--mono); font-size: 21px; font-weight: 600; letter-spacing: -0.02em; }
  .cell span { color: var(--muted); font-size: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; margin: 0; }
  dt { color: var(--muted); font-size: 12.5px; }
  dd { margin: 0; font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>fluvia <span>→ dsh</span></h1>
  <div class="banner">${banner}</div>

  <h2>Envelopes</h2>
  <div class="grid">
    ${cell(stats.received, 'received')}
    ${cell(stats.delivered, 'delivered')}
    ${cell(stats.queued, 'queued')}
    ${cell(stats.deliveries, 'agent deliveries')}
    ${cell(stats.evicted, 'evicted')}
    ${cell(stats.failed, 'failed')}
  </div>

  <h2>Wiring</h2>
  <dl>
    <dt>endpoint</dt><dd>POST ${escapeHtml(endpoint)}</dd>
    <dt>mode</dt><dd>${escapeHtml(view.mode)}</dd>
    <dt>target</dt><dd>${escapeHtml(view.target)}</dd>
    <dt>target agents</dt><dd>${view.targetAgents.length ? view.targetAgents.map(escapeHtml).join(', ') : '—'}</dd>
    <dt>live agents</dt><dd>${view.liveAgents.length ? view.liveAgents.map(escapeHtml).join(', ') : '—'}</dd>
    <dt>last received</dt><dd>${stamp(stats.lastReceivedAt)}</dd>
    <dt>last delivered</dt><dd>${stamp(stats.lastDeliveredAt)}</dd>
    <dt>listening since</dt><dd>${stamp(view.startedAt)}</dd>
  </dl>

  <footer>
    Point a fluvia session here with
    <code>--notify dsh:${escapeHtml(endpoint)}</code>.
    Delivered envelopes appear in the dsh Web UI, not on this page.
    Machine-readable status: <code>GET ${escapeHtml(view.path)}</code>.
  </footer>
</main>
</body>
</html>
`
}

/** One counter tile. */
function cell(value: number, label: string): string {
  return `<div class="cell"><b>${value}</b><span>${label}</span></div>`
}

/** Render an epoch-ms stamp, or an em dash when the event has not happened. */
function stamp(at: number | null): string {
  return at === null ? '—' : new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

/**
 * Escape a value for HTML text and quoted-attribute contexts.
 *
 * Agent ids and the configured target reach this page from config and from the
 * harness, so they are not attacker-controlled in any normal deployment — but
 * this page is bound to a port, and "normal deployment" is not a security
 * boundary. Escaping is one line; auditing every interpolation site is not.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
