/**
 * End-to-end check of the delivery path that does not need model credentials.
 *
 * A real `dsh web` boot proves the plugin loads, binds, and receives; it cannot
 * prove what happens *after* `followup()` without an LLM API key. This harness
 * covers the other half: it drives the real {@link Courier} and the real
 * {@link startReceiver} over real HTTP, against an agent double whose type is
 * `TargetAgent` — a `Pick` of the harness's own `Agent` interface — so the
 * calls asserted here are the same calls a live agent would receive.
 *
 * Run: `node --experimental-strip-types test/verify.ts` (or through tsx).
 * Exits non-zero on the first failed assertion.
 *
 * @module dsh-plugin-fluvia/test/verify
 */

import { strict as assert } from 'node:assert'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
// Imported through the package's own name, not by relative path: that exercises
// the published `exports` map and the built `lib/` this plugin actually ships,
// so a broken manifest fails here rather than inside somebody's harness.
import {
  Courier,
  parseEnvelope,
  startReceiver,
  summarizeEnvelope,
  type AgentSource,
  type CourierLog,
  type TargetAgent,
} from 'dsh-plugin-fluvia'

/** Lines the courier and receiver logged, so a test can assert on reporting too. */
const logged: string[] = []

/** A {@link CourierLog} that records instead of printing. */
const log: CourierLog = {
  info: (format: unknown) => void logged.push(`info ${String(format)}`),
  warn: (format: unknown) => void logged.push(`warn ${String(format)}`),
}

/**
 * An agent double.
 *
 * Typed as {@link TargetAgent}, which is `Pick<Agent, 'id' | 'status' |
 * 'followup' | 'inject'>` — if the harness changes any of those signatures this
 * file stops compiling, so the double cannot quietly diverge from the real
 * interface it stands in for.
 */
class AgentDouble implements TargetAgent {
  /** Messages handed to {@link followup}, in order. */
  readonly followups: UserMessage[] = []
  /** Messages handed to {@link inject}, in order. */
  readonly injections: UserMessage[] = []
  /** When set, both entry points throw it, standing in for a disposing agent. */
  failWith: Error | undefined

  /** The agent's session-backed id. */
  readonly id: TargetAgent['id']
  /** Lifecycle state; every double here stands in for an idle agent. */
  readonly status: TargetAgent['status']

  // Plain assignment rather than parameter properties, so this file also runs
  // under Node's strip-only TypeScript mode with no build step.
  constructor(id: TargetAgent['id'], status: TargetAgent['status'] = 'idle') {
    this.id = id
    this.status = status
  }

  followup(message: UserMessage): void {
    if (this.failWith) throw this.failWith
    this.followups.push(message)
  }

  inject(message: UserMessage): void {
    if (this.failWith) throw this.failWith
    this.injections.push(message)
  }
}

/** A mutable stand-in for `ctx.agents`, so a test can make an agent "appear". */
class RegistryDouble implements AgentSource {
  readonly agents: TargetAgent[] = []
  list(): readonly TargetAgent[] {
    return this.agents
  }
}

/** One envelope shaped exactly like `fluvia-dsh`'s http transport posts it. */
function envelope(n: number, agent = 'planner'): unknown {
  return {
    v: 1,
    session: 's-verify',
    at: 1000 + n,
    agent,
    ids: [`n${n}`],
    text: `<fluvia-notify agent="${agent}" session="s-verify">\nenvelope ${n}\n</fluvia-notify>`,
    calls: [
      { call: `c${n}`, fn: 'compileKernel', outcome: n % 2 === 0 ? 'done' : 'failed' },
    ],
  }
}

/** Read the one text block out of a delivered message. */
function textOf(message: UserMessage): string {
  const block = message.content[0]
  assert.ok(block && block.type === 'text', 'delivered message must carry a text block')
  return block.text
}

/** Print a passing check so the transcript shows what was actually verified. */
function ok(what: string): void {
  process.stdout.write(`  ok  ${what}\n`)
}

