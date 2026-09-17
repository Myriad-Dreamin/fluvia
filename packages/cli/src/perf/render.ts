/**
 * Turns a {@link PerfModel} into one self-contained HTML document.
 *
 * Everything the browser needs ships inside the file: the stylesheet, the
 * script and the model itself, embedded as a JSON blob. There are no network
 * requests of any kind, because the report is meant to survive being copied to
 * a machine that has never heard of this project.
 *
 * The document is deliberately split in two. This module emits a *static
 * shell* — headings, card frames, the empty SVG elements — and the client
 * script paints every data-driven pixel from the embedded blob. That split is
 * what makes the timeline honest at any width: the SVG is re-measured and
 * redrawn on resize instead of being scaled, so tick labels and row labels stay
 * the same size on a phone as on a 1280px desktop.
 *
 * The client script builds DOM nodes rather than concatenating HTML strings.
 * Trace text is agent-authored and may contain anything at all; going through
 * `textContent` means a call whose error message is `<img onerror=…>` renders
 * as characters, not as markup.
 *
 * @module @fluvia/cli/perf/render
 */

import type { PerfModel } from './model.ts'

/**
 * Serialise a value for embedding inside a `<script type="application/json">`
 * element. `<`, `>` and `&` can only occur inside JSON strings, so escaping
 * them as `\uXXXX` keeps the JSON valid while making it impossible for trace
 * text to close the element early. U+2028/U+2029 are escaped because they are
 * legal in JSON but not in JavaScript source.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Escape the few strings this module interpolates into markup itself. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------- style */

/**
 * The stylesheet. Colours are declared once as custom properties on `:root`
 * and redeclared in the dark-mode block, so every rule below — and every SVG
 * class the client script uses — is theme-agnostic. One accent hue (indigo)
 * carries structure and selection; the only other colours are the four outcome
 * semantics plus a neutral for notifications.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f4f6f9;
  --panel: #ffffff;
  --panel-2: #f8f9fb;
  --border: #dde2ea;
  --border-strong: #c3ccd9;
  --text: #11151c;
  --muted: #5a6474;
  --faint: #8a94a4;
  --accent: #3050c8;
  --accent-soft: rgba(48, 80, 200, 0.12);
  --grid: #e6eaf0;
  --lane: #f8f9fb;
  --lane-alt: #eef1f6;
  --edge: rgba(90, 100, 116, 0.42);
  --done: #1f8a4c;
  --failed: #cf2f2f;
  --cancelled: #b5730a;
  --skipped: #7b8494;
  --open: #5a6474;
  --notify: #6b4fc4;
  --wait-bg: rgba(122, 132, 148, 0.13);
  --wait-fg: rgba(122, 132, 148, 0.45);
  --slot: rgba(48, 80, 200, 0.30);
  --shadow: 0 1px 2px rgba(17, 21, 28, 0.06);
  --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1014;
    --panel: #14181e;
    --panel-2: #191e26;
    --border: #262d37;
    --border-strong: #38414e;
    --text: #e7ebf1;
    --muted: #98a2b2;
    --faint: #6f7987;
    --accent: #7f9bff;
    --accent-soft: rgba(127, 155, 255, 0.16);
    --grid: #222932;
    --lane: #161b22;
    --lane-alt: #1b212a;
    --edge: rgba(160, 172, 190, 0.38);
    --done: #45b972;
    --failed: #f2685f;
    --cancelled: #e0a020;
    --skipped: #79838f;
    --open: #98a2b2;
    --notify: #a48bef;
    --wait-bg: rgba(150, 162, 180, 0.12);
    --wait-fg: rgba(150, 162, 180, 0.40);
    --slot: rgba(127, 155, 255, 0.38);
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.45 var(--sans);
  font-variant-numeric: tabular-nums;
}
.wrap { max-width: 1560px; margin: 0 auto; padding: 18px 16px 48px; }
h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 650; }
a { color: var(--accent); }

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  padding: 14px 16px;
  margin-bottom: 14px;
  min-width: 0;
}
.card-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.card-head .spacer { flex: 1 1 auto; }
.hint { color: var(--faint); font-size: 11.5px; }

.split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
.split > .card { margin-bottom: 0; }
@media (min-width: 1040px) { .split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }

/* ---- header ---- */
.hdr-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.sid { font-family: var(--mono); font-size: 13px; color: var(--muted); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-bottom: 14px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px;
  padding: 2px 9px; font-size: 11.5px; color: var(--muted); background: var(--panel-2);
}
.chip b { color: var(--text); font-weight: 600; font-family: var(--mono); font-size: 11.5px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.kpi { background: var(--panel); padding: 9px 11px; }
.kpi .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
.kpi .v { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; margin-top: 2px; font-family: var(--mono); }
.kpi .u { font-size: 11px; color: var(--muted); font-family: var(--sans); font-weight: 400; margin-left: 2px; }
.mix { margin-top: 12px; }
.mixbar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--panel-2); border: 1px solid var(--border); }
.mixbar > span { display: block; min-width: 2px; }
.mixlegend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 7px; font-size: 11.5px; color: var(--muted); }
.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.warn {
  margin: 0 0 12px; padding: 7px 10px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--cancelled); color: var(--cancelled);
  background: color-mix(in srgb, var(--cancelled) 9%, transparent);
}

/* ---- legend ---- */
.legend { display: flex; flex-wrap: wrap; gap: 4px 13px; font-size: 11.5px; color: var(--muted); }
.legend .hatchbox { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px;
  background: repeating-linear-gradient(45deg, var(--wait-fg) 0 2px, var(--wait-bg) 2px 5px); }
.legend .sep { color: var(--border-strong); }

