/**
 * The client half of fluvia's boundary protocol, as it runs inside the sandbox.
 *
 * fluvia's deployment model puts the model — and this harness with it — inside
 * a sandbox, and the runtime that actually executes the instruction set
 * outside. This module is everything on the inside: it opens a socket, says
 * hello, submits lines, and reads back acknowledgements and notifications.
 *
 * **None of it is trusted, and none of it needs to be.** The server assigns the
 * agent id (our `label` is a request, not a claim), refuses an `@agent` prefix
 * on a submitted line, scopes handles per agent, routes notifications only to
 * the owning connection, and publishes the instruction set read-only. A model
 * that rewrote this entire file would gain nothing, because every one of those
 * properties is enforced on the far side. What this file owes the deployment is
 * therefore *liveness*, not safety: stay connected, correlate answers
 * correctly, and never lose a notification silently.
 *
 * The frame types are **copied** from `src/server/protocol.ts` rather than
 * imported. The repository root has no build step, so a published plugin
 * cannot reach into it — and duplicating an untrusted client's view of a
 * server-enforced contract costs nothing, because divergence shows up
 * immediately as a refused connection rather than as a silent security hole.
 *
 * @module dsh-plugin-fluvia/wire
 */
import type { CourierLog } from './courier.js';
/** Wire version this client speaks; a server on another major version refuses us. */
export declare const PROTOCOL_VERSION = 1;
/** One instruction of the published instruction set. Mirrors `IsaEntry`. */
export interface IsaEntry {
    /** Callable name. */
    name: string;
    /** `async` binds two handles; `control` answers synchronously. */
    kind: 'async' | 'control';
    /** Base name of the value handle an async call binds. */
    out: string;
    /** Signature hint, e.g. `({ size, dtype })`. */
    params: string;
    /** One-line description. */
    summary: string;
}
/** Server-enforced ceilings, published so a client can pace itself. */
export interface Limits {
    /** Longest line accepted, in bytes. */
    maxLineBytes: number;
    /** Calls one agent may have unsettled at once. */
    maxInFlight: number;
    /** Sustained submissions per second, token-bucket. */
    submitsPerSecond: number;
}
/**
 * One settled call, as the server reports it.
 *
 * Structurally fluvia's `Notification`. Only the fields this plugin renders are
 * declared: a newer server adding fields stays compatible, and a field this
 * plugin never reads is not part of its contract.
 */
export interface WireNotification {
    /** Stable notification id, e.g. `n4`. */
    id: string;
    /** When the call settled, relative to the runtime's session origin. */
    at: number;
    /** The agent the server attributed the call to. */
    agent: string;
    /** The settled call. */
    call: string;
    /** Its function name. */
    fn: string;
    /** Its terminal state. */
    outcome: 'done' | 'failed' | 'cancelled' | 'skipped';
    /** The two variables bound at submission. */
    bind: {
        value: string;
        error: string;
    };
    /** Which variable now carries data, or `null` when both channels are void. */
    ready: {
        name: string;
        kind: 'value' | 'error';
        type?: string;
        summary?: string;
    } | null;
    /** Failure detail when `outcome === 'failed'`. */
    error?: {
        kind?: string;
        message?: string;
        retryable?: boolean;
        detail?: unknown;
    };
    /** Why it never ran, when `outcome === 'skipped'`. */
    skip?: {
        reason: string;
        from: string;
    };
    /** Wall-clock breakdown. */
    timing: {
        waitedMs: number;
        runMs: number;
        totalMs: number;
    };
    /** Calls this settlement unblocked. */
    unblocked: string[];
    /** Per-notification rendered text; the envelope renderer composes its own. */
    text: string;
}
/** Frames this client sends. */
export type ClientFrame = {
    t: 'hello';
    v: number;
    label?: string;
    token?: string;
} | {
    t: 'submit';
    id?: number;
    line: string;
} | {
    t: 'bye';
};
/** Frames the server sends. */
export type ServerFrame = {
    t: 'welcome';
    v: number;
    agent: string;
    session: string;
    concurrency: number;
    isa: IsaEntry[];
    limits: Limits;
} | {
    t: 'ack';
    id?: number;
    call: string;
    fn: string;
    bind: {
        value: string;
        error: string;
    };
    deps: {
        name: string;
        from: string;
        kind: 'value' | 'error';
    }[];
    state: string;
} | {
    t: 'control';
    id?: number;
    fn: string;
    text: string;
    rows: unknown[];
} | {
    t: 'error';
    id?: number;
    message: string;
    line?: string;
} | {
    t: 'result';
    notification: WireNotification;
} | {
    t: 'bye';
    reason: string;
};
/** The server's answer to one submitted line. */
export type Answer = Extract<ServerFrame, {
    t: 'ack';
}> | Extract<ServerFrame, {
    t: 'control';
}> | Extract<ServerFrame, {
    t: 'error';
}>;
/** How a connect address is written in configuration. Mirrors `Address`. */
export type Address = {
    kind: 'unix';
    path: string;
} | {
    kind: 'tcp';
    host: string;
    port: number;
};
/**
 * Parse `unix:/run/fluvia.sock` or `tcp:127.0.0.1:7790`.
 *
 * A bare path is a unix socket, because that is the form that keeps the
 * endpoint inside the filesystem's permission model rather than on a port
 * anything routable can reach.
 *
 * @param spec — the configured address.
 * @returns the parsed address.
 * @throws {Error} when the spec is neither form.
 */
