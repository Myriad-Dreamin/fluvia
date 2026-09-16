/**
 * The managed fluvia CLI: one long-lived child process shared by every dsh
 * session in this harness.
 *
 * fluvia's CLI is a REPL whose whole contract is "one line in, one answer out,
 * never a wait". That maps onto a child process with a pipe better than onto
 * anything else: the tool writes a line to stdin and reads the single record
 * fluvia writes back on its NDJSON stdout. The *result* of the call does not
 * come back this way at all — the child posts it to this plugin's own HTTP
 * receiver via `--notify dsh:http://…`, which is the loop that already exists.
 * There is deliberately no second path for results.
 *
 * One process, not one per session, because fluvia's dependency graph is the
 * valuable shared state: two dsh sessions submitting into the same runtime can
 * pass handles to each other and can `inspect(@other)`. Attribution is kept
 * straight by the `@agent` prefix (see `identity.ts`), not by isolation.
 *
 * @module dsh-plugin-fluvia/cli-process
 */
import type { CourierLog } from './courier.js';
/** What the plugin needs to know to run the CLI. */
export interface CliConfig {
    /** Whether the CLI is managed at all; `false` leaves this plugin receive-only. */
    enabled: boolean;
    /** Working directory for the child — the fluvia repo root. */
    cwd: string;
    /** Executable to run; defaults to the harness's own `node`. */
    command: string;
    /** Full argument-vector override. Empty means "build the default vector". */
    args: string[];
    /** `--concurrency` for the CLI's scheduler. */
    concurrency: number;
    /** `--preload` module providing the toolbox. */
    preload: string;
    /** `--trace` destination, relative to {@link cwd} unless absolute. */
    trace: string;
}
/** One answer fluvia gives to one submitted line. */
export type CliAnswer = 
/** The line scheduled a call. */
{
    readonly type: 'ack';
    readonly call: string;
    readonly fn: string;
    readonly agent: string;
    readonly bind: {
        readonly value: string;
        readonly error: string;
    };
    readonly deps: readonly {
        readonly name: string;
        readonly from: string;
        readonly kind: string;
    }[];
    readonly state: string;
}
/** The line ran a control function (`list`, `vars`, `inspect`, `cancel`, …). */
 | {
    readonly type: 'control';
    readonly fn: string;
    readonly agent: string;
    readonly text: string;
}
/** The line was rejected without scheduling anything. */
 | {
    readonly type: 'error';
    readonly agent: string;
    readonly message: string;
    readonly line: string;
};
/**
 * Build the default argument vector for the CLI.
 *
 * Exported because it is the most testable part of the process manager and
 * because `docs/dsh-ui.md` quotes it — a reader who wants to run the same
 * child by hand should be able to see exactly what the plugin runs.
 *
 * @param config — the resolved CLI configuration.
 * @param notifyUrl — absolute URL of this plugin's own receiver.
 * @returns the argument vector, excluding the executable itself.
 */
export declare function defaultCliArgs(config: CliConfig, notifyUrl: string): string[];
/**
 * The fluvia repository root, derived from this file's own location.
 *
 * The plugin lives at `<repo>/packages/dsh-plugin-fluvia/lib/*.js`, so the repo
 * is three levels up. Deriving it means a checkout can move — or be cloned by
 * someone else entirely — without editing a config file, and it means no user's
 * home directory is baked into a published artifact.
 */
export declare function fluviaRepoRoot(): string;
/**
 * Owns the child process and the request/answer correlation on its stdout.
 *
 * Correlation is a FIFO queue rather than an id map because fluvia has no
 * request ids — it answers lines in the order it reads them, one answer per
 * line. What makes that safe is filtering: `result` records (notifications
 * delivered through the stdout sink) and `log` records interleave freely with
 * answers, so only the three {@link ANSWER_TYPES} advance the queue.
 */
