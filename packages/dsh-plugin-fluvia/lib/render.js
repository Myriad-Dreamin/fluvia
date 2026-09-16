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
/** Coalescing window: arrivals inside it are delivered as one envelope. */
const BATCH_MS = 120;
/** Flush early once this many notifications are buffered. */
const MAX_BATCH = 16;
/**
 * The window slides — every arrival restarts it — so a burst becomes one
 * envelope rather than one per straggler. A steadily dripping stream would then
 * be held forever, so the oldest buffered notification is never held longer
 * than `BATCH_MS * HOLD_FACTOR`. `MAX_BATCH` caps the size, this caps the
 * latency; together they bound both axes.
 */
const HOLD_FACTOR = 4;
/** Longest `error.detail` rendering allowed into an envelope, in characters. */
const DETAIL_BUDGET = 120;
/**
 * Buffers one session's settled calls and emits coalesced envelopes.
 *
 * One coalescer per dsh session, because an envelope is delivered into one
 * agent's turn and its `agent` attribute has to be true.
 */
export class EnvelopeCoalescer {
    agent;
    session;
    emit;
    buffer = [];
    window;
    hold;
    closed = false;
    /**
     * @param agent — the fluvia agent id the server assigned this connection.
     * @param session — the runtime's session id, stamped on every envelope.
     * @param emit — called with each coalesced envelope.
     */
    constructor(agent, session, emit) {
        this.agent = agent;
        this.session = session;
        this.emit = emit;
    }
    /** Number of notifications currently held inside the coalescing window. */
    get buffered() {
        return this.buffer.length;
    }
    /**
     * Take one settled call.
     *
     * Returns immediately; the envelope is emitted when the window closes, when
     * {@link MAX_BATCH} is reached, or at {@link flush}.
     */
    add(notification) {
        this.buffer.push(notification);
        if (this.closed || this.buffer.length >= MAX_BATCH)
            this.flush();
        else
            this.arm();
    }
    /** Emit whatever is buffered right now, and disarm the timers. */
    flush() {
        this.disarm();
        if (this.buffer.length === 0)
            return;
        const batch = this.buffer;
        this.buffer = [];
        this.emit(buildEnvelope(batch, this.agent, this.session));
    }
    /** Flush and refuse to buffer further; used when the session goes away. */
    close() {
        this.closed = true;
        this.flush();
    }
    /**
     * Restart the sliding window, starting the hold timer on the first arrival.
     *
     * Both timers are unref'd: a coalescing window is not a reason to keep the
     * harness process alive, and {@link close} flushes anyway.
     */
    arm() {
        if (this.window)
            clearTimeout(this.window);
        this.window = setTimeout(() => this.flush(), BATCH_MS);
        this.window.unref?.();
        if (!this.hold) {
            this.hold = setTimeout(() => this.flush(), BATCH_MS * HOLD_FACTOR);
            this.hold.unref?.();
        }
    }
    /** Cancel both timers. */
    disarm() {
        if (this.window)
            clearTimeout(this.window);
        if (this.hold)
            clearTimeout(this.hold);
        this.window = undefined;
        this.hold = undefined;
    }
}
/**
 * Build one envelope from a batch of settled calls.
 *
 * @param batch — notifications for one agent, in any order.
 * @param agent — the fluvia agent id they belong to.
 * @param session — the runtime session id.
 * @returns the envelope, with its rendered `text` and its structured `calls`.
 */
