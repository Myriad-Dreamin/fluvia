/**
 * The `fluvia` tool: the half of the loop that lets the model *call* fluvia.
 *
 * Everything else in this package carries results inward. This carries
 * submissions outward, and it has exactly one job that is easy to get wrong:
 * **return immediately**. A tool that waited for the call to settle would hand
 * the model a synchronous API with extra steps and throw away the only thing
 * fluvia offers. So `execute` resolves on fluvia's acknowledgement — the `ack`,
 * `control` or `error` record for the submitted line — and the settled result
 * arrives later, on its own, as a notification through this plugin's receiver.
 *
 * The result text is therefore doing teaching work, not just reporting: it
 * names the two handles the call bound, says the call is still running, and
 * tells the model what to do next (submit dependents now, do not poll). A model
 * that reads only tool results should still end up using fluvia correctly.
 *
 * @module dsh-plugin-fluvia/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fluviaAgentId, stripAgentPrefix } from './identity.js';
/**
 * What the model is told the tool is for.
 *
 * Written for a model that has never seen fluvia and will not read a skill
 * file first. It states the grammar, the handle model, the chaining rule and
 * the recovery rule, because each of those is a mistake the model would
 * otherwise make on its first call — and it points at the skill for the rest
 * rather than trying to be the manual.
 */
const DESCRIPTION = [
    'Submit one line to the fluvia async dataflow runtime and get an instant acknowledgement.',
    'Calls NEVER block: the line is scheduled, you get back the call id and its two handles right away, and the result arrives later on its own as a `<fluvia-notify>` message. Do not poll and do not wait — submit the next call instead.',
    '',
    'One call per line, JS call syntax, no computation: `prepareKernel({ size: 4096 })`, `compileKernel(kernel0, { opt: 3 })`. Arguments may be literals, arrays, objects and handle names — nothing else. No nested calls, no operators, no member access.',
    '',
    'Every call binds TWO handles: a value handle named after the function\'s output (`kernel0`) and an error handle (`err0`). Exactly one of the two ever becomes ready; the other becomes void. Success fills the value handle, failure fills the error handle.',
    '',
    'Chain by passing a handle: `compileKernel(kernel0)` waits for `kernel0` so you do not have to. Pass the VALUE handle for the happy path; pass the ERROR handle to submit the recovery branch up front (`recover(err0)`). Exactly one branch runs and the other is skipped for free, so submit the whole pipeline in one burst.',
    '',
    'Control lines take no handles and answer with text: `list` (calls in flight), `vars` (bound handles), `defs` (available functions and signatures), `inspect(c3)` or `inspect(@agent)`, `cancel(c5)`, `help`.',
    '',
    'The long form is skills/fluvia/SKILL.md in the fluvia repository.',
].join('\n');
/** What the model is told about the one parameter. */
const LINE_DESCRIPTION = [
    'Exactly one fluvia line, with no trailing newline and no `@agent` prefix (your dsh session is attached automatically, and results come back only to you).',
    'Examples: `prepareKernel({ size: 4096, dtype: "f32" })`, `compileKernel(kernel0, { opt: 3 })`, `benchmark(kernel1, dataset0, { iters: 200 })`, `recover(err0)`, `list`, `cancel(c5)`, `inspect(@other)`.',
    'Run `defs` first if you do not know which functions are loaded.',
].join(' ');
/** One-line reminder appended to every rejected line. */
const SYNTAX_REMINDER = 'fluvia takes one plain call per line — a function name plus literal, array, object or handle arguments. No nested calls, operators, member access or statements. Run `defs` to see the loaded signatures.';
/**
 * Build the `fluvia` tool definition.
 *
 * Takes the CLI rather than a `Context` so the interesting behaviour — prefix
 * rewriting, answer rendering, refusal of session-killing lines — is reachable
 * from a test with a stub CLI.
 *
 * @param cli — the managed CLI this tool submits to.
 * @returns a registry-ready definition for `ctx.tools.register`.
 */
export function buildFluviaTool(cli) {
    return defineTool({
        name: 'fluvia',
        description: DESCRIPTION,
        parameters: {
            line: {
                type: 'string',
                required: true,
                description: LINE_DESCRIPTION,
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
        // Submissions are independent lines on one pipe; the CLI serializes them
        // itself and answers in order, so parallel tool calls are safe and are in
        // fact the intended usage — a whole pipeline goes out in one batch.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const raw = typeof args.line === 'string' ? args.line.trim() : '';
            if (!raw) {
                return { text: `Empty line. ${SYNTAX_REMINDER}`, kind: 'error' };
            }
            // A multi-line argument would be read by fluvia as several lines, and
            // only the first would be answered — the rest would desynchronize the
            // answer queue for every other session sharing this CLI.
            if (/[\r\n]/.test(raw)) {
                return {
                    text: `Submit one line per call. ${SYNTAX_REMINDER}`,
                    kind: 'error',
                };
            }
            // `.exit` would drain and close the runtime that every other dsh session
            // in this harness is sharing. The model has no business doing that.
            const body = stripAgentPrefix(raw);
            if (body === '.exit' || body === '.quit') {
                return {
                    text: 'Refused: the fluvia runtime is shared by this harness and is not yours to close. Use `cancel(<call>)` to stop one call.',
                    kind: 'error',
                };
            }
            // Identity is assigned here, never taken from the model: the prefix is
            // what routes notifications back to this session, so a model-supplied one
            // would let a turn redirect its own results (or someone else's).
            const agent = exec.agent;
            if (!agent) {
                return {
                    text: 'Refused: this tool can only be called inside an agent turn, because fluvia attributes every call to the calling session.',
                    kind: 'error',
                };
            }
            const line = `@${fluviaAgentId(agent.id)} ${body}`;
            let answer;
            try {
                answer = await cli.submit(line, exec.signal);
            }
            catch (error) {
                return {
                    text: `The fluvia runtime did not accept the line: ${error instanceof Error ? error.message : String(error)}`,
                    kind: 'error',
                };
            }
            return renderAnswer(answer);
        },
    });
}
/**
 * Turn one fluvia answer into the tool's result.
 *
 * Exported for the verification harness, which asserts on this text because it
 * is the entire curriculum the model gets at runtime.
 *
 * @param answer — the record fluvia returned for the submitted line.
 * @returns the structured tool value.
 */
export function renderAnswer(answer) {
    if (answer.type === 'ack') {
        const { call, fn, bind, state, deps } = answer;
        // `waiting` is not a problem to report, it is information: it names the
        // handle the call is parked on, which is the model's own earlier call.
        const blocked = [...new Set(deps.map((dep) => dep.name))];
        const status = state === 'waiting' && blocked.length > 0 ? `waiting on ${blocked.join(', ')}` : state;
        const next = `result arrives as a fluvia notification; do not poll, ` +
            `submit dependent calls now by passing ${bind.value}` +
            ` (or ${bind.error} for the recovery branch)`;
        return {
            text: `${call} ${fn} ⇒ ${bind.value}, ${bind.error} [${status}] — ${next}`,
            kind: 'ack',
            call,
            value_handle: bind.value,
            error_handle: bind.error,
            state,
        };
    }
    if (answer.type === 'control') {
        // Control functions already render for an agent reader — `list` is a table,
        // `help` is the syntax. Re-wording it here would only lose fidelity.
        return { text: answer.text, kind: 'control' };
    }
    return { text: `Rejected: ${answer.message}\n${SYNTAX_REMINDER}`, kind: 'error' };
}
