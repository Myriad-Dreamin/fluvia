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
import { Courier } from './courier.js';
import { startReceiver } from './receiver.js';
export { Courier, buildMessage } from './courier.js';
export { ENVELOPE_VERSION, parseEnvelope, summarizeEnvelope } from './envelope.js';
export { startReceiver } from './receiver.js';
/** Cordis plugin name, used by loader diagnostics and by the logger. */
export const name = 'fluvia';
/**
 * The agent registry this plugin resolves delivery targets against.
 *
 * Declaring it makes the loader hold the plugin in `PENDING` until `agents`
 * exists, so `apply` never has to defend against a half-built context.
 */
export const inject = ['agents'];
/**
 * Schemastery validation for {@link Config}.
 *
 * Declared the way shipped dsh plugins declare theirs, so `dsh --dump-config`
 * renders the defaults and a `--patch` overlay can set any field. The defaults
 * are the whole configuration for the common case: run the plugin, point
 * fluvia at `http://127.0.0.1:7788/inbox`, and nothing else needs saying.
 */
export const Config = z.object({
    host: z.string().default('127.0.0.1').description('Interface to bind the receiver to.'),
    port: z.natural().default(7788).description('TCP port for the receiver.'),
    path: z.string().default('/inbox').description('Request path that accepts envelope POSTs.'),
    mode: z
        .union([z.const('followup'), z.const('inject'), z.const('auto')])
        .default('followup')
        .description('followup wakes the agent; inject waits for the next pre-step; auto picks per agent status.'),
    target: z
        .string()
        .default('newest')
        .description('newest, all, or a literal session id.'),
    queueLimit: z
        .natural()
        .default(200)
        .description('Envelopes held while no agent matches the target.'),
});
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
export function apply(ctx, config) {
    const log = ctx.logger(name);
    // `ctx.agents.list()` returns `Agent[]`; `AgentSource` is the read-only
    // slice of the registry the courier is allowed to use.
    const agents = { list: () => ctx.agents.list() };
    const courier = new Courier({
        agents,
        mode: config.mode,
        target: config.target,
        queueLimit: Math.max(1, config.queueLimit),
        log,
    });
    /**
     * Flush on the next macrotask rather than inside the dispatch that triggered
     * it.
     *
     * `agent/created` is emitted *before* the loop starts, and a synchronous
     * listener failure there vetoes publication — so driving an agent from
     * inside that dispatch would couple this plugin's delivery path to the
     * harness's creation transaction. Deferring costs nothing (the queue is
     * already late by definition) and removes the coupling entirely. The
     * immediate is unref'd so a pending flush can never hold the process open,
     * and `scheduled` collapses a burst of lifecycle events into one drain.
     */
    let scheduled;
    const scheduleFlush = () => {
        if (scheduled)
            return;
        scheduled = setImmediate(() => {
            scheduled = undefined;
            try {
                courier.flush();
            }
            catch (error) {
                // Unreachable by contract — flush() contains its own failures — but a
                // throw on a timer callback is an uncatchable process crash, so this
                // is belt and braces on purpose.
                log.warn(`flush failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        scheduled.unref();
    };
    // An agent appeared: whatever is held is now deliverable.
    ctx.on('agent/created', () => scheduleFlush());
    // Also on session-start, the documented first startup-driving extension
    // point. A resumed session reaches it too, and the flush is idempotent, so
    // listening to both costs one no-op and closes the gap where `agent/created`
    // fires for an agent the target does not yet match.
    ctx.on('agent/session-start', () => scheduleFlush());
    ctx.effect(async () => {
        const receiver = await startReceiver({
            host: config.host,
            port: config.port,
            path: config.path,
            mode: config.mode,
            target: config.target,
            queueLimit: Math.max(1, config.queueLimit),
            courier,
            log,
        });
        log.info(`listening on http://${config.host}:${receiver.port} — POST ${config.path} to deliver, GET / for status (mode=${config.mode}, target=${config.target})`);
        return async () => {
            if (scheduled) {
                clearImmediate(scheduled);
                scheduled = undefined;
            }
            await receiver.close();
            const dropped = courier.discard();
            log.info(`stopped${dropped > 0 ? `, discarded ${dropped} held envelope(s)` : ''}`);
        };
    }, 'fluvia-receiver');
}
