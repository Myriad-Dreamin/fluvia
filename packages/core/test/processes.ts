/**
 * The supervisor's pid face, checked from the outside.
 *
 * A call that asks for its own process group gets one, `pgid` is what
 * "everything this call started" means, `killGroup` ends that group deepest
 * member first, and a piped stdin is writable. All of it is read from the
 * kernel (`/proc`) and from pids — never inferred from the command text, which
 * cannot enumerate a `&`, a subshell, a `nohup`, a `setsid`, or a program's own
 * fork.
 *
 * Run with `pnpm --filter @fluvia/core test`.
 *
 * @module @fluvia/core/test/processes
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { NotifyHub } from '../src/plugins/notify.ts'
import { ProcessSupervisor } from '../src/plugins/processes.ts'
import type { Tracer } from '../src/trace.ts'

/** A tracer that keeps events in memory: this test never needs a trace file. */
class RecordingTracer {
  readonly origin = 0
  readonly events: Array<Record<string, unknown>> = []
  now(): number {
    return performance.now()
  }
  emit(k: string, body: Record<string, unknown>): number {
    const t = this.now()
    this.events.push({ seq: this.events.length, t, k, ...body })
    return t
  }
  /** The `process.spawn` event for one supervisor id, which must exist. */
  spawn(id: string): Record<string, unknown> {
    const event = this.events.find((e) => e['k'] === 'process.spawn' && e['id'] === id)
    assert.ok(event, `no process.spawn was traced for ${id}`)
    return event
  }
}

/** The pids in one process group, read from `/proc`. */
function groupPids(pgid: number): number[] {
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue
    let raw: string
    try {
      raw = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue // it went away between the listing and the read
    }
    // comm may hold spaces and parentheses, so the fields start after the last ')'
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    if (Number(fields[2]) === pgid) pids.push(Number(entry))
  }
  return pids
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const ctx = new Context()
const tracer = new RecordingTracer()
await ctx.plugin(NotifyHub, tracer as unknown as Tracer)
await ctx.plugin(ProcessSupervisor, {
  tracer: tracer as unknown as Tracer,
  dir: mkdtempSync(join(tmpdir(), 'fluvia-processes-')),
})
await ctx.inject(['processes'], () => {})
const processes = ctx.processes

/** A call record, as much of it as the supervisor and its notification read. */
const call = { id: 'c0', agent: 'worker', bind: { value: 'p0', error: 'e0' } } as never

// 1. A detached child leads its own group, and the group rides the trace.
const tree = await processes.spawn(call, { command: 'sh', args: ['-c', 'sleep 30 & wait'], detached: true })
assert.equal(tree.pgid, tree.pid, 'a detached child leads the group it was given')
assert.equal(tracer.spawn(tree.id)['pgid'], tree.pid, 'process.spawn carries the group')
assert.equal(tracer.spawn(tree.id)['pid'], tree.pid)

await sleep(300)
assert.equal(groupPids(tree.pgid).length, 2, 'the shell and the child it forked')

// 2. killGroup ends the whole group, deepest member first, and leaves nothing.
assert.equal(await processes.killGroup(tree.id), true)
assert.deepEqual(groupPids(tree.pgid), [], 'nothing the call started is left behind')

// 3. A child that did not ask for its own group is refused: its group is this
//    runtime's own, and signalling it would signal this process with itself.
const shared = await processes.spawn(call, { command: 'sleep', args: ['30'] })
assert.notEqual(shared.pgid, shared.pid, 'a shared-group child does not lead its group')
assert.equal(await processes.killGroup(shared.id), false, 'so its group is not ours to end')
processes.killAll()

// 4. `stdin: 'pipe'` is writable; a child without one answers false.
const sink = await processes.spawn(call, { command: 'cat', stdin: 'pipe' })
assert.equal(processes.write(sink.id, 'hello\n'), true)
await sleep(250)
assert.equal(readFileSync(sink.stdout, 'utf8'), 'hello\n', 'the piped stdin landed')

const silent = await processes.spawn(call, { command: 'sleep', args: ['30'] })
assert.equal(processes.write(silent.id, 'x'), false, 'no pipe, no write')
processes.killAll()

// 5. A deadline is the net under a call that may leave something running: the
//    first threshold asks with SIGTERM, the second insists with SIGKILL, and
//    both firings are in the trace, so "ended by its deadline" is auditable.
const polite = await processes.spawn(call, {
  command: 'sleep',
  args: ['30'],
  detached: true,
  deadline: { terminateAfterMs: 150, killAfterMs: 600 },
})
await sleep(400)
const term = tracer.events.find((e) => e['k'] === 'process.kill' && e['id'] === polite.id)
assert.ok(term, 'the first threshold is traced')
assert.equal(term['signal'], 'SIGTERM')
assert.equal(term['afterMs'], 150)
assert.equal(term['pgid'], polite.pgid)
assert.deepEqual(groupPids(polite.pgid), [], 'a child that takes the SIGTERM is gone')
assert.ok(
  !tracer.events.some((e) => e['k'] === 'process.kill' && e['id'] === polite.id && e['signal'] === 'SIGKILL'),
  'and is not also SIGKILLed',
)

// A program that traps SIGTERM outlives the first threshold; the second is what
// ends it — and it ends the whole group the program led.
const stubborn = await processes.spawn(call, {
  command: 'sh',
  args: ['-c', 'trap "" TERM; while :; do sleep 1; done'],
  detached: true,
  deadline: { terminateAfterMs: 150, killAfterMs: 500 },
})
await sleep(900)
const insisted = tracer.events.find(
  (e) => e['k'] === 'process.kill' && e['id'] === stubborn.id && e['signal'] === 'SIGKILL',
)
assert.ok(insisted, 'a child that traps SIGTERM meets the second threshold')
assert.equal(insisted['afterMs'], 500)
assert.deepEqual(groupPids(stubborn.pgid), [], 'and the whole group it led is gone')

// A process that ended on its own leaves no kill behind.
const quiet = await processes.spawn(call, {
  command: 'true',
  deadline: { terminateAfterMs: 100, killAfterMs: 200 },
})
await sleep(400)
assert.ok(
  !tracer.events.some((e) => e['k'] === 'process.kill' && e['id'] === quiet.id),
  'a process that already exited is not killed by its deadline',
)

await processes.drain()
console.log('processes: ok')
