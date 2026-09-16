/**
 * The status page served at `GET /` on the receiver's own port.
 *
 * The primary surface for a delivered envelope is the dsh Web UI — that is the
 * whole point of the plugin. This page answers a different and much narrower
 * question, the one an operator asks when nothing shows up in the UI: *is the
 * endpoint even bound, and did anything arrive?* So it reports plumbing
 * (counts, target resolution, the configured route) and deliberately does not
 * reproduce envelope text, which would turn a health check into a second,
 * competing transcript.
 *
 * It is a single self-contained string with no external assets: the page must
 * render on a LAN host with no internet, and a plugin has no business adding a
 * CDN dependency to someone else's harness process.
 *
 * @module dsh-plugin-fluvia/status-page
 */
import type { CourierStats, DeliveryMode, TargetSelector } from './courier.js';
/** Everything the page shows; assembled by the receiver on each request. */
export interface StatusView {
    /** Host the receiver is bound to. */
    host: string;
    /** Port the receiver is bound to. */
    port: number;
    /** Path that accepts envelope POSTs. */
    path: string;
    /** Configured delivery mode. */
    mode: DeliveryMode;
    /** Configured target selector. */
    target: TargetSelector;
    /** Maximum envelopes held while no agent is live. */
    queueLimit: number;
    /** Counters from the courier. */
    stats: CourierStats;
    /** Ids of every live agent, in registration order. */
    liveAgents: string[];
    /** Ids the target selector currently resolves to. */
    targetAgents: string[];
    /** Epoch ms at which the receiver bound its port. */
    startedAt: number;
}
/**
 * Render the status view as JSON.
 *
 * Served at `GET <path>` (the same route that accepts POSTs) so the endpoint
 * is checkable by a script as well as by a browser — and so a test can assert
 * on the delivery counters without parsing HTML.
 *
 * @param view — the current view.
 * @returns a JSON document.
 */
export declare function renderStatusJson(view: StatusView): string;
/**
 * Render the status view as a standalone HTML page.
 *
 * @param view — the current view.
 * @returns a complete HTML document.
 */
export declare function renderStatusPage(view: StatusView): string;
//# sourceMappingURL=status-page.d.ts.map