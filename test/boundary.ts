/**
 * What the boundary is worth, checked from the outside.
 *
 * fluvia's deployment model puts the model inside a sandbox and the runtime
 * outside it, so the interesting properties are not "does a call work" but
 * "what happens when a client tries something it should not be able to do".
 * Each check below is one of those attempts, driven through the real wire by
 * two clients against a real server.
 *
 * Run with `pnpm test:boundary`.
 *
 * @module fluvia/test/boundary
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'


/** Start a server of our own, so the test owns its lifetime and its socket. */
const dir = mkdtempSync(join(tmpdir(), 'fluvia-boundary-'))
const socket = join(dir, 'fluvia.sock')
const server = spawn(
  process.execPath,
  [
    '--import',
    'tsx',
    fileURLToPath(new URL('../src/server/bin.ts', import.meta.url)),
    '--listen',
    `unix:${socket}`,
    '--concurrency',
    '4',
    '--max-in-flight',
    '3',
    '--rate',
    '50',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)
process.on('exit', () => server.kill('SIGTERM'))
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not announce in time')), 30_000)
  server.stdout!.setEncoding('utf8')
  server.stdout!.on('data', (chunk: string) => {
    if (chunk.includes('listening')) {
      clearTimeout(timer)
      resolve()
    }
  })
  server.on('exit', (code) => reject(new Error(`server exited with ${String(code)}`)))
})

const address = parseAddress(`unix:${socket}`)

import { FluviaClient } from '../src/client/client.ts'
import { parseAddress } from '../src/server/protocol.ts'
import type { Notification } from '../src/core/types.ts'

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = '') => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const aNotes: Notification[] = []
const bNotes: Notification[] = []
const a = await FluviaClient.connect(address, { label: 'dsh-alice', onNotification: (n) => aNotes.push(n) })
const b = await FluviaClient.connect(address, { label: 'dsh-bob', onNotification: (n) => bNotes.push(n) })

check('server assigns identity', a.agent === 'dsh-alice' && b.agent === 'dsh-bob', `${a.agent} / ${b.agent}`)
check('identity is unique', (await FluviaClient.connect(address, { label: 'dsh-alice' })).agent === 'dsh-alice-2')
check('ISA is published', a.isa.some((e) => e.name === 'prepareKernel') && a.isa.some((e) => e.kind === 'control'))

const ack = await a.submit('prepareKernel({ size: 512 })')
check('submit acks instantly', ack.t === 'ack', ack.t === 'ack' ? `${ack.call} ⇒ ${ack.bind.value}` : JSON.stringify(ack))
const aCall = ack.t === 'ack' ? ack.call : ''
const aHandle = ack.t === 'ack' ? ack.bind.value : ''

const spoof = await b.submit(`@dsh-alice prepareKernel({ size: 8 })`)
check('an @agent prefix is refused', spoof.t === 'error', spoof.t === 'error' ? spoof.message : '')

const steal = await b.submit(`compileKernel(${aHandle}, { opt: 1 })`)
check("another agent's handle is not nameable", steal.t === 'error' && /unknown handle/.test(steal.message), steal.t === 'error' ? steal.message : '')

const cancel = await b.submit(`cancel(${aCall})`)
check("another agent's call cannot be cancelled", cancel.t === 'control' && /unknown call/.test(cancel.text), cancel.t === 'control' ? cancel.text.trim() : '')

const peek = await b.submit(`inspect(${aCall})`)
check("another agent's call cannot be inspected", peek.t === 'control' && /unknown target/.test(peek.text), peek.t === 'control' ? peek.text.trim() : '')

const roster = await b.submit('inspect(@dsh-alice)')
check("another agent cannot be profiled", roster.t === 'control' && /unknown agent/.test(roster.text), roster.t === 'control' ? roster.text.trim() : '')

const list = await b.submit('list("all")')
check('list shows only own calls', list.t === 'control' && !list.text.includes(aCall), list.t === 'control' ? list.text.split('\n')[0] : '')

const isaEscape = await b.submit('preload("/tmp/evil.js")')
check('the ISA cannot be extended over the wire', isaEscape.t === 'error', isaEscape.t === 'error' ? isaEscape.message : '')

const compute = await b.submit('prepareKernel({ size: 1 + 1 })')
check('no computation crosses the wire', compute.t === 'error', compute.t === 'error' ? compute.message : '')

// in-flight cap is 3 for this server
const many = await Promise.all([1, 2, 3, 4, 5].map((n) => b.submit(`sleep({ ms: 4000, label: "s${n}" })`)))
const rejected = many.filter((answer) => answer.t === 'error' && /in flight/.test(answer.message))
check('in-flight cap is enforced', rejected.length === 2, `${rejected.length} of 5 refused`)

const exited = await new Promise<string>((resolve) => {
  const c = FluviaClient.connect(address, { label: 'quitter', onClose: (reason) => resolve(reason) })
  void c.then((client) => client.submit('.exit'))
})
check('.exit closes only that connection', /exited/.test(exited), exited)

await new Promise((r) => setTimeout(r, 1200))
check('notifications go only to the owner', aNotes.length >= 1 && aNotes.every((n) => n.agent === 'dsh-alice') && !bNotes.some((n) => n.agent === 'dsh-alice'),
  `alice ${aNotes.length}, bob ${bNotes.length}`)

const stillAlive = await a.submit('list')
check('runtime survives a client leaving', stillAlive.t === 'control')

a.close()
b.close()
server.kill('SIGTERM')
rmSync(dir, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURE(S)` : `\nall ${String(checks)} boundary checks passed`)
process.exit(failures ? 1 : 0)
