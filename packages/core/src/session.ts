/**
 * The terminal surface: one line in, one answer out — and never a wait. The
 * session turns a typed line into either a scheduled call (answered with its id
 * and the two handles it bound) or a control answer, and records both
 * renderings in the trace so the perf report can replay the conversation
 * exactly as the agent saw it.
 *
 * What a line *means* is decided in `core/dispatch.ts`, which the server shares;
 * this module only decides how it reads.
 *
 * @module @fluvia/core/session
 */

import type { Context } from '@deepseek-ai/cordis'
import { dispatchLine, isExitLine } from './dispatch.ts'
import { splitAgentPrefix } from './parser.ts'
import type { Tracer } from './trace.ts'
import { renderAck } from './format.ts'

/** How the CLI talks back: readable text, or NDJSON for a harness. */
export type OutputMode = 'human' | 'json'

/** Writes to stdout and mirrors every line into the trace. */
export class Output {
  constructor(
    private readonly tracer: Tracer,
    /** `human` prints text; `json` prints one JSON object per line. */
    readonly mode: OutputMode,
  ) {}

  /**
   * Print an answer. The trace always stores the human rendering, whatever the
   * mode. In machine mode an error still has to reach the harness — a swallowed
   * startup failure is how a session silently does nothing — so errors are
   * re-emitted as `log` records.
   */
  say(agent: string, text: string, level: 'info' | 'error' | 'notify' = 'info'): void {
    this.tracer.emit('cli.output', { agent, level, text })
    if (this.mode === 'json') {
      if (level === 'error') this.json({ type: 'log', level, agent, text })
      return
    }
    process.stdout.write(`${text}\n`)
  }

  /** Emit a machine-mode record. Ignored in human mode. */
  json(record: Record<string, unknown>): void {
    if (this.mode !== 'json') return
    process.stdout.write(`${JSON.stringify(record)}\n`)
  }
}

/** Session options resolved from the command line. */
export interface SessionOptions {
  /** Agent id used for lines with no `@agent` prefix. */
  defaultAgent: string
}

export class CliSession {
  constructor(
    private readonly ctx: Context,
    private readonly out: Output,
    private readonly tracer: Tracer,
    private readonly options: SessionOptions,
  ) {}

  /**
   * Handle one input line.
   *
   * @returns `'exit'` when the line asked to close the session.
   */
  handle(line: string): 'ok' | 'exit' {
    const trimmed = line.trim()
    const { agent: prefix, rest } = splitAgentPrefix(trimmed)
    if (!rest) return 'ok'
    if (isExitLine(trimmed)) {
      // Closing the session is CLI business, not an agent's work. Attributing
      // an unprefixed `.exit` to the default agent would enrol an agent that
      // never called anything, and every report would then show a lane with no
      // rows in it.
      this.tracer.emit('agent.input', { agent: prefix ?? '', line: trimmed })
      return 'exit'
    }

    const agent = prefix ?? this.options.defaultAgent
    this.tracer.emit('agent.input', { agent, line: trimmed })

    // The terminal's operator drives every agent in this runtime, so an
    // `@agent` prefix is theirs to use.
    const dispatch = dispatchLine(this.ctx, trimmed, { agent: this.options.defaultAgent, prefix: 'honour' })
    switch (dispatch.kind) {
      case 'noop':
      case 'exit':
        return 'ok'
      case 'ack': {
        const call = dispatch.call
        this.out.say(call.agent, renderAck(call))
        this.out.json({
          type: 'ack',
          call: call.id,
          seq: call.seq,
          fn: call.fn,
          agent: call.agent,
          bind: call.bind,
          deps: call.deps.map((dep) => ({ name: dep.name, from: dep.from, kind: dep.kind })),
          state: call.state,
        })
        return 'ok'
      }
      case 'control':
        this.out.say(agent, dispatch.result.text)
        this.out.json({
          type: 'control',
          fn: dispatch.fn,
          agent,
          text: dispatch.result.text,
          rows: dispatch.result.rows ?? [],
        })
        return 'ok'
      case 'error':
        this.out.say(agent, `✗ ${dispatch.message}`, 'error')
        this.out.json({ type: 'error', agent, message: dispatch.message, line: trimmed })
        return 'ok'
    }
  }
}
