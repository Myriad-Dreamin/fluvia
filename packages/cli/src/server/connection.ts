/**
 * One connection from the sandboxed side, and everything it is not allowed to
 * do. A connection may submit lines and read its own results; identity,
 * admission, pacing and lifetime are decided here, on the runtime's side of the
 * boundary.
 *
 * @module @fluvia/cli/server/connection
 */

import { timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { dispatchLine, isExitLine } from '@fluvia/core/dispatch'
import type { Tracer } from '@fluvia/core/trace'
import { encodeFrame, decodeFrame, PROTOCOL_VERSION } from '@fluvia/core/protocol'
import type { ClientFrame, IsaEntry, Limits, ServerFrame } from '@fluvia/core/protocol'

/** What the server decides about each connection. */
export interface ConnectionPolicy {
  /** Ceilings published to the client and enforced here. */
  limits: Limits
  /** Shared secret a client must present, when the transport needs one. */
  token?: string
  /** What happens to an agent's unsettled calls when it disconnects. */
  onDisconnect: 'cancel' | 'keep'
}

/** Assign agent ids and keep them unique among live connections. */
export class AgentNamer {
  private readonly live = new Set<string>()

  /**
   * Turn a client's requested label into an agent id.
   *
   * The label is a **request**: it is sanitized to fluvia's `@agent` grammar,
   * length-capped, and made unique. A client cannot take an id that another
   * live connection holds, which is what stops one sandboxed agent from
   * receiving another's notifications or naming its handles.
   */
  assign(label: string | undefined): string {
    const cleaned = (label ?? 'agent').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
    const base = /^[A-Za-z_]/.test(cleaned) ? cleaned : `a-${cleaned}`
    let id = base
    for (let n = 2; this.live.has(id); n++) id = `${base}-${n}`
    this.live.add(id)
    return id
  }

  /** Release an id when its connection goes away. */
  release(id: string): void {
    this.live.delete(id)
  }
}

/** A simple token bucket: sustained rate with a one-second burst. */
class RateLimiter {
  private tokens: number
  private last = Date.now()

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond
  }

  /** @returns whether this submission is within the allowance. */
  take(): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.last) / 1000) * this.perSecond)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

/** Serve one client connection. */
export class Connection {
  private buffer = ''
  private agent?: string
  private closed = false
  private readonly limiter: RateLimiter

  constructor(
    private readonly ctx: Context,
    private readonly socket: Socket,
    private readonly tracer: Tracer,
    private readonly namer: AgentNamer,
    private readonly policy: ConnectionPolicy,
    private readonly session: string,
  ) {
    this.limiter = new RateLimiter(policy.limits.submitsPerSecond)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', () => this.dispose('socket error'))
    socket.on('close', () => this.dispose('closed'))
  }

  /** The assigned agent id, once the handshake has completed. */
  get agentId(): string | undefined {
    return this.agent
  }

  /** Push a settled call to this connection, if it is the agent's own. */
  deliver(frame: ServerFrame): void {
    this.send(frame)
  }

  /** Close from the server side. */
  close(reason: string): void {
    this.send({ t: 'bye', reason })
    this.socket.end()
  }

  /* ----------------------------------------------------------- internals */

  private onData(chunk: string): void {
    this.buffer += chunk
    // A client that never sends a newline must not be able to grow the buffer
    // without bound; the cap is the line limit plus slack for one frame's
    // envelope.
    if (this.buffer.length > this.policy.limits.maxLineBytes * 4) {
      this.fail('input too long')
      return
    }
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim()) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    if (this.closed) return
    const decoded = decodeFrame<ClientFrame>(line)
    if ('error' in decoded) return this.fail(`bad frame: ${decoded.error}`)
    const frame = decoded.frame

