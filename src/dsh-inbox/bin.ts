/**
 * The dsh inbox: the other end of `--notify dsh:http:<url>`.
 *
 * `fluvia-dsh` POSTs one envelope record per delivery, which is exactly what a
 * DeepSeek Harness deployment would forward into an agent turn. In a real
 * deployment that receiver lives inside dsh; here it is a standalone server so
 * the envelope stream can be watched while a session runs — the notification
 * side of fluvia has no other visible surface.
 *
 * Usage: tsx src/dsh-inbox/bin.ts [--port 7788] [--path /inbox] [--log <file>]
 *
 * @module fluvia/dsh-inbox/bin
 */

import { createServer } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

/** One envelope as `fluvia-dsh`'s http transport posts it. */
interface EnvelopeRecord {
  v: number
  session: string
  at: number
  agent: string
  ids: string[]
  text: string
  calls?: { call: string; fn: string; outcome: string }[]
}

/** An envelope plus what the inbox knows about it. */
interface Received extends EnvelopeRecord {
  /** Monotonic index, used by the page to poll for what it has not seen. */
  n: number
  /** Wall-clock arrival, epoch ms. */
  received: number
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '7788' },
    host: { type: 'string', default: '127.0.0.1' },
    path: { type: 'string', default: '/inbox' },
    log: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  process.stdout.write('usage: tsx src/dsh-inbox/bin.ts [--port 7788] [--host 127.0.0.1] [--path /inbox] [--log <file>]\n')
  process.exit(0)
}

/** Kept in memory; the log file is the durable copy when `--log` is given. */
const received: Received[] = []
/** Cap so a long session cannot exhaust memory; the page shows the newest. */
const KEEP = 500

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'POST' && url.pathname === values.path) {
    const body = await readBody(request)
    try {
      const record = JSON.parse(body) as EnvelopeRecord
      const entry: Received = { ...record, n: received.length, received: Date.now() }
      received.push(entry)
      if (received.length > KEEP) received.splice(0, received.length - KEEP)
      if (values.log) {
        await mkdir(dirname(values.log), { recursive: true })
        await appendFile(values.log, `${JSON.stringify(entry)}\n`)
      }
      process.stdout.write(`← ${entry.agent || 'cli'} ${entry.ids.join(',')} (${entry.text.split('\n').length} lines)\n`)
      send(response, 202, 'application/json', JSON.stringify({ ok: true, n: entry.n }))
    } catch (error) {
      send(response, 400, 'application/json', JSON.stringify({ ok: false, error: (error as Error).message }))
    }
    return
  }

  if (url.pathname === '/api/envelopes') {
    const since = Number(url.searchParams.get('since') ?? '-1')
    send(response, 200, 'application/json', JSON.stringify(received.filter((entry) => entry.n > since)))
    return
  }

  if (url.pathname === '/') {
    send(response, 200, 'text/html; charset=utf-8', PAGE)
    return
  }

  send(response, 404, 'text/plain; charset=utf-8', 'not found\n')
})

/** Collect a request body; envelopes are small, so buffering is fine. */
function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (body += chunk))
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

/** Write one response. */
function send(response: import('node:http').ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}

