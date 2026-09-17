/**
 * `fluvia bench` — cut a recorded session into a slice and replay it.
 *
 * Usage:
 *   fluvia slice lines  --trace <file>
 *   fluvia slice replay --trace <file> --from <n> [--to <n>] [--concurrency <n>]
 *                       [--edit <n>=<line>]... [--json]
 *   fluvia slice export --trace <file> --out <file.json>
 *   fluvia slice page   [--trace <file>] [--out <file.html>]
 *
 * `replay` is the mechanical mode: every recorded line of the slice is typed
 * again on its anchor and the runtime's answers are diffed against the
 * recording. Agent mode needs an agent, so it lives where agents live: the pi
 * web app (packages/pi-web-fluvia) and the demo page drive `SliceSession`
 * with `takeover` set.
 *
 * @module @fluvia/cli/slice/bin
 */

import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { readTrace } from '@fluvia/core/trace'
import toolbox from '@fluvia/toolbox-default'
import { indexTrace } from '@fluvia/core/bench/slice'
import { SliceSession } from '@fluvia/core/bench/session'
import type { SliceReport } from '@fluvia/core/bench/session'

/** Run the slice bench against `argv` (everything after `fluvia bench`). */
const USAGE = `fluvia slice — cut a recorded session into a slice and replay it

  fluvia slice lines  --trace <file>
  fluvia slice replay --trace <file> --from <n> [--to <n>] [--concurrency <n>]
                      [--edit <n>=<line>]... [--json]
  fluvia slice export --trace <file> --out <file.json>
  fluvia slice page   [--trace <file>] [--out <file.html>]

lines   list the recorded lines with what each was typed after
replay  type the slice again on a virtual clock and diff every call against the recording
export  write the trace's events as a JSON array
page    build the interactive slice page into one HTML file (needs a checkout)
`

export async function main(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    process.stdout.write(USAGE)
    return
  }
  if (argv[0] === 'page') {
    const { main: buildPage } = await import('./page/build.ts')
    await buildPage(argv.slice(1))
    return
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      trace: { type: 'string' },
      from: { type: 'string', default: '0' },
      to: { type: 'string' },
      concurrency: { type: 'string' },
      edit: { type: 'string', multiple: true },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })

  const command = positionals[0] ?? 'lines'
  if (!values.trace) {
    process.stderr.write('slice: --trace <file> is required\n')
    process.exit(2)
  }
  const loaded = readTrace(values.trace)
  const trace = indexTrace(loaded.events)

  switch (command) {
    case 'lines': {
      for (const line of trace.lines) {
        const anchor =
          line.anchor.kind === 'notify'
            ? `after ${line.anchor.call} +${line.anchor.gapMs}ms`
            : line.anchor.kind === 'line'
              ? `after line ${line.anchor.index} +${line.anchor.gapMs}ms`
              : `+${line.anchor.gapMs}ms`
        process.stdout.write(`${String(line.index).padStart(3)}  ${(line.call ?? line.kind).padEnd(8)} ${anchor.padEnd(22)} ${line.line}\n`)
      }
      break
    }
    case 'replay': {
      const edits: Record<number, string> = {}
      for (const spec of values.edit ?? []) {
        const at = spec.indexOf('=')
        edits[Number(spec.slice(0, at))] = spec.slice(at + 1)
      }
      const started = performance.now()
      const session = await SliceSession.open(trace, {
        from: Number(values.from),
        to: values.to === undefined ? undefined : Number(values.to),
        concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
        edits,
        toolbox,
      })
      const report = await session.finish()
      if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      else process.stdout.write(render(report, performance.now() - started))
      process.exitCode = report.totals.diverged || report.totals.missing ? 1 : 0
      break
    }
    case 'export': {
      if (!values.out) throw new Error('export needs --out <file.json>')
      writeFileSync(values.out, JSON.stringify(loaded.events))
      process.stdout.write(`${loaded.events.length} events → ${values.out}\n`)
      break
    }
    default:
      process.stderr.write(`slice: unknown command ${command}; expected lines, replay, export or page\n`)
      process.exit(2)
  }
}

function render(report: SliceReport, wallMs: number): string {
  const out: string[] = []
  out.push(
    `slice lines ${report.from}..${report.to - 1} · concurrency ${report.concurrency} · replayed in ${Math.round(wallMs)}ms wall`,
    `calls: ${report.totals.same} same, ${report.totals.diverged} diverged, ${report.totals.missing} missing`,
    '',
  )
  for (const call of report.calls) {
    if (call.status === 'same') continue
    out.push(`  ${call.status.padEnd(8)} line ${call.line} ${call.agent} ${call.fn}`)
    for (const diff of call.diffs) out.push(`      ${diff.field}: ${diff.recorded}`, `      ${' '.repeat(diff.field.length)}→ ${diff.replayed}`)
  }
  for (const line of report.lines) {
    if (line.status === 'same') continue
    out.push(`  line ${line.index} ${line.status}: ${line.replayed ?? line.recorded}`)
  }
  for (const order of report.order) {
    if (order.same) continue
    out.push(`  notification order for ${order.agent} changed:`, `      recorded ${order.recorded.join(', ')}`, `      replayed ${order.replayed.join(', ')}`)
  }
  if (!report.calls.some((call) => call.status !== 'same') && report.order.every((order) => order.same)) out.push('  no divergence')
  return `${out.join('\n')}\n`
}
