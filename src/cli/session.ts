/**
 * One line in, one answer out — and never a wait. The session turns a typed
 * line into either a scheduled call (answered with its id and the two handles
 * it bound) or a control answer, and records both renderings in the trace so
 * the perf report can replay the conversation exactly as the agent saw it.
 *
 * @module fluvia/cli/session
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CallRecord, FunctionDef } from '../core/types.ts'
import type { RawArg } from '../core/parser.ts'
import { ParseError, parseLine, splitAgentPrefix } from '../core/parser.ts'
import { SubmitError } from '../plugins/scheduler.ts'
import type { ControlResult } from '../plugins/inspect.ts'
import type { Tracer } from '../core/trace.ts'
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
    if (rest === '.exit' || rest === '.quit') {
      // Closing the session is CLI business, not an agent's work. Attributing
      // an unprefixed `.exit` to the default agent would enrol an agent that
      // never called anything, and every report would then show a lane with no
      // rows in it.
      this.tracer.emit('agent.input', { agent: prefix ?? '', line: trimmed })
      return 'exit'
    }
    const agent = prefix ?? this.options.defaultAgent
    this.ctx.env.agent(agent).lines++
    this.tracer.emit('agent.input', { agent, line: trimmed })

    let parsed
    try {
      parsed = parseLine(trimmed)
    } catch (error) {
      this.fail(agent, (error as ParseError).message, trimmed)
      return 'ok'
    }
    if (!parsed) return 'ok'

    const def = this.ctx.functions.get(parsed.fn)
    if (!def) {
      const suggestions = this.ctx.functions.suggest(parsed.fn)
      this.fail(
        agent,
        `unknown function: ${parsed.fn}${suggestions.length ? `. Did you mean ${suggestions.join(', ')}?` : '. Run defs() to see what is loaded.'}`,
        trimmed,
      )
      return 'ok'
    }

    try {
      if (def.kind === 'control') this.runControl(agent, def, parsed.args)
      else this.submit(agent, def, parsed)
    } catch (error) {
      this.fail(agent, error instanceof SubmitError ? error.message : `${(error as Error).name}: ${(error as Error).message}`, trimmed)
    }
    return 'ok'
  }

  /** Schedule an async call and acknowledge it immediately. */
  private submit(agent: string, def: FunctionDef, parsed: NonNullable<ReturnType<typeof parseLine>>): void {
    const call: CallRecord = this.ctx.calls.submit(agent, parsed, def)
    this.out.say(agent, renderAck(call))
    this.out.json({
      type: 'ack',
      call: call.id,
      seq: call.seq,
      fn: call.fn,
      agent,
      bind: call.bind,
      deps: call.deps.map((dep) => ({ name: dep.name, from: dep.from, kind: dep.kind })),
      state: call.state,
    })
  }

  /**
   * Run a control function. Control arguments are taken **literally**: an
   * identifier is the id or name it spells (`cancel(c5)`, `inspect(kernel0)`),
   * never the payload behind it, because inspection is about the graph rather
   * than about the data flowing through it.
   */
  private runControl(agent: string, def: FunctionDef, args: RawArg[]): void {
    const positional = def.positional ?? []
    const resolved: Record<string, unknown> = {}
    let slot = 0
    for (const arg of args) {
      const value = literal(arg)
      if (arg.n === 'obj') Object.assign(resolved, value)
      else if (slot < positional.length) resolved[positional[slot++]!] = value
    }
    const result = def.run(resolved, {
      call: 'control',
      agent,
      signal: new AbortController().signal,
      progress: () => {},
      sleep: async () => {},
      runtime: this.ctx.calls.facade,
    }) as ControlResult
    this.out.say(agent, result.text)
    this.out.json({ type: 'control', fn: def.name, agent, text: result.text, rows: result.rows ?? [] })
  }

  /** Report a rejected line without scheduling anything. */
  private fail(agent: string, message: string, line: string): void {
    this.out.say(agent, `✗ ${message}`, 'error')
    this.out.json({ type: 'error', agent, message, line })
  }
}

/** Literal view of a control argument: identifiers stay as their own names. */
function literal(arg: RawArg): unknown {
  switch (arg.n) {
    case 'lit':
      return arg.v
    case 'ref':
      return arg.name
    case 'arr':
      return arg.items.map(literal)
    case 'obj':
      return Object.fromEntries(arg.props.map((prop) => [prop.key, literal(prop.value)]))
  }
}