export function buildEnvelope(batch, agent, session) {
    const sorted = [...batch].sort((a, b) => a.at - b.at);
    return {
        v: 1,
        session,
        at: Date.now(),
        agent,
        ids: sorted.map((n) => n.id),
        text: renderBlock(sorted, agent, session),
        calls: sorted.map((n) => ({ call: n.call, fn: n.fn, outcome: n.outcome })),
    };
}
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
export function renderBlock(sorted, agent, session) {
    const out = [`<fluvia-notify agent="${attr(agent)}" session="${attr(session)}">`, headline(sorted)];
    const done = sorted.filter((n) => n.outcome === 'done');
    if (done.length) {
        out.push('', 'ready');
        for (const n of done)
            out.push(`  ${renderDone(n)}`);
    }
    const failed = sorted.filter((n) => n.outcome === 'failed');
    if (failed.length) {
        out.push('', 'failed');
        for (const n of failed)
            out.push(...renderFailed(n));
        // Said once per envelope rather than per call: the recovery move is always
        // the same, and repeating it would bury the failures themselves.
        out.push('  → recover by passing a ready err handle to another call; work waiting on the value handle is already skipped.');
    }
    const skipped = sorted.filter((n) => n.outcome === 'skipped');
    if (skipped.length) {
        out.push('', 'skipped (never ran)');
        for (const n of skipped)
            out.push(`  ${renderSkipped(n)}`);
    }
    const cancelled = sorted.filter((n) => n.outcome === 'cancelled');
    if (cancelled.length) {
        out.push('', 'cancelled');
        for (const n of cancelled)
            out.push(`  ${renderCancelled(n)}`);
    }
    out.push('', ...renderRunnable(sorted));
    out.push('</fluvia-notify>');
    return out.join('\n');
}
/** The one-line summary that opens a block: how many, over how long, in what mix. */
function headline(sorted) {
    // Fixed order, matching the sections below, so the headline and the body read
    // in the same sequence however the settlements happened to arrive.
    const order = [
        ['done', 'ready'],
        ['failed', 'failed'],
        ['skipped', 'skipped'],
        ['cancelled', 'cancelled'],
    ];
    const mix = order
        .map(([outcome, label]) => [sorted.filter((n) => n.outcome === outcome).length, label])
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`)
        .join(', ');
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = sorted.length > 1 && first && last ? last.at - first.at : 0;
    const window = span >= 1 ? ` within ${ms(span)}` : '';
    return `${sorted.length} call${sorted.length === 1 ? '' : 's'} settled${window} — ${mix}.`;
}
/** `c2 compileKernel → bin2 : Binary 4.1 MB (wait 12ms, run 840ms)` */
function renderDone(n) {
    const name = n.ready?.name ?? n.bind.value;
    const what = [n.ready?.type, n.ready?.summary].filter(Boolean).join(' ') || 'ok';
    return `${n.call} ${n.fn} → ${name} : ${what} ${timing(n)}`;
}
/** The failure head line plus, when the toolbox attached one, a trimmed detail line. */
function renderFailed(n) {
    const name = n.ready?.name ?? n.bind.error;
    const kind = n.error?.kind ?? 'Error';
    const message = n.error?.message ?? 'failed';
    const retry = n.error?.retryable === true ? ' [retryable]' : n.error?.retryable === false ? ' [not retryable]' : '';
    const lines = [`  ${n.call} ${n.fn} → ${name} : ${kind} — ${message}${retry} ${timing(n)}`];
    const detail = digest(n.error?.detail);
    if (detail)
        lines.push(`      detail: ${detail}`);
    return lines;
}
/** `c5 report — skipped: upstream_failed from c3; bin5 and err5 are both void.` */
function renderSkipped(n) {
    const reason = n.skip ? `${n.skip.reason} from ${n.skip.from}` : 'upstream did not produce the channel it consumes';
    return `${n.call} ${n.fn} — ${reason}; ${n.bind.value} and ${n.bind.error} are both void.`;
}
/** Cancellations carry no reason, so state only what is true. */
function renderCancelled(n) {
    return `${n.call} ${n.fn} — cancelled after ${ms(n.timing.totalMs)}; ${n.bind.value} and ${n.bind.error} are both void.`;
}
/**
 * Close the block with the scheduler's reaction, grouped by the call that
 * caused it, so the agent can tell which of its settlements moved the graph.
 */
function renderRunnable(sorted) {
    // A call that settled inside this very batch is not "now runnable" — it is
    // already reported above, and listing it twice would read as pending work.
    const settled = new Set(sorted.map((n) => n.call));
    const lines = ['now runnable'];
    let any = false;
    for (const n of sorted) {
        const moved = n.unblocked.filter((call) => !settled.has(call));
        if (!moved.length)
            continue;
        any = true;
        lines.push(`  ${n.call} unblocked ${moved.join(', ')}`);
    }
    if (!any)
        lines.push('  nothing else was waiting on these handles.');
    return lines;
}
/** `(wait 12ms, run 840ms)`, the split that tells queueing apart from real work. */
function timing(n) {
    return `(wait ${ms(n.timing.waitedMs)}, run ${ms(n.timing.runMs)})`;
}
/** Durations at agent-readable precision: milliseconds below a second, then seconds. */
function ms(value) {
    if (!Number.isFinite(value))
        return '?';
    if (value < 1000)
        return `${Math.round(value)}ms`;
    const seconds = value / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}
/** One-line, budgeted rendering of an arbitrary `error.detail`. */
function digest(detail) {
    if (detail === undefined || detail === null)
        return undefined;
    let text;
    try {
        text = typeof detail === 'string' ? detail : (JSON.stringify(detail) ?? String(detail));
    }
    catch {
        return undefined;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text)
        return undefined;
    return text.length > DETAIL_BUDGET ? `${text.slice(0, DETAIL_BUDGET - 1)}…` : text;
}
/** Escape a value for an XML-ish attribute of the envelope tag. */
function attr(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
