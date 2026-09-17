/**
 * `trace.json`: one pi × fluvia bench, exported so it can be watched again
 * without a model.
 *
 * It holds what the agent was given (system prompt, tools' runtime, the slice
 * it started from), everything said in the conversation (the user's prompts,
 * each model turn with its tool calls, every tool result and notification),
 * and the fluvia runtime's own event stream. Replaying feeds the recorded model
 * turns back through a scripted model while the fluvia runtime really runs, so
 * the calls, notifications and wake-ups happen again rather than being redrawn.
 *
 * DOM-free.
 *
 * @module pi-web-fluvia/record
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { AssistantMessage } from '@mariozechner/pi-ai'
import type { TraceEvent } from '@fluvia/core/types'
import type { SliceSetup } from './slice.ts'

export const RECORD_FORMAT = 'pi-web-fluvia.trace'

export interface SessionRecord {
  format: typeof RECORD_FORMAT
  version: 1
  exportedAt: string
  /** Free text, e.g. that a record was scripted rather than produced by a model. */
  note?: string
  mode: 'live' | 'slice'
  /** The model that produced the recorded turns. Replays never contact it. */
  model: { provider: string; id: string; api: string; baseUrl: string }
  systemPrompt: string
  live?: { agent: string; concurrency: number }
  slice?: {
    setup: SliceSetup
    task: string
    maxTurns: number
    traceName: string
    /** The recorded fluvia session the slice was cut from. */
    traceEvents: TraceEvent[]
  }
  /** The conversation, in order, as the agent held it. */
  messages: AgentMessage[]
  /** The fluvia runtime's events during the run. */
  runtime: TraceEvent[]
}

export function buildRecord(input: Omit<SessionRecord, 'format' | 'version' | 'exportedAt'>): SessionRecord {
  // Plain JSON: drops functions and undefined, and detaches from live state.
  return JSON.parse(JSON.stringify({ format: RECORD_FORMAT, version: 1, exportedAt: new Date().toISOString(), ...input })) as SessionRecord
}

export function parseRecord(value: unknown): SessionRecord {
  const record = value as Partial<SessionRecord> | null
  if (!record || record.format !== RECORD_FORMAT) {
    throw new Error(`not a pi-web-fluvia trace (expected "format": "${RECORD_FORMAT}")`)
  }
  if (record.version !== 1) throw new Error(`unsupported trace version ${String(record.version)}`)
  if (!Array.isArray(record.messages)) throw new Error('trace has no messages')
  if (record.mode === 'slice' && !record.slice?.traceEvents?.length) throw new Error('slice trace has no recorded session to cut')
  if (record.mode !== 'live' && record.mode !== 'slice') throw new Error(`unknown mode ${String(record.mode)}`)
  return record as SessionRecord
}

export function assistantTurns(record: SessionRecord): { index: number; message: AssistantMessage }[] {
  return record.messages
    .map((message, index) => ({ index, message }))
    .filter((entry): entry is { index: number; message: AssistantMessage } => entry.message.role === 'assistant')
}

/** Messages the human typed (not notifications, not tool results). */
export function humanPrompts(record: SessionRecord): { index: number; message: AgentMessage }[] {
  return record.messages
    .map((message, index) => ({ index, message }))
    .filter(({ message }) => {
      const role = (message as { role: string }).role
      return role === 'user' || role === 'user-with-attachments'
    })
}

/** Text of any message, for comparing a replay against its recording. */
export function messageText(message: AgentMessage | undefined): string {
  if (!message) return ''
  const m = message as { text?: unknown; content?: unknown }
  if (typeof m.text === 'string') return m.text
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((block: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) =>
        block.type === 'text' ? block.text : block.type === 'toolCall' ? `${block.name}(${JSON.stringify(block.arguments)})` : '',
      )
      .join('')
  }
  return ''
}
