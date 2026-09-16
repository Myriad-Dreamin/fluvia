/**
 * The one mapping that lets a dsh session and a fluvia agent be the same actor.
 *
 * fluvia attributes every call to an `@agent`, and it notifies per agent. dsh
 * identifies a conversation by its session id. If the two agree, one fluvia
 * runtime can serve several dsh sessions and each session gets back only the
 * notifications for the calls it made — which is also what makes
 * `inspect(@other)` mean something rather than being a leak.
 *
 * They cannot simply *be* the same string, because fluvia's prefix grammar is
 * narrower than a dsh session id. `src/core/parser.ts` accepts a prefix
 * matching `^@([A-Za-z_][\w-]*)\s`, so an agent id must begin with a letter or
 * underscore — and a dsh session id is often a UUID that begins with a digit
 * (`8c8f0b70-…`). This module owns the translation in both directions, in one
 * place, so the tool that submits and the courier that routes cannot disagree.
 *
 * @module dsh-plugin-fluvia/identity
 */
/**
 * Prefix that turns any dsh session id into a legal fluvia agent id.
 *
 * It is a constant rather than a config key on purpose: both ends of the
 * mapping live in this process, nothing outside reads it, and making it
 * configurable would only create a way for the two ends to be set differently.
 */
export const FLUVIA_AGENT_PREFIX = 'dsh-';
/** Characters fluvia's prefix grammar allows after the first one. */
const ILLEGAL = /[^\w-]/g;
/**
 * The fluvia agent id that stands for one dsh session.
 *
 * The result always satisfies fluvia's prefix grammar: it starts with `d` from
 * the constant prefix, and every other character is forced into `[\w-]`.
 *
 * @param sessionId — a dsh session/agent id.
 * @returns the `@`-less fluvia agent id, e.g. `dsh-8c8f0b70-0656-49f3-…`.
 */
export function fluviaAgentId(sessionId) {
    return sanitizeAgentLabel(`${FLUVIA_AGENT_PREFIX}${sessionId}`);
}
/**
 * Force any string into fluvia's agent grammar.
 *
 * The runtime sanitizes the label it is sent anyway — this is not a security
 * measure, it is so the label this plugin *asks* for is the one it gets back,
 * which keeps logs and routing legible. A label that starts with a digit (a
 * UUID often does) is prefixed rather than rejected.
 *
 * @param value — any requested label.
 * @returns a label matching `^[A-Za-z_][\w-]*$`.
 */
export function sanitizeAgentLabel(value) {
    const cleaned = value.replace(ILLEGAL, '-');
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `a-${cleaned}`;
}
/**
 * Whether a fluvia agent id — as it comes back on an envelope — denotes one
 * particular dsh session.
 *
 * Compares against the mapped form rather than reversing the mapping, because
 * sanitizing is lossy: two session ids could in principle map onto one fluvia
 * agent, and comparing forwards makes that a missed match instead of a
 * misdelivery. An exact match on the raw id is also accepted, so a session
 * whose id already happens to be a legal fluvia agent still routes when
 * something else submitted on its behalf.
 *
 * @param envelopeAgent — `envelope.agent`, the fluvia-side agent id.
 * @param sessionId — the dsh session to test.
 * @returns whether the envelope belongs to that session.
 */
export function matchesSession(envelopeAgent, sessionId) {
    return envelopeAgent === fluviaAgentId(sessionId) || envelopeAgent === sessionId;
}
/**
 * Whether a fluvia agent id was minted by this plugin for a dsh session.
 *
 * The distinction decides what happens to an envelope nobody live owns. A
 * `dsh-`prefixed agent is definitely one dsh session's work, so its envelope
 * waits for that session rather than being handed to whichever session the
 * configured target happens to select — otherwise two sessions sharing a
 * runtime would read each other's results, which is exactly what the
 * attribution exists to prevent. Anything else (fluvia's own default `a0`, or
 * a `planner`/`tuner` from a session someone started by hand) has no owner
 * here and falls back to the configured target.
 *
 * @param envelopeAgent — `envelope.agent`, the fluvia-side agent id.
 * @returns whether the id denotes a dsh session in this harness.
 */
export function isDshOwned(envelopeAgent) {
    return envelopeAgent.startsWith(FLUVIA_AGENT_PREFIX);
}
/**
 * Strip a leading `@agent ` prefix from a submitted line.
 *
 * Mirrors `splitAgentPrefix` in fluvia's own parser, so the tool recognizes
 * exactly what fluvia would and no more. In particular `inspect(@other)` is
 * NOT a prefix — the `@` is inside the argument list — so identity rewriting
 * leaves cross-agent inspection alone.
 *
 * @param line — one submitted line.
 * @returns the line with any leading agent prefix removed, trimmed.
 */
export function stripAgentPrefix(line) {
    const match = /^@([A-Za-z_][\w-]*)\s+([\s\S]*)$/.exec(line.trim());
    return match ? match[2].trim() : line.trim();
}
