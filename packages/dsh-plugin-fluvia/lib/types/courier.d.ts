/**
 * The courier: everything between "an envelope arrived" and "a dsh agent has
 * it in its inbox".
 *
 * This module holds the whole delivery policy — which agents an envelope is
 * for, what happens when there are none yet, and how the text becomes a
 * message the harness will accept — and it holds it behind plain data
 * dependencies rather than a `Context`. That is deliberate: the interesting
 * behaviour here (queue-then-flush) has to be exercisable without booting a
 * harness, and the types it programs against ({@link TargetAgent},
 * {@link AgentSource}) are derived from the real `Agent` with `Pick`, so a test
 * double cannot drift from the interface the runtime actually passes.
 *
 * The plugin surface in `index.ts` does the wiring; the receiver in
 * `receiver.ts` does the HTTP. Neither of them decides anything.
 *
 * @module dsh-plugin-fluvia/courier
 */
import type { Logger } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { type NotifyEnvelope } from './envelope.js';
/**
 * How an envelope enters an agent's turn.
 *
 * `followup` queues an ordinary follow-up turn **and wakes the driver**, so an
 * idle agent actually reacts to the notification; that is the point of the
 * integration and hence the default. `inject` queues model-facing context for
 * the next pre-step **without** waking, which suits a deployment that wants
 * fluvia's output to ride along with work the human already started instead of
 * starting work of its own.
 *
 * `auto` picks per agent: `followup` when the agent is idle (an unclaimed
 * notice is a completion the model never learns about) and `inject` when it is
 * already running (several envelopes then cost one step instead of one turn
 * each). It is the policy `docs/guide/dsh.md` describes, and the one to
 * reach for when a queued backlog would otherwise become a queue of turns.
 */
export type DeliveryMode = 'followup' | 'inject' | 'auto';
/**
 * The slice of a live dsh `Agent` the courier touches.
 *
 * Declared as a `Pick` of the real interface rather than a hand-written
 * structural type: if `Agent.followup` ever changes shape, this stops
 * compiling instead of failing at runtime inside a harness, and a test double
 * typed as `TargetAgent` is by construction a valid stand-in.
 */
export type TargetAgent = Pick<Agent, 'id' | 'status' | 'followup' | 'inject'>;
/**
 * The slice of `ctx.agents` the courier reads.
 *
 * Only `list()` — the registry's own "all live agents, in registration order".
 * Resolving the target from the live list at delivery time (rather than
 * caching an agent when one is created) means the courier is always right
 * about what is alive, including agents that existed before this plugin
 * loaded.
 */
export interface AgentSource {
    /** All live agents, in registration order; the last entry is the newest. */
    list(): readonly TargetAgent[];
}
/** The logger methods the courier uses; satisfied by `ctx.logger('fluvia')`. */
export type CourierLog = Pick<Logger, 'info' | 'warn'>;
/**
 * Target selector understood by {@link Courier}.
 *
 * This is the *fallback*. An envelope whose `agent` names one of the live dsh
 * sessions always goes to that session first — see {@link Courier.resolveFor}
 * — so a runtime shared by several sessions routes by ownership and only
 * unattributed envelopes (a fluvia session nobody here started, or a CLI-level
 * notice) fall through to this setting.
 */
export type TargetSelector = 
/** The most recently created live agent — what a single-session Web UI means. */
'newest'
/** Every live agent; a broadcast. */
 | 'all'
/** A literal session/agent id, pinning delivery to one known session. */
 | (string & {});
/** Everything {@link Courier} needs; all of it injectable, none of it a `Context`. */
export interface CourierOptions {
    /** The live agent registry to resolve targets against. */
    agents: AgentSource;
    /** Whether delivery wakes the agent ({@link DeliveryMode}). */
    mode: DeliveryMode;
    /** Which live agents an envelope is for ({@link TargetSelector}). */
    target: TargetSelector;
    /** Maximum envelopes held while no agent is live; see {@link Courier.accept}. */
    queueLimit: number;
    /** Where the courier reports what it did. */
    log: CourierLog;
}
/** What {@link Courier.accept} did with one envelope. */
export type AcceptOutcome = 
/** Handed to at least one live agent; `agents` lists the ids reached. */
{
    readonly kind: 'delivered';
    readonly agents: readonly string[];
}
/** No live target yet; held for the next {@link Courier.flush}. `depth` is the queue size after queueing. */
 | {
    readonly kind: 'queued';
    readonly depth: number;
}
/** Live targets existed but every one of them rejected the message. */
 | {
    readonly kind: 'failed';
    readonly error: string;
};
/** A snapshot of what the courier has done, for the status page and for tests. */
export interface CourierStats {
    /** Envelopes accepted off the wire. */
    received: number;
    /** Envelopes that reached at least one agent. */
    delivered: number;
    /** Individual agent deliveries; exceeds `delivered` under `target: all`. */
    deliveries: number;
    /** Envelopes currently held waiting for an agent. */
    queued: number;
    /** Envelopes dropped from the head of a full queue. */
    evicted: number;
    /** Envelopes whose every target threw. */
    failed: number;
    /** Epoch ms of the most recent accepted envelope, or `null`. */
    lastReceivedAt: number | null;
    /** Epoch ms of the most recent successful delivery, or `null`. */
    lastDeliveredAt: number | null;
}
/**
 * Routes envelopes to live agents, holding them when there are none.
 *
 * The queue is the whole reason this class exists. A dsh Web UI creates its
 * session when the human opens one, which is almost always *after* a fluvia
 * run has started posting; without a queue the first — and most interesting —
 * envelopes would be answered with "no agent" and lost. So an envelope that
 * finds no target is held, bounded, and replayed in arrival order the moment
 * an agent appears.
 */