async function main(): Promise<void> {
  /* ------------------------------------------------ 1. parsing and summary */

  const parsed = parseEnvelope(JSON.stringify(envelope(2)))
  assert.equal(parsed.agent, 'planner')
  assert.equal(parsed.ids.length, 1)
  assert.equal(summarizeEnvelope(parsed), 'fluvia/planner: 1 call — 1 ready')
  ok('parseEnvelope accepts a real envelope and summarizeEnvelope describes it')

  assert.throws(() => parseEnvelope('not json'), /not valid JSON/)
  assert.throws(() => parseEnvelope('{"text":""}'), /non-empty string/)
  assert.throws(() => parseEnvelope('[]'), /must be a JSON object/)
  ok('parseEnvelope rejects malformed bodies instead of throwing downstream')

  /* -------------------------------- 2. receiver + queue-then-flush, over HTTP */

  const registry = new RegistryDouble()
  const courier = new Courier({ agents: registry, mode: 'followup', target: 'newest', queueLimit: 200, log })
  // Port 0: the OS picks a free one, so this harness can never collide with a
  // running receiver (7788) or with the perf server (7777).
  const receiver = await startReceiver({
    host: '127.0.0.1',
    port: 0,
    path: '/inbox',
    mode: 'followup',
    target: 'newest',
    queueLimit: 200,
    courier,
    log,
  })
  const base = `http://127.0.0.1:${receiver.port}`
  ok(`receiver bound an ephemeral port (${receiver.port})`)

  try {
    // No agent is live yet — the Web-UI-before-session case.
    for (const n of [1, 2, 3]) {
      const response = await fetch(`${base}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope(n)),
      })
      assert.equal(response.status, 202, 'receiver must answer 202')
      const body = (await response.json()) as { kind: string; depth: number }
      assert.equal(body.kind, 'queued')
      assert.equal(body.depth, n)
    }
    ok('POSTs with no live agent answer 202 and are queued, in order')

    // An agent appears; this is what the `agent/created` listener triggers.
    const first = new AgentDouble('s-first' as TargetAgent['id'])
    registry.agents.push(first)
    assert.equal(courier.flush(), 3, 'flush must deliver every held envelope')
    assert.equal(first.followups.length, 3)
    assert.deepEqual(
      first.followups.map((m) => textOf(m).match(/envelope (\d)/)?.[1]),
      ['1', '2', '3'],
      'held envelopes must flush in arrival order',
    )
    ok('flush() delivers the whole queue, in order, via followup()')

    // Attribution is the part that must not regress.
    const source = first.followups[0]!.source as { kind: string; plugin?: string; form?: string; summary?: string }
    assert.equal(source.kind, 'plugin', 'must not claim a user source')
    assert.equal(source.plugin, 'fluvia')
    assert.equal(source.form, 'notice')
    assert.equal(source.summary, 'fluvia/planner: 1 call — 1 failed')
    assert.equal(first.followups[0]!.role, 'user')
    assert.ok(Object.isFrozen(first.followups[0]), 'createUserMessage must have frozen the message')
    ok('delivered messages are plugin-attributed notices, not user messages')

    // With an agent live, delivery is immediate.
    const direct = await fetch(`${base}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope(4)),
    })
    const directBody = (await direct.json()) as { kind: string; agents: string[] }
    assert.equal(directBody.kind, 'delivered')
    assert.deepEqual(directBody.agents, ['s-first'])
    assert.equal(first.followups.length, 4)
    ok('a POST with a live agent delivers immediately')

    // `newest` follows the registry's registration order.
    const second = new AgentDouble('s-second' as TargetAgent['id'])
    registry.agents.push(second)
    assert.deepEqual(courier.targetAgentIds(), ['s-second'], 'newest must be the last-registered agent')
    courier.accept(parseEnvelope(JSON.stringify(envelope(5))))
    assert.equal(second.followups.length, 1)
    assert.equal(first.followups.length, 4, 'newest must not also deliver to the older agent')
    ok('target "newest" resolves to the most recently created live agent')

    /* ----------------------------------------------------- 3. status surfaces */

    const status = (await (await fetch(`${base}/inbox`)).json()) as {
      stats: { received: number; delivered: number; queued: number }
      targetAgents: string[]
      liveAgents: string[]
    }
    assert.equal(status.stats.received, 5)
    assert.equal(status.stats.delivered, 5)
    assert.equal(status.stats.queued, 0)
    assert.deepEqual(status.liveAgents, ['s-first', 's-second'])
    assert.deepEqual(status.targetAgents, ['s-second'])
    ok('GET <path> reports accurate counters and target resolution')

    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    const html = await page.text()
    assert.match(html, /fluvia/)
    assert.match(html, /s-second/)
    ok('GET / serves the status page')

    assert.equal((await fetch(`${base}/nope`)).status, 404)
    assert.equal((await fetch(`${base}/inbox`, { method: 'DELETE' })).status, 405)
    assert.equal(
      (await fetch(`${base}/inbox`, { method: 'POST', body: 'garbage' })).status,
      400,
      'a malformed body must be a 400, not a crash',
    )
    ok('bad routes, bad methods and bad bodies answer without throwing')

    /* ---------------------------------------------- 4. the remaining policies */

    // inject mode routes to the other entry point.
    const injectRegistry = new RegistryDouble()
    const injectTarget = new AgentDouble('s-inject' as TargetAgent['id'])
    injectRegistry.agents.push(injectTarget)
    const injector = new Courier({ agents: injectRegistry, mode: 'inject', target: 'newest', queueLimit: 200, log })
    injector.accept(parseEnvelope(JSON.stringify(envelope(6))))
    assert.equal(injectTarget.injections.length, 1)
    assert.equal(injectTarget.followups.length, 0)
    ok('mode "inject" calls inject() rather than followup()')

    // `auto` reads each agent's status: idle wakes, running rides along.
    const autoRegistry = new RegistryDouble()
    const idle = new AgentDouble('s-idle' as TargetAgent['id'], 'idle')
    const busy = new AgentDouble('s-busy' as TargetAgent['id'], 'running')
    autoRegistry.agents.push(idle, busy)
    const auto = new Courier({ agents: autoRegistry, mode: 'auto', target: 'all', queueLimit: 200, log })
    auto.accept(parseEnvelope(JSON.stringify(envelope(10))))
    assert.equal(idle.followups.length, 1, 'an idle agent must be woken')
    assert.equal(idle.injections.length, 0)
    assert.equal(busy.injections.length, 1, 'a running agent must be injected, not woken')
    assert.equal(busy.followups.length, 0)
    ok('mode "auto" wakes idle agents and injects into running ones')

    // target: all broadcasts.
    const allCourier = new Courier({ agents: registry, mode: 'followup', target: 'all', queueLimit: 200, log })
    allCourier.accept(parseEnvelope(JSON.stringify(envelope(7))))
    assert.equal(first.followups.length, 5)
    assert.equal(second.followups.length, 2)
    ok('target "all" broadcasts to every live agent')

    // A pinned id ignores everything else.
    const pinned = new Courier({ agents: registry, mode: 'followup', target: 's-first', queueLimit: 200, log })
    pinned.accept(parseEnvelope(JSON.stringify(envelope(8))))
    assert.equal(first.followups.length, 6)
    assert.equal(second.followups.length, 2)
    ok('a literal session id pins delivery to that agent')

    // A refusing agent is counted, not retried forever.
    second.failWith = new Error('agent is disposing')
    const failing = new Courier({ agents: registry, mode: 'followup', target: 's-second', queueLimit: 200, log })
    const outcome = failing.accept(parseEnvelope(JSON.stringify(envelope(9))))
    assert.equal(outcome.kind, 'failed')
    assert.equal(failing.stats.failed, 1)
    assert.equal(failing.stats.queued, 0, 'a refusing live agent must not re-queue the envelope')
    assert.ok(logged.some((line) => line.includes('agent is disposing')))
    second.failWith = undefined
    ok('a throwing agent is reported and counted, never re-queued')

    // The bound evicts the oldest.
    const bounded = new Courier({ agents: new RegistryDouble(), mode: 'followup', target: 'newest', queueLimit: 3, log })
    for (const n of [1, 2, 3, 4, 5]) bounded.accept(parseEnvelope(JSON.stringify(envelope(n))))
    assert.equal(bounded.stats.queued, 3)
    assert.equal(bounded.stats.evicted, 2)
    ok('the queue is bounded and evicts oldest-first')
  } finally {
    await receiver.close()
  }

  // The port must be free the instant close() resolves, or a reload breaks.
  const afterClose = await fetch(base, { signal: AbortSignal.timeout(1500) }).then(
    () => 'still listening',
    () => 'refused',
  )
  assert.equal(afterClose, 'refused', 'close() must release the port')
  ok('close() releases the port')

  process.stdout.write('\nall checks passed\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
})
