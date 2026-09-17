/**
 * The line parser. An agent writes JS **call syntax**, not JavaScript: a callee
 * identifier and arguments built from literals, arrays, objects and handle
 * names. Anything that would compute — operators, nested calls, member access,
 * functions — is rejected with a message that says what to write instead.
 *
 * The restriction is deliberate. The CLI is a scheduling surface, not an
 * interpreter: every value an agent can express is either something it typed or
 * a handle the runtime produced, which is exactly what makes a call's arguments
 * replayable and its dependency edges discoverable by reading the line.
 *
 * @module @fluvia/core/parser
 */

import { parseExpressionAt } from 'acorn'
import type { Expression, Node, Property } from 'acorn'

/** An argument before handle names are resolved to handle ids. */
export type RawArg =
  | { n: 'lit'; v: string | number | boolean | null }
  | { n: 'ref'; name: string }
  | { n: 'arr'; items: RawArg[] }
  | { n: 'obj'; props: { key: string; value: RawArg }[] }

/** A parsed line, before the environment resolves its references. */
export interface ParsedLine {
  /** Function name as written. */
  fn: string
  /** Arguments in source order. */
  args: RawArg[]
  /** `@agent` prefix, when the line carried one. */
  agent?: string
  /** The line as typed, minus the agent prefix. */
  source: string
}

/** A line the parser refused, with the reason an agent can act on. */
export class ParseError extends Error {
  constructor(
    message: string,
    /** 0-based column in the (prefix-stripped) line, when known. */
    readonly column?: number,
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

/**
 * Agent ids are written `@planner`, which is not valid JavaScript, so they are
 * rewritten to string literals before acorn sees them. The rewrite preserves
 * column positions (`@x` becomes `"x"`, both two characters wider than the bare
 * name) so parse errors still point at the right place.
 */
const AGENT_TOKEN = /@([A-Za-z_][\w-]*)/g

/** Rewrite `@name` tokens outside string literals into `"@name"` literals. */
function maskAgents(source: string): string {
  let inString: string | undefined
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += source[++i] ?? ''
      } else if (ch === inString) {
        inString = undefined
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = ch
      out += ch
      continue
    }
    if (ch === '@') {
      AGENT_TOKEN.lastIndex = i
      const match = AGENT_TOKEN.exec(source)
      if (match && match.index === i) {
        // `@planner` -> `"@planner"`: same character count plus the two quotes,
        // which keeps every later column shifted by a constant we can ignore.
        out += `"@${match[1]}"`
        i += match[0].length - 1
        continue
      }
    }
    out += ch
  }
  return out
}

/**
 * Split the optional `@agent` prefix off a line.
 *
 * @returns the agent id (without `@`) and the remaining source.
 */
export function splitAgentPrefix(line: string): { agent?: string; rest: string } {
  const match = /^@([A-Za-z_][\w-]*)\s+(.*)$/s.exec(line.trim())
  if (!match) return { rest: line.trim() }
  return { agent: match[1]!, rest: match[2]!.trim() }
}

/**
 * Parse one input line.
 *
 * @param line — a single line, with or without an `@agent` prefix.
 * @returns the parsed call, or `undefined` for a blank line or a `#` comment.
 * @throws ParseError when the line is not a plain call.
 */
export function parseLine(line: string): ParsedLine | undefined {
  const { agent, rest } = splitAgentPrefix(line)
  if (!rest || rest.startsWith('#')) return undefined

  // A bare identifier is the zero-argument form: `list` means `list()`.
  if (/^[A-Za-z_]\w*$/.test(rest)) {
    return { fn: rest, args: [], agent, source: rest }
  }

  let node: Expression
  try {
    node = parseExpressionAt(maskAgents(rest), 0, { ecmaVersion: 2024 })
  } catch (error) {
    throw new ParseError(`cannot parse as a call: ${(error as Error).message}`)
  }
  if (node.end < maskAgents(rest).trimEnd().length) {
    throw new ParseError('one call per line: trailing input after the call', node.end)
  }
  if (node.type !== 'CallExpression') {
    throw new ParseError(`expected a call like \`fn(args)\`, got ${describeNode(node)}`, node.start)
  }
  if (node.callee.type !== 'Identifier') {
    throw new ParseError('the callee must be a plain function name', node.callee.start)
  }
  if (node.optional) throw new ParseError('optional calls (`fn?.()`) are not supported', node.start)

  const args = node.arguments.map((arg) => toRawArg(arg as Node))
  return { fn: node.callee.name, args, agent, source: rest }
}

