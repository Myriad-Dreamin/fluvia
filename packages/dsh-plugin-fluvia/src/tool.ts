/**
 * The `fluvia` tool: the half of the loop that lets the model *call* fluvia.
 *
 * Everything else in this package carries results inward. This carries
 * submissions outward, and it has exactly one job that is easy to get wrong:
 * **return immediately**. A tool that waited for the call to settle would hand
 * the model a synchronous API with extra steps and throw away the only thing
 * fluvia offers. So `execute` resolves on the runtime's acknowledgement — the
 * `ack`, `control` or `error` frame correlated to the submitted line — and the
 * settled result arrives later, on its own, as a notification.
 *
 * The result text is therefore doing teaching work, not just reporting: it
 * names the two handles the call bound, says the call is still running, and
 * tells the model what to do next. A model that reads only tool results should
 * still end up using fluvia correctly.
 *
 * The **description is built from the runtime's published instruction set**,
 * not from a list in this file. The host decides what is loadable; the model is
 * told what the host actually loaded. A hardcoded list here would be a second
 * source of truth that the sandboxed side owns — exactly the wrong way round.
 *
 * @module dsh-plugin-fluvia/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Answer, IsaEntry, WireHub } from './wire.js'

/** Instructions listed in the description before it stops enumerating. */
const ISA_BUDGET = 40

/** One-line reminder appended to every rejected line. */
const SYNTAX_REMINDER =
  'fluvia takes one plain call per line — a function name plus literal, array, object or handle arguments. No nested calls, operators, member access or statements. Run `defs` to see the loaded signatures.'

/**
 * The part of the description that is true regardless of what is loaded.
 *
 * Written for a model that has never seen fluvia and will not read a skill file
 * first. It states the grammar, the handle model, the chaining rule and the
 * recovery rule, because each is a mistake the model would otherwise make on
 * its first call.
 */
const PREAMBLE = [
  'Submit one line to the fluvia async dataflow runtime and get an instant acknowledgement.',
  'Calls NEVER block: the line is scheduled, you get back the call id and its two handles right away, and the result arrives later on its own as a `<fluvia-notify>` message. Do not poll and do not wait — submit the next call instead.',
  '',
  'One call per line, JS call syntax, no computation: `prepareKernel({ size: 4096 })`, `compileKernel(kernel0, { opt: 3 })`. Arguments may be literals, arrays, objects and handle names — nothing else. No nested calls, no operators, no member access.',
  '',
  "Every call binds TWO handles: a value handle named after the instruction's output (`kernel0`) and an error handle (`err0`). Exactly one of the two ever becomes ready; the other becomes void. Success fills the value handle, failure fills the error handle.",
  '',
  'Chain by passing a handle: `compileKernel(kernel0)` waits for `kernel0` so you do not have to. Pass the VALUE handle for the happy path; pass the ERROR handle to submit the recovery branch up front (`recover(err0)`). Exactly one branch runs and the other is skipped for free, so submit the whole pipeline in one burst.',
].join('\n')

/**
 * Render the description for one published instruction set.
 *
 * Exported because the verification harness asserts on it: the guarantee that
 * the model is told the *host's* instruction set, rather than a list this
 * package shipped, is worth a test.
 *
 * @param isa — `welcome.isa`, exactly as the runtime published it.
 * @returns the tool description sent to the model.
 */
export function renderDescription(isa: readonly IsaEntry[]): string {
  const sections = [PREAMBLE]

  const async_ = isa.filter((entry) => entry.kind === 'async')
  const control = isa.filter((entry) => entry.kind === 'control')

  if (async_.length > 0) {
    const listed = async_.slice(0, ISA_BUDGET)
    sections.push(
      '',
      `Instructions loaded by the host (${async_.length}); each binds <out>N and errN:`,
      ...listed.map((entry) => `  ${entry.name}${entry.params} → ${entry.out}N, errN — ${entry.summary}`),
    )
    if (async_.length > listed.length) {
      sections.push(`  …and ${async_.length - listed.length} more; run \`defs\` for the full list.`)
    }
  }

  if (control.length > 0) {
    sections.push(
      '',
      `Control instructions (answer with text, bind no handles): ${control.map((entry) => entry.name).join(', ')}.`,
    )
  }

  sections.push(
    '',
    'The instruction set is fixed by the host that runs the fluvia runtime. You cannot add to it, change it, or reach the implementations behind it — submit lines against what is listed above.',
    'The long form is skills/fluvia/SKILL.md in the fluvia repository.',
  )
  return sections.join('\n')
}

/**
 * Render the `line` parameter's description for one instruction set.
 *
 * @param isa — the published instruction set, used for a concrete example.
 * @returns the parameter description sent to the model.
 */