/* ---- timeline svg ---- */
.tl-wrap { width: 100%; }
svg { display: block; width: 100%; }
svg text { font-family: var(--sans); fill: var(--text); }
.tick-line { stroke: var(--grid); stroke-width: 1; shape-rendering: crispEdges; }
.tick-label { font-size: 10px; fill: var(--faint); font-family: var(--mono); }
.axis-rule { stroke: var(--border-strong); stroke-width: 1; shape-rendering: crispEdges; }
.lane-band { fill: var(--lane); }
.lane-band.alt { fill: var(--lane-alt); }
.lane-label { font-size: 10.5px; font-weight: 650; fill: var(--muted); letter-spacing: 0.05em; text-transform: uppercase; }
.lane-rule { stroke: var(--border); stroke-width: 1; shape-rendering: crispEdges; }
.row-label { font-size: 11px; fill: var(--muted); font-family: var(--mono); }
.row-label.sel { fill: var(--accent); font-weight: 650; }
.hatch-bg { fill: var(--wait-bg); }
.hatch-fg { stroke: var(--wait-fg); stroke-width: 2.4; }
.bar-wait { fill: url(#fl-hatch); }
.bar-slot { fill: var(--slot); }
.bar-run.done { fill: var(--done); }
.bar-run.failed { fill: var(--failed); }
.bar-run.cancelled { fill: var(--cancelled); }
.bar-run.skipped { fill: var(--skipped); }
.bar-run.open { fill: var(--open); opacity: 0.55; }
.bar-mark.skipped { fill: var(--skipped); }
.open-cap { fill: var(--open); }
.bar-sel { fill: none; stroke: var(--accent); stroke-width: 1.6; rx: 3; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1; opacity: 0.5; }
.edge.err { stroke-dasharray: 3 2; }
.edge.hot { stroke: var(--accent); stroke-width: 1.7; opacity: 1; }
.notify-lag { stroke: var(--notify); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0.8; }
.notify-mark { fill: var(--notify); }
.row-hit { fill: transparent; cursor: pointer; }
.row-hit:hover + .row-hover, .row-hover.on { fill: var(--accent-soft); }
.row-hover { fill: transparent; pointer-events: none; }
.prog-tick { fill: var(--panel); opacity: 0.85; }
.conc-area { fill: var(--accent); opacity: 0.22; }
.conc-line { fill: none; stroke: var(--accent); stroke-width: 1.4; }
.limit-line { stroke: var(--failed); stroke-width: 1; stroke-dasharray: 4 3; }
.limit-label { font-size: 10px; fill: var(--failed); font-family: var(--mono); }

/* ---- detail ---- */
.empty { color: var(--faint); font-size: 12px; padding: 14px 0; }
.dt-head { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; margin-bottom: 10px; }
.dt-id { font-family: var(--mono); font-size: 15px; font-weight: 650; }
.dt-fn { font-family: var(--mono); font-size: 13px; color: var(--muted); }
.badge { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 650; padding: 1px 7px; border-radius: 4px; border: 1px solid; }
.badge.done { color: var(--done); border-color: var(--done); }
.badge.failed { color: var(--failed); border-color: var(--failed); }
.badge.cancelled { color: var(--cancelled); border-color: var(--cancelled); }
.badge.skipped { color: var(--skipped); border-color: var(--skipped); }
.badge.open { color: var(--open); border-color: var(--open); }
.sub { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); font-weight: 650; margin: 13px 0 5px; }
pre.args { margin: 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; }
.tok-key { color: var(--muted); }
.tok-str { color: var(--done); }
.tok-num { color: var(--accent); }
.tok-kw { color: var(--cancelled); }
.tok-punct { color: var(--faint); }
.ref { color: var(--notify); border-bottom: 1px dotted var(--notify); cursor: pointer; }
.callref { font-family: var(--mono); color: var(--accent); cursor: pointer; border-bottom: 1px dotted var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
th { text-align: left; font-weight: 650; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
td.num, th.num { text-align: right; font-family: var(--mono); padding-right: 12px; }
td.mono { font-family: var(--mono); }
tr.sel td { background: var(--accent-soft); }
.state-ready { color: var(--done); font-weight: 600; }
.state-void { color: var(--skipped); }
.state-pending { color: var(--cancelled); }
.note { display: flex; gap: 9px; font-size: 11.5px; padding: 2px 0; }
.note .at { font-family: var(--mono); color: var(--faint); flex: 0 0 auto; min-width: 56px; text-align: right; }
.box { border-left: 3px solid; padding: 7px 10px; border-radius: 0 5px 5px 0; font-size: 12px; background: var(--panel-2); }
.box.failed { border-color: var(--failed); }
.box.skipped { border-color: var(--skipped); }
.box.cancelled { border-color: var(--cancelled); }
.box .kind { font-family: var(--mono); font-weight: 650; }
.box pre { margin: 6px 0 0; font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-word; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }

/* ---- transcript ---- */
.scroll { max-height: 460px; overflow: auto; overscroll-behavior: contain; }
.scroll-x { overflow-x: auto; }
.tline { display: grid; grid-template-columns: 52px 66px minmax(0, 1fr); gap: 8px; padding: 2px 4px; border-radius: 4px; font-size: 11.5px; }
.tline:hover { background: var(--panel-2); }
.tline.hit { background: var(--accent-soft); }
.tline .at { font-family: var(--mono); color: var(--faint); text-align: right; }
.tline .who { font-family: var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.tline .txt { font-family: var(--mono); white-space: pre-wrap; word-break: break-word; }
.tline.input .txt { color: var(--text); font-weight: 600; }
.tline.input .txt::before { content: "› "; color: var(--accent); }
.tline.info .txt { color: var(--muted); }
.tline.error .txt { color: var(--failed); }
.tline.notify .txt { color: var(--notify); }
select { font: inherit; font-size: 11.5px; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

/* ---- tooltip ---- */
.tip {
  position: fixed; z-index: 20; pointer-events: none; max-width: 300px;
  background: var(--panel); color: var(--text); border: 1px solid var(--border-strong);
  border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.18); padding: 7px 9px; font-size: 11.5px;
}
.tip[hidden] { display: none; }
.tip .t-h { font-family: var(--mono); font-weight: 650; margin-bottom: 4px; }
.tip .t-r { display: flex; justify-content: space-between; gap: 14px; color: var(--muted); }
.tip .t-r b { color: var(--text); font-family: var(--mono); font-weight: 600; }
.tip .t-sum { margin-top: 4px; color: var(--muted); word-break: break-word; }

.foot { color: var(--faint); font-size: 11px; font-family: var(--mono); word-break: break-all; }
`

/* ------------------------------------------------------------------- shell */

/** The static markup the client script paints into. */
const SHELL = `
<main class="wrap">
  <header class="card" id="hdr"></header>

  <section class="card">
    <div class="card-head">
      <h2>Timeline</h2>
      <span class="spacer"></span>
      <div class="legend" id="legend"></div>
    </div>
    <div class="tl-wrap"><svg id="tl" role="img" aria-label="Call timeline"></svg></div>
  </section>

  <div class="split">
    <section class="card">
      <div class="card-head"><h2>Call detail</h2><span class="spacer"></span><span class="hint">click a row</span></div>
      <div id="detail"></div>
    </section>
    <section class="card">
      <div class="card-head">
        <h2>Transcript</h2><span class="spacer"></span>
        <label class="hint">agent <select id="tfilter"></select></label>
      </div>
      <div class="scroll" id="transcript"></div>
    </section>
  </div>

  <section class="card">
    <div class="card-head"><h2>Concurrency over time</h2><span class="spacer"></span><span class="hint" id="conc-hint"></span></div>
    <svg id="conc" role="img" aria-label="Concurrency over time"></svg>
  </section>

  <div class="split">
    <section class="card">
      <div class="card-head"><h2>Per agent</h2></div>
      <div class="scroll-x" id="agent-table"></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Per function</h2></div>
      <div class="scroll-x" id="fn-table"></div>
    </section>
  </div>

  <footer class="foot" id="foot"></footer>
</main>
<div class="tip" id="tip" hidden></div>
<noscript><div class="wrap"><p class="warn">This report draws its timeline in the browser and needs JavaScript enabled.</p></div></noscript>
`

/* ------------------------------------------------------------------ client */

/**
 * The browser-side program, emitted verbatim into a `<script>` element.
 *
 * Written in ES5-ish vanilla JavaScript with no template literals so that the
 * whole thing can live inside a TypeScript template literal without escaping,
 * and with no framework so that the file stays one download with no download.
 */
const CLIENT = String.raw`
(function () {
  'use strict';

  var D = JSON.parse(document.getElementById('fluvia-data').textContent);
  var SVGNS = 'http://www.w3.org/2000/svg';
  var OUTCOMES = ['done', 'failed', 'cancelled', 'skipped'];

  /* ---------------------------------------------------------- tiny helpers */

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  function s(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) { var v = attrs[k]; if (v !== null && v !== undefined) n.setAttribute(k, String(v)); }
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /** Human duration. Sub-millisecond work is real here, so keep two decimals. */
  function ms(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v === 0) return '0';
    if (Math.abs(v) < 1) return v.toFixed(2) + 'ms';
    if (Math.abs(v) < 100) return v.toFixed(1) + 'ms';
    if (Math.abs(v) < 1000) return Math.round(v) + 'ms';
    return (v / 1000).toFixed(2) + 's';
  }
  /** Axis tick labels: compact, and consistent across the whole axis. */
  function tickText(v, step) {
    if (step >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 's';
    if (step >= 1) return String(Math.round(v)) + 'ms';
    return v.toFixed(1) + 'ms';
  }
  /** A 1/2/5 x 10^n step that yields roughly 'want' ticks over 'span'. */
  function niceStep(span, want) {
    var raw = span / Math.max(1, want);
    if (!(raw > 0)) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }
  function pct(a, b) { return b > 0 ? (100 * a / b) : 0; }

  /* --------------------------------------------------------------- indexes */

  var callById = {};
  for (var i = 0; i < D.calls.length; i++) callById[D.calls[i].id] = D.calls[i];
  var notifyByCall = {};
  for (var j = 0; j < D.notifications.length; j++) {
    var nn = D.notifications[j];
    (notifyByCall[nn.call] || (notifyByCall[nn.call] = [])).push(nn);
  }
  /** Terminal state, or the synthetic 'open' bucket for calls the trace lost. */
  function cls(c) { return c.open ? 'open' : (c.outcome || 'open'); }

  var selected = null;

  /* ---------------------------------------------------------------- header */

  function chip(label, value) {
    var n = h('span', 'chip');
    add(n, document.createTextNode(label + ' '), h('b', null, value));
    return n;
  }
  function kpi(key, value, unit) {
    var n = h('div', 'kpi');
    var v = h('div', 'v', value);
    if (unit) add(v, h('span', 'u', unit));
    return add(n, h('div', 'k', key), v);
  }

  function drawHeader() {
    var root = clear(document.getElementById('hdr'));
    var st = D.stats;

    var top = h('div', 'hdr-top');
    add(top, h('h1', null, 'fluvia session report'), h('span', 'sid', D.meta.session));
    add(root, top);

    if (D.truncated) {
      add(root, h('p', 'warn',
        'No session.end event: this trace is truncated or the session is still running. ' +
        'Unsettled calls are drawn as open-ended bars to the end of the trace.'));
    }

    var meta = h('div', 'meta');
    add(meta,
      chip('node', D.meta.runtime.node),
      chip('platform', D.meta.runtime.platform),
      chip('fluvia', D.meta.runtime.fluvia),
      chip('concurrency', D.meta.concurrency),
      chip('sinks', (D.meta.sinks || []).join(', ') || 'none'),
      chip('preload', (D.meta.preload || []).join(', ') || 'none'));
    if (D.endReason) add(meta, chip('ended', D.endReason));
    add(root, meta);

    var kpis = h('div', 'kpis');
    add(kpis,
      kpi('wall clock', ms(D.wallMs)),
      kpi('calls', st.calls),
      kpi('agents', st.agents),
      kpi('notifications', st.notifications),
      kpi('mean parallelism', D.meanParallelism.toFixed(2), '× of ' + D.meta.concurrency),
      kpi('peak concurrency', D.peakConcurrency, '/ ' + D.meta.concurrency),
      kpi('busy time', ms(st.busyMs)));
    add(root, kpis);

    var mix = h('div', 'mix');
    var bar = h('div', 'mixbar');
    var total = 0;
    for (var o = 0; o < OUTCOMES.length; o++) total += st.outcomes[OUTCOMES[o]];
    var legend = h('div', 'mixlegend');
    for (var k = 0; k < OUTCOMES.length; k++) {
      var name = OUTCOMES[k], n = st.outcomes[name];
      if (n > 0) {
        var seg = h('span');
        seg.style.width = pct(n, total).toFixed(3) + '%';
        seg.style.background = 'var(--' + name + ')';
        seg.title = name + ': ' + n;
        add(bar, seg);
      }
      var item = h('span', null);
      var sw = h('span', 'swatch');
      sw.style.background = 'var(--' + name + ')';
      add(item, sw, document.createTextNode(name + ' ' + n));
      add(legend, item);
    }
    var openCalls = st.calls - total;
    if (openCalls > 0) {
      var oi = h('span', null);
      var osw = h('span', 'swatch');
      osw.style.background = 'var(--open)';
      add(oi, osw, document.createTextNode('unsettled ' + openCalls));
      add(legend, oi);
    }
    add(mix, bar, legend);
    add(root, mix);
  }

  function drawLegend() {
    var root = clear(document.getElementById('legend'));
    var items = D.hasQueueEvents
      ? [['blocked on deps', null], ['waiting for a slot', 'slot'],
         ['done', 'done'], ['failed', 'failed'], ['cancelled', 'cancelled'],
         ['skipped', 'skipped'], ['unsettled', 'open'], ['notification', 'notify']]
      : [['wait (submit → start)', null],
         ['done', 'done'], ['failed', 'failed'], ['cancelled', 'cancelled'],
         ['skipped', 'skipped'], ['unsettled', 'open'], ['notification', 'notify']];
    for (var i = 0; i < items.length; i++) {
      var span = h('span');
      var sw = h('span', items[i][1] ? 'swatch' : 'hatchbox');
      if (items[i][1]) sw.style.background = 'var(--' + items[i][1] + ')';
      add(span, sw, document.createTextNode(items[i][0]));
      add(root, span);
    }
  }

  /* -------------------------------------------------------------- timeline */

  var ROW_H = 19, BAR_H = 11, LANE_H = 20, LANE_GAP = 7, AXIS_H = 26, BOTTOM = 10;
  var rows = [];   /* {kind:'lane'|'call', ...} in draw order */
  var rowY = {};   /* call id -> centre y */

  function buildRows() {
    rows = [];
    for (var a = 0; a < D.agents.length; a++) {
      var agent = D.agents[a];
      var own = [];
      for (var i = 0; i < D.calls.length; i++) if (D.calls[i].agent === agent.id) own.push(D.calls[i]);
      rows.push({ kind: 'lane', agent: agent, count: own.length, index: a });
      for (var c = 0; c < own.length; c++) rows.push({ kind: 'call', call: own[c], index: a });
    }
  }

  function drawTimeline() {
    var svg = clear(document.getElementById('tl'));
    var host = svg.parentNode;
    var W = Math.max(320, host.clientWidth || 900);
    var labelW = W < 620 ? 92 : W < 900 ? 130 : 178;
    var x0 = labelW, x1 = W - 12;
    var plotW = Math.max(60, x1 - x0);
    var span = Math.max(D.wallMs, 1);
    function X(t) { return x0 + (Math.max(0, Math.min(span, t)) / span) * plotW; }

    if (rows.length === 0) {
      svg.setAttribute('viewBox', '0 0 ' + W + ' 60');
      svg.setAttribute('height', 60);
      var t = s('text', { x: 10, y: 34, class: 'row-label' });
      t.textContent = 'No calls in this trace.';
      add(svg, t);
      return;
    }

    /* Vertical layout: one band per agent, one row per call inside it. */
    var y = AXIS_H, bands = [];
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].kind === 'lane') {
        if (bands.length) y += LANE_GAP;
        rows[r].y = y;
        bands.push({ row: rows[r], top: y, index: rows[r].index });
        y += LANE_H;
      } else {
        rows[r].y = y;
        rowY[rows[r].call.id] = y + ROW_H / 2;
        y += ROW_H;
      }
      if (bands.length) bands[bands.length - 1].bottom = y;
    }
    var H = y + BOTTOM;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('height', H);

    var defs = s('defs');
    var pat = s('pattern', { id: 'fl-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    add(pat, s('rect', { width: 5, height: 5, class: 'hatch-bg' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'hatch-fg' }));
    add(defs, pat);
    add(svg, defs);

    var gBands = s('g'), gGrid = s('g'), gEdges = s('g'), gBars = s('g'), gMarks = s('g'), gLabels = s('g'), gHits = s('g');

    /* agent bands */
    for (var b = 0; b < bands.length; b++) {
      var band = bands[b];
      add(gBands, s('rect', {
        x: 0, y: band.top, width: W, height: Math.max(0, band.bottom - band.top),
        class: 'lane-band' + (b % 2 ? ' alt' : '')
      }));
      var lbl = s('text', { x: 6, y: band.top + 14, class: 'lane-label' });
      lbl.textContent = '@' + band.row.agent.id + '  ·  ' + band.row.count + (band.row.count === 1 ? ' call' : ' calls');
      add(gBands, lbl);
      add(gBands, s('line', { x1: 0, y1: band.top, x2: W, y2: band.top, class: 'lane-rule' }));
    }

    /* time axis: gridlines behind everything, labels along the top */
    var step = niceStep(span, W < 620 ? 4 : 8);
    for (var tv = 0; tv <= span + 1e-9; tv += step) {
      var gx = Math.round(X(tv)) + 0.5;
      add(gGrid, s('line', { x1: gx, y1: AXIS_H - 6, x2: gx, y2: H - BOTTOM, class: 'tick-line' }));
      var tl = s('text', { x: gx, y: AXIS_H - 11, class: 'tick-label', 'text-anchor': tv === 0 ? 'start' : 'middle' });
      tl.textContent = tickText(tv, step);
      add(gGrid, tl);
    }
    add(gGrid, s('line', { x1: x0, y1: AXIS_H - 5.5, x2: x1, y2: AXIS_H - 5.5, class: 'axis-rule' }));

    /* dependency edges: producer settle -> consumer start, drawn under the bars */
    for (var e = 0; e < D.edges.length; e++) {
      var edge = D.edges[e];
      var from = callById[edge.from], to = callById[edge.to];
      if (!from || !to || rowY[from.id] === undefined || rowY[to.id] === undefined) continue;
      var fx = X(from.settle === null || from.settle === undefined ? span : from.settle);
      var fy = rowY[from.id];
      var tx = X(to.start === null || to.start === undefined ? to.submit : to.start);
      var ty = rowY[to.id];
      var dx = Math.max(10, Math.abs(tx - fx) * 0.45);
      var path = s('path', {
        d: 'M' + fx + ',' + fy + ' C' + (fx + dx) + ',' + fy + ' ' + (tx - dx) + ',' + ty + ' ' + tx + ',' + ty,
        class: 'edge' + (edge.kind === 'error' ? ' err' : '')
      });
      path.setAttribute('data-from', edge.from);
      path.setAttribute('data-to', edge.to);
      add(gEdges, path);
    }

    /* one group per call: hit area, wait segment, run segment, notifications */
    for (var i2 = 0; i2 < rows.length; i2++) {
      if (rows[i2].kind !== 'call') continue;
      var call = rows[i2].call, top = rows[i2].y, by = top + (ROW_H - BAR_H) / 2;
      var kind = cls(call);
      var hasSettle = call.settle !== null && call.settle !== undefined;
      var endT = hasSettle ? call.settle : span;
      var startT = (call.start === null || call.start === undefined) ? endT : call.start;
      /* The wait splits at the moment the call became eligible. Without a
         call.queued event (older traces, and skipped calls that never became
         eligible at all) there is nothing to split and the whole wait is
         dependency wait. */
      var queuedT = (call.queued === null || call.queued === undefined) ? null : call.queued;

      /* hover/click target spanning the whole row, so thin bars stay reachable */
      var hover = s('rect', { x: 0, y: top, width: W, height: ROW_H, class: 'row-hover' });
      hover.setAttribute('data-hover', call.id);
      var hit = s('rect', { x: 0, y: top, width: W, height: ROW_H, class: 'row-hit' });
      hit.setAttribute('data-call', call.id);
      add(gHits, hover, hit);

      /* WAIT part 1 — blocked on dependencies: submit -> queued, hatched. */
      var wx = X(call.submit), depEnd = X(queuedT === null ? startT : queuedT);
      if (depEnd - wx > 0.4) {
        add(gBars, s('rect', { x: wx, y: by + 2, width: depEnd - wx, height: BAR_H - 4, rx: 1.5, class: 'bar-wait' }));
      }
      /* WAIT part 2 — eligible but starved of a concurrency slot: a solid
         muted bar, because solid-vs-hatched stays readable at 2px where two
         hatch angles would not. This is the scheduler-pressure segment. */
      if (queuedT !== null) {
        var sx = X(queuedT), sx2 = X(startT);
        if (sx2 - sx > 0.4) {
          add(gBars, s('rect', { x: sx, y: by + 2, width: sx2 - sx, height: BAR_H - 4, rx: 1.5, class: 'bar-slot' }));
        }
      }

      if (kind === 'skipped') {
        /* Skipped calls never ran: a thin marker at the moment they settled. */
        add(gBars, s('rect', { x: Math.max(x0, X(endT) - 1.5), y: by - 1, width: 3, height: BAR_H + 2, rx: 1, class: 'bar-mark skipped' }));
      } else if (call.start === null || call.start === undefined) {
        /* Still waiting when the trace ended: all wait, no run segment at all.
           Drawing a zero-width run bar here would imply work that never began. */
        var ox = X(endT);
        add(gBars, s('path', { d: 'M' + ox + ',' + by + ' L' + (ox + 6) + ',' + (by + BAR_H / 2) + ' L' + ox + ',' + (by + BAR_H) + ' Z', class: 'open-cap' }));
      } else {
        var rx0 = X(startT), rx1 = X(endT);
        add(gBars, s('rect', {
          x: rx0, y: by, width: Math.max(1.5, rx1 - rx0), height: BAR_H, rx: 2,
          class: 'bar-run ' + kind
        }));
        /* progress notes as hairlines inside the run segment */
        for (var p = 0; p < call.progress.length; p++) {
          var px = X(call.progress[p].at);
          if (px > rx0 + 1 && px < rx1 - 1) add(gBars, s('rect', { x: px, y: by, width: 1, height: BAR_H, class: 'prog-tick' }));
        }
        if (!hasSettle) {
          /* open-ended: a chevron at the trace end instead of a square edge */
          var cxp = X(span);
          add(gBars, s('path', { d: 'M' + cxp + ',' + by + ' L' + (cxp + 6) + ',' + (by + BAR_H / 2) + ' L' + cxp + ',' + (by + BAR_H) + ' Z', class: 'open-cap' }));
        }
      }

      /* notifications: emit -> first delivery lag, then a diamond at delivery */
      var notes = notifyByCall[call.id] || [];
      for (var q = 0; q < notes.length; q++) {
        var note = notes[q];
        var dl = note.deliveries[0];
        var ex = X(note.emitAt), my = top + ROW_H / 2;
        if (dl) {
          var dxp = X(dl.at);
          if (dxp - ex > 0.6) add(gMarks, s('line', { x1: ex, y1: my, x2: dxp, y2: my, class: 'notify-lag' }));
          add(gMarks, s('path', { d: 'M' + dxp + ',' + (my - 4) + ' l4,4 l-4,4 l-4,-4 z', class: 'notify-mark' }));
        } else {
          add(gMarks, s('path', { d: 'M' + ex + ',' + (my - 3) + ' l3,3 l-3,3 l-3,-3 z', class: 'notify-mark' }));
        }
      }

      /* row label in the gutter, truncated to the space actually available */
      var text = call.id + ' ' + call.fn;
      var maxChars = Math.max(4, Math.floor((labelW - 12) / 6.05));
      if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
      var rl = s('text', { x: 6, y: top + ROW_H / 2 + 3.5, class: 'row-label' });
      rl.setAttribute('data-label', call.id);
      rl.textContent = text;
      var ttl = s('title');
      ttl.textContent = call.id + ' ' + call.fn + ' (' + kind + ')';
      add(rl, ttl);
      add(gLabels, rl);
    }

    add(svg, gBands, gGrid, gEdges, gBars, gMarks, gLabels, gHits);
    paintSelection();
  }

  /** Re-apply selection styling without rebuilding the whole SVG. */
  function paintSelection() {
    var svg = document.getElementById('tl');
    var old = svg.querySelectorAll('.bar-sel');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    var hovers = svg.querySelectorAll('[data-hover]');
    for (var j = 0; j < hovers.length; j++) hovers[j].setAttribute('class', 'row-hover' + (hovers[j].getAttribute('data-hover') === selected ? ' on' : ''));
    var labels = svg.querySelectorAll('[data-label]');
    for (var k = 0; k < labels.length; k++) labels[k].setAttribute('class', 'row-label' + (labels[k].getAttribute('data-label') === selected ? ' sel' : ''));
    var edges = svg.querySelectorAll('.edge');
    for (var m = 0; m < edges.length; m++) {
      var hot = selected && (edges[m].getAttribute('data-from') === selected || edges[m].getAttribute('data-to') === selected);
      var base = 'edge' + (edges[m].classList.contains('err') ? ' err' : '');
      edges[m].setAttribute('class', hot ? base + ' hot' : base);
      if (hot) edges[m].parentNode.appendChild(edges[m]);
    }
  }

  /* --------------------------------------------------------------- tooltip */

  var tip = document.getElementById('tip');
  function tipRow(label, value) {
    var r = h('div', 't-r');
    return add(r, h('span', null, label), h('b', null, value));
  }
  function showTip(call, ev) {
    clear(tip);
    var head = h('div', 't-h', call.id + '  ' + call.fn);
    add(tip, head);
    add(tip, tipRow('agent', '@' + call.agent));
    add(tip, tipRow('state', cls(call)));
    add(tip, tipRow('submit', ms(call.submit)));
    if (call.depWaitMs !== undefined && call.depWaitMs !== null) {
      add(tip, tipRow('blocked on deps', ms(call.depWaitMs)));
      add(tip, tipRow('waiting for slot', ms(call.slotWaitMs)));
    } else {
      add(tip, tipRow('waited', ms(call.waitedMs)));
    }
    add(tip, tipRow('ran', call.start === null || call.start === undefined ? '—' : ms(call.runMs)));
    add(tip, tipRow('total', ms(call.totalMs)));
    if (call.value && call.value.summary) add(tip, h('div', 't-sum', call.value.summary));
    if (call.error) add(tip, h('div', 't-sum', call.error.kind + ': ' + call.error.message));
    if (call.skip) add(tip, h('div', 't-sum', 'skipped: ' + call.skip.reason + ' (' + call.skip.from + ')'));
    if (call.cancel) add(tip, h('div', 't-sum', 'cancelled by ' + call.cancel.by + ': ' + call.cancel.reason));
    tip.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    var pad = 14, w = tip.offsetWidth, ht = tip.offsetHeight;
    var left = ev.clientX + pad, top = ev.clientY + pad;
    if (left + w > window.innerWidth - 6) left = ev.clientX - w - pad;
    if (top + ht > window.innerHeight - 6) top = ev.clientY - ht - pad;
    tip.style.left = Math.max(6, left) + 'px';
    tip.style.top = Math.max(6, top) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  /* ---------------------------------------------------------- detail panel */

  function callRef(id) {
    var n = h('span', 'callref', id);
    n.setAttribute('data-call', id);
    return n;
  }

  /** Render an ArgNode tree back into the source the agent (nearly) wrote. */
  function renderArg(node, out, indent) {
    var pad = new Array(indent + 1).join('  ');
    if (!node) { add(out, h('span', 'tok-punct', 'null')); return; }
    if (node.n === 'lit') {
      var v = node.v;
      if (typeof v === 'string') add(out, h('span', 'tok-str', JSON.stringify(v)));
      else if (typeof v === 'number') add(out, h('span', 'tok-num', String(v)));
      else add(out, h('span', 'tok-kw', String(v)));
      return;
    }
    if (node.n === 'ref') {
      var r = h('span', 'ref', node.name);
      if (node.handle) r.title = 'handle ' + node.handle;
      add(out, r);
      return;
    }
    if (node.n === 'arr') {
      if (node.items.length === 0) { add(out, h('span', 'tok-punct', '[]')); return; }
      add(out, h('span', 'tok-punct', '['));
      for (var i = 0; i < node.items.length; i++) {
        add(out, document.createTextNode('\n' + pad + '  '));
        renderArg(node.items[i], out, indent + 1);
        if (i < node.items.length - 1) add(out, h('span', 'tok-punct', ','));
      }
      add(out, document.createTextNode('\n' + pad), h('span', 'tok-punct', ']'));
      return;
    }
    if (node.n === 'obj') {
      if (node.props.length === 0) { add(out, h('span', 'tok-punct', '{}')); return; }
      add(out, h('span', 'tok-punct', '{'));
      for (var p = 0; p < node.props.length; p++) {
        add(out, document.createTextNode('\n' + pad + '  '));
        add(out, h('span', 'tok-key', node.props[p].key), h('span', 'tok-punct', ': '));
        renderArg(node.props[p].value, out, indent + 1);
        if (p < node.props.length - 1) add(out, h('span', 'tok-punct', ','));
      }
      add(out, document.createTextNode('\n' + pad), h('span', 'tok-punct', '}'));
      return;
    }
    add(out, document.createTextNode(JSON.stringify(node)));
  }

  function sub(text) { return h('div', 'sub', text); }

  function drawDetail() {
    var root = clear(document.getElementById('detail'));
    var call = selected ? callById[selected] : null;
    if (!call) {
      add(root, h('p', 'empty', D.calls.length
        ? 'Select a call in the timeline or the transcript to inspect its arguments, handles, timings and notes.'
        : 'This trace contains no calls.'));
      return;
    }

    var head = h('div', 'dt-head');
    add(head, h('span', 'dt-id', call.id), h('span', 'dt-fn', call.fn + '()'),
      h('span', 'badge ' + cls(call), cls(call)), h('span', 'hint', '@' + call.agent + ' · seq ' + call.seq));
    add(root, head);

    /* arguments, with handle references left symbolic as the parser saw them */
    add(root, sub('arguments'));
    var pre = h('pre', 'args');
    if (!call.args || call.args.length === 0) add(pre, h('span', 'tok-punct', call.fn + '()'));
    else {
      add(pre, h('span', 'tok-punct', call.fn + '('));
      for (var a = 0; a < call.args.length; a++) {
        renderArg(call.args[a], pre, 0);
        if (a < call.args.length - 1) add(pre, h('span', 'tok-punct', ', '));
      }
      add(pre, h('span', 'tok-punct', ')'));
    }
    add(root, pre);

    /* dependencies in both directions */
    add(root, sub('dependencies'));
    var deps = h('div', 'chips');
    if (!call.deps.length) add(deps, h('span', 'hint', 'none — this call was eligible at submission'));
    for (var d = 0; d < call.deps.length; d++) {
      var dep = call.deps[d];
      var c = h('span', 'chip');
      add(c, document.createTextNode(dep.name + ' (' + dep.kind + ') from '), callRef(dep.from));
      add(deps, c);
    }
    add(root, deps);
    if (call.downstream.length) {
      add(root, sub('unblocks'));
      var down = h('div', 'chips');
      for (var w = 0; w < call.downstream.length; w++) {
        var dc = h('span', 'chip');
        add(dc, callRef(call.downstream[w]));
        add(down, dc);
      }
      add(root, down);
    }

    /* bound variables */
    add(root, sub('bound variables'));
    var ht = h('table');
    var thead = h('thead'), hr = h('tr');
    add(hr, h('th', null, 'variable'), h('th', null, 'handle'), h('th', null, 'channel'), h('th', null, 'state'), h('th', null, 'type'), h('th', null, 'summary'));
    add(thead, hr); add(ht, thead);
    var tb = h('tbody');
    for (var hh = 0; hh < call.handles.length; hh++) {
      var hv = call.handles[hh], tr = h('tr');
      add(tr, h('td', 'mono', hv.name), h('td', 'mono', hv.id || '—'), h('td', null, hv.kind),
        h('td', 'state-' + hv.state, hv.state), h('td', 'mono', hv.type || '—'), h('td', null, hv.summary || '—'));
      add(tb, tr);
    }
    add(ht, tb); add(root, ht);

    /* state transitions */
    add(root, sub('state transitions'));
    var tt = h('table'), tth = h('thead'), ttr = h('tr');
    add(ttr, h('th', null, 'event'), h('th', 'num', 'at'), h('th', 'num', 'Δ'));
    add(tth, ttr); add(tt, tth);
    var ttb = h('tbody');
    function trow(label, at, delta) {
      var r = h('tr');
      add(r, h('td', null, label), h('td', 'num', at === null || at === undefined ? '—' : ms(at)), h('td', 'num', delta));
      add(ttb, r);
    }
    trow('submit', call.submit, '—');
    if (D.hasQueueEvents) {
      trow('queued', call.queued,
        call.queued === null || call.queued === undefined
          ? (call.outcome === 'skipped' ? 'never became eligible' : 'never queued')
          : '+' + ms(call.depWaitMs) + ' blocked on deps');
    }
    trow('start', call.start,
      call.start === null || call.start === undefined
        ? 'never started'
        : (call.slotWaitMs === undefined || call.slotWaitMs === null
            ? '+' + ms(call.waitedMs) + ' waited'
            : '+' + ms(call.slotWaitMs) + ' waiting for a slot'));
    trow('settle', call.settle, call.settle === null || call.settle === undefined
      ? 'open at end of trace'
      : (call.start === null || call.start === undefined ? 'never ran' : '+' + ms(call.runMs) + ' ran'));
    trow('total', null, ms(call.totalMs) + (call.open ? ' (so far)' : '') + ' · ' + ms(call.waitedMs) + ' waited');
    add(tt, ttb); add(root, tt);

    /* notifications back to the agent */
    var notes = notifyByCall[call.id] || [];
    if (notes.length) {
      add(root, sub('notifications'));
      for (var nI = 0; nI < notes.length; nI++) {
        var nv = notes[nI];
        var line = h('div', 'note');
        add(line, h('span', 'at', ms(nv.emitAt)));
        var body = nv.id + ' → @' + nv.agent;
        if (nv.deliveries.length === 0) body += ' · emitted, never delivered';
        else {
          var dd = nv.deliveries[0];
          body += ' · ' + dd.sink + ' after ' + ms(nv.lagMs) + ' · ' + dd.bytes + 'B';
          if (dd.coalesced > 1) body += ' · coalesced with ' + (dd.coalesced - 1) + ' more';
          if (nv.deliveries.length > 1) body += ' · ' + nv.deliveries.length + ' sinks';
        }
        add(line, h('span', null, body));
        add(root, line);
      }
    }

    /* progress notes */
    if (call.progress.length) {
      add(root, sub('progress'));
      for (var pI = 0; pI < call.progress.length; pI++) {
        var pv = call.progress[pI];
        var pl = h('div', 'note');
        add(pl, h('span', 'at', '+' + ms(pv.at - (call.start === null || call.start === undefined ? call.submit : call.start))),
          h('span', null, (pv.pct !== undefined && pv.pct !== null ? pv.pct + '% · ' : '') + pv.note));
        add(root, pl);
      }
    }

    /* the reason it ended the way it did */
    if (call.error) {
      add(root, sub('error'));
      var eb = h('div', 'box failed');
      add(eb, h('span', 'kind', call.error.kind), document.createTextNode(' ' + call.error.message));
      if (call.error.retryable !== undefined) add(eb, h('div', 'hint', call.error.retryable ? 'retryable' : 'not retryable'));
      if (call.error.detail !== undefined) add(eb, h('pre', null, JSON.stringify(call.error.detail, null, 2)));
      add(root, eb);
    }
    if (call.skip) {
      add(root, sub('skip'));
      var sb = h('div', 'box skipped');
      add(sb, h('span', 'kind', call.skip.reason), document.createTextNode(' — upstream '), callRef(call.skip.from));
      add(root, sb);
    }
    if (call.cancel) {
      add(root, sub('cancellation'));
      var cb = h('div', 'box cancelled');
      add(cb, h('span', 'kind', call.cancel.by), document.createTextNode(' — ' + call.cancel.reason));
      add(root, cb);
    }
  }

  /* ------------------------------------------------------------ transcript */

  var filterAgent = '*';

  function drawTranscriptFilter() {
    var sel = clear(document.getElementById('tfilter'));
    var all = h('option', null, 'all');
    all.value = '*';
    add(sel, all);
    for (var i = 0; i < D.agents.length; i++) {
      var o = h('option', null, '@' + D.agents[i].id);
      o.value = D.agents[i].id;
      add(sel, o);
    }
    /* CLI-level output carries no agent id; give it its own bucket rather than
       inventing a lane for it. */
    for (var c = 0; c < D.transcript.length; c++) {
      if (!D.transcript[c].agent) {
        var cli = h('option', null, 'cli');
        cli.value = '';
        add(sel, cli);
        break;
      }
    }
    sel.value = filterAgent;
    sel.addEventListener('change', function () { filterAgent = sel.value; drawTranscript(); });
  }

  function drawTranscript() {
    var root = clear(document.getElementById('transcript'));
    var shown = 0;
    for (var i = 0; i < D.transcript.length; i++) {
      var line = D.transcript[i];
      if (filterAgent !== '*' && line.agent !== filterAgent) continue;
      shown++;
      var mentions = line.calls.indexOf(selected) >= 0;
      var row = h('div', 'tline ' + line.level + (mentions ? ' hit' : ''));
      add(row, h('span', 'at', ms(line.t)), h('span', 'who', line.agent ? '@' + line.agent : 'cli'));
      var txt = h('span', 'txt');
      /* Split the text on the call ids it mentions so each becomes clickable. */
      if (line.calls.length) {
        var re = new RegExp('\\b(' + line.calls.join('|') + ')\\b', 'g');
        var last = 0, m2;
        while ((m2 = re.exec(line.text)) !== null) {
          if (m2.index > last) add(txt, document.createTextNode(line.text.slice(last, m2.index)));
          add(txt, callRef(m2[1]));
          last = m2.index + m2[1].length;
        }
        if (last < line.text.length) add(txt, document.createTextNode(line.text.slice(last)));
      } else {
        txt.textContent = line.text;
      }
      add(row, txt);
      add(root, row);
    }
    if (!shown) add(root, h('p', 'empty', 'No transcript lines' + (filterAgent === '*' ? ' in this trace.' : ' for @' + filterAgent + '.')));
  }

  /* ----------------------------------------------------------------- stats */

  function table(cols, rowsData) {
    var t = h('table'), thead = h('thead'), hr = h('tr');
    for (var i = 0; i < cols.length; i++) add(hr, h('th', cols[i].num ? 'num' : null, cols[i].label));
    add(thead, hr); add(t, thead);
    var tb = h('tbody');
    for (var r = 0; r < rowsData.length; r++) {
      var tr = h('tr');
      if (rowsData[r].__sel) tr.className = 'sel';
      for (var c = 0; c < cols.length; c++) {
        var cell = rowsData[r][cols[c].key];
        add(tr, h('td', cols[c].num ? 'num' : (cols[c].mono ? 'mono' : null), cell));
      }
      add(tb, tr);
    }
    add(t, tb);
    return t;
  }

  function drawAgentTable() {
    var root = clear(document.getElementById('agent-table'));
    if (!D.agentStats.length) { add(root, h('p', 'empty', 'No agents joined this session.')); return; }
    var rowsData = D.agentStats.map(function (a) {
      return {
        agent: '@' + a.agent, calls: a.calls,
        done: a.outcomes.done, failed: a.outcomes.failed, cancelled: a.outcomes.cancelled, skipped: a.outcomes.skipped,
        p50: ms(a.p50TotalMs), p95: ms(a.p95TotalMs),
        wait: ms(a.meanWaitMs), dep: ms(a.meanDepWaitMs), slot: ms(a.meanSlotWaitMs), run: ms(a.meanRunMs),
        nl50: ms(a.notifyP50Ms), nl95: ms(a.notifyP95Ms)
      };
    });
    var waitCols = D.hasQueueEvents
      ? [{ key: 'dep', label: 'mean dep wait', num: true }, { key: 'slot', label: 'mean slot wait', num: true }]
      : [{ key: 'wait', label: 'mean wait', num: true }];
    add(root, table([
      { key: 'agent', label: 'agent', mono: true }, { key: 'calls', label: 'calls', num: true },
      { key: 'done', label: 'done', num: true }, { key: 'failed', label: 'fail', num: true },
      { key: 'cancelled', label: 'canc', num: true }, { key: 'skipped', label: 'skip', num: true },
      { key: 'p50', label: 'p50 total', num: true }, { key: 'p95', label: 'p95 total', num: true }
    ].concat(waitCols).concat([
      { key: 'run', label: 'mean run', num: true },
      { key: 'nl50', label: 'notify p50', num: true }, { key: 'nl95', label: 'notify p95', num: true }
    ]), rowsData));
  }

  function drawFnTable() {
    var root = clear(document.getElementById('fn-table'));
    if (!D.fnStats.length) { add(root, h('p', 'empty', 'No functions were called.')); return; }
    var rowsData = D.fnStats.map(function (f) {
      return {
        fn: f.fn, count: f.count, p50: ms(f.p50RunMs), p95: ms(f.p95RunMs), busy: ms(f.busyMs),
        slot: ms(f.meanSlotWaitMs),
        mix: f.outcomes.done + '/' + f.outcomes.failed + '/' + f.outcomes.cancelled + '/' + f.outcomes.skipped
      };
    });
    add(root, table([
      { key: 'fn', label: 'function', mono: true }, { key: 'count', label: 'n', num: true },
      { key: 'p50', label: 'p50 run', num: true }, { key: 'p95', label: 'p95 run', num: true },
      { key: 'busy', label: 'busy', num: true }
    ].concat(D.hasQueueEvents ? [{ key: 'slot', label: 'mean slot wait', num: true }] : []).concat([
      { key: 'mix', label: 'done/fail/canc/skip', num: true }
    ]), rowsData));
  }

  /* ------------------------------------------------ concurrency area chart */

  function drawConcurrency() {
    var svg = clear(document.getElementById('conc'));
    var host = svg.parentNode;
    var W = Math.max(320, host.clientWidth || 900);
    var H = 132, padL = 34, padR = 12, padT = 12, padB = 22;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('height', H);
    var plotW = Math.max(40, W - padL - padR), plotH = H - padT - padB;
    var span = Math.max(D.wallMs, 1);
    var limit = D.meta.concurrency || 1;
    var top = Math.max(1, D.peakConcurrency, limit) + 0.5;
    function X(t) { return padL + (Math.max(0, Math.min(span, t)) / span) * plotW; }
    function Y(n) { return padT + plotH - (n / top) * plotH; }

    document.getElementById('conc-hint').textContent =
      'peak ' + D.peakConcurrency + ' · limit ' + limit + ' · mean ' + D.meanParallelism.toFixed(2) +
      (D.hasQueueEvents ? ' · slot wait p50 ' + ms(D.slotWaitP50Ms) + ' / p95 ' + ms(D.slotWaitP95Ms) : '');

    /* y gridlines at integer levels, thinned out when the axis is crowded */
    var everyY = Math.ceil(top / 6);
    for (var n = 0; n <= Math.floor(top); n += everyY) {
      var gy = Math.round(Y(n)) + 0.5;
      add(svg, s('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, class: 'tick-line' }));
      var yl = s('text', { x: padL - 6, y: gy + 3.5, class: 'tick-label', 'text-anchor': 'end' });
      yl.textContent = String(n);
      add(svg, yl);
    }

    /* the profile is a step function, so the path uses only H and V moves */
    var pts = D.concurrency;
    var dArea = 'M' + X(pts[0].t) + ',' + Y(0), dLine = '';
    for (var i = 0; i < pts.length; i++) {
      var px = X(pts[i].t), py = Y(pts[i].n);
      if (i === 0) { dArea += ' L' + px + ',' + py; dLine = 'M' + px + ',' + py; }
      else { dArea += ' L' + px + ',' + Y(pts[i - 1].n) + ' L' + px + ',' + py; dLine += ' L' + px + ',' + Y(pts[i - 1].n) + ' L' + px + ',' + py; }
    }
    var lastX = X(pts[pts.length - 1].t);
    dArea += ' L' + lastX + ',' + Y(0) + ' Z';
    add(svg, s('path', { d: dArea, class: 'conc-area' }), s('path', { d: dLine, class: 'conc-line' }));

    /* the scheduler's limit, as a reference line */
    var ly = Math.round(Y(limit)) + 0.5;
    add(svg, s('line', { x1: padL, y1: ly, x2: W - padR, y2: ly, class: 'limit-line' }));
    var ll = s('text', { x: W - padR, y: ly - 4, class: 'limit-label', 'text-anchor': 'end' });
    ll.textContent = 'concurrency limit ' + limit;
    add(svg, ll);

    /* x axis shares the timeline's tick logic so the two charts read together */
    var step = niceStep(span, W < 620 ? 4 : 8);
    for (var tv = 0; tv <= span + 1e-9; tv += step) {
      var tx = Math.round(X(tv)) + 0.5;
      add(svg, s('line', { x1: tx, y1: padT + plotH, x2: tx, y2: padT + plotH + 4, class: 'tick-line' }));
      var tl = s('text', { x: tx, y: H - 6, class: 'tick-label', 'text-anchor': tv === 0 ? 'start' : 'middle' });
      tl.textContent = tickText(tv, step);
      add(svg, tl);
    }
  }

  /* ---------------------------------------------------------------- wiring */

  function select(id) {
    selected = (callById[id] && id !== selected) ? id : (callById[id] ? id : null);
    paintSelection();
    drawDetail();
    drawTranscript();
  }

  document.addEventListener('click', function (ev) {
    var node = ev.target;
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-call')) { select(node.getAttribute('data-call')); return; }
      node = node.parentNode;
    }
  });

  var tl = document.getElementById('tl');
  tl.addEventListener('mousemove', function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute('data-call');
    if (id && callById[id]) { showTip(callById[id], ev); } else { hideTip(); }
  });
  tl.addEventListener('mouseleave', hideTip);
  window.addEventListener('scroll', hideTip, true);

  /** Keyboard walk over the call list, so the report is usable without a mouse. */
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    if (!D.calls.length) return;
    var at = -1;
    for (var i = 0; i < D.calls.length; i++) if (D.calls[i].id === selected) at = i;
    var next = ev.key === 'ArrowDown' ? Math.min(D.calls.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1);
    selected = D.calls[next].id;
    ev.preventDefault();
    paintSelection(); drawDetail(); drawTranscript();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { drawTimeline(); drawConcurrency(); }, 120);
  });

  document.getElementById('foot').textContent = 'trace: ' + D.source;

  drawHeader();
  drawLegend();
  buildRows();
  drawTimeline();
  drawTranscriptFilter();
  drawTranscript();
  drawDetail();
  drawAgentTable();
  drawFnTable();
  drawConcurrency();
})();
`

/* ------------------------------------------------------------------ render */

/**
 * Render the whole report as one HTML string.
 *
 * The model is embedded rather than flattened into markup, so the page keeps
 * the full fidelity of the trace: the detail panel can pretty-print argument
 * trees and the timeline can be redrawn at a different width without a round
 * trip to the process that produced it.
 */
export function renderReport(model: PerfModel): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>fluvia perf · ${escapeHtml(model.meta.session)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    SHELL,
    `<script type="application/json" id="fluvia-data">${embedJson(model)}</script>`,
    `<script>${CLIENT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