/** Convert a validated AST node into a {@link RawArg}. */
function toRawArg(node: Node): RawArg {
  switch (node.type) {
    case 'Literal': {
      const value = (node as any).value
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        return { n: 'lit', v: value }
      }
      throw new ParseError(`unsupported literal: ${describeNode(node)}`, node.start)
    }
    case 'Identifier': {
      const name = (node as any).name as string
      if (name === 'undefined') return { n: 'lit', v: null }
      return { n: 'ref', name }
    }
    case 'UnaryExpression': {
      // Negative numbers are notation, not arithmetic, so `-1` is allowed while
      // `1 - 2` is not: the operand has to be a numeric literal.
      const unary = node as any
      const operand = unary.argument
      if ((unary.operator === '-' || unary.operator === '+') && operand.type === 'Literal' && typeof operand.value === 'number') {
        return { n: 'lit', v: unary.operator === '-' ? -operand.value : operand.value }
      }
      throw new ParseError(`arithmetic is not supported here: \`${unary.operator}\``, node.start)
    }
    case 'ArrayExpression': {
      const items = (node as any).elements.map((element: Node | null) => {
        if (!element) throw new ParseError('array holes are not supported', node.start)
        if (element.type === 'SpreadElement') throw new ParseError('spread is not supported', element.start)
        return toRawArg(element)
      })
      return { n: 'arr', items }
    }
    case 'ObjectExpression': {
      const props = (node as any).properties.map((property: Node) => {
        if (property.type !== 'Property') {
          throw new ParseError('spread in objects is not supported', property.start)
        }
        const prop = property as Property
        if (prop.computed) throw new ParseError('computed keys are not supported', prop.start)
        if (prop.kind !== 'init' || prop.method) throw new ParseError('object methods are not supported', prop.start)
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal' && typeof prop.key.value !== 'object'
              ? String(prop.key.value)
              : undefined
        if (key === undefined) throw new ParseError('unsupported object key', prop.key.start)
        return { key, value: toRawArg(prop.value as Node) }
      })
      return { n: 'obj', props }
    }
    case 'TemplateLiteral': {
      const template = node as any
      if (template.expressions.length) {
        throw new ParseError('template interpolation is not supported; pass a plain string', node.start)
      }
      return { n: 'lit', v: String(template.quasis[0]?.value.cooked ?? '') }
    }
    case 'CallExpression':
      throw new ParseError('nested calls are not supported: submit it on its own line and pass the handle', node.start)
    case 'MemberExpression':
      throw new ParseError('member access is not supported: pass the whole handle', node.start)
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'ConditionalExpression':
      throw new ParseError('the CLI does not evaluate expressions: pass a literal or a handle', node.start)
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      throw new ParseError('functions cannot be passed: the toolbox is preloaded', node.start)
    default:
      throw new ParseError(`unsupported argument: ${describeNode(node)}`, node.start)
  }
}

/** Quote an object key that is not a bare identifier, so the echo re-parses. */
function identifierKey(key: string): string {
  return /^[A-Za-z_]\w*$/.test(key) ? key : JSON.stringify(key)
}

/** Human label for an AST node, used in parse errors. */
function describeNode(node: Node): string {
  return node.type.replace(/Expression$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

/** Render a {@link RawArg} tree back to source, for echoing a call in reports. */
export function formatArg(arg: RawArg | { n: 'ref'; name: string; handle?: string }): string {
  switch (arg.n) {
    case 'lit':
      return typeof arg.v === 'string' ? JSON.stringify(arg.v) : String(arg.v)
    case 'ref':
      return arg.name
    case 'arr':
      return `[${arg.items.map(formatArg).join(', ')}]`
    case 'obj':
      return `{ ${arg.props.map((p) => `${identifierKey(p.key)}: ${formatArg(p.value)}`).join(', ')} }`
  }
}
