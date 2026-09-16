/**
 * `dsh-plugin-fluvia` — the sandboxed side of a fluvia deployment.
 *
 * fluvia splits into two processes on purpose. The **runtime** (`pnpm serve`)
 * owns the instruction set, the scheduler and the trace, and runs wherever the
 * operator put it. The **model** — and this harness with it — runs inside a
 * sandbox and gets exactly one capability: a socket on which it may submit
 * lines and read back results. This plugin is that socket, plus the two things
 * that make it usable from a dsh agent turn:
 *
 * - a `fluvia` **tool**, whose description is built from the instruction set
 *   the runtime actually published, so the model is told what the host loaded
 *   rather than what this package guessed;
 * - a **courier**, which turns settled calls into `<fluvia-notify>` messages on
 *   the session that submitted them, waking an idle agent so it reacts.
 *
 * What the boundary buys is worth stating plainly, because it is the reason
 * the code is shaped this way: a model that fully owned this process still
 * could not change which implementations are loaded, could not read the trace,
 * could not stop the runtime, and could not name, inspect or cancel another
 * session's handles. All of that is enforced on the far side of the socket. The
 * code here owes the deployment liveness and good ergonomics — not safety.
 *
 * Two transports exist. `connect` (the default) is the sandboxed one described
 * above. `http` keeps the older arrangement in which a fluvia CLI POSTs
 * envelopes to a local endpoint, for deployments that never split the
 * processes; it offers no isolation and is not the recommended shape.
 *
 * @module dsh-plugin-fluvia
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { type DeliveryMode, type TargetSelector } from './courier.js';
export type { AcceptOutcome, AgentSource, CourierLog, CourierOptions, CourierStats, DeliveryMode, TargetAgent, TargetSelector } from './courier.js';
export { Courier, buildMessage } from './courier.js';
export type { EnvelopeCall, NotifyEnvelope } from './envelope.js';
export { ENVELOPE_VERSION, parseEnvelope, summarizeEnvelope } from './envelope.js';
export { FLUVIA_AGENT_PREFIX, fluviaAgentId, isDshOwned, matchesSession, sanitizeAgentLabel, stripAgentPrefix } from './identity.js';
export { EnvelopeCoalescer, buildEnvelope, renderBlock } from './render.js';
export { startReceiver } from './receiver.js';
export type { Receiver, ReceiverOptions } from './receiver.js';
export type { StatusView } from './status-page.js';
export { buildFluviaTool, renderAnswer, renderDescription, renderLineDescription } from './tool.js';
export type { FluviaToolValue } from './tool.js';
export { PROTOCOL_VERSION, WireConnection, WireHub, decodeFrame, encodeFrame, formatAddress, parseAddress, } from './wire.js';
export type { Address, Answer, ClientFrame, IsaEntry, Limits, ServerFrame, WireNotification, WireSession } from './wire.js';
/** Cordis plugin name, used by loader diagnostics and by the logger. */
export declare const name = "fluvia";
/**
 * Services this plugin needs before it loads.
 *
 * `agents` resolves delivery targets; `tools` registers the model-facing
 * `fluvia` tool. Declaring both makes the loader hold the plugin in `PENDING`
 * until they exist, so `apply` never defends against a half-built context.
 */
export declare const inject: string[];
/** Where notifications come from, and therefore what this plugin binds. */
export type Transport = 
/** A socket to a fluvia runtime outside the sandbox. The isolating shape. */
'connect'
/** A local HTTP endpoint a fluvia CLI POSTs envelopes to. No isolation. */
 | 'http';
/** Connection, delivery policy, and the local status endpoint. */
export interface Config {
    /** `connect` talks to a runtime over a socket; `http` receives envelope POSTs. */
    transport: Transport;
    /** Runtime address: `unix:<path>` or `tcp:<host>:<port>`. */
    connect: string;
    /** File holding the shared secret, when the runtime was started with `--token-file`. */
    tokenFile: string;
    /** Label prefix requested for each session's connection; empty derives it from the session id. */
    label: string;
    /** Whether a delivered envelope wakes the agent (`followup`), waits for the next step (`inject`), or picks per agent status (`auto`). */
    mode: DeliveryMode;
    /** Fallback target for an envelope with no identifiable owner: `newest`, `all`, or a session id. */
    target: TargetSelector;
    /** How many envelopes to hold while no agent owns them; the oldest are evicted past this. */
    queueLimit: number;
    /** Interface for the local status endpoint. */
    host: string;
    /** Port for the local status endpoint. */
    port: number;
    /** Status path; also the envelope intake when `transport: 'http'`. */
    path: string;
}
/**
 * Schemastery validation for {@link Config}.
 *
 * Declared the way shipped dsh plugins declare theirs, so `dsh --dump-config`
 * renders the defaults and a `--patch` overlay can set any field.
 *
 * **`preload` and `concurrency` are deliberately absent.** They decide what an
 * instruction *does* and how much of the host it may use, so they belong to
 * `pnpm serve` on the other side of the boundary. Accepting them here would put
 * the instruction set under the control of the process the model runs in, which
 * is the exact thing the split exists to prevent — a model with file access
 * could then point the instruction set at its own code.
 */
export declare const Config: z<Config>;
/**
 * Mount the plugin.
 *
 * Every resource is fiber-owned. `ctx.on` disposes its listeners when the fiber
 * unloads, and the socket pool, the tool registration and the status server are
 * registered through `ctx.effect`, whose async disposer is awaited — so an
 * unload cannot return while a port is still bound or a socket still open.
 *
 * @param ctx — plugin context; must carry `agents` and `tools` (see {@link inject}).
 * @param config — validated {@link Config}.
 * @throws {Error} when the status port cannot be bound, or when the fluvia
 *   runtime cannot be reached under `transport: 'connect'`. Both fail the
 *   plugin load rather than leaving a tool that lies about what it can do.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map