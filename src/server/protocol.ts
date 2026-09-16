/**
 * The wire between a model's side and the runtime's side.
 *
 * fluvia's deployment model puts the model — and whatever harness runs it —
 * inside a sandbox, and the runtime that actually executes the instruction set
 * outside it. The model can therefore submit lines and read results, and can do
 * nothing else: it cannot change which implementations are loaded, cannot see
 * another agent's handles, cannot reach the trace, and cannot stop the runtime.
 *
 * Every one of those properties is enforced on the server side of this
 * protocol, because anything enforced on the client side is enforced by code
 * the model can edit.
 *
 * @module fluvia/server/protocol
 */

import type { CallRecord, Notification } from '../core/types.ts'

/** Wire version. A client announcing a different major version is refused. */
export const PROTOCOL_VERSION = 1

/** One instruction of the published instruction set. */
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

/** Frames a client may send. */
export type ClientFrame =
  /** Must be first. `label` is a request, not a claim: the server assigns the id. */
  | { t: 'hello'; v: number; label?: string; token?: string }
  /** Submit one line. `id` correlates the answer; the server echoes it. */
  | { t: 'submit'; id?: number; line: string }
  /** Close this connection. It never closes anyone else's, nor the runtime. */
  | { t: 'bye' }

/** Frames the server sends. */
export type ServerFrame =
  /** Answer to `hello`: the assigned identity and the instruction set. */
  | {
      t: 'welcome'
      v: number
      /** The agent id assigned to this connection. Lines are attributed to it. */
      agent: string
      /** The runtime's session id, which is also its trace name. */
      session: string
      /** Scheduler concurrency, shared by every connection. */
      concurrency: number
      /** The instruction set. Read-only: no frame can change it. */
      isa: IsaEntry[]
      /** Ceilings in force for this connection. */
      limits: Limits
    }
  /** A call was scheduled. The work has not finished. */
  | {
      t: 'ack'
      id?: number
      call: string
      fn: string
      bind: { value: string; error: string }
      deps: { name: string; from: string; kind: 'value' | 'error' }[]
      state: CallRecord['state']
    }
  /** A control instruction answered. */
  | { t: 'control'; id?: number; fn: string; text: string; rows: unknown[] }
  /** The line was refused; nothing was scheduled. */
  | { t: 'error'; id?: number; message: string; line?: string }
  /** A call of *this* connection's agent settled. */
  | { t: 'result'; notification: Notification }
  /** The server is closing this connection. */
  | { t: 'bye'; reason: string }

/** Serialize a frame as one NDJSON line. */
export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Parse one NDJSON line into a frame.
 *
 * @returns the frame, or a reason it was rejected. Malformed input from the
 * sandboxed side is expected, not exceptional, so it never throws.
 */
export function decodeFrame<T extends ClientFrame | ServerFrame>(line: string): { frame: T } | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { error: 'not JSON' }
  }
  if (typeof value !== 'object' || value === null || typeof (value as { t?: unknown }).t !== 'string') {
    return { error: 'not a frame' }
  }
  return { frame: value as T }
}

/** How a listen/connect address is written on a command line. */
export type Address =
  /** A unix domain socket; filesystem permissions are the access control. */
  | { kind: 'unix'; path: string }
  /** A TCP endpoint; a shared secret is then mandatory. */
  | { kind: 'tcp'; host: string; port: number }

/**
 * Parse `unix:/run/fluvia.sock` or `tcp:127.0.0.1:7790`.
 *
 * A bare path is taken as a unix socket, because that is the form that keeps
 * the endpoint inside the filesystem's permission model.
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

/** Human rendering of an address, for logs and for the welcome banner. */
export function formatAddress(address: Address): string {
  return address.kind === 'unix' ? `unix:${address.path}` : `tcp:${address.host}:${address.port}`
}