const port = Number(values.port)
server.listen(port, values.host, () => {
  process.stdout.write(
    [
      'fluvia dsh inbox',
      `  receiving  POST http://${values.host}:${port}${values.path}`,
      `  watching   http://${values.host}:${port}/`,
      values.log ? `  logging    ${values.log}` : '',
      '',
      `  point a session at it:  --notify dsh:http://${values.host}:${port}${values.path}`,
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.closeAllConnections?.()
    server.close(() => process.exit(0))
  })
}

/**
 * The watch page. Self-contained and dependency-free, polling `/api/envelopes`
 * for what it has not seen — envelopes arrive in bursts a second apart, so a
 * poll is honest and a socket would be ceremony.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fluvia · dsh inbox</title>
<style>
  :root {
    --bg: #f7f7f8; --panel: #ffffff; --ink: #16161a; --muted: #6b6b76;
    --border: #e3e3e8; --accent: #4f46e5; --accent-soft: #eef2ff;
    --ready: #15803d; --failed: #b91c1c; --skipped: #a16207; --cancelled: #6b6b76;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e0e11; --panel: #17171c; --ink: #ececf1; --muted: #9a9aa6;
      --border: #26262e; --accent: #8b87f5; --accent-soft: #1d1b33;
      --ready: #4ade80; --failed: #f87171; --skipped: #fbbf24; --cancelled: #9a9aa6;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.5; }
  header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--border); padding: 14px 16px; display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--muted); font-weight: 400; }
  .meta { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .live { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ready); }
  .dot.stale { background: var(--muted); }
  main { max-width: 900px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column-reverse; gap: 12px; }
  .env { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .env-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 9px 12px; border-bottom: 1px solid var(--border); background: var(--accent-soft); }
  .chip { font-family: var(--mono); font-size: 12px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); }
  .chip.agent { color: var(--accent); border-color: currentColor; }
  .ids { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .when { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--muted); }
  pre { margin: 0; padding: 12px; font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  pre b { font-weight: 600; }
  pre .ready { color: var(--ready); } pre .failed { color: var(--failed); }
  pre .skipped { color: var(--skipped); } pre .cancelled { color: var(--cancelled); }
  .empty { color: var(--muted); text-align: center; padding: 48px 16px; }
  .empty code { font-family: var(--mono); background: var(--panel); border: 1px solid var(--border); padding: 2px 6px; border-radius: 6px; }
</style>
</head>
<body>
<header>
  <h1>fluvia <span>· dsh inbox</span></h1>
  <div class="meta" id="count">0 envelopes</div>
  <div class="live" style="margin-left:auto"><span class="dot" id="dot"></span><span id="status">watching</span></div>
</header>
<main id="list">
  <div class="empty" id="empty">No envelopes yet. Point a session at this inbox with<br><code>--notify dsh:http://HOST:PORT/inbox</code></div>
</main>
<script>
(function () {
  var since = -1, total = 0, list = document.getElementById('list'), empty = document.getElementById('empty')
  var SECTIONS = ['ready', 'failed', 'skipped', 'cancelled']
  function tag(text) {
    var pre = document.createElement('pre')
    text.split('\\n').forEach(function (line, index) {
      var section = SECTIONS.find(function (name) { return line === name || line.indexOf(name + ' ') === 0 })
      if (section) {
        var strong = document.createElement('b')
        strong.className = section
        strong.textContent = line
        pre.appendChild(strong)
      } else {
        pre.appendChild(document.createTextNode(line))
      }
      if (index) pre.insertBefore(document.createTextNode(''), null)
      pre.appendChild(document.createTextNode('\\n'))
    })
    return pre
  }
  function card(entry) {
    var root = document.createElement('div')
    root.className = 'env'
    var head = document.createElement('div')
    head.className = 'env-head'
    var agent = document.createElement('span')
    agent.className = 'chip agent'
    agent.textContent = '@' + (entry.agent || 'cli')
    var ids = document.createElement('span')
    ids.className = 'ids'
    ids.textContent = entry.ids.join(' ')
    var session = document.createElement('span')
    session.className = 'chip'
    session.textContent = entry.session
    var when = document.createElement('span')
    when.className = 'when'
    when.textContent = new Date(entry.received).toLocaleTimeString()
    head.appendChild(agent); head.appendChild(ids); head.appendChild(session); head.appendChild(when)
    root.appendChild(head)
    root.appendChild(tag(entry.text))
    return root
  }
  function poll() {
    fetch('/api/envelopes?since=' + since).then(function (r) { return r.json() }).then(function (rows) {
      document.getElementById('dot').className = 'dot'
      document.getElementById('status').textContent = 'watching'
      rows.forEach(function (entry) {
        since = Math.max(since, entry.n)
        total++
        if (empty) { empty.remove(); empty = null }
        list.appendChild(card(entry))
      })
      if (rows.length) document.getElementById('count').textContent = total + ' envelope' + (total === 1 ? '' : 's')
    }).catch(function () {
      document.getElementById('dot').className = 'dot stale'
      document.getElementById('status').textContent = 'disconnected'
    })
  }
  poll(); setInterval(poll, 1000)
})()
</script>
</body>
</html>
`
