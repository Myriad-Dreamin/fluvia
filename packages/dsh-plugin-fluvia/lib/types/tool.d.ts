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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Answer, IsaEntry, WireHub } from './wire.js';
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
export declare function renderDescription(isa: readonly IsaEntry[]): string;
/**
 * Render the `line` parameter's description for one instruction set.
 *
 * @param isa — the published instruction set, used for a concrete example.
 * @returns the parameter description sent to the model.
 */
export declare function renderLineDescription(isa: readonly IsaEntry[]): string;
/** The structured value the tool resolves with. */
export interface FluviaToolValue {
    /** Model-facing text. */
    text: string;
    /** Which kind of answer the runtime gave. */
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
export declare function buildFluviaTool(hub: WireHub, isa: readonly IsaEntry[]): ToolDefinition;
/**
 * Turn one runtime answer into the tool's result.
 *
 * Exported for the verification harness, which asserts on this text because it
 * is the entire curriculum the model gets at runtime.
 *
 * @param answer — the frame the runtime returned for the submitted line.
 * @returns the structured tool value.
 */
export declare function renderAnswer(answer: Answer): FluviaToolValue;
//# sourceMappingURL=tool.d.ts.map