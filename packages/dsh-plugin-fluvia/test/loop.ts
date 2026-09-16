/**
 * The closed loop across the boundary: submit → ack → settle → notification →
 * the session that asked, and no other.
 *
 * `verify.ts` covers rendering and routing against doubles. This covers the
 * part only two real processes can show: a fluvia runtime started the way an
 * operator starts it (`pnpm serve`, outside the sandbox), and this plugin's
 * wire client connecting to it as two independent dsh sessions.
 *
 * What it is really testing is the boundary. Two sessions share one runtime;
 * each must see its own results and nothing of the other's, and neither may
 * reach past the socket. It needs the fluvia repository (it spawns the real
 * server) but no harness, no model and no credentials.
 *
 * Run: `node --experimental-strip-types test/loop.ts`.
 *
 * @module dsh-plugin-fluvia/test/loop
 */

import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  Courier,
  EnvelopeCoalescer,
  WireHub,
  fluviaAgentId,
  parseAddress,
  type AgentSource,
  type CourierLog,
  type TargetAgent,
  type WireNotification,
} from 'dsh-plugin-fluvia'

/** Two dsh sessions share one runtime; only one of them submits work. */
const SUBMITTER = 's-loop-submitter'
const BYSTANDER = 's-loop-bystander'

/**
 * A short socket path.
 *
 * Unix socket paths are capped near 107 bytes by the kernel, which the
 * session scratchpad directory alone nearly exhausts — so this test keeps its
 * own short name and unlinks it afterwards.
 */
const SOCKET = `/tmp/fluvia-plugin-loop-${process.pid}.sock`

/** The fluvia repo: this package lives at `<repo>/packages/dsh-plugin-fluvia/test`. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const logged: string[] = []
const log: CourierLog = {
  info: (format: unknown) => void logged.push(`info ${String(format)}`),
  warn: (format: unknown) => void logged.push(`warn ${String(format)}`),
}

/** Minimal stand-in for a live agent; see `verify.ts` for why this type. */
class AgentDouble implements TargetAgent {
  readonly followups: UserMessage[] = []
  readonly injections: UserMessage[] = []
  readonly id: TargetAgent['id']
  readonly status: TargetAgent['status'] = 'idle'

  constructor(id: TargetAgent['id']) {
    this.id = id
  }

  followup(message: UserMessage): void {
    this.followups.push(message)
  }

  inject(message: UserMessage): void {
    this.injections.push(message)
  }
}

/** A registry holding both sessions. */
class RegistryDouble implements AgentSource {
  readonly agents: TargetAgent[] = []
  list(): readonly TargetAgent[] {
    return this.agents
  }
}

/** The text block of a delivered message. */
function textOf(message: UserMessage): string {
  const block = message.content[0]
  assert.ok(block && block.type === 'text')
  return block.text
}

function ok(what: string): void {
  process.stdout.write(`  ok  ${what}\n`)
}

/** Poll until `predicate` holds or the budget runs out. */
async function until(predicate: () => boolean, what: string, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(200)
  }
  throw new Error(`timed out waiting for ${what}\n--- log ---\n${logged.join('\n')}`)
}

/** Start `pnpm serve` and wait until its socket answers. */
async function startRuntime(): Promise<ChildProcess> {
  rmSync(SOCKET, { force: true })
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server/bin.ts', '--listen', `unix:${SOCKET}`, '--concurrency', '4'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (c: string) => (output += c))
  child.stderr?.on('data', (c: string) => (output += c))
  child.on('exit', (code) => logged.push(`warn runtime exited with ${code}`))

  // Probe the socket rather than parsing a banner: the handshake is the real
  // readiness signal.
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const probe = new WireHub(parseAddress(`unix:${SOCKET}`), undefined, () => 'probe', () => {}, log)
    try {
      const connection = await probe.connectionFor('probe')
      const session = connection.session
      probe.close()
      if (session) return child
    } catch {
      probe.close()
      await delay(500)
    }
  }
  child.kill('SIGKILL')
  throw new Error(`the fluvia runtime never came up.\n--- output ---\n${output}`)
}

