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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CliAnswer, FluviaCli } from './cli-process.js';
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
export declare function buildFluviaTool(cli: FluviaCli): ToolDefinition;
/** The structured value the tool resolves with. */
export interface FluviaToolValue {
    /** Model-facing text. */
    text: string;
    /** Which kind of answer fluvia gave. */
    kind: 'ack' | 'control' | 'error';
    /** Call id, for an `ack`. */
    call?: string;
    /** Value handle, for an `ack`. */
    value_handle?: string;
    /** Error handle, for an `ack`. */
    error_handle?: string;
    /** Scheduler state, for an `ack`. */
    state?: string;
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
export declare function renderAnswer(answer: CliAnswer): FluviaToolValue;
//# sourceMappingURL=tool.d.ts.map