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
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { summarizeEnvelope } from './envelope.js';
import { isDshOwned, matchesSession } from './identity.js';
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
export class Courier {
    options;
    /**
     * Envelopes waiting for a live agent, oldest first.
     *
     * Each remembers the session that owns it when the transport already knew —
     * on the connection transport the notification arrived on that session's own
     * socket, which is a stronger fact than anything the envelope's `agent`
     * string could assert.
     */
    pending = [];
    /** Mutable counters exposed through {@link stats}. */
    counters = {
        received: 0,
        delivered: 0,
        deliveries: 0,
        queued: 0,
        evicted: 0,
        failed: 0,
        lastReceivedAt: null,
        lastDeliveredAt: null,
    };
    /**
     * @param options — registry, delivery policy and queue bound; see {@link CourierOptions}.
     */
    constructor(options) {
        this.options = options;
    }
    /** A copy of the current counters; mutating it does not affect the courier. */
    get stats() {
        return { ...this.counters, queued: this.pending.length };
    }
    /** The ids of every live agent, in registration order. */
    liveAgentIds() {
        return this.options.agents.list().map((agent) => agent.id);
    }
    /** The ids the current {@link CourierOptions.target} resolves to right now. */
    targetAgentIds() {
        return this.resolve().map((agent) => agent.id);
    }
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
    accept(envelope, owner) {
        this.counters.received += 1;
        this.counters.lastReceivedAt = Date.now();
        const targets = this.resolveFor(envelope, owner);
        if (targets.length === 0) {
            this.enqueue(envelope, owner);
            this.options.log.info(`queued ${summarizeEnvelope(envelope)} — no live agent for target "${this.options.target}" (${this.pending.length} held)`);
            return { kind: 'queued', depth: this.pending.length };
        }
        const reached = this.deliver(envelope, targets);
        if (reached.length === 0) {
            this.counters.failed += 1;
            // Deliberately not re-queued: the targets are live and refusing, so
            // holding the envelope would only replay the same rejection forever.
            return { kind: 'failed', error: `no target accepted the envelope (${targets.length} tried)` };
        }
        return { kind: 'delivered', agents: reached };
    }
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
    flush() {
        if (this.pending.length === 0)
            return 0;
        // Detach the whole queue before delivering: `followup` wakes a driver, and
        // a driver that somehow posts back into this courier must not mutate the
        // array being iterated.
        const batch = this.pending.splice(0, this.pending.length);
        const reached = new Set();
        const held = [];
        let sent = 0;
        for (const entry of batch) {
            // Per envelope, not once for the batch: a queue can hold work owned by
            // several sessions, and the session that just appeared may own only some
            // of it. What it does not own stays held for the session that does.
            const targets = this.resolveFor(entry.envelope, entry.owner);
            if (targets.length === 0) {
                held.push(entry);
                continue;
            }
            const delivered = this.deliver(entry.envelope, targets);
            if (delivered.length > 0) {
                sent += 1;
                for (const id of delivered)
                    reached.add(id);
            }
            else {
                this.counters.failed += 1;
            }
        }
        if (held.length > 0) {
            // Ahead of anything that arrived while we were delivering, so arrival
            // order survives a partial flush.
            this.pending.unshift(...held);
            this.trim();
        }
        if (sent > 0) {
            this.options.log.info(`flushed ${sent}/${batch.length} held envelope(s) to ${[...reached].join(', ')}`);
        }
        return sent;
    }
    /** Drop everything still held, for a clean plugin unload. Returns what was discarded. */
    discard() {
        const dropped = this.pending.length;
        this.pending.length = 0;
        return dropped;
    }
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
    resolveFor(envelope, owner) {
        const live = this.options.agents.list();
        // An owner supplied by the transport is authoritative: the notification came
        // back on that session's own connection, so no name matching is involved and
        // no fallback is appropriate. If that session is gone, the envelope waits.
        if (owner !== undefined) {
            const exact = live.find((agent) => agent.id === owner);
            return exact ? [exact] : [];
        }
        const matched = live.find((agent) => matchesSession(envelope.agent, agent.id));
        if (matched)
            return [matched];
        return isDshOwned(envelope.agent) ? [] : this.resolve();
    }
    /**
     * Which live agents the configured target selects, ignoring ownership.
     *
     * `newest` takes the last entry of the registry's registration-ordered list,
     * which is the session a human just opened in the Web UI. Note that `newest`
     * and `all` are reserved: an agent whose id is literally one of those words
     * cannot be pinned by id.
     */
    resolve() {
        const live = this.options.agents.list();
        if (this.options.target === 'all')
            return live;
        if (this.options.target === 'newest') {
            const newest = live[live.length - 1];
            return newest ? [newest] : [];
        }
        return live.filter((agent) => agent.id === this.options.target);
    }
    /**
     * Hand one envelope to each target, counting what got through.
     *
     * Each agent is tried independently: under `target: all` one disposing agent
     * must not cost the others their notification.
     *
     * @returns the ids that accepted the message.
     */
    deliver(envelope, targets) {
        const message = buildMessage(envelope);
        const reached = [];
        for (const agent of targets) {
            try {
                // `auto` reads status per agent, not once per envelope: under
                // `target: all` two agents can be in different states.
                const wake = this.options.mode === 'followup' || (this.options.mode === 'auto' && agent.status === 'idle');
                if (wake)
                    agent.followup(message);
                else
                    agent.inject(message);
                reached.push(agent.id);
            }
            catch (error) {
                this.options.log.warn(`${this.options.mode} failed for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (reached.length > 0) {
            this.counters.delivered += 1;
            this.counters.deliveries += reached.length;
            this.counters.lastDeliveredAt = Date.now();
            this.options.log.info(`${this.options.mode} → ${reached.join(', ')} : ${summarizeEnvelope(envelope)}`);
        }
        return reached;
    }
    /**
     * Hold one envelope, evicting the oldest when the bound is reached.
     *
     * Oldest-first eviction is the right bias for notifications: they describe
     * work that has already settled, so the stalest entry is the least useful,
     * and an agent that finally wakes wants the recent state of the graph rather
     * than its first minute.
     */
    enqueue(envelope, owner) {
        this.pending.push(owner === undefined ? { envelope } : { envelope, owner });
        this.trim();
    }
    /** Enforce {@link CourierOptions.queueLimit}, counting what it costs. */
    trim() {
        while (this.pending.length > this.options.queueLimit) {
            this.pending.shift();
            this.counters.evicted += 1;
        }
    }
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
export function buildMessage(envelope) {
    return createUserMessage({
        content: [{ type: 'text', text: envelope.text }],
        source: {
            kind: 'plugin',
            plugin: 'fluvia',
            form: 'notice',
            summary: boundContextSummary(summarizeEnvelope(envelope)),
        },
    });
}
