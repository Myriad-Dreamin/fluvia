/**
 * Turning settled calls into the `<fluvia-notify>` block a model reads.
 *
 * On the HTTP transport fluvia's own `fluvia-dsh` sink does this work before
 * posting. On the connection transport the server sends one raw `result` frame
 * per settled call, so the coalescing and the rendering have to happen here —
 * and they have to produce *the same* block, or the model's experience would
 * depend on which transport an operator chose.
 *
 * Two jobs, in order:
 *
 * 1. **Coalesce.** A raw sink interrupts an agent once per settled call. That
 *    is fine when one call settles a minute; it wrecks an agent's attention
 *    when eight land in the same second, because under `followup` each one
 *    costs a turn boundary. Notifications arriving inside a short sliding
 *    window are therefore held and delivered as one envelope.
 * 2. **Rank.** Inside an envelope, what is now actionable leads: ready values
 *    first, then failures (which carry a live error handle to recover from),
 *    then skips and cancellations (which carry only dead handles), then the
 *    calls the batch just unblocked.
 *
 * This is a deliberate copy of the rendering in fluvia's
 * `src/plugins/notify-dsh.ts`, for the same reason the frame types are copied:
 * a published plugin cannot import from a repository root that has no build
 * step. The block format is a contract with the model, not with that module.
 *
 * @module dsh-plugin-fluvia/render
 */
import type { NotifyEnvelope } from './envelope.js';
import type { WireNotification } from './wire.js';
/**
 * Buffers one session's settled calls and emits coalesced envelopes.
 *
 * One coalescer per dsh session, because an envelope is delivered into one
 * agent's turn and its `agent` attribute has to be true.
 */
export declare class EnvelopeCoalescer {
    private readonly agent;
    private readonly session;
    private readonly emit;
    private buffer;
    private window;
    private hold;
    private closed;
    /**
     * @param agent — the fluvia agent id the server assigned this connection.
     * @param session — the runtime's session id, stamped on every envelope.
     * @param emit — called with each coalesced envelope.
     */
    constructor(agent: string, session: string, emit: (envelope: NotifyEnvelope) => void);
    /** Number of notifications currently held inside the coalescing window. */
    get buffered(): number;
    /**
     * Take one settled call.
     *
     * Returns immediately; the envelope is emitted when the window closes, when
     * {@link MAX_BATCH} is reached, or at {@link flush}.
     */
    add(notification: WireNotification): void;
    /** Emit whatever is buffered right now, and disarm the timers. */
    flush(): void;
    /** Flush and refuse to buffer further; used when the session goes away. */
    close(): void;
    /**
     * Restart the sliding window, starting the hold timer on the first arrival.
     *
     * Both timers are unref'd: a coalescing window is not a reason to keep the
     * harness process alive, and {@link close} flushes anyway.
     */
    private arm;
    /** Cancel both timers. */
    private disarm;
}
/**
 * Build one envelope from a batch of settled calls.
 *
 * @param batch — notifications for one agent, in any order.
 * @param agent — the fluvia agent id they belong to.
 * @param session — the runtime session id.
 * @returns the envelope, with its rendered `text` and its structured `calls`.
 */
export declare function buildEnvelope(batch: WireNotification[], agent: string, session: string): NotifyEnvelope;
/**
 * Render one agent's `<fluvia-notify>` block.
 *
 * The reader is an agent that fired several calls and then did something else
 * for a second. It needs to know, in this order: what it can now use, what
 * broke and whether retrying is worth it, what silently will not happen, and
 * what the runtime picked up as a consequence.
 *
 * @param sorted — notifications for one agent, oldest first.
 * @param agent — the agent id for the tag attribute.
 * @param session — the session id for the tag attribute.
 * @returns the rendered block.
 */
export declare function renderBlock(sorted: WireNotification[], agent: string, session: string): string;
//# sourceMappingURL=render.d.ts.map