    if (frame.t === 'hello') return this.onHello(frame)
    if (!this.agent) return this.fail('hello must come first')
    if (frame.t === 'bye') return this.close('client said bye')
    if (frame.t === 'submit') return this.onSubmit(frame)
    this.fail(`unsupported frame: ${(frame as { t: string }).t}`)
  }

  private onHello(frame: Extract<ClientFrame, { t: 'hello' }>): void {
    if (this.agent) return this.fail('already greeted')
    if (frame.v !== PROTOCOL_VERSION) {
      return this.fail(`protocol version ${String(frame.v)} is not supported (server speaks ${PROTOCOL_VERSION})`)
    }
    if (this.policy.token !== undefined && !constantTimeEquals(frame.token ?? '', this.policy.token)) {
      // Same message either way: a distinguishable answer turns the handshake
      // into an oracle.
      return this.fail('unauthorized')
    }
    this.agent = this.namer.assign(frame.label)
    this.ctx.env.agent(this.agent)
    this.tracer.emit('agent.input', { agent: this.agent, line: `# connected (label ${frame.label ?? '-'})` })
    this.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      agent: this.agent,
      session: this.session,
      concurrency: this.ctx.calls.concurrency,
      isa: this.isa(),
      limits: this.policy.limits,
    })
  }

  private onSubmit(frame: Extract<ClientFrame, { t: 'submit' }>): void {
    const agent = this.agent!
    const id = frame.id
    if (typeof frame.line !== 'string') return this.answerError(id, 'submit.line must be a string')
    if (Buffer.byteLength(frame.line) > this.policy.limits.maxLineBytes) {
      return this.answerError(id, `line exceeds ${this.policy.limits.maxLineBytes} bytes`)
    }
    if (isExitLine(frame.line)) {
      // `.exit` means "close my connection" here. On the CLI it stops the
      // process, and a shared runtime must never be stoppable by one of the
      // agents it serves.
      return this.close('client exited')
    }
    if (!this.limiter.take()) {
      return this.answerError(id, `rate limit: at most ${this.policy.limits.submitsPerSecond} submissions per second`)
    }
    const inFlight = this.ctx.calls.list().filter((call) => call.agent === agent && !isSettled(call.state)).length
    if (inFlight >= this.policy.limits.maxInFlight) {
      return this.answerError(id, `too many calls in flight (${inFlight}); wait for notifications or cancel some`)
    }

    this.tracer.emit('agent.input', { agent, line: frame.line })
    // Identity is fixed per connection: `prefix: 'reject'` is what makes an
    // `@other` prefix a protocol error rather than a way to change lanes.
    const dispatch = dispatchLine(this.ctx, frame.line, { agent, prefix: 'reject' })
    switch (dispatch.kind) {
      case 'noop':
      case 'exit':
        return
      case 'ack': {
        const call = dispatch.call
        this.send({
          t: 'ack',
          id,
          call: call.id,
          fn: call.fn,
          bind: call.bind,
          deps: call.deps.map((dep) => ({ name: dep.name, from: dep.from, kind: dep.kind })),
          state: call.state,
        })
        return
      }
      case 'control':
        this.send({ t: 'control', id, fn: dispatch.fn, text: dispatch.result.text, rows: dispatch.result.rows ?? [] })
        return
      case 'error':
        this.answerError(id, dispatch.message, frame.line)
    }
  }

  /** The published instruction set, derived from what the host preloaded. */
  private isa(): IsaEntry[] {
    return this.ctx.functions.list().map((def) => ({
      name: def.name,
      kind: def.kind === 'control' ? 'control' : 'async',
      out: def.out,
      params: def.params ?? (def.positional?.length ? `(${def.positional.join(', ')}, { … })` : '({ … })'),
      summary: def.summary,
    }))
  }

  private answerError(id: number | undefined, message: string, line?: string): void {
    this.send({ t: 'error', id, message, line })
  }

  private send(frame: ServerFrame): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(encodeFrame(frame))
  }

  /** Refuse and close: a client that violates the framing gets no dialogue. */
  private fail(reason: string): void {
    this.send({ t: 'error', message: reason })
    this.close(reason)
  }

  private dispose(reason: string): void {
    if (this.closed) return
    this.closed = true
    if (!this.agent) return
    if (this.policy.onDisconnect === 'cancel') {
      // Nobody is left to read these results, and they hold concurrency slots
      // the remaining agents can use.
      for (const call of this.ctx.calls.list()) {
        if (call.agent === this.agent && !isSettled(call.state)) {
          this.ctx.calls.cancel(call.id, 'server', `agent disconnected (${reason})`)
        }
      }
    }
    this.namer.release(this.agent)
  }
}

/** Terminal states, duplicated here to keep the module free of scheduler imports. */
function isSettled(state: string): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled' || state === 'skipped'
}

/** Compare secrets without leaking their length through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
