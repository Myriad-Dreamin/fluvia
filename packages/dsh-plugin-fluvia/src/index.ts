/**
 * `dsh-plugin-fluvia` — the sandboxed side of a fluvia deployment.
 *
 * fluvia splits into two processes on purpose. The **runtime** (`pnpm serve`)
 * owns the instruction set, the scheduler and the trace, and runs wherever the
 * operator put it. The **model** — and this harness with it — runs inside a
 * sandbox and gets exactly one capability: a socket on which it may submit
 * lines and read back results. This plugin is that socket, plus the two things
 * that make it usable from a dsh agent turn:
 *
 * - a `fluvia` **tool**, whose description is built from the instruction set
 *   the runtime actually published, so the model is told what the host loaded
 *   rather than what this package guessed;
 * - a **courier**, which turns settled calls into `<fluvia-notify>` messages on
 *   the session that submitted them, waking an idle agent so it reacts.
 *
 * What the boundary buys is worth stating plainly, because it is the reason
 * the code is shaped this way: a model that fully owned this process still
 * could not change which implementations are loaded, could not read the trace,
 * could not stop the runtime, and could not name, inspect or cancel another
 * session's handles. All of that is enforced on the far side of the socket. The
 * code here owes the deployment liveness and good ergonomics — not safety.
 *
 * Two transports exist. `connect` (the default) is the sandboxed one described
 * above. `http` keeps the older arrangement in which a fluvia CLI POSTs
 * envelopes to a local endpoint, for deployments that never split the
 * processes; it offers no isolation and is not the recommended shape.
 *
 * @module dsh-plugin-fluvia
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Imported for its `declare module '@deepseek-ai/cordis'` augmentation, which
// is what puts `agents` on `Context`. Nothing here references the value side.
import type {} from '@deepseek-ai/dsh-agent'
import { Courier, type AgentSource, type DeliveryMode, type TargetSelector } from './courier.js'
import { fluviaAgentId, sanitizeAgentLabel } from './identity.js'
import { EnvelopeCoalescer } from './render.js'
import { startReceiver } from './receiver.js'
import { buildFluviaTool } from './tool.js'
import { WireHub, formatAddress, parseAddress, type IsaEntry, type WireNotification } from './wire.js'

export type { AcceptOutcome, AgentSource, CourierLog, CourierOptions, CourierStats, DeliveryMode, TargetAgent, TargetSelector } from './courier.js'
export { Courier, buildMessage } from './courier.js'
export type { EnvelopeCall, NotifyEnvelope } from './envelope.js'
export { ENVELOPE_VERSION, parseEnvelope, summarizeEnvelope } from './envelope.js'
export { FLUVIA_AGENT_PREFIX, fluviaAgentId, isDshOwned, matchesSession, sanitizeAgentLabel, stripAgentPrefix } from './identity.js'
export { EnvelopeCoalescer, buildEnvelope, renderBlock } from './render.js'
export { startReceiver } from './receiver.js'
export type { Receiver, ReceiverOptions } from './receiver.js'
export type { StatusView } from './status-page.js'
export { buildFluviaTool, renderAnswer, renderDescription, renderLineDescription } from './tool.js'
export type { FluviaToolValue } from './tool.js'
export {
  PROTOCOL_VERSION,
  WireConnection,
  WireHub,
  decodeFrame,
  encodeFrame,
  formatAddress,
  parseAddress,
} from './wire.js'
export type { Address, Answer, ClientFrame, IsaEntry, Limits, ServerFrame, WireNotification, WireSession } from './wire.js'

/** Cordis plugin name, used by loader diagnostics and by the logger. */
export const name = 'fluvia'

/**
 * Services this plugin needs before it loads.
 *
 * `agents` resolves delivery targets; `tools` registers the model-facing
 * `fluvia` tool. Declaring both makes the loader hold the plugin in `PENDING`
 * until they exist, so `apply` never defends against a half-built context.
 */
export const inject = ['agents', 'tools']

/** How long to keep retrying the runtime at load before failing the plugin. */
const PROBE_BUDGET_MS = 15_000

