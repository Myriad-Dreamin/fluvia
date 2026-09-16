/**
 * The client half of fluvia's boundary protocol, as it runs inside the sandbox.
 *
 * fluvia's deployment model puts the model — and this harness with it — inside
 * a sandbox, and the runtime that actually executes the instruction set
 * outside. This module is everything on the inside: it opens a socket, says
 * hello, submits lines, and reads back acknowledgements and notifications.
 *
 * **None of it is trusted, and none of it needs to be.** The server assigns the
 * agent id (our `label` is a request, not a claim), refuses an `@agent` prefix
 * on a submitted line, scopes handles per agent, routes notifications only to
 * the owning connection, and publishes the instruction set read-only. A model
 * that rewrote this entire file would gain nothing, because every one of those
 * properties is enforced on the far side. What this file owes the deployment is
 * therefore *liveness*, not safety: stay connected, correlate answers
 * correctly, and never lose a notification silently.
 *
 * The frame types are **copied** from `src/server/protocol.ts` rather than
 * imported. The repository root has no build step, so a published plugin
 * cannot reach into it — and duplicating an untrusted client's view of a
 * server-enforced contract costs nothing, because divergence shows up
 * immediately as a refused connection rather than as a silent security hole.
 *
 * @module dsh-plugin-fluvia/wire
 */