export declare function parseAddress(spec: string): Address;
/** Human rendering of an address, for logs and the status page. */
export declare function formatAddress(address: Address): string;
/** Serialize a frame as one NDJSON line. */
export declare function encodeFrame(frame: ClientFrame): string;
/**
 * Parse one NDJSON line into a server frame.
 *
 * Never throws: this plugin reads a socket, and malformed input on a socket is
 * an expected condition rather than a bug to crash on.
 *
 * @param line — one NDJSON line, without its terminator.
 * @returns the frame, or a reason it was rejected.
 */
export declare function decodeFrame(line: string): {
    frame: ServerFrame;
} | {
    error: string;
};
/** What one session's connection needs in order to open. */
export interface WireOptions {
    /** Where the runtime listens. */
    address: Address;
    /** Requested label; the server sanitizes it and may uniquify it. */
    label: string;
    /** Shared secret, when the server was started with `--token-file`. */
    token?: string;
    /** Called for every settled call belonging to this connection's agent. */
    onNotification(notification: WireNotification): void;
    /** Where connection lifecycle is reported. */
    log: CourierLog;
}
/** What the server told us at handshake; the authoritative view of this connection. */
export interface WireSession {
    /** The agent id the server ASSIGNED. Never the label we asked for, necessarily. */
    agent: string;
    /** The runtime's session id, which is also its trace name. */
    session: string;
    /** Scheduler concurrency, shared by every agent on the runtime. */
    concurrency: number;
    /** The instruction set the host loaded. Read-only. */
    isa: IsaEntry[];
    /** The ceilings in force for this connection. */
    limits: Limits;
}
/**
 * One dsh session's connection to the fluvia runtime.
 *
 * One connection per session, not one per harness: the server derives identity
 * from the connection, scopes handles to it, and delivers notifications only to
 * it. Sharing a connection between two dsh sessions would hand them one
 * identity and therefore each other's results — the very thing the boundary
 * exists to prevent.
 *
 * The connection reconnects on its own. A runtime restart, a socket that went
 * away while the harness idled, a host that had not started yet when the first
 * tool call arrived: all of those are ordinary, and all of them resolve into a
 * fresh `hello` rather than into a dead tool.
 */