export declare class Courier {
    private readonly options;
    /**
     * Envelopes waiting for a live agent, oldest first.
     *
     * Each remembers the session that owns it when the transport already knew —
     * on the connection transport the notification arrived on that session's own
     * socket, which is a stronger fact than anything the envelope's `agent`
     * string could assert.
     */
    private readonly pending;
    /** Mutable counters exposed through {@link stats}. */
    private readonly counters;
    /**
     * @param options — registry, delivery policy and queue bound; see {@link CourierOptions}.
     */
    constructor(options: CourierOptions);
    /** A copy of the current counters; mutating it does not affect the courier. */
    get stats(): CourierStats;
    /** The ids of every live agent, in registration order. */
    liveAgentIds(): string[];
    /** The ids the current {@link CourierOptions.target} resolves to right now. */
    targetAgentIds(): string[];
    /**
     * Take one envelope: deliver it if an agent is live, otherwise hold it.
     *
     * Never throws. The caller is an HTTP handler whose job is to answer 202
     * quickly, and a delivery problem is this plugin's business to report, not
     * the posting session's business to retry.
     *
     * @param envelope — a validated envelope.
     * @param owner — the dsh session that owns it, when the transport knows.
     *   The connection transport always knows; the HTTP transport never does and
     *   falls back to matching `envelope.agent`.
     * @returns what happened, for the HTTP response body and the log line.
     */
    accept(envelope: NotifyEnvelope, owner?: string): AcceptOutcome;
    /**
     * Replay every held envelope, in arrival order, to whatever is live now.
     *
     * Called when an agent appears. Drains nothing when no agent resolves — a
     * newly created agent need not match a pinned `target` id — so the queue
     * survives until the *right* agent shows up.
     *
     * Never throws: it runs off a lifecycle event, and a throw there would be
     * reported against the harness rather than against this plugin.
     *
     * @returns the number of envelopes delivered out of the queue.
     */
    flush(): number;
    /** Drop everything still held, for a clean plugin unload. Returns what was discarded. */
    discard(): number;
    /**
     * Which live agents one specific envelope is for.
     *
     * Ownership wins over configuration. The `fluvia` tool submits every line
     * prefixed with the calling session's own id, so `envelope.agent` identifies
     * the session that asked for this work — and that session is the only one
     * with any use for the answer. Routing on it is what lets two dsh sessions
     * share one fluvia runtime without reading each other's notifications.
     *
     * An envelope whose owner is not live right now is HELD rather than
     * redirected: it names a dsh session, so handing it to whichever session the
     * configured target picks would show one conversation another's results.
     * Only an envelope with no dsh owner at all — fluvia's own default `a0`, or a
     * session someone started by hand — falls through to the configured
     * {@link TargetSelector}.
     */
    private resolveFor;
    /**
     * Which live agents the configured target selects, ignoring ownership.
     *
     * `newest` takes the last entry of the registry's registration-ordered list,
     * which is the session a human just opened in the Web UI. Note that `newest`
     * and `all` are reserved: an agent whose id is literally one of those words
     * cannot be pinned by id.
     */
    private resolve;
    /**
     * Hand one envelope to each target, counting what got through.
     *
     * Each agent is tried independently: under `target: all` one disposing agent
     * must not cost the others their notification.
     *
     * @returns the ids that accepted the message.
     */
    private deliver;
    /**
     * Hold one envelope, evicting the oldest when the bound is reached.
     *
     * Oldest-first eviction is the right bias for notifications: they describe
     * work that has already settled, so the stalest entry is the least useful,
     * and an agent that finally wakes wants the recent state of the graph rather
     * than its first minute.
     */
    private enqueue;
    /** Enforce {@link CourierOptions.queueLimit}, counting what it costs. */
    private trim;
}
/**
 * Turn an envelope into the user message a dsh agent will accept.
 *
 * The attribution is the load-bearing part. The source is
 * `{ kind: 'plugin', plugin: 'fluvia' }`, never `{ kind: 'user' }`: an omitted
 * or user-shaped source claims host-attested human authority, which
 * permission-sensitive plugins read as a grant. fluvia is a program, so it
 * says so. `form: 'notice'` with a one-line `summary` is the declared shape
 * for "a one-off account of something that just happened", which is exactly
 * what a settled-call batch is, and it lets the Web UI collapse the block to
 * its summary line instead of pasting a wall of text into the transcript.
 *
 * @param envelope — the envelope to deliver.
 * @returns a frozen, identified user message carrying the rendered block.
 */
export declare function buildMessage(envelope: NotifyEnvelope): UserMessage;
//# sourceMappingURL=courier.d.ts.map