/**
 * `fluvia bench` — find the benchmark cases in a tree, execute them, and say
 * which ones still hold.
 *
 * A case file is TypeScript that exports cases built with `defineBench`. Node
 * strips the types on import, so a case file needs no build step and no test
 * framework: it is loaded, its cases are run against the recordings they name,
 * and their judges decide. Nothing here samples a model unless a case's
 * takeover driver does, so the default run is free and offline — which is the
 * point: a harness change should be checkable without spending anything.
 *
 * Usage:
 *   fluvia bench [dir…] [--filter <substr>] [--json]
 *
 * Exit codes: 0 all passed, 1 a case failed, 2 a file could not be loaded or
 * a case could not be set up (the rest still run).
 *
 * @module @fluvia/cli/slice/bin
 */

import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import toolbox from '@fluvia/toolbox-default'
import { isBenchCase, runCase } from '@fluvia/core/bench/case'
import type { BenchCase, CaseResult } from '@fluvia/core/bench/case'

/** Case files are recognised by this suffix, whatever the extension. */
const PATTERN = /\.bench\.(ts|mts|cts|js|mjs|cjs)$/
/** Never walked: build output and dependencies hold copies of the cases. */
const SKIP = new Set(['node_modules', 'lib', 'dist', 'out', '.git'])

/** A file that could not be loaded, or a case that could not be set up. */
interface RunError {
  file: string
  case?: string
  message: string
}

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      filter: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    process.stdout.write(usage())
    return
  }

  const roots = (positionals.length ? positionals : ['.']).map((dir) => resolve(dir))
  const files: string[] = []
  for (const root of roots) collect(root, files)
  files.sort()

  const filter = values.filter?.toLowerCase()
  const results: CaseResult[] = []
  const errors: RunError[] = []

  for (const file of files) {
    const shown = relative(process.cwd(), file) || file
    const fileMatches = !filter || shown.toLowerCase().includes(filter)
    let cases: BenchCase[]
    try {
      cases = await load(file)
    } catch (error) {
      errors.push({ file: shown, message: reason(error) })
      continue
    }
    const base = shown.split(sep).pop()!.replace(PATTERN, '')
    for (const [index, entry] of cases.entries()) {
      const name = entry.name ?? (cases.length > 1 ? `${base} #${index + 1}` : base)
      if (!fileMatches && !name.toLowerCase().includes(filter!)) continue
      try {
        results.push(await runCase({ ...entry, name }, { dir: dirname(file), file: shown, toolbox }))
      } catch (error) {
        errors.push({ file: shown, case: name, message: reason(error) })
      }
    }
  }

  if (values.json) process.stdout.write(`${JSON.stringify(asJson(results, errors, files.length), null, 2)}\n`)
  else process.stdout.write(render(results, errors, files.length, filter))

  if (errors.length) process.exitCode = 2
  else if (results.some((result) => !result.pass)) process.exitCode = 1
}

/* ------------------------------------------------------------------ discovery */

function collect(dir: string, into: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // A root that is a file, or unreadable: nothing to walk.
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) collect(path, into)
    } else if (PATTERN.test(entry.name)) {
      into.push(path)
    }
  }
}

/**
 * The cases a file exports: a default export that is one case or an array of
 * them, plus a named `cases` export for files that want the default for
 * something else.
 */
async function load(file: string): Promise<BenchCase[]> {
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown; cases?: unknown }
  const found: BenchCase[] = []
  let sawSomething = false
  for (const candidate of [module.default, module.cases]) {
    if (candidate === undefined) continue
    sawSomething = true
    for (const entry of Array.isArray(candidate) ? candidate : [candidate]) {
      if (isBenchCase(entry)) found.push(entry)
    }
  }
  if (!found.length) {
    throw new Error(
      sawSomething
        ? 'exports nothing built with defineBench(); a case must come from `defineBench({ … })`'
        : 'exports no cases; expected `export default defineBench({ … })` or `export const cases = [ … ]`',
    )
  }
  return found
}

/* --------------------------------------------------------------------- output */

