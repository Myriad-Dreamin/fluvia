/**
 * The wire contract between fluvia's `fluvia-dsh` notification sink and this
 * plugin: one JSON envelope per HTTP POST.
 *
 * fluvia owns the producing side (`src/plugins/notify-dsh.ts`, which coalesces
 * settled calls into one envelope per agent). This module owns the *reading*
 * side, and it deliberately restates the shape instead of importing it: the
 * two processes are separate deployments that upgrade independently, so the
 * receiver must treat the body as untrusted input from a possibly older — or
 * newer — producer rather than as a value it already typed.
 *
 * That is why {@link parseEnvelope} validates rather than casts. A body that
 * is not an envelope must produce a 400 the operator can read, never a
 * `TypeError` thrown deep inside the delivery path.
 *
 * @module dsh-plugin-fluvia/envelope
 */
/**
 * Envelope schema version this plugin understands.
 *
 * Producers stamp `v: 1`. A future producer that bumps it still sends `text`,
 * which is the only field delivery strictly needs, so an unknown version is
 * accepted with a warning rather than rejected — refusing it would silently
 * drop notifications the moment fluvia gains a field.
 */
export declare const ENVELOPE_VERSION = 1;
/**
 * Largest POST body the receiver will buffer, in bytes.
 *
 * A real envelope is a few kilobytes of rendered text. This bound exists so a
 * misdirected upload — or a hostile client on a LAN-exposed port — cannot make
 * the harness process hold an unbounded string.
 */
export declare const MAX_BODY_BYTES = 1048576;
/** One settled call as the envelope reports it; a projection of fluvia's `Notification`. */
export interface EnvelopeCall {
    /** The settled call's id, e.g. `c9`. */
    call: string;
    /** Its function name, e.g. `compileKernel`. */
    fn: string;
    /** Its terminal state: `done`, `failed`, `skipped` or `cancelled`. */
    outcome: string;
}
/**
 * One coalesced batch of fluvia notifications, as posted by `fluvia-dsh`.
 *
 * `text` is the rendered `<fluvia-notify>` block and is the payload that
 * reaches the model. `calls` is the same information structured, which this
 * plugin uses only to write a one-line summary for the transcript row — it
 * never re-renders the block, because fluvia already decided how an agent
 * should read its own notifications.
 */
export interface NotifyEnvelope {
    /** Schema version stamped by the producer; see {@link ENVELOPE_VERSION}. */
    v: number;
    /** fluvia session id, so one dsh agent can tell two fluvia sessions apart. */
    session: string;
    /** Epoch milliseconds at which fluvia delivered the envelope. */
    at: number;
    /** The fluvia-side agent the batch belongs to; one envelope never mixes agents. */
    agent: string;
    /** Notification ids carried, in render order. */
    ids: string[];
    /** The rendered `<fluvia-notify>` block — the model-facing payload. */
    text: string;
    /** The batch, structured; empty when the producer omitted it. */
    calls: EnvelopeCall[];
}
/**
 * Parse and validate one POST body as a {@link NotifyEnvelope}.
 *
 * Only `text` is genuinely required: it is what gets delivered, and an
 * envelope without it has nothing to say. Every other field is defaulted,
 * because a receiver that rejects an envelope over a missing label would lose
 * a real notification to a cosmetic mismatch.
 *
 * @param body — the raw request body, expected to be JSON.
 * @returns the validated envelope, with defaults filled in.
 * @throws {Error} when the body is not JSON, is not an object, or carries no
 *   usable `text`; the caller turns this into a 400.
 */
export declare function parseEnvelope(body: string): NotifyEnvelope;
/**
 * Summarize an envelope in one line, for the collapsed transcript row and the
 * status page.
 *
 * The reader is glancing at a list, so the line answers "whose work, how much,
 * how did it go" and stops. Outcome order matches fluvia's own rendering
 * (ready, failed, skipped, cancelled) so the summary and the block it
 * summarizes read in the same sequence.
 *
 * @param envelope — the envelope to describe.
 * @returns a single line with no trailing punctuation, e.g.
 *   `fluvia/planner: 3 calls — 2 ready, 1 failed`.
 */
export declare function summarizeEnvelope(envelope: NotifyEnvelope): string;
//# sourceMappingURL=envelope.d.ts.map