export function renderLineDescription(isa: readonly IsaEntry[]): string {
  const example = isa.find((entry) => entry.kind === 'async')
  const sample = example ? `${example.name}${example.params}` : 'prepareKernel({ size: 4096 })'
  return [
    'Exactly one fluvia line, with no trailing newline.',
    'Do NOT write an `@agent` prefix: your identity is fixed by the connection and a prefix is refused by the runtime.',
    `Examples: \`${sample}\`, \`list\`, \`cancel(c5)\`, \`defs\`.`,
    'Run `defs` first if you are unsure of an instruction\'s arguments.',
  ].join(' ')
}

/** The structured value the tool resolves with. */
export interface FluviaToolValue {
  /** Model-facing text. */
  text: string
  /** Which kind of answer the runtime gave. */
  kind: 'ack' | 'control' | 'error'
  /** Call id, for an `ack`. */
  call?: string
  /** Value handle, for an `ack`. */
  value_handle?: string
  /** Error handle, for an `ack`. */
  error_handle?: string
  /** Scheduler state, for an `ack`. */
  state?: string
}

/**
 * Build the `fluvia` tool definition.
 *
 * Takes the hub rather than a `Context` so the interesting behaviour — refusal
 * of session-killing lines, answer rendering, the per-session connection — is
 * reachable from a test without a harness.
 *
 * @param hub — the per-session connection pool.
 * @param isa — the instruction set to describe, from a probe connection's welcome.
 * @returns a registry-ready definition for `ctx.tools.register`.
 */
export function buildFluviaTool(hub: WireHub, isa: readonly IsaEntry[]): ToolDefinition {
  return defineTool({
    name: 'fluvia',
    description: renderDescription(isa),
    parameters: {
      line: {
        type: 'string',
        required: true,
        description: renderLineDescription(isa),
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          /** The model-facing rendering; see {@link renderAnswer}. */
          text: { type: 'string', required: true },
          /** `ack`, `control` or `error`, so a consumer can branch without parsing prose. */
          kind: { type: 'string', required: true, enum: ['ack', 'control', 'error'] },
          /** Call id for an `ack`. */
          call: { type: 'string' },
          /** Value handle bound by an `ack`. */
          value_handle: { type: 'string' },
          /** Error handle bound by an `ack`. */
          error_handle: { type: 'string' },
          /** Scheduler state at acknowledgement: `running` or `waiting`. */
          state: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // Submissions are independent lines on one socket, correlated by frame id,
    // so parallel tool calls are safe and are in fact the intended usage — a
    // whole pipeline goes out in one batch.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const raw = typeof args.line === 'string' ? args.line.trim() : ''
      if (!raw) return { text: `Empty line. ${SYNTAX_REMINDER}`, kind: 'error' as const }
      // A multi-line argument would be two frames' worth of work in one frame;
      // the runtime treats a submitted line as one line and would refuse it.
      if (/[\r\n]/.test(raw)) return { text: `Submit one line per call. ${SYNTAX_REMINDER}`, kind: 'error' as const }

      // The tool runs on behalf of a session, and that session IS the identity:
      // a call with no agent has no connection to submit on and no owner to
      // notify. The runtime would refuse it anyway; refusing here says why.
      const agent = exec.agent
      if (!agent) {
        return {
          text: 'Refused: this tool can only be called inside an agent turn, because the fluvia runtime identifies every call by the connection that submitted it.',
          kind: 'error' as const,
        }
      }

      let answer: Answer
      try {
        const connection = await hub.connectionFor(agent.id)
        answer = await connection.submit(raw, exec.signal)
      } catch (error) {
        return {
          text: `The fluvia runtime did not accept the line: ${error instanceof Error ? error.message : String(error)}`,
          kind: 'error' as const,
        }
      }
      return renderAnswer(answer)
    },
  })
}

/**
 * Turn one runtime answer into the tool's result.
 *
 * Exported for the verification harness, which asserts on this text because it
 * is the entire curriculum the model gets at runtime.
 *
 * @param answer — the frame the runtime returned for the submitted line.
 * @returns the structured tool value.
 */
export function renderAnswer(answer: Answer): FluviaToolValue {
  if (answer.t === 'ack') {
    const { call, fn, bind, state, deps } = answer
    // `waiting` is not a problem to report, it is information: it names the
    // handle the call is parked on, which is the model's own earlier call.
    const blocked = [...new Set(deps.map((dep) => dep.name))]
    const status = state === 'waiting' && blocked.length > 0 ? `waiting on ${blocked.join(', ')}` : state
    const next =
      `result arrives as a fluvia notification; do not poll, ` +
      `submit dependent calls now by passing ${bind.value}` +
      ` (or ${bind.error} for the recovery branch)`
    return {
      text: `${call} ${fn} ⇒ ${bind.value}, ${bind.error} [${status}] — ${next}`,
      kind: 'ack',
      call,
      value_handle: bind.value,
      error_handle: bind.error,
      state,
    }
  }

  if (answer.t === 'control') {
    // Control instructions already render for an agent reader — `list` is a
    // table, `help` is the syntax. Re-wording would only lose fidelity.
    return { text: answer.text, kind: 'control' }
  }

  return { text: `Rejected: ${answer.message}\n${SYNTAX_REMINDER}`, kind: 'error' }
}