export declare class WireConnection {
    private readonly options;
    private socket;
    private buffer;
    private nextId;
    private readonly pending;
    /** In-flight connect, so concurrent submissions share one handshake. */
    private connecting;
    /** The live handshake result, or `undefined` while disconnected. */
    private current;
    /** Set by {@link close} so a deliberate teardown is not retried. */
    private closed;
    /** Consecutive failed connects, for the backoff. */
    private attempts;
    /**
     * @param options — address, identity request, and the notification callback.
     */
    constructor(options: WireOptions);
    /** The handshake result while connected, else `undefined`. */
    get session(): WireSession | undefined;
    /** Whether a socket is open and the handshake has completed. */
    get connected(): boolean;
    /**
     * Connect if necessary and return the handshake result.
     *
     * Idempotent and safe to call concurrently: the first caller owns the
     * handshake and the rest await it, so a burst of parallel tool calls opens
     * one connection rather than one each.
     *
     * @returns the server's `welcome` data.
     * @throws {Error} when the connection cannot be established.
     */
    ensureConnected(): Promise<WireSession>;
    /**
     * Submit one line and resolve with the server's answer to it.
     *
     * Resolves as soon as the line is *accepted* — an `ack` means scheduled, not
     * finished. Results arrive later through `onNotification`. That asymmetry is
     * the entire point of fluvia, so this method must never wait for settlement.
     *
     * The line is sent verbatim. It carries **no** `@agent` prefix: identity is
     * the connection's, assigned by the server, and a prefix is a protocol error.
     *
     * @param line — one complete fluvia line.
     * @param signal — the caller's cancellation.
     * @returns the correlated `ack`, `control` or `error` frame.
     * @throws {Error} when the connection fails, the wait times out, or `signal` aborts.
     */
    submit(line: string, signal?: AbortSignal): Promise<Answer>;
    /** Close politely. The server treats this as "this agent is done", never as a shutdown. */
    close(): void;
    /** Open one socket and complete the handshake. */
    private open;
    /** Wire up a socket that has completed its handshake. */
    private attach;
    /** Split the stream into NDJSON lines. */
    private onData;
    /** Route one frame. */
    private onFrame;
    /** The socket went away: fail what was waiting, then reconnect unless closing. */
    private onDisconnect;
    /** Answer every waiting submission with an error frame rather than hanging. */
    private failPending;
}
/**
 * One connection per dsh session, opened on demand.
 *
 * The hub exists because identity is per-connection on the far side. Each dsh
 * session gets its own socket, its own server-assigned agent id, its own handle
 * namespace and its own notification stream — which is what lets several
 * sessions share one runtime without being able to observe each other.
 */
export declare class WireHub {
    private readonly address;
    private readonly tokenFile;
    private readonly labelFor;
    private readonly onNotification;
    private readonly log;
    private readonly connections;
    private closed;
    /**
     * @param address — where the runtime listens.
     * @param tokenFile — path to the shared secret, when the runtime requires one.
     * @param labelFor — maps a dsh session id to the label to request.
     * @param onNotification — called with the owning session id and the settled call.
     * @param log — where connection lifecycle is reported.
     */
    constructor(address: Address, tokenFile: string | undefined, labelFor: (sessionId: string) => string, onNotification: (sessionId: string, notification: WireNotification) => void, log: CourierLog);
    /** Session ids that currently hold a connection. */
    get sessions(): string[];
    /** The handshake result for one session, if it is connected. */
    sessionOf(sessionId: string): WireSession | undefined;
    /**
     * Get (or open) the connection belonging to one dsh session.
     *
     * @param sessionId — the dsh session id.
     * @returns the connection, already handshaken.
     * @throws {Error} when the runtime cannot be reached.
     */
    connectionFor(sessionId: string): Promise<WireConnection>;
    /** Drop one session's connection, e.g. when its agent is disposed. */
    release(sessionId: string): void;
    /** Close every connection. The runtime keeps running; only our agents leave. */
    close(): void;
    /**
     * Read the shared secret.
     *
     * Read per connection rather than cached at load, so rotating the token file
     * takes effect on the next session without reloading the plugin. The secret
     * is never logged and never leaves this process except as a `hello` field.
     */
    private readToken;
}
//# sourceMappingURL=wire.d.ts.map