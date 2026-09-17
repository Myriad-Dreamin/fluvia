/**
 * `fluvia` — one executable, one subcommand per deployment shape.
 *
 * Each subcommand is a module with a `main(argv)`; this file only decides which
 * one runs and hands it everything after the subcommand name. Loading is lazy
 * so that `fluvia --help` does not pull in esbuild, a net server or a browser
 * launcher to print six lines.
 *
 * @module @fluvia/cli/main
 */

import { VERSION } from './version.ts'

/** A subcommand: what it is for, and the module that implements it. */
interface Command {
  readonly summary: string
  readonly load: () => Promise<{ main: (argv: string[]) => Promise<void> }>
}

const COMMANDS: Record<string, Command> = {
  cli: {
    summary: 'single-process REPL: the whole runtime in one trusted process',
    load: () => import('./cli/bin.ts'),
  },
  serve: {
    summary: 'run the runtime outside the sandbox and listen for clients',
    load: () => import('./server/bin.ts'),
  },
  connect: {
    summary: 'thin client for a running `fluvia serve`',
    load: () => import('./client/bin.ts'),
  },
  demo: {
    summary: 'drive the CLI as a scripted pair of agents and record a trace',
    load: () => import('./demo/run.ts'),
  },
  perf: {
    summary: 'render a trace as a self-contained HTML report and serve it',
    load: () => import('./perf/bin.ts'),
  },
  'dsh-inbox': {
    summary: 'receive `dsh:http:<url>` envelopes and watch them live',
    load: () => import('./dsh-inbox/bin.ts'),
  },
  bench: {
    summary: 'cut a recorded session into a slice: lines | replay | export',
    load: () => import('./bench/bin.ts'),
  },
  'bench-page': {
    summary: 'build the interactive slice-bench page into one HTML file',
    load: () => import('./bench/page/build.ts'),
  },
  run: {
    summary: 'run every `*.bench.ts` case in a tree and report pass or fail',
    load: () => import('./run/bin.ts'),
  },
}

/** Usage, generated from the table so the two cannot drift apart. */
function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  return [
    `fluvia ${VERSION} — a fully asynchronous dataflow CLI for LLM agents`,
    '',
    'usage: fluvia <command> [options]',
    '',
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
    '',
    'Run `fluvia <command> --help` for a command\'s own options.',
    '',
  ].join('\n')
}

/** Pick a subcommand and run it with the rest of the argv. */
export async function main(argv: string[]): Promise<void> {
  const [name, ...rest] = argv
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(usage())
    return
  }
  if (name === '--version' || name === '-v') {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  const command = COMMANDS[name]
  if (!command) {
    process.stderr.write(`fluvia: unknown command ${name}\n\n${usage()}`)
    process.exit(2)
  }
  const module = await command.load()
  await module.main(rest)
}
