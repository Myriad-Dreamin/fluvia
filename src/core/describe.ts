/**
 * How a value is shown once it lands in a handle. An agent never sees a payload
 * in full — it sees a type and a one-line summary, and passes the handle on. So
 * the digest is the entire user interface of a result, and it is worth getting
 * right: a toolbox tags its own results (`$type`, `$summary`), and everything
 * else is described structurally.
 *
 * @module fluvia/core/describe
 */

import type { CallError, ValueDigest } from './types.ts'
import { FluviaError } from './types.ts'

/** Longest summary we keep; longer ones are clipped with an ellipsis. */
const MAX_SUMMARY = 96

/** Describe any value as a `{ type, summary }` pair for display and tracing. */
export function describe(value: unknown): ValueDigest {
  if (value === null) return { type: 'null', summary: 'null' }
  if (value === undefined) return { type: 'void', summary: '(no value)' }
  if (typeof value === 'string') return { type: 'string', summary: clip(JSON.stringify(value)) }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return { type: typeof value, summary: String(value) }
  }
  if (Array.isArray(value)) {
    return { type: `Array(${value.length})`, summary: clip(value.map((item) => describe(item).summary).join(', ')) }
  }
  if (value instanceof Error) return { type: value.name, summary: clip(value.message) }
  if (typeof value === 'object') {
    const tagged = value as Record<string, unknown>
    const type = typeof tagged.$type === 'string' ? tagged.$type : 'object'
    if (typeof tagged.$summary === 'string') return { type, summary: clip(tagged.$summary) }
    const keys = Object.keys(tagged).filter((key) => !key.startsWith('$'))
    const body = keys
      .slice(0, 4)
      .map((key) => `${key}=${describe(tagged[key]).summary}`)
      .join(' ')
    return { type, summary: clip(body || `{${keys.length} keys}`) }
  }
  return { type: typeof value, summary: clip(String(value)) }
}

/** Clip a summary to {@link MAX_SUMMARY} characters. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat
}

/**
 * Flatten a thrown value into the trace's error shape. {@link FluviaError}
 * carries its own class and structured detail; anything else is reported by its
 * constructor name, because a toolbox that throws a bare `Error` should still
 * produce a notification an agent can read.
 */
export function toCallError(thrown: unknown): CallError {
  if (thrown instanceof FluviaError) {
    return { kind: thrown.kind, message: thrown.message, detail: thrown.detail, retryable: thrown.retryable }
  }
  if (thrown instanceof Error) {
    return { kind: thrown.name || 'Error', message: thrown.message }
  }
  return { kind: 'Thrown', message: String(thrown) }
}