/** Pause between probe attempts while the runtime is still starting. */
const PROBE_INTERVAL_MS = 1_000

/** Label used by the short-lived connection that reads the instruction set. */
const PROBE_LABEL = 'dsh-probe'

/** Where notifications come from, and therefore what this plugin binds. */
export type Transport =
  /** A socket to a fluvia runtime outside the sandbox. The isolating shape. */
  | 'connect'
  /** A local HTTP endpoint a fluvia CLI POSTs envelopes to. No isolation. */
  | 'http'

/** Connection, delivery policy, and the local status endpoint. */
export interface Config {
  /** `connect` talks to a runtime over a socket; `http` receives envelope POSTs. */
  transport: Transport
  /** Runtime address: `unix:<path>` or `tcp:<host>:<port>`. */
  connect: string
  /** File holding the shared secret, when the runtime was started with `--token-file`. */
  tokenFile: string
  /** Label prefix requested for each session's connection; empty derives it from the session id. */
  label: string
  /** Whether a delivered envelope wakes the agent (`followup`), waits for the next step (`inject`), or picks per agent status (`auto`). */
  mode: DeliveryMode
  /** Fallback target for an envelope with no identifiable owner: `newest`, `all`, or a session id. */
  target: TargetSelector
  /** How many envelopes to hold while no agent owns them; the oldest are evicted past this. */
  queueLimit: number
  /** Interface for the local status endpoint. */
  host: string
  /** Port for the local status endpoint. */
  port: number
  /** Status path; also the envelope intake when `transport: 'http'`. */
  path: string
}

/**
 * Schemastery validation for {@link Config}.
 *
 * Declared the way shipped dsh plugins declare theirs, so `dsh --dump-config`
 * renders the defaults and a `--patch` overlay can set any field.
 *
 * **`preload` and `concurrency` are deliberately absent.** They decide what an
 * instruction *does* and how much of the host it may use, so they belong to
 * `pnpm serve` on the other side of the boundary. Accepting them here would put
 * the instruction set under the control of the process the model runs in, which
 * is the exact thing the split exists to prevent — a model with file access
 * could then point the instruction set at its own code.
 */
export const Config: z<Config> = z.object({
  transport: z
    .union([z.const('connect'), z.const('http')])
    .default('connect')
    .description('connect: socket to a fluvia runtime outside the sandbox. http: receive envelope POSTs locally.'),
  connect: z
    .string()
    .default('unix:/tmp/fluvia.sock')
    .description('Runtime address for transport "connect": unix:<path> or tcp:<host>:<port>.'),
  tokenFile: z
    .string()
    .default('')
    .description('File holding the shared secret, when the runtime runs with --token-file.'),
  label: z
    .string()
    .default('')
    .description('Label prefix requested per session; empty derives it from the session id. The runtime assigns the final id.'),
  mode: z
    .union([z.const('followup'), z.const('inject'), z.const('auto')])
    .default('followup')
    .description('followup wakes the agent; inject waits for the next pre-step; auto picks per agent status.'),
  target: z
    .string()
    .default('newest')
    .description('Fallback for an envelope with no identifiable owner: newest, all, or a literal session id.'),
  queueLimit: z
    .natural()
    .default(200)
    .description('Envelopes held while no agent owns them.'),
  host: z.string().default('127.0.0.1').description('Interface for the local status endpoint.'),
  port: z.natural().default(7788).description('Port for the local status endpoint.'),
  path: z.string().default('/inbox').description('Status path; also the envelope intake under transport "http".'),
}) as unknown as z<Config>

