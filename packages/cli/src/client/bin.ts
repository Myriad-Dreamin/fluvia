/**
 * `fluvia connect` — the same terminal experience as `fluvia cli`, except the
 * runtime is somewhere else.
 *
 * This is the surface a sandboxed operator gets: it reads the instruction set
 * from the server rather than loading one, submits lines, and prints results as
 * they arrive. Nothing it does can reach past the wire, which is what makes it
 * safe to hand to the side of the boundary the model lives on.
 *
 * Usage: fluvia connect [--connect unix:/tmp/fluvia.sock] [--label me]
 *                       [--token-file <path>] [--script <file>]
 *
 * @module @fluvia/cli/client/bin
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { FluviaClient } from './client.ts'
import { parseAddress } from '@fluvia/core/protocol'
import { renderNotificationLine } from '@fluvia/core/format'

/** Run the thin client against `argv` (everything after `fluvia connect`). */
export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      connect: { type: 'string', default: 'unix:/tmp/fluvia.sock' },
      label: { type: 'string' },
      'token-file': { type: 'string' },
      script: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    process.stdout.write('usage: fluvia connect [--connect <addr>] [--label <name>] [--token-file <p>] [--script <f>]\n')
    return
  }

  const client = await FluviaClient.connect(parseAddress(values.connect!), {
    label: values.label ?? `cli-${process.pid}`,
    token: values['token-file'] ? readFileSync(values['token-file'], 'utf8').trim() : undefined,
    onNotification: (notification) => process.stdout.write(`${renderNotificationLine(notification)}\n`),
    onClose: (reason) => {
      process.stdout.write(`connection closed: ${reason}\n`)
      process.exit(0)
    },
  })

  if (!values.quiet) {
    const instructions = client.isa.filter((entry) => entry.kind === 'async')
    process.stdout.write(
      [
        `fluvia ${client.session} · agent ${client.agent} · concurrency ${client.concurrency}`,
        `instruction set (${instructions.length}): ${instructions.map((entry) => entry.name).join(', ')}`,
        `limits: ${client.limits.maxInFlight} calls in flight · ${client.limits.submitsPerSecond}/s · ${client.limits.maxLineBytes} bytes/line`,
        'one call per line · results arrive as notifications · help() for the syntax',
      ].join('\n') + '\n',
    )
  }

  await run()

  /** Feed lines from a script file, or from stdin until EOF. */
  async function run(): Promise<void> {
    if (values.script) {
      for (const line of readFileSync(values.script, 'utf8').split('\n')) {
        if (line.trim()) await submit(line)
      }
      // A script's calls are still in flight when its last line is read, so the
      // notifications have to be waited for rather than raced against exit.
      await new Promise((resolve) => setTimeout(resolve, 100))
      return
    }
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    for await (const line of rl) {
      if (line.trim() === '.exit' || line.trim() === '.quit') break
      if (line.trim()) await submit(line)
    }
    rl.close()
    client.close()
  }

  /** Submit one line and print whatever the server answers. */
  async function submit(line: string): Promise<void> {
    const answer = await client.submit(line)
    if (answer.t === 'ack') {
      const waiting = answer.deps.length ? `waiting: ${answer.deps.map((dep) => dep.name).join(', ')}` : answer.state
      process.stdout.write(`→ ${answer.call} ${answer.fn} ⇒ ${answer.bind.value}, ${answer.bind.error}  [${waiting}]\n`)
    } else if (answer.t === 'control') {
      process.stdout.write(`${answer.text}\n`)
    } else {
      process.stdout.write(`✗ ${answer.message}\n`)
    }
  }
}
