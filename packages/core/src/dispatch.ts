/**
 * One line in, one decision out — shared by every entry point.
 *
 * The CLI and the server must agree on exactly what a line means, including
 * what they refuse, because they sit on opposite sides of a trust boundary: the
 * CLI is driven by whoever owns the terminal, while the server accepts
 * connections from agents that must not be able to reach past the instruction
 * set. Two implementations of "what is a legal line" would mean two answers,
 * and the weaker one would be the one that matters.
 *
 * So parsing, callee resolution, identity handling and scheduling live here,
 * and the callers only differ in how they render the result.
 *
 * @module @fluvia/core/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CallRecord, FunctionDef } from './types.ts'
import type { RawArg } from './parser.ts'
import { ParseError, parseLine } from './parser.ts'
import { SubmitError } from './plugins/scheduler.ts'
import type { ControlResult } from './plugins/inspect.ts'

/** What a dispatched line turned into. */
export type Dispatch =
  /** Blank line or a `#` comment: recorded, nothing scheduled. */
  | { kind: 'noop' }
  /** `.exit` — the caller decides what closing means for its surface. */
  | { kind: 'exit' }
  /** An async call was scheduled; the work has not finished. */
  | { kind: 'ack'; call: CallRecord }
  /** A control function answered synchronously. */
  | { kind: 'control'; fn: string; result: ControlResult }
  /** The line was refused. Nothing was scheduled. */
  | { kind: 'error'; message: string }

/** How much a caller is allowed to do with the agent prefix on a line. */
export type PrefixPolicy =
  /** `@agent` selects the submitting agent — the local operator's privilege. */
  | 'honour'
  /** A prefix is a protocol violation: the connection's identity is fixed. */
  | 'reject'

/** Everything dispatch needs that is not the line itself. */
export interface DispatchOptions {
  /** The agent a line is attributed to when it carries no prefix. */
  agent: string
  /** Whether an `@agent` prefix may change that. */
  prefix?: PrefixPolicy
}

/**
 * Parse, validate and act on one line.
 *
 * @returns what happened, in a form the caller can render or serialize.
 */
export function dispatchLine(ctx: Context, line: string, options: DispatchOptions): Dispatch {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'noop' }

  let parsed
  try {
    parsed = parseLine(trimmed)
  } catch (error) {
    return { kind: 'error', message: (error as ParseError).message }
  }
  if (!parsed) return { kind: 'noop' }

  if (parsed.agent !== undefined && options.prefix === 'reject') {
    // Letting a connection pick its own `@agent` would let it read another
    // agent's notifications and name its handles: identity is assigned, never
    // claimed.
    return {
      kind: 'error',
      message: `an @agent prefix is not accepted here; this connection submits as @${options.agent}`,
    }
  }
  const agent = (options.prefix === 'reject' ? undefined : parsed.agent) ?? options.agent

  const def = ctx.functions.get(parsed.fn)
  if (!def) {
    const suggestions = ctx.functions.suggest(parsed.fn)
    return {
      kind: 'error',
      message:
        `unknown function: ${parsed.fn}` +
        (suggestions.length ? `. Did you mean ${suggestions.join(', ')}?` : '. Run defs() to see the instruction set.'),
    }
  }

  ctx.env.agent(agent).lines++
  try {
    if (def.kind === 'control') {
      return { kind: 'control', fn: def.name, result: runControl(ctx, def, parsed.args, agent) }
    }
    return { kind: 'ack', call: ctx.calls.submit(agent, parsed, def) }
  } catch (error) {
    const reason =
      error instanceof SubmitError ? error.message : `${(error as Error).name}: ${(error as Error).message}`
    return { kind: 'error', message: reason }
  }
}

/** True for the one line that means "close this session". */
export function isExitLine(line: string): boolean {
  const body = line.trim().replace(/^@[A-Za-z_][\w-]*\s+/, '')
  return body === '.exit' || body === '.quit'
}

/**
 * Run a control function.
 *
 * Control arguments are taken **literally**: an identifier is the id or name it
 * spells (`cancel(c5)`, `inspect(kernel0)`), never the payload behind it,
 * because inspection is about the graph rather than about the data flowing
 * through it.
 */
function runControl(ctx: Context, def: FunctionDef, args: RawArg[], agent: string): ControlResult {
  const positional = def.positional ?? []
  const resolved: Record<string, unknown> = {}
  let slot = 0
  for (const arg of args) {
    const value = literal(arg)
    if (arg.n === 'obj') Object.assign(resolved, value)
    else if (slot < positional.length) resolved[positional[slot++]!] = value
  }
  return def.run(resolved, {
    call: 'control',
    agent,
    signal: new AbortController().signal,
    progress: () => {},
    sleep: async () => {},
    runtime: ctx.calls.facade,
  }) as ControlResult
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
