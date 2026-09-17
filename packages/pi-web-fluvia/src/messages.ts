/**
 * The `fluvia-notify` message: settled fluvia calls, delivered into the agent's
 * transcript as their own message type.
 *
 * It is a custom pi-agent-core message (declaration-merged below), so the UI
 * can render it as what it is — a notification, not something the user typed —
 * while the model reads it as a user turn carrying a `<fluvia-notify>` block.
 *
 * This module is DOM-free: the headless verification imports it from Node.
 *
 * @module pi-web-fluvia/messages
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { Message } from '@mariozechner/pi-ai'

/** One coalesced delivery of settled calls. */
export interface FluviaNotifyMessage {
  role: 'fluvia-notify'
  /** The rendered `<fluvia-notify>` block, exactly as the model reads it. */
  text: string
  /** How many settled calls the block carries. */
  count: number
  /** Where it came from: a live runtime, or a slice's virtual clock. */
  source: 'live' | 'slice'
  /** Virtual offset from the cut, for slice deliveries. */
  at?: number
  timestamp: number
}

declare module '@mariozechner/pi-agent-core' {
  interface CustomAgentMessages {
    'fluvia-notify': FluviaNotifyMessage
  }
}

export function isFluviaNotify(message: AgentMessage): message is FluviaNotifyMessage {
  return (message as { role?: string }).role === 'fluvia-notify'
}

/**
 * Turn `fluvia-notify` messages into user messages and leave everything else
 * alone. The browser composes this with pi-web-ui's `defaultConvertToLlm`;
 * Node uses {@link convertToLlmNode}.
 */
export function expandFluviaMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) =>
    isFluviaNotify(message)
      ? ({ role: 'user', content: [{ type: 'text', text: message.text }], timestamp: message.timestamp } satisfies Message)
      : message,
  )
}

/** `convertToLlm` without pi-web-ui: standard roles pass, custom roles are dropped. */
export function convertToLlmNode(messages: AgentMessage[]): Message[] {
  return expandFluviaMessages(messages).filter(
    (message): message is Message => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
  )
}