import { connect as netConnect, type Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import type { CourierLog } from './courier.js'

/** Wire version this client speaks; a server on another major version refuses us. */
export const PROTOCOL_VERSION = 1

/** One instruction of the published instruction set. Mirrors `IsaEntry`. */
export interface IsaEntry {
  /** Callable name. */
  name: string
  /** `async` binds two handles; `control` answers synchronously. */
  kind: 'async' | 'control'
  /** Base name of the value handle an async call binds. */
  out: string
  /** Signature hint, e.g. `({ size, dtype })`. */
  params: string
  /** One-line description. */
  summary: string
}

/** Server-enforced ceilings, published so a client can pace itself. */
export interface Limits {
  /** Longest line accepted, in bytes. */
  maxLineBytes: number
  /** Calls one agent may have unsettled at once. */
  maxInFlight: number
  /** Sustained submissions per second, token-bucket. */
  submitsPerSecond: number
}

/**
 * One settled call, as the server reports it.
 *
 * Structurally fluvia's `Notification`. Only the fields this plugin renders are
 * declared: a newer server adding fields stays compatible, and a field this
 * plugin never reads is not part of its contract.
 */
export interface WireNotification {
  /** Stable notification id, e.g. `n4`. */
  id: string
  /** When the call settled, relative to the runtime's session origin. */
  at: number
  /** The agent the server attributed the call to. */
  agent: string
  /** The settled call. */
  call: string
  /** Its function name. */
  fn: string
  /** Its terminal state. */
  outcome: 'done' | 'failed' | 'cancelled' | 'skipped'
  /** The two variables bound at submission. */
  bind: { value: string; error: string }
  /** Which variable now carries data, or `null` when both channels are void. */
  ready: { name: string; kind: 'value' | 'error'; type?: string; summary?: string } | null
  /** Failure detail when `outcome === 'failed'`. */
  error?: { kind?: string; message?: string; retryable?: boolean; detail?: unknown }
  /** Why it never ran, when `outcome === 'skipped'`. */
  skip?: { reason: string; from: string }
  /** Wall-clock breakdown. */
  timing: { waitedMs: number; runMs: number; totalMs: number }
  /** Calls this settlement unblocked. */
  unblocked: string[]
  /** Per-notification rendered text; the envelope renderer composes its own. */
  text: string
}

/** Frames this client sends. */
export type ClientFrame =
  | { t: 'hello'; v: number; label?: string; token?: string }
  | { t: 'submit'; id?: number; line: string }
  | { t: 'bye' }

/** Frames the server sends. */
export type ServerFrame =
  | {
      t: 'welcome'
      v: number
      agent: string
      session: string
      concurrency: number
      isa: IsaEntry[]
      limits: Limits
    }
  | {
      t: 'ack'
      id?: number
      call: string
      fn: string
      bind: { value: string; error: string }
      deps: { name: string; from: string; kind: 'value' | 'error' }[]
      state: string
    }
  | { t: 'control'; id?: number; fn: string; text: string; rows: unknown[] }
  | { t: 'error'; id?: number; message: string; line?: string }
  | { t: 'result'; notification: WireNotification }
  | { t: 'bye'; reason: string }

/** The server's answer to one submitted line. */
export type Answer =
  | Extract<ServerFrame, { t: 'ack' }>
  | Extract<ServerFrame, { t: 'control' }>
  | Extract<ServerFrame, { t: 'error' }>

/** How a connect address is written in configuration. Mirrors `Address`. */
export type Address = { kind: 'unix'; path: string } | { kind: 'tcp'; host: string; port: number }

/**
 * Parse `unix:/run/fluvia.sock` or `tcp:127.0.0.1:7790`.
 *
 * A bare path is a unix socket, because that is the form that keeps the
 * endpoint inside the filesystem's permission model rather than on a port
 * anything routable can reach.
 *
 * @param spec — the configured address.
 * @returns the parsed address.
 * @throws {Error} when the spec is neither form.
 */
export function parseAddress(spec: string): Address {
  if (spec.startsWith('unix:')) return { kind: 'unix', path: spec.slice('unix:'.length) }
  if (spec.startsWith('tcp:')) {
    const rest = spec.slice('tcp:'.length)
    const index = rest.lastIndexOf(':')
    if (index <= 0) throw new Error(`${spec}: expected tcp:<host>:<port>`)
    const port = Number(rest.slice(index + 1))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${spec}: bad port`)
    return { kind: 'tcp', host: rest.slice(0, index), port }
  }
  if (spec.includes('/')) return { kind: 'unix', path: spec }
  throw new Error(`${spec}: expected unix:<path> or tcp:<host>:<port>`)
}

/** Human rendering of an address, for logs and the status page. */
export function formatAddress(address: Address): string {
  return address.kind === 'unix' ? `unix:${address.path}` : `tcp:${address.host}:${address.port}`
}

/** Serialize a frame as one NDJSON line. */
export function encodeFrame(frame: ClientFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Parse one NDJSON line into a server frame.
 *
 * Never throws: this plugin reads a socket, and malformed input on a socket is
 * an expected condition rather than a bug to crash on.
 *
 * @param line — one NDJSON line, without its terminator.
 * @returns the frame, or a reason it was rejected.
 */
export function decodeFrame(line: string): { frame: ServerFrame } | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { error: 'not JSON' }
  }
  if (typeof value !== 'object' || value === null || typeof (value as { t?: unknown }).t !== 'string') {
    return { error: 'not a frame' }
  }
  return { frame: value as ServerFrame }
}

/** Longest a submitted line may wait for its answer before the tool gives up. */
const ANSWER_TIMEOUT_MS = 15_000

/** How long a connection attempt may take before it is abandoned. */
const CONNECT_TIMEOUT_MS = 10_000

/** Pause before the first reconnect; doubles per consecutive failure. */
const RECONNECT_BASE_MS = 500

/** Ceiling on the reconnect backoff, so a down runtime stays quiet. */
const RECONNECT_MAX_MS = 30_000

/** What one session's connection needs in order to open. */
export interface WireOptions {
  /** Where the runtime listens. */
  address: Address
  /** Requested label; the server sanitizes it and may uniquify it. */
  label: string
  /** Shared secret, when the server was started with `--token-file`. */
  token?: string
  /** Called for every settled call belonging to this connection's agent. */
  onNotification(notification: WireNotification): void
  /** Where connection lifecycle is reported. */
  log: CourierLog
}

/** What the server told us at handshake; the authoritative view of this connection. */
export interface WireSession {
  /** The agent id the server ASSIGNED. Never the label we asked for, necessarily. */
  agent: string
  /** The runtime's session id, which is also its trace name. */
  session: string
  /** Scheduler concurrency, shared by every agent on the runtime. */
  concurrency: number
  /** The instruction set the host loaded. Read-only. */
  isa: IsaEntry[]
  /** The ceilings in force for this connection. */
  limits: Limits
}

/** A submission waiting for its correlated answer. */
interface Pending {
  resolve(answer: Answer): void
  timer: NodeJS.Timeout
}

/**
 * One dsh session's connection to the fluvia runtime.
 *
 * One connection per session, not one per harness: the server derives identity
 * from the connection, scopes handles to it, and delivers notifications only to
 * it. Sharing a connection between two dsh sessions would hand them one
 * identity and therefore each other's results — the very thing the boundary
 * exists to prevent.
 *
 * The connection reconnects on its own. A runtime restart, a socket that went
 * away while the harness idled, a host that had not started yet when the first
 * tool call arrived: all of those are ordinary, and all of them resolve into a
 * fresh `hello` rather than into a dead tool.
 */
export class WireConnection {
  private socket: Socket | undefined
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** In-flight connect, so concurrent submissions share one handshake. */
  private connecting: Promise<WireSession> | undefined
  /** The live handshake result, or `undefined` while disconnected. */
  private current: WireSession | undefined
  /** Set by {@link close} so a deliberate teardown is not retried. */
  private closed = false
  /** Consecutive failed connects, for the backoff. */
  private attempts = 0

  /**
   * @param options — address, identity request, and the notification callback.
   */
  constructor(private readonly options: WireOptions) {}

  /** The handshake result while connected, else `undefined`. */
  get session(): WireSession | undefined {
    return this.current
  }

  /** Whether a socket is open and the handshake has completed. */
  get connected(): boolean {
    return this.current !== undefined && this.socket !== undefined && !this.socket.destroyed
  }

  /**
   * Connect if necessary and return the handshake result.
   *
   * Idempotent and safe to call concurrently: the first caller owns the
   * handshake and the rest await it, so a burst of parallel tool calls opens
   * one connection rather than one each.
   *
   * @returns the server's `welcome` data.
   * @throws {Error} when the connection cannot be established.
   */
  async ensureConnected(): Promise<WireSession> {
    if (this.closed) throw new Error('the fluvia plugin is unloading')
    if (this.current && this.connected) return this.current
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  /**
   * Submit one line and resolve with the server's answer to it.
   *
   * Resolves as soon as the line is *accepted* — an `ack` means scheduled, not
   * finished. Results arrive later through `onNotification`. That asymmetry is
   * the entire point of fluvia, so this method must never wait for settlement.
   *
   * The line is sent verbatim. It carries **no** `@agent` prefix: identity is
   * the connection's, assigned by the server, and a prefix is a protocol error.
   *
   * @param line — one complete fluvia line.
   * @param signal — the caller's cancellation.
   * @returns the correlated `ack`, `control` or `error` frame.
   * @throws {Error} when the connection fails, the wait times out, or `signal` aborts.
   */
  async submit(line: string, signal?: AbortSignal): Promise<Answer> {
    await this.ensureConnected()
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('the fluvia runtime connection is not writable')
    signal?.throwIfAborted()

    const id = this.nextId++
    return new Promise<Answer>((resolve, reject) => {
      const cleanup = (): void => {
        const entry = this.pending.get(id)
        if (entry) clearTimeout(entry.timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('cancelled before the fluvia runtime answered'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`the fluvia runtime did not answer within ${ANSWER_TIMEOUT_MS}ms`))
      }, ANSWER_TIMEOUT_MS)
      timer.unref?.()

      // Registered before the write: a unix socket can answer in the same tick,
      // and an answer with no waiting resolver is a lost turn.
      this.pending.set(id, {
        resolve: (answer) => {
          cleanup()
          resolve(answer)
        },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        socket.write(encodeFrame({ t: 'submit', id, line }))
      } catch (error) {
        cleanup()
        reject(new Error(`could not write to the fluvia runtime: ${(error as Error).message}`))
      }
    })
  }

  /** Close politely. The server treats this as "this agent is done", never as a shutdown. */
  close(): void {
    this.closed = true
    this.failPending('the fluvia plugin is unloading')
    const socket = this.socket
    this.socket = undefined
    this.current = undefined
    if (!socket || socket.destroyed) return
    try {
      socket.write(encodeFrame({ t: 'bye' }))
      socket.end()
    } catch {
      socket.destroy()
    }
  }

  /** Open one socket and complete the handshake. */
  private async open(): Promise<WireSession> {
    const { address, label, token, log } = this.options
    const token_ = token
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s =
        address.kind === 'unix'
          ? netConnect({ path: address.path })
          : netConnect({ host: address.host, port: address.port })
      s.setEncoding('utf8')
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error(`connecting to ${formatAddress(address)} timed out`))
      }, CONNECT_TIMEOUT_MS)
      timer.unref?.()
      s.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new Error(`cannot reach the fluvia runtime at ${formatAddress(address)} — ${error.message}`))
      })
      s.once('connect', () => {
        clearTimeout(timer)
        resolve(s)
      })
    })

    const welcome = await new Promise<WireSession>((resolve, reject) => {
      let greeting = ''
      const onError = (error: Error): void => reject(new Error(`handshake failed: ${error.message}`))
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('the fluvia runtime did not send a welcome'))
      }, CONNECT_TIMEOUT_MS)
      timer.unref?.()

      // The handshake is read by hand: the frame dispatcher below only makes
      // sense once the welcome has told us who the server says we are.
      const onData = (chunk: string): void => {
        greeting += chunk
        const index = greeting.indexOf('\n')
        if (index < 0) return
        const line = greeting.slice(0, index)
        const rest = greeting.slice(index + 1)
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)

        const decoded = decodeFrame(line)
        if ('error' in decoded) {
          socket.destroy()
          return reject(new Error(`bad greeting: ${decoded.error}`))
        }
        const frame = decoded.frame
        if (frame.t !== 'welcome') {
          const reason = frame.t === 'error' ? frame.message : frame.t === 'bye' ? frame.reason : frame.t
          socket.end()
          return reject(new Error(`the fluvia runtime refused the connection: ${reason}`))
        }
        if (frame.v !== PROTOCOL_VERSION) {
          socket.end()
          return reject(new Error(`protocol mismatch: runtime speaks v${frame.v}, this plugin speaks v${PROTOCOL_VERSION}`))
        }
        this.attach(socket)
        if (rest) this.onData(rest)
        resolve({
          agent: frame.agent,
          session: frame.session,
          concurrency: frame.concurrency,
          isa: frame.isa,
          limits: frame.limits,
        })
      }
      socket.on('data', onData)
      socket.once('error', onError)
      socket.write(encodeFrame({ t: 'hello', v: PROTOCOL_VERSION, label, token: token_ }))
    }).catch((error: unknown) => {
      this.attempts += 1
      throw error
    })

    this.attempts = 0
    this.current = welcome
    log.info(
      `connected to ${formatAddress(address)} as "${welcome.agent}" (runtime session ${welcome.session}, ${welcome.isa.length} instructions, concurrency ${welcome.concurrency})`,
    )
    // The server may have sanitized or uniquified our label. Saying so once is
    // what makes a mismatched routing assumption visible instead of puzzling.
    if (welcome.agent !== label) {
      log.info(`the runtime assigned "${welcome.agent}" rather than the requested label "${label}"`)
    }
    return welcome
  }

  /** Wire up a socket that has completed its handshake. */
  private attach(socket: Socket): void {
    this.socket = socket
    this.buffer = ''
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('close', () => this.onDisconnect('connection closed'))
    socket.on('error', (error: Error) => this.onDisconnect(error.message))
  }

  /** Split the stream into NDJSON lines. */
  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      const decoded = decodeFrame(line)
      if ('error' in decoded) {
        this.options.log.warn(`ignoring a malformed frame from the fluvia runtime: ${decoded.error}`)
        continue
      }
      this.onFrame(decoded.frame)
    }
  }

  /** Route one frame. */
  private onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'result':
        // Notifications are the reason this connection exists. The server has
        // already decided this one is ours; there is nothing to filter.
        try {
          this.options.onNotification(frame.notification)
        } catch (error) {
          this.options.log.warn(`notification handler threw: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      case 'ack':
      case 'control':
      case 'error': {
        // Correlation is by frame id, never by arrival order: a notification
        // landing between a submission and its answer must not be mistaken for
        // that answer, and the server is free to answer out of order.
        if (frame.id === undefined) return
        const entry = this.pending.get(frame.id)
        if (!entry) return
        entry.resolve(frame)
        return
      }
      case 'bye':
        this.onDisconnect(`the runtime closed this connection: ${frame.reason}`)
        return
      case 'welcome':
        // A second welcome on a live connection is not part of the protocol.
        return
    }
  }

  /** The socket went away: fail what was waiting, then reconnect unless closing. */
  private onDisconnect(reason: string): void {
    if (this.closed) return
    const wasConnected = this.current !== undefined
    this.current = undefined
    this.socket = undefined
    this.failPending(reason)
    if (!wasConnected) return

    this.options.log.warn(`fluvia runtime connection lost (${reason}); will reconnect on demand`)
    // Reconnecting eagerly matters: notifications for calls already in flight
    // arrive on a connection, so a session that merely waits would never learn
    // that work it already submitted had finished.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS)
    const timer = setTimeout(() => {
      if (this.closed) return
      void this.ensureConnected().catch((error: unknown) => {
        this.options.log.warn(`reconnect failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
    timer.unref?.()
  }

  /** Answer every waiting submission with an error frame rather than hanging. */
  private failPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      entry.resolve({ t: 'error', id, message: `connection closed: ${reason}` })
    }
    this.pending.clear()
  }
}

/**
 * One connection per dsh session, opened on demand.
 *
 * The hub exists because identity is per-connection on the far side. Each dsh
 * session gets its own socket, its own server-assigned agent id, its own handle
 * namespace and its own notification stream — which is what lets several
 * sessions share one runtime without being able to observe each other.
 */
export class WireHub {
  private readonly connections = new Map<string, WireConnection>()
  private closed = false

  /**
   * @param address — where the runtime listens.
   * @param tokenFile — path to the shared secret, when the runtime requires one.
   * @param labelFor — maps a dsh session id to the label to request.
   * @param onNotification — called with the owning session id and the settled call.
   * @param log — where connection lifecycle is reported.
   */
  constructor(
    private readonly address: Address,
    private readonly tokenFile: string | undefined,
    private readonly labelFor: (sessionId: string) => string,
    private readonly onNotification: (sessionId: string, notification: WireNotification) => void,
    private readonly log: CourierLog,
  ) {}

  /** Session ids that currently hold a connection. */
  get sessions(): string[] {
    return [...this.connections.keys()]
  }

  /** The handshake result for one session, if it is connected. */
  sessionOf(sessionId: string): WireSession | undefined {
    return this.connections.get(sessionId)?.session
  }

  /**
   * Get (or open) the connection belonging to one dsh session.
   *
   * @param sessionId — the dsh session id.
   * @returns the connection, already handshaken.
   * @throws {Error} when the runtime cannot be reached.
   */
  async connectionFor(sessionId: string): Promise<WireConnection> {
    if (this.closed) throw new Error('the fluvia plugin is unloading')
    let connection = this.connections.get(sessionId)
    if (!connection) {
      connection = new WireConnection({
        address: this.address,
        label: this.labelFor(sessionId),
        token: await this.readToken(),
        onNotification: (notification) => this.onNotification(sessionId, notification),
        log: this.log,
      })
      this.connections.set(sessionId, connection)
    }
    await connection.ensureConnected()
    return connection
  }

  /** Drop one session's connection, e.g. when its agent is disposed. */
  release(sessionId: string): void {
    const connection = this.connections.get(sessionId)
    if (!connection) return
    this.connections.delete(sessionId)
    connection.close()
  }

  /** Close every connection. The runtime keeps running; only our agents leave. */
  close(): void {
    this.closed = true
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
  }

  /**
   * Read the shared secret.
   *
   * Read per connection rather than cached at load, so rotating the token file
   * takes effect on the next session without reloading the plugin. The secret
   * is never logged and never leaves this process except as a `hello` field.
   */
  private async readToken(): Promise<string | undefined> {
    if (!this.tokenFile) return undefined
    try {
      return (await readFile(this.tokenFile, 'utf8')).trim()
    } catch (error) {
      throw new Error(`cannot read tokenFile "${this.tokenFile}": ${(error as Error).message}`)
    }
  }
}
