/**
 * `dsh-plugin-fluvia` — deliver fluvia notification envelopes into a DeepSeek
 * Harness agent turn.
 *
 * fluvia is a fully-async dataflow CLI: an agent fires calls that settle later,
 * and its `fluvia-dsh` notification handler coalesces each burst of settled
 * calls into one rendered `<fluvia-notify>` block, which it POSTs as a JSON
 * envelope. On its own that is a stream with no reader. This plugin is the
 * reader: it binds an HTTP endpoint inside the harness process and turns each
 * envelope into a user message on a live agent, so the notifications land in
 * the dsh Web UI transcript where the human and the model both see them.
 *
 * The three decisions worth knowing about:
 *
 * 1. **Attribution.** Messages carry `{ kind: 'plugin', plugin: 'fluvia' }`,
 *    never a user source. An omitted or user-shaped source claims host-attested
 *    human authority that permission-sensitive plugins act on; fluvia is a
 *    program and says so.
 * 2. **Queueing.** The Web UI creates its session when the human opens one, so
 *    envelopes normally arrive before any agent exists. Rather than answering
 *    "no agent" and losing the most interesting notifications, the courier
 *    holds them, bounded, and replays them in order when an agent appears.
 * 3. **`followup` by default.** It wakes an idle driver, which is the point:
 *    a notification nobody reads until the human types again is a log file,
 *    not a notification. `inject` is available for deployments that want the
 *    opposite.
 *
 * Layout: this module is wiring and configuration only. `courier.ts` owns the
 * delivery policy, `receiver.ts` the HTTP, `envelope.ts` the wire contract.
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
export { startReceiver } from './receiver.js';
export type { Receiver, ReceiverOptions } from './receiver.js';
export type { StatusView } from './status-page.js';
export { FluviaCli, defaultCliArgs, fluviaRepoRoot, notifyUrlFor } from './cli-process.js';
export type { CliAnswer, CliConfig } from './cli-process.js';
export { FLUVIA_AGENT_PREFIX, fluviaAgentId, isDshOwned, matchesSession, stripAgentPrefix } from './identity.js';
export { buildFluviaTool, renderAnswer } from './tool.js';
export type { FluviaToolValue } from './tool.js';
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
/** Receiver binding, delivery policy, and queue bound. */
export interface Config {
    /** Interface to bind the receiver to. Keep the loopback default unless a fluvia session runs on another host. */
    host: string;
    /** TCP port for the receiver. `0` binds an ephemeral port, which is only useful in tests. */
    port: number;
    /** Request path that accepts envelope POSTs; `GET` on the same path returns status as JSON. */
    path: string;
    /** Whether a delivered envelope wakes the agent (`followup`), waits for the next step (`inject`), or picks per agent status (`auto`). */
    mode: DeliveryMode;
    /** Which live agents receive an envelope: `newest`, `all`, or a literal session id. */
    target: TargetSelector;
    /** How many envelopes to hold while no agent matches the target; the oldest are evicted past this. */
    queueLimit: number;
    /** The managed fluvia CLI the `fluvia` tool submits to. */
    cli: FluviaCliConfig;
}
/**
 * Configuration of the long-lived fluvia CLI child process.
 *
 * Defaults are chosen so that a checkout of the fluvia repository needs no
 * configuration at all: `cwd` is derived from where this plugin is installed,
 * and every other value matches what `pnpm demo` would use.
 */
export interface FluviaCliConfig {
    /** Run the CLI and expose the `fluvia` tool. `false` leaves the plugin receive-only. */
    enabled: boolean;
    /** Working directory for the child. Defaults to the fluvia repo this plugin lives in. */
    cwd: string;
    /** Executable to run. Defaults to the Node binary running the harness. */
    command: string;
    /** Complete argument-vector override. Empty means the default vector, which is the documented one. */
    args: string[];
    /** `--concurrency` for fluvia's scheduler. */
    concurrency: number;
    /** `--preload` module supplying the toolbox. */
    preload: string;
    /** `--trace` destination; relative paths resolve against `cwd`. */
    trace: string;
    /** Consecutive restart attempts after an unexpected exit before giving up. */
    maxRestarts: number;
}
/**
 * Schemastery validation for {@link Config}.
 *
 * Declared the way shipped dsh plugins declare theirs, so `dsh --dump-config`
 * renders the defaults and a `--patch` overlay can set any field. The defaults
 * are the whole configuration for the common case: run the plugin, point
 * fluvia at `http://127.0.0.1:7788/inbox`, and nothing else needs saying.
 */
export declare const Config: z<Config>;
/**
 * Mount the plugin: bind the receiver and wire the queue flush.
 *
 * Both resources are fiber-owned. `ctx.on` disposes its listeners when the
 * fiber unloads, and the receiver is registered through `ctx.effect`, whose
 * async disposer is awaited — so an unload cannot return while the port is
 * still bound, and a reload cannot collide with its own previous listener.
 *
 * @param ctx — plugin context; must carry `agents` (see {@link inject}).
 * @param config — validated {@link Config}.
 * @throws {Error} when the configured address cannot be bound, which fails the
 *   plugin load rather than leaving a silently dead endpoint.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map