/**
 * Mount the plugin.
 *
 * Every resource is fiber-owned. `ctx.on` disposes its listeners when the fiber
 * unloads, and the socket pool, the tool registration and the status server are
 * registered through `ctx.effect`, whose async disposer is awaited — so an
 * unload cannot return while a port is still bound or a socket still open.
 *
 * @param ctx — plugin context; must carry `agents` and `tools` (see {@link inject}).
 * @param config — validated {@link Config}.
 * @throws {Error} when the status port cannot be bound, or when the fluvia
 *   runtime cannot be reached under `transport: 'connect'`. Both fail the
 *   plugin load rather than leaving a tool that lies about what it can do.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)

  // `ctx.agents.list()` returns `Agent[]`; `AgentSource` is the read-only slice
  // of the registry the courier is allowed to use.
  const agents: AgentSource = { list: () => ctx.agents.list() }
  const courier = new Courier({
    agents,
    mode: config.mode,
    target: config.target,
    queueLimit: Math.max(1, config.queueLimit),
    log,
  })

  /**
   * Flush on the next macrotask rather than inside the dispatch that triggered
   * it.
   *
   * `agent/created` is emitted *before* the loop starts, and a synchronous
   * listener failure there vetoes publication — so driving an agent from inside
   * that dispatch would couple this plugin's delivery path to the harness's
   * creation transaction. Deferring costs nothing (the queue is already late by
   * definition) and removes the coupling. The immediate is unref'd so a pending
   * flush can never hold the process open, and `scheduled` collapses a burst of
   * lifecycle events into one drain.
   */
  let scheduled: NodeJS.Immediate | undefined
  const scheduleFlush = (): void => {
    if (scheduled) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      try {
        courier.flush()
      } catch (error) {
        // Unreachable by contract — flush() contains its own failures — but a
        // throw on a timer callback is an uncatchable process crash.
        log.warn(`flush failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    scheduled.unref()
  }

  ctx.on('agent/created', () => scheduleFlush())
  // `agent/session-start` is the documented first startup-driving extension
  // point. A resumed session reaches it too, and the flush is idempotent.
  ctx.on('agent/session-start', () => scheduleFlush())

  ctx.effect(async () => {
    /** One coalescing buffer per session; see `render.ts` for why. */
    const coalescers = new Map<string, EnvelopeCoalescer>()
    let hub: WireHub | undefined

    if (config.transport === 'connect') {
      const address = parseAddress(config.connect)
      const prefix = config.label.trim()
      // The label is per-session no matter what the operator configured, because
      // identity is per-connection on the far side: two sessions sharing one
      // requested label would still get two connections, but their ids would
      // differ only by the runtime's uniquifier, which makes logs unreadable.
      const labelFor = (sessionId: string): string =>
        prefix ? sanitizeAgentLabel(`${prefix}-${sessionId}`) : fluviaAgentId(sessionId)

      hub = new WireHub(
        address,
        config.tokenFile.trim() || undefined,
        labelFor,
        (sessionId, notification) => onNotification(sessionId, notification),
        log,
      )

      const isa = await probeInstructionSet(address, config.tokenFile.trim() || undefined, log)
      // Registering the tool does NOT open a session's connection: each session
      // connects on its first submission. A harness that never calls the tool
      // holds no sockets.
      const unregister = ctx.tools.register(buildFluviaTool(hub, isa))
      log.info(`tool "fluvia" registered with ${isa.length} published instructions from ${formatAddress(address)}`)

      // A disposed agent's connection is its own; releasing it frees the agent
      // id on the runtime so a later session can reuse the label.
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        coalescers.get(agent.id)?.close()
        coalescers.delete(agent.id)
        hub?.release(agent.id)
      })

      const receiver = await startStatus()
      return async () => {
        unregister()
        offDisposed()
        for (const coalescer of coalescers.values()) coalescer.close()
        coalescers.clear()
        hub?.close()
        await receiver.close()
        finish()
      }
    }

    // transport: 'http' — the unsplit arrangement. A fluvia CLI (or the
    // `fluvia-dsh` sink of any session) POSTs already-rendered envelopes here.
    const receiver = await startStatus()
    log.info('transport "http": envelopes are accepted by POST; no runtime connection is opened and no tool is registered')
    return async () => {
      await receiver.close()
      finish()
    }

    /**
     * Take one settled call off a session's connection.
     *
     * The owning session is known from the socket it arrived on, which is a
     * stronger fact than any name in the payload — so it is passed to the
     * courier explicitly and no target matching happens at all.
     */
    function onNotification(sessionId: string, notification: WireNotification): void {
      let coalescer = coalescers.get(sessionId)
      if (!coalescer) {
        const session = hub?.sessionOf(sessionId)
        coalescer = new EnvelopeCoalescer(
          session?.agent ?? notification.agent,
          session?.session ?? 'fluvia',
          (envelope) => {
            try {
              courier.accept(envelope, sessionId)
            } catch (error) {
              log.warn(`delivery failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          },
        )
        coalescers.set(sessionId, coalescer)
      }
      coalescer.add(notification)
    }

    /**
     * Bind the local status endpoint.
     *
     * It is bound under both transports: under `http` it is the envelope
     * intake, and under `connect` it is the one place an operator can check
     * whether anything is arriving without reading harness logs. The POST route
     * refuses envelopes under `connect`, because accepting them there would
     * silently create a second, unauthenticated results path into an agent's
     * turn.
     */
    async function startStatus(): ReturnType<typeof startReceiver> {
      const bound = await startReceiver({
        host: config.host,
        port: config.port,
        path: config.path,
        mode: config.mode,
        target: config.target,
        queueLimit: Math.max(1, config.queueLimit),
        courier,
        log,
        acceptPosts: config.transport === 'http',
      })
      log.info(
        `status on http://${config.host}:${bound.port}${config.path} (transport=${config.transport}, mode=${config.mode})`,
      )
      return bound
    }

    /** Common teardown tail. */
    function finish(): void {
      if (scheduled) {
        clearImmediate(scheduled)
        scheduled = undefined
      }
      const dropped = courier.discard()
      log.info(`stopped${dropped > 0 ? `, discarded ${dropped} held envelope(s)` : ''}`)
    }
  }, 'fluvia')
}

