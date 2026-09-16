#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pnpm demo-perf` — render the newest fluvia trace and serve it.
 *
 * The command is meant to be typed with no arguments right after `pnpm demo`,
 * so the default behaviour is to find the trace the demo just wrote, turn it
 * into `out/perf.html` and open it. Everything else is an escape hatch: a
 * trace path for looking at an older session, `--port` for when the default is
 * taken by something that is not us, and `--no-open` for headless boxes and
 * for scripted checks.
 *
 * The process stays alive on purpose. The report is a page you keep open while
 * you read it, so the server runs until Ctrl-C and then shuts down cleanly
 * rather than being killed mid-write.
 *
 * @module fluvia/perf/bin
 */

import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { readTrace } from '../core/trace.ts'
import { buildModel } from './model.ts'
import { renderReport } from './render.ts'
import { openBrowser, serveReport } from './serve.ts'

/** Exit code used for "there is nothing to render", as opposed to a crash. */
const EXIT_NO_TRACE = 1

/** Parsed command line. */
interface Options {
  /** Explicit trace path, or `undefined` to auto-discover the newest one. */
  trace?: string
  /** First port to try. */
  port: number
  /** Whether to ask the desktop to open the URL. */
  open: boolean
  /** Print usage and stop. */
  help: boolean
}

/** Usage text, kept next to the parser so the two cannot drift apart. */
const USAGE = `fluvia perf — render a session trace as a self-contained HTML report

usage: tsx src/perf/bin.ts [trace] [options]

  trace            path to a .jsonl.gz or .jsonl trace.
                   Default: the newest out/*.jsonl.gz (then out/*.jsonl).

  --port <n>       preferred port; incremented while busy (default: 7777)
  --no-open        do not try to launch a browser
  -h, --help       show this message

The report is written to out/perf.html and served until Ctrl-C.`

/** Parse `argv`, throwing a plain `Error` on anything malformed. */
function parseArgs(argv: string[]): Options {
  const options: Options = { port: 7777, open: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '--open') options.open = true
    else if (arg === '--port') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`--port expects a number between 1 and 65535, got ${argv[i] ?? '<nothing>'}`)
      }
      options.port = value
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length))
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`--port expects a number between 1 and 65535, got ${arg.slice(7)}`)
      }
      options.port = value
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else if (options.trace === undefined) {
      options.trace = arg
    } else {
      throw new Error(`unexpected extra argument: ${arg}`)
    }
  }
  return options
}

/**
 * Find the most recently modified trace in `out/`.
 *
 * Gzip traces are preferred because that is what the CLI writes by default;
 * plain `.jsonl` is only consulted when there is no compressed candidate, so a
 * stale uncompressed file cannot shadow a fresh session.
 */
function newestTrace(outDir: string): string | undefined {
  if (!existsSync(outDir)) return undefined
  const candidates: { path: string; mtimeMs: number }[] = []
  const collect = (suffix: string) => {
    for (const name of readdirSync(outDir)) {
      if (!name.endsWith(suffix)) continue
      const path = join(outDir, name)
      try {
        const info = statSync(path)
        if (info.isFile()) candidates.push({ path, mtimeMs: info.mtimeMs })
      } catch {
        // A file that vanished between readdir and stat is simply not a candidate.
      }
    }
  }
  collect('.jsonl.gz')
  if (candidates.length === 0) collect('.jsonl')
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.path
}

/** Round-trip a byte count into something worth printing. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Draw a box around the URL; this is the one line the user must not miss. */
function banner(url: string): string {
  const line = `  ${url}  `
  const rule = '─'.repeat(line.length)
  return ['', `┌${rule}┐`, `│${line}│`, `└${rule}┘`, ''].join('\n')
}

/** Entry point. Resolves a trace, renders it, serves it, waits for Ctrl-C. */
async function main(): Promise<void> {
  let options: Options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`fluvia perf: ${(error as Error).message}\n`)
    console.error(USAGE)
    process.exit(2)
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  const cwd = process.cwd()
  const outDir = join(cwd, 'out')
  const tracePath = options.trace ? resolve(cwd, options.trace) : newestTrace(outDir)

  if (!tracePath) {
    console.error('fluvia perf: no trace found.')
    console.error(`  Looked for out/*.jsonl.gz and out/*.jsonl under ${outDir}`)
    console.error('  Run `pnpm demo` first to record a session, or pass a trace path:')
    console.error('    pnpm demo-perf path/to/session.jsonl.gz')
    process.exit(EXIT_NO_TRACE)
    return
  }
  if (!existsSync(tracePath)) {
    console.error(`fluvia perf: no such trace: ${tracePath}`)
    console.error('  Run `pnpm demo` first to record a session.')
    process.exit(EXIT_NO_TRACE)
    return
  }

  const trace = readTrace(tracePath)
  const model = buildModel(trace)
  const html = renderReport(model)

  const reportPath = join(outDir, 'perf.html')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, html, 'utf8')

  const outcomes = model.stats.outcomes
  console.log(`fluvia perf — ${model.meta.session}`)
  console.log(`  trace   ${tracePath}`)
  console.log(
    `  session ${model.stats.calls} calls · ${model.stats.agents} agents · ` +
      `${model.stats.notifications} notifications · ${model.wallMs.toFixed(1)}ms wall`,
  )
  console.log(
    `  outcome ${outcomes.done} done · ${outcomes.failed} failed · ` +
      `${outcomes.cancelled} cancelled · ${outcomes.skipped} skipped` +
      (model.truncated ? ' · trace truncated (no session.end)' : ''),
  )
  console.log(`  report  ${reportPath} (${humanBytes(Buffer.byteLength(html))})`)

  const server = await serveReport(html, { port: options.port })
  if (server.port !== options.port) console.log(`  port    ${options.port} was busy, using ${server.port}`)
  console.log(banner(server.url))
  if (options.open) openBrowser(server.url)
  console.log('  Ctrl-C to stop serving.')

  // Keep the event loop alive until the user asks us to stop, then close the
  // listener so the port is free immediately for the next run.
  await new Promise<void>((done) => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      process.stdout.write('\n')
      console.log('fluvia perf: stopped.')
      void server.close().then(done)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

main().catch((error: unknown) => {
  console.error(`fluvia perf: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
