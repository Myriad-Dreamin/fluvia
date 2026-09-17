/**
 * The client half of the boundary — the part that runs wherever the model runs.
 *
 * It is deliberately thin, and none of it is trusted: it cannot pick its own
 * agent id, cannot change the instruction set, and cannot ask for anything the
 * server does not already enforce. Everything here is convenience for the
 * caller, not authority.
 *
 * @module @fluvia/cli/client/client
 */

import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import type { Notification } from '@fluvia/core/types'
import { decodeFrame, encodeFrame, PROTOCOL_VERSION } from '@fluvia/core/protocol'
import type { Address, ClientFrame, IsaEntry, Limits, ServerFrame } from '@fluvia/core/protocol'

/** The server's answer to one submitted line. */
export type Answer =
  | Extract<ServerFrame, { t: 'ack' }>
  | Extract<ServerFrame, { t: 'control' }>
  | Extract<ServerFrame, { t: 'error' }>

/** What the caller supplies to open a connection. */
export interface ConnectOptions {
  /** Requested label. The server sanitizes it and may change it. */
  label?: string
  /** Shared secret, when the server requires one. */
  token?: string
  /** Called for every settled call of this connection's agent. */
  onNotification?(notification: Notification): void
  /** Called when the connection ends, with the server's reason if it gave one. */
  onClose?(reason: string): void
}

/** A live connection to a fluvia runtime. */
export class FluviaClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, (answer: Answer) => void>()
  private closed = false

  private constructor(
    private readonly socket: Socket,
    private readonly options: ConnectOptions,
    /** The identity the server assigned; the client does not choose it. */
    readonly agent: string,
    /** The runtime's session id. */
    readonly session: string,
    /** The published instruction set — read-only. */
    readonly isa: IsaEntry[],
    /** The ceilings the server enforces. */
    readonly limits: Limits,
    /** Scheduler concurrency, shared with every other agent. */
    readonly concurrency: number,
  ) {
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('close', () => this.onClose('connection closed'))
    socket.on('error', (error: Error) => this.onClose(error.message))
  }

  /** Open a connection and complete the handshake. */
  static connect(address: Address, options: ConnectOptions = {}): Promise<FluviaClient> {
    return new Promise((resolve, reject) => {
      const socket =
        address.kind === 'unix'
          ? netConnect({ path: address.path })
          : netConnect({ host: address.host, port: address.port })
      socket.setEncoding('utf8')

      const onError = (error: Error) => reject(error)
      socket.once('error', onError)
      socket.once('connect', () => {
        const hello: ClientFrame = { t: 'hello', v: PROTOCOL_VERSION, label: options.label, token: options.token }
        socket.write(encodeFrame(hello))
      })

      // The handshake is read by hand, because the frame dispatcher below only
      // exists once the welcome has told us who we are.
      let greeting = ''
      const onData = (chunk: string) => {
        greeting += chunk
        const index = greeting.indexOf('\n')
        if (index < 0) return
        const line = greeting.slice(0, index)
        const rest = greeting.slice(index + 1)
        socket.off('data', onData)
        socket.off('error', onError)
        const decoded = decodeFrame<ServerFrame>(line)
        if ('error' in decoded) return reject(new Error(`bad greeting: ${decoded.error}`))
        const frame = decoded.frame
        if (frame.t !== 'welcome') {
          const reason = frame.t === 'error' || frame.t === 'bye' ? ('message' in frame ? frame.message : frame.reason) : frame.t
          socket.end()
          return reject(new Error(`server refused the connection: ${reason}`))
        }
        const client = new FluviaClient(
          socket,
          options,
          frame.agent,
          frame.session,
          frame.isa,
          frame.limits,
          frame.concurrency,
        )
        if (rest) client.onData(rest)
        resolve(client)
      }
      socket.on('data', onData)
    })
  }

  /**
   * Submit one line and resolve with the server's answer.
   *
   * It resolves as soon as the line is *accepted* — an `ack` means scheduled,
   * never finished. Results arrive through `onNotification`.
   */
  submit(line: string): Promise<Answer> {
    if (this.closed) return Promise.reject(new Error('connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      // Registered before the write: a unix socket can answer in the same tick.
      this.pending.set(id, resolve)
      try {
        this.socket.write(encodeFrame({ t: 'submit', id, line } satisfies ClientFrame))
      } catch (error) {
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  /** Close politely; the server never takes this as a shutdown of the runtime. */
  close(): void {
    if (this.closed) return
    this.socket.write(encodeFrame({ t: 'bye' } satisfies ClientFrame))
    this.socket.end()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      const decoded = decodeFrame<ServerFrame>(line)
      if ('error' in decoded) continue
      this.onFrame(decoded.frame)
    }
  }

  private onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'result':
        this.options.onNotification?.(frame.notification)
        return
      case 'ack':
      case 'control':
      case 'error': {
        // Correlation is by id, so a notification arriving between a submission
        // and its answer cannot be mistaken for that answer.
        const resolve = frame.id === undefined ? undefined : this.pending.get(frame.id)
        if (resolve && frame.id !== undefined) {
          this.pending.delete(frame.id)
          resolve(frame)
        }
        return
      }
      case 'bye':
        this.onClose(frame.reason)
        return
      case 'welcome':
        return
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [id, resolve] of this.pending) {
      resolve({ t: 'error', id, message: `connection closed: ${reason}` })
    }
    this.pending.clear()
    this.options.onClose?.(reason)
  }
}