async function main(): Promise<void> {
  const registry = new RegistryDouble()
  const submitter = new AgentDouble(SUBMITTER as TargetAgent['id'])
  const bystander = new AgentDouble(BYSTANDER as TargetAgent['id'])
  // Bystander registered LAST, so `target: newest` would pick it. Everything
  // that lands on the submitter therefore landed there by ownership.
  registry.agents.push(submitter, bystander)

  const courier = new Courier({ agents: registry, mode: 'followup', target: 'newest', queueLimit: 200, log })
  const coalescers = new Map<string, EnvelopeCoalescer>()

  const runtime = await startRuntime()
  ok(`the fluvia runtime is listening on unix:${SOCKET}`)

  const hub = new WireHub(
    parseAddress(`unix:${SOCKET}`),
    undefined,
    (sessionId) => fluviaAgentId(sessionId),
    (sessionId: string, notification: WireNotification) => {
      let coalescer = coalescers.get(sessionId)
      if (!coalescer) {
        const session = hub.sessionOf(sessionId)
        coalescer = new EnvelopeCoalescer(
          session?.agent ?? notification.agent,
          session?.session ?? 'fluvia',
          (envelope) => void courier.accept(envelope, sessionId),
        )
        coalescers.set(sessionId, coalescer)
      }
      coalescer.add(notification)
    },
    log,
  )

  try {
    const connection = await hub.connectionFor(SUBMITTER)
    const session = connection.session
    assert.ok(session, 'the handshake must produce a welcome')
    assert.equal(session.agent, fluviaAgentId(SUBMITTER), 'the runtime assigned the label we requested')
    assert.ok(session.isa.length > 0, 'the runtime published its instruction set')
    assert.ok(session.limits.maxInFlight > 0 && session.limits.maxLineBytes > 0, 'limits are published')
    ok(`connected as "${session.agent}" with ${session.isa.length} published instructions`)

    // 1. A call. The answer must come back instantly and name both handles.
    const started = Date.now()
    const first = await connection.submit('prepareKernel({ size: 4096, dtype: "f32" })')
    const ackMs = Date.now() - started
    assert.ok(first.t === 'ack', `expected an ack, got ${first.t}`)
    assert.equal(first.fn, 'prepareKernel')
    assert.equal(first.bind.value, 'kernel0')
    assert.equal(first.bind.error, 'err0')
    assert.ok(ackMs < 2_000, `the ack must be immediate, took ${ackMs}ms`)
    ok(`a call is acknowledged in ${ackMs}ms with both handles`)

    // 2. A dependent call, submitted before the first has settled.
    const second = await connection.submit('compileKernel(kernel0, { opt: 3 })')
    assert.ok(second.t === 'ack')
    assert.equal(second.state, 'waiting', 'a dependent call parks until its handle is ready')
    assert.deepEqual(second.deps.map((d) => d.name), ['kernel0'])
    ok('a dependent call is accepted while its producer is still running')

    // 3. A control line answers with text.
    const listed = await connection.submit('list')
    assert.ok(listed.t === 'control')
    assert.match(listed.text, /prepareKernel/)
    ok('a control line answers with the runtime’s own text')

    // 4. A rejected line is reported, and correlation survives it.
    const bad = await connection.submit('compileKernel(kernel0, { opt: 1 + 2 })')
    assert.ok(bad.t === 'error')
    assert.match(bad.message, /does not evaluate expressions/)
    const afterBad = await connection.submit('vars')
    assert.ok(afterBad.t === 'control', 'correlation must survive a rejection')
    ok('a rejected line is reported and correlation survives it')

    // 5. The boundary: an `@agent` prefix is the runtime's to refuse.
    const spoofed = await connection.submit(`@${fluviaAgentId(BYSTANDER)} prepareKernel({ size: 8 })`)
    assert.ok(spoofed.t === 'error', 'an @agent prefix must be refused by the runtime')
    ok(`the runtime refuses an @agent prefix: "${spoofed.message}"`)

    // 6. The loop: settled results come back, to the submitter only.
    await until(() => submitter.followups.length >= 2, 'both notifications to reach the submitting session')
    ok(`settled results came back as ${submitter.followups.length} notification(s) over the connection`)

    const blocks = submitter.followups.map(textOf).join('\n')
    assert.match(blocks, /<fluvia-notify/, 'the delivered text is the rendered fluvia block')
    assert.match(blocks, new RegExp(`agent="${fluviaAgentId(SUBMITTER)}"`))
    assert.match(blocks, /prepareKernel/)
    assert.match(blocks, /compileKernel/)
    ok('the notifications carry the rendered <fluvia-notify> blocks for both calls')

    assert.equal(
      bystander.followups.length,
      0,
      'the other session must receive nothing, even though it is the `newest` target',
    )
    ok('the bystanding session received nothing, despite being the configured target')

    // 7. A second session is a second identity with its own handle namespace.
    const otherConnection = await hub.connectionFor(BYSTANDER)
    const otherSession = otherConnection.session
    assert.ok(otherSession)
    assert.notEqual(otherSession.agent, session.agent, 'two sessions get two agent ids')
    // `--scope agent` is the server default, so the submitter's handles are not
    // even nameable from here.
    const stolen = await otherConnection.submit('compileKernel(kernel0, { opt: 1 })')
    assert.ok(stolen.t === 'error', `another session must not be able to name kernel0, got ${stolen.t}`)
    ok(`a second session cannot name the first's handles: "${stolen.message}"`)

    const stats = courier.stats
    assert.equal(stats.queued, 0)
    assert.equal(stats.failed, 0)
    ok(`courier counters agree: ${stats.received} received, ${stats.delivered} delivered, 0 failed`)
  } finally {
    for (const coalescer of coalescers.values()) coalescer.close()
    hub.close()
    await delay(300)
    runtime.kill('SIGTERM')
    await delay(1_500)
    runtime.kill('SIGKILL')
    rmSync(SOCKET, { force: true })
  }

  process.stdout.write('\nclosed-loop checks passed\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  rmSync(SOCKET, { force: true })
  process.exitCode = 1
})