function render(results: CaseResult[], errors: RunError[], files: number, filter?: string): string {
  const out: string[] = []
  const rows = results.map((result) => ({
    result,
    cells: [
      result.pass ? 'pass' : 'FAIL',
      result.name,
      result.subject,
      `${result.report.totals.same}/${result.report.totals.diverged}/${result.report.totals.missing}`,
      `${result.verdicts.filter((verdict) => verdict.pass).length}/${result.verdicts.length}`,
      `${result.ms}ms`,
    ],
  }))
  const header = ['', 'case', 'subject', 'same/div/miss', 'judges', 'wall']
  const width = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row.cells[i]!.length)))
  const line = (cells: string[]) => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(width[i]!))).join('  ').trimEnd()

  if (rows.length) out.push(line(header), width.map((w) => '─'.repeat(w)).join('  '))
  let file = ''
  for (const row of rows) {
    if (row.result.file !== file) {
      file = row.result.file ?? ''
      out.push(file)
    }
    out.push(line(row.cells))
    for (const verdict of row.result.verdicts) {
      if (verdict.pass) continue
      out.push(`${' '.repeat(width[0]!)}  ✗ ${verdict.name}${verdict.reason ? `: ${verdict.reason}` : ''}`)
    }
    if (row.result.runs.length > 1) out.push(`${' '.repeat(width[0]!)}  ${row.result.passed}/${row.result.runs.length} runs passed`)
  }

  for (const error of errors) out.push(`load error  ${error.file}${error.case ? ` · ${error.case}` : ''}: ${error.message}`)

  if (!rows.length && !errors.length) {
    out.push(filter ? `no cases matched ${JSON.stringify(filter)} in ${files} file${files === 1 ? '' : 's'}` : 'no *.bench.ts files found')
  }
  out.push('', summaryLine(results, errors))
  return `${out.join('\n')}\n`
}

function summaryLine(results: CaseResult[], errors: RunError[]): string {
  const modelRuns = results.reduce((sum, result) => sum + result.cost.modelRuns, 0)
  const free = results.filter((result) => result.cost.modelRuns === 0).length
  const parts = [
    `${results.length} case${results.length === 1 ? '' : 's'}`,
    `${results.filter((result) => result.pass).length} passed`,
    `${free} free (no model)`,
    `${modelRuns} model run${modelRuns === 1 ? '' : 's'}`,
  ]
  if (errors.length) parts.push(`${errors.length} load error${errors.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/**
 * The machine-readable shape. The slice report is summarised rather than
 * embedded whole: what a CI job asks is which calls diverged and why, and the
 * line-by-line detail is one `fluvia slice replay --json` away.
 */
function asJson(results: CaseResult[], errors: RunError[], files: number): unknown {
  return {
    cases: results.map((result) => ({
      name: result.name,
      file: result.file,
      subject: result.subject,
      from: result.from,
      pass: result.pass,
      passed: result.passed,
      runs: result.runs.length,
      ms: result.ms,
      cost: result.cost,
      verdicts: result.verdicts,
      report: {
        from: result.report.from,
        to: result.report.to,
        takeover: result.report.takeover,
        concurrency: result.report.concurrency,
        totals: result.report.totals,
        order: result.report.order.map((lane) => ({ agent: lane.agent, same: lane.same })),
        diverged: result.report.calls
          .filter((call) => call.status !== 'same')
          .map((call) => ({ line: call.line, agent: call.agent, fn: call.fn, status: call.status, diffs: call.diffs })),
      },
    })),
    errors,
    summary: {
      files,
      cases: results.length,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      free: results.filter((result) => result.cost.modelRuns === 0).length,
      modelRuns: results.reduce((sum, result) => sum + result.cost.modelRuns, 0),
      tokens: results.reduce((sum, result) => sum + (result.cost.tokens ?? 0), 0) || undefined,
      errors: errors.length,
    },
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function usage(): string {
  return [
    'usage: fluvia bench [dir…] [options]',
    '',
    'Run every `*.bench.ts` case under the given directories (default `.`).',
    '',
    '  --filter <substr>  only files or cases whose path or name contains it',
    '  --json             print { cases, errors, summary } instead of a table',
    '',
    'Exit codes: 0 all passed, 1 a case failed, 2 a file or case could not be loaded.',
    '',
  ].join('\n')
}