/**
 * Read the runtime's instruction set with one short-lived connection.
 *
 * The tool's description has to be accurate at registration time, and the only
 * authority on what is loaded is the runtime's `welcome`. The probe therefore
 * runs at load and retries for {@link PROBE_BUDGET_MS}, which covers the normal
 * race of a container starting before the host's runtime does.
 *
 * Failing the plugin load when the runtime is unreachable is deliberate. A
 * registered `fluvia` tool that cannot name a single real instruction is worse
 * than no tool: the model would call it, get connection errors, and have no way
 * to tell a misconfiguration from a transient fault.
 *
 * @param address — where the runtime listens.
 * @param token — shared secret, when one is configured.
 * @param log — where progress is reported while waiting.
 * @returns the published instruction set.
 * @throws {Error} when the runtime stays unreachable past the budget.
 */
async function probeInstructionSet(
  address: ReturnType<typeof parseAddress>,
  token: string | undefined,
  log: ReturnType<Context['logger']>,
): Promise<IsaEntry[]> {
  const deadline = Date.now() + PROBE_BUDGET_MS
  let last: unknown
  let announced = false

  for (;;) {
    // A hub of one, so the probe takes exactly the handshake path a real
    // session will: a bug there fails at load rather than on the model's first
    // tool call. Notifications are ignored — this connection submits nothing.
    const probe = new WireHub(address, token, () => PROBE_LABEL, () => {}, log)
    try {
      const connection = await probe.connectionFor('probe')
      const session = connection.session
      if (!session) throw new Error('the runtime accepted the connection but sent no welcome')
      return session.isa
    } catch (error) {
      last = error
      if (Date.now() >= deadline) break
      if (!announced) {
        log.info(`waiting for the fluvia runtime at ${formatAddress(address)}…`)
        announced = true
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PROBE_INTERVAL_MS)
        timer.unref?.()
      })
    } finally {
      // Always release the probe's agent id, so the label is free for reuse and
      // the runtime does not accumulate dead connections across retries.
      probe.close()
    }
  }

  throw new Error(
    `cannot reach the fluvia runtime at ${formatAddress(address)} after ${PROBE_BUDGET_MS}ms — ` +
      `start it on the host side with \`pnpm serve --listen ${formatAddress(address)}\`. ` +
      `Last error: ${last instanceof Error ? last.message : String(last)}`,
  )
}
