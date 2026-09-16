/**
 * The closed loop, without a harness: submit → ack → settle → notification →
 * the same agent.
 *
 * `verify.ts` covers the receiver and the courier against doubles. This covers
 * the part that only a real child process can prove: that the managed fluvia
 * CLI starts, accepts a line prefixed with a dsh session id, answers instantly,
 * and then — seconds later, on its own — POSTs the settled result back to this
 * plugin's receiver, which routes it to the session that submitted it and to no
 * other.
 *
 * It needs the fluvia repository (it spawns the real CLI) but no harness, no
 * model and no credentials.
 *
 * Run: `node --experimental-strip-types test/loop.ts`.
 *
 * @module dsh-plugin-fluvia/test/loop
 */

import { strict as assert } from 'node:assert'
import { setTimeout as delay } from 'node:timers/promises'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  Courier,
  FluviaCli,
  fluviaAgentId,
  fluviaRepoRoot,
  notifyUrlFor,
  startReceiver,
  type AgentSource,
  type CourierLog,
  type TargetAgent,
} from 'dsh-plugin-fluvia'

/** Two dsh sessions share one fluvia runtime; only one submits the work. */
const SUBMITTER = 's-loop-submitter'
const BYSTANDER = 's-loop-bystander'

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

async function main(): Promise<void> {
  const registry = new RegistryDouble()
  const submitter = new AgentDouble(SUBMITTER as TargetAgent['id'])
  const bystander = new AgentDouble(BYSTANDER as TargetAgent['id'])
  // Bystander registered LAST, so `target: newest` would pick it. Everything
  // that lands on the submitter therefore landed there by ownership, not by
  // the fallback.
  registry.agents.push(submitter, bystander)

  const courier = new Courier({ agents: registry, mode: 'followup', target: 'newest', queueLimit: 200, log })
  const receiver = await startReceiver({
    host: '127.0.0.1',
    // Ephemeral: this harness must never collide with a running plugin (7788)
    // or with the fluvia perf server (7777).
    port: 0,
    path: '/inbox',
    mode: 'followup',
    target: 'newest',
    queueLimit: 200,
    courier,
    log,
  })

  const root = fluviaRepoRoot()
  const cli = new FluviaCli(
    {
      enabled: true,
      cwd: root,
      command: process.execPath,
      args: [],
      concurrency: 4,
      preload: 'src/toolbox/default.ts',
      trace: `${root}/out/dsh-plugin-loop-test.jsonl.gz`,
    },
    notifyUrlFor('127.0.0.1', receiver.port, '/inbox'),
    log,
    2,
  )

  try {
    await cli.ensureStarted()
    assert.ok(cli.running, 'the CLI child must be running')
    assert.ok((cli.functions?.length ?? 0) > 0, 'the toolbox must have loaded')
    ok(`the managed CLI started (session ${cli.sessionId}, ${cli.functions?.length} functions)`)

    const prefix = `@${fluviaAgentId(SUBMITTER)}`

    // 1. A call. The answer must come back instantly and name both handles.
    const started = Date.now()
    const first = await cli.submit(`${prefix} prepareKernel({ size: 4096, dtype: "f32" })`)
    const ackMs = Date.now() - started
    assert.equal(first.type, 'ack')
    assert.ok(first.type === 'ack')
    assert.equal(first.fn, 'prepareKernel')
    assert.equal(first.agent, fluviaAgentId(SUBMITTER), 'the call must be attributed to the submitting session')
    assert.equal(first.bind.value, 'kernel0')
    assert.equal(first.bind.error, 'err0')
    assert.ok(ackMs < 2_000, `the ack must be immediate, took ${ackMs}ms`)
    ok(`a call is acknowledged in ${ackMs}ms with both handles, attributed to the submitter`)

    // 2. A dependent call, submitted before the first has settled.
    const second = await cli.submit(`${prefix} compileKernel(kernel0, { opt: 3 })`)
    assert.ok(second.type === 'ack')
    assert.equal(second.state, 'waiting', 'a dependent call parks until its handle is ready')
    assert.deepEqual(
      second.deps.map((d) => d.name),
      ['kernel0'],
    )
    ok('a dependent call is accepted while its producer is still running')

    // 3. A control line answers with text.
    const listed = await cli.submit(`${prefix} list`)
    assert.ok(listed.type === 'control')
    assert.match(listed.text, /prepareKernel/)
    ok('a control line answers with the CLI’s own text')

    // 4. A rejected line is reported, and does NOT desynchronize the queue.
    const bad = await cli.submit(`${prefix} compileKernel(kernel0, { opt: 1 + 2 })`)
    assert.ok(bad.type === 'error')
    assert.match(bad.message, /does not evaluate expressions/)
    const afterBad = await cli.submit(`${prefix} vars`)
    assert.ok(afterBad.type === 'control', 'the answer queue must still be aligned after a rejection')
    ok('a rejected line is reported and leaves the answer queue aligned')

    // 5. The loop: settled results come back as envelopes, to the submitter.
    await until(() => submitter.followups.length >= 2, 'both notifications to reach the submitting session')
    ok(`settled results came back as ${submitter.followups.length} notification(s) through the receiver`)

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

    const stats = courier.stats
    assert.ok(stats.received >= 2)
    assert.equal(stats.queued, 0)
    assert.equal(stats.failed, 0)
    ok(`courier counters agree: ${stats.received} received, ${stats.delivered} delivered, 0 failed`)
  } finally {
    await cli.stop()
    await receiver.close()
  }

  assert.equal(cli.running, false, 'stop() must leave no child running')
  ok('stop() shut the child down')

  process.stdout.write('\nclosed-loop checks passed\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