export declare class FluviaCli {
    private readonly config;
    private readonly notifyUrl;
    private readonly log;
    private readonly maxRestarts;
    private child;
    private reader;
    /** Submissions awaiting an answer, oldest first. */
    private readonly pending;
    /** In-flight start, so concurrent tool calls share one spawn. */
    private starting;
    /** Set by {@link stop} so an intentional exit is not treated as a crash. */
    private stopped;
    /** Consecutive failed starts, reset once the child proves stable. */
    private restarts;
    /** Pending restart timer, cleared on stop. */
    private restartTimer;
    /** When the current child spawned, for the restart-budget reset. */
    private startedAt;
    /** The last `ready` record, for diagnostics and the status page. */
    private ready;
    /**
     * @param config — resolved CLI configuration.
     * @param notifyUrl — absolute URL of this plugin's receiver, passed to `--notify`.
     * @param log — where lifecycle and failure are reported.
     * @param maxRestarts — consecutive restart attempts before giving up.
     */
    constructor(config: CliConfig, notifyUrl: string, log: CourierLog, maxRestarts: number);
    /** Whether a child is currently spawned and its stdin is writable. */
    get running(): boolean;
    /** The fluvia session id the running child reported, or `undefined`. */
    get sessionId(): string | undefined;
    /** The function names the running child loaded, or `undefined`. */
    get functions(): string[] | undefined;
    /**
     * Start the child if it is not running.
     *
     * Idempotent and safe to call concurrently: the first caller owns the spawn
     * and the rest await the same promise, so a burst of parallel tool calls
     * cannot produce two fluvia runtimes.
     *
     * @throws {Error} when the CLI is disabled or the child cannot be spawned.
     */
    ensureStarted(): Promise<void>;
    /**
     * Submit one line and resolve with fluvia's answer to it.
     *
     * Resolves as soon as fluvia has *accepted* the line — never when the call
     * settles. That is the entire point of the integration: a tool that waited
     * for settlement would reintroduce exactly the blocking fluvia exists to
     * avoid.
     *
     * @param line — a complete fluvia line, already carrying its `@agent` prefix.
     * @param signal — the caller's cancellation; an aborted wait rejects.
     * @returns the `ack`, `control` or `error` record for this line.
     * @throws {Error} when the child is not writable, the wait times out, the
     *   child exits first, or `signal` aborts.
     */
    submit(line: string, signal?: AbortSignal): Promise<CliAnswer>;
    /**
     * Stop the child for good.
     *
     * Closing stdin first lets fluvia run its own shutdown — it drains in-flight
     * calls, flushes its sinks and seals the trace — so a normal unload does not
     * truncate the trace file. SIGKILL is the backstop for a child that ignores
     * the close.
     */
    stop(): Promise<void>;
    /** Spawn one child and resolve once its stdout is wired up. */
    private start;
    /** Resolver for the `ready` record, set while {@link start} is awaiting it. */
    private readyWaiter;
    /**
     * Handle one NDJSON line from the child.
     *
     * Only `ack`, `control` and `error` advance the pending queue. `result`
     * records (notifications arriving through the stdout sink) and `log` records
     * interleave with answers and must be ignored here, or a notification would
     * be handed back as if it were the answer to an unrelated submission.
     */
    private onLine;
    /** The child exited: fail everything waiting, then decide about restarting. */
    private onExit;
    /** Restart with exponential backoff, up to the configured budget. */
    private scheduleRestart;
    /** Reject every waiting submission with one reason. */
    private failPending;
    /** Remove one entry from the queue after it settled on its own. */
    private drop;
}
/**
 * Resolve the address the *child* should post notifications to.
 *
 * The receiver may be bound to a wildcard, which is an address to listen on
 * and not one to connect to; a child told to POST to `0.0.0.0` fails on some
 * stacks and silently reaches the wrong interface on others.
 *
 * @param host — the configured bind host.
 * @param port — the bound port.
 * @param path — the receiver's POST path.
 * @returns an absolute URL the child can reach.
 */
export declare function notifyUrlFor(host: string, port: number, path: string): string;
/** Resolve a possibly-relative path against the CLI's working directory. */
export declare function resolveAgainstCwd(cwd: string, value: string): string;
//# sourceMappingURL=cli-process.d.ts.map