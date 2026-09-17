/**
 * The `fluvia` AgentTool. It submits lines in order through whatever `submit`
 * it is given — a live connection or a slice session — and returns the
 * runtime's instant answers. It never waits for a call to settle.
 *
 * @module pi-web-fluvia/tool
 */

import type { AgentTool } from '@mariozechner/pi-agent-core'
import { Type } from '@mariozechner/pi-ai'
import type { IsaEntry } from '@fluvia/core/protocol'
import { renderToolDescription } from './describe.ts'

const parameters = Type.Object({
  calls: Type.Optional(
    Type.String({
      description:
        'fluvia calls as plain text, one call per line, submitted in order. A later line may use handles bound by an earlier one. No `@agent` prefix. Example:\nprepareKernel({ size: 4096, dtype: "f32" })\ncompileKernel(kernel0, { opt: 3 })',
    }),
  ),
})

/**
 * The calls a tool invocation carries, one per line. Also reads the older
 * `line` / `lines: string[]` arguments, so traces recorded before the plain-text
 * form still replay.
 */
export function callsOf(params: unknown): string[] {
  const p = (params ?? {}) as { calls?: unknown; lines?: unknown; line?: unknown }
  const chunks: string[] = []
  for (const value of [p.calls, p.lines, p.line]) {
    if (typeof value === 'string') chunks.push(value)
    else if (Array.isArray(value)) chunks.push(...value.filter((v): v is string => typeof v === 'string'))
  }
  return chunks
    .flatMap((chunk) => chunk.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
}

/** What the tool reports besides text. */
export interface FluviaToolDetails {
  lines: string[]
  answers: string[]
}

/** Submits one line and resolves with the model-facing answer text. */
export type SubmitLine = (line: string, signal?: AbortSignal) => Promise<string> | string

export function createFluviaTool(submit: SubmitLine, isa: readonly IsaEntry[]): AgentTool<typeof parameters, FluviaToolDetails> {
  return {
    name: 'fluvia',
    label: 'fluvia',
    description: renderToolDescription(isa),
    parameters,
    // Handle names depend on submission order, so a batch of tool calls in one
    // assistant message must not interleave.
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      const lines = callsOf(params)
      if (!lines.length) throw new Error('Pass `calls`: fluvia calls as plain text, one per line.')
      const answers: string[] = []
      for (const line of lines) {
        if (signal?.aborted) break
        answers.push(await submit(line, signal))
      }
      const text = lines.length === 1 ? answers[0]! : lines.map((line, i) => `> ${line}\n${answers[i] ?? '(not submitted: aborted)'}`).join('\n')
      return { content: [{ type: 'text', text }], details: { lines, answers } }
    },
  }
}
