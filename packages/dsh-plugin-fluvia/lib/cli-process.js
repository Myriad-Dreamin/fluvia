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
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
/**
 * How long a submitted line may wait for its answer before the tool gives up.
 *
 * fluvia answers synchronously inside its readline callback, so this is a
 * safety net rather than a budget: it exists so a wedged child surfaces as a
 * tool error instead of a turn that never ends.
 */
const ANSWER_TIMEOUT_MS = 15_000;
/** Pause before the first restart attempt; doubles per consecutive failure. */
const RESTART_BASE_MS = 500;
/** Upper bound on the restart backoff, so a permanently broken CLI stays quiet. */
const RESTART_MAX_MS = 30_000;
/**
 * How long the child must stay up before its restart budget is forgiven.
 *
 * Without this, a CLI that crashes once a day would eventually exhaust a
 * lifetime budget and stop coming back. The budget is meant to catch a crash
 * *loop*, so it resets once the process has proven it can run.
 */
const RESTART_FORGIVE_MS = 60_000;
/** Record types that answer a submission; everything else is out-of-band. */
const ANSWER_TYPES = new Set(['ack', 'control', 'error']);
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
export function defaultCliArgs(config, notifyUrl) {
    return [
        // tsx is loaded as an import hook rather than used as the executable, so
        // the child is the same `node` the harness runs under.
        '--import',
        'tsx',
        'src/cli/bin.ts',
        '--json',
        '--concurrency',
        String(config.concurrency),
        '--preload',
        config.preload,
        '--trace',
        config.trace,
        // The results channel: straight back into this plugin's receiver.
        '--notify',
        `dsh:${notifyUrl}`,
        // Keeps the full notification on the child's own stdout and in its trace,
        // which is what makes a stuck session diagnosable from the outside.
        '--notify',
        'stdout',
    ];
}
/**
 * The fluvia repository root, derived from this file's own location.
 *
 * The plugin lives at `<repo>/packages/dsh-plugin-fluvia/lib/*.js`, so the repo
 * is three levels up. Deriving it means a checkout can move — or be cloned by
 * someone else entirely — without editing a config file, and it means no user's
 * home directory is baked into a published artifact.
 */
export function fluviaRepoRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
/**
 * Owns the child process and the request/answer correlation on its stdout.
 *
 * Correlation is a FIFO queue rather than an id map because fluvia has no
 * request ids — it answers lines in the order it reads them, one answer per
 * line. What makes that safe is filtering: `result` records (notifications
 * delivered through the stdout sink) and `log` records interleave freely with
 * answers, so only the three {@link ANSWER_TYPES} advance the queue.
 */
export class FluviaCli {
    config;
    notifyUrl;
    log;
    maxRestarts;
    child;
    reader;
    /** Submissions awaiting an answer, oldest first. */
    pending = [];
    /** In-flight start, so concurrent tool calls share one spawn. */
    starting;
    /** Set by {@link stop} so an intentional exit is not treated as a crash. */
    stopped = false;
    /** Consecutive failed starts, reset once the child proves stable. */
    restarts = 0;
    /** Pending restart timer, cleared on stop. */
    restartTimer;
    /** When the current child spawned, for the restart-budget reset. */
    startedAt = 0;
    /** The last `ready` record, for diagnostics and the status page. */
    ready;
    /**
     * @param config — resolved CLI configuration.
     * @param notifyUrl — absolute URL of this plugin's receiver, passed to `--notify`.
     * @param log — where lifecycle and failure are reported.
     * @param maxRestarts — consecutive restart attempts before giving up.
     */
    constructor(config, notifyUrl, log, maxRestarts) {
        this.config = config;
        this.notifyUrl = notifyUrl;
        this.log = log;
        this.maxRestarts = maxRestarts;
    }
    /** Whether a child is currently spawned and its stdin is writable. */
    get running() {
        return this.child !== undefined && this.child.exitCode === null && this.child.stdin.writable;
    }
    /** The fluvia session id the running child reported, or `undefined`. */
    get sessionId() {
        return this.ready?.session;
    }
    /** The function names the running child loaded, or `undefined`. */
    get functions() {
        return this.ready?.functions;
    }
    /**
     * Start the child if it is not running.
     *
     * Idempotent and safe to call concurrently: the first caller owns the spawn
     * and the rest await the same promise, so a burst of parallel tool calls
     * cannot produce two fluvia runtimes.
     *
     * @throws {Error} when the CLI is disabled or the child cannot be spawned.
     */
    async ensureStarted() {
        if (!this.config.enabled)
            throw new Error('the managed fluvia CLI is disabled (cli.enabled: false)');
        if (this.stopped)
            throw new Error('the fluvia plugin is unloading');
        if (this.running)
            return;
        this.starting ??= this.start().finally(() => {
            this.starting = undefined;
        });
        await this.starting;
    }
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
    async submit(line, signal) {
        await this.ensureStarted();
        const child = this.child;
        if (!child || !child.stdin.writable)
            throw new Error('the fluvia CLI is not accepting input');
        signal?.throwIfAborted();
        return new Promise((resolvePromise, rejectPromise) => {
            const entry = {
                resolve: (answer) => {
                    cleanup();
                    resolvePromise(answer);
                },
                reject: (error) => {
                    cleanup();
                    rejectPromise(error);
                },
                timer: setTimeout(() => {
                    this.drop(entry);
                    cleanup();
                    rejectPromise(new Error(`the fluvia CLI did not answer within ${ANSWER_TIMEOUT_MS}ms`));
                }, ANSWER_TIMEOUT_MS),
            };
            // A coalescing window is not a reason to keep the harness alive.
            entry.timer.unref?.();
            const onAbort = () => {
                this.drop(entry);
                cleanup();
                rejectPromise(new Error('cancelled before the fluvia CLI answered'));
            };
            const cleanup = () => {
                clearTimeout(entry.timer);
                signal?.removeEventListener('abort', onAbort);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pending.push(entry);
            // Queue the resolver BEFORE writing: fluvia can answer inside the same
            // tick the write lands, and an answer with no resolver is a lost turn.
            child.stdin.write(`${line}\n`, (error) => {
                if (error) {
                    this.drop(entry);
                    cleanup();
                    rejectPromise(new Error(`could not write to the fluvia CLI: ${error.message}`));
                }
            });
        });
    }
    /**
     * Stop the child for good.
     *
     * Closing stdin first lets fluvia run its own shutdown — it drains in-flight
     * calls, flushes its sinks and seals the trace — so a normal unload does not
     * truncate the trace file. SIGKILL is the backstop for a child that ignores
     * the close.
     */
    async stop() {
        this.stopped = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        this.failPending(new Error('the fluvia plugin is unloading'));
        const child = this.child;
        if (!child || child.exitCode !== null)
            return;
        await new Promise((done) => {
            const kill = setTimeout(() => child.kill('SIGKILL'), 3_000);
            kill.unref?.();
            child.once('exit', () => {
                clearTimeout(kill);
                done();
            });
            // `.exit` is fluvia's own "drain and close"; stdin EOF has the same
            // effect and works even if the child is mid-line.
            try {
                child.stdin.end();
            }
            catch {
                child.kill('SIGTERM');
            }
        });
        this.child = undefined;
    }
    /** Spawn one child and resolve once its stdout is wired up. */
    async start() {
        const args = this.config.args.length > 0 ? this.config.args : defaultCliArgs(this.config, this.notifyUrl);
        const command = this.config.command;
        this.log.info(`starting fluvia CLI: ${command} ${args.join(' ')} (cwd ${this.config.cwd})`);
        let child;
        try {
            child = spawn(command, args, {
                cwd: this.config.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                // The child must not inherit a controlling terminal; it is a service.
                env: process.env,
            });
        }
        catch (error) {
            throw new Error(`could not spawn the fluvia CLI: ${error.message}`);
        }
        this.child = child;
        this.startedAt = Date.now();
        this.ready = undefined;
        child.stdout.setEncoding('utf8');
        const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
        this.reader = reader;
        reader.on('line', (line) => this.onLine(line));
        // fluvia writes human-readable failures (a bad `--preload`, a refused
        // notify endpoint) to stderr; surfacing them is the difference between a
        // diagnosable misconfiguration and a silently empty toolbox.
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            const text = chunk.trim();
            if (text)
                this.log.warn(`fluvia CLI stderr: ${text}`);
        });
        child.on('error', (error) => this.log.warn(`fluvia CLI process error: ${error.message}`));
        child.on('exit', (code, signal) => this.onExit(code, signal));
        // Resolve on the `ready` record rather than on spawn: a child that dies on
        // a bad toolbox path would otherwise look started, and the first tool call
        // would fail with a confusing write error instead of the real reason.
        await new Promise((done, fail) => {
            const timer = setTimeout(() => {
                fail(new Error(`the fluvia CLI did not report ready within ${ANSWER_TIMEOUT_MS}ms`));
            }, ANSWER_TIMEOUT_MS);
            timer.unref?.();
            const settle = () => {
                clearTimeout(timer);
                child.off('exit', onEarlyExit);
                this.readyWaiter = undefined;
            };
            const onEarlyExit = (code) => {
                settle();
                fail(new Error(`the fluvia CLI exited with code ${code} before reporting ready`));
            };
            child.once('exit', onEarlyExit);
            this.readyWaiter = () => {
                settle();
                done();
            };
        });
        // Read through the accessors: `this.ready` was assigned `undefined` above
        // and only the awaited `ready` record refills it, which narrowing cannot see.
        this.log.info(`fluvia CLI ready: session ${this.sessionId ?? '?'}, ${this.functions?.length ?? 0} functions`);
    }
    /** Resolver for the `ready` record, set while {@link start} is awaiting it. */
    readyWaiter;
    /**
     * Handle one NDJSON line from the child.
     *
     * Only `ack`, `control` and `error` advance the pending queue. `result`
     * records (notifications arriving through the stdout sink) and `log` records
     * interleave with answers and must be ignored here, or a notification would
     * be handed back as if it were the answer to an unrelated submission.
     */
    onLine(line) {
        const text = line.trim();
        if (!text)
            return;
        let record;
        try {
            record = JSON.parse(text);
        }
        catch {
            // The CLI is in `--json` mode, so a non-JSON line is a banner or a
            // dependency's stray write. Neither is an answer.
            return;
        }
        const type = record['type'];
        if (type === 'ready') {
            this.ready = {
                session: typeof record['session'] === 'string' ? record['session'] : '?',
                functions: Array.isArray(record['functions'])
                    ? record['functions'].filter((f) => typeof f === 'string')
                    : [],
            };
            this.readyWaiter?.();
            return;
        }
        if (typeof type !== 'string' || !ANSWER_TYPES.has(type))
            return;
        const entry = this.pending.shift();
        // An answer with no waiting submission means somebody else wrote to the
        // child's stdin, or a previous submission already timed out. Dropping it is
        // correct; resolving a later submission with it would be a lie.
        if (!entry)
            return;
        entry.resolve(record);
    }
    /** The child exited: fail everything waiting, then decide about restarting. */
    onExit(code, signal) {
        this.reader?.close();
        this.reader = undefined;
        this.child = undefined;
        const uptime = Date.now() - this.startedAt;
        this.failPending(new Error(`the fluvia CLI exited (code ${code}, signal ${signal})`));
        if (this.stopped)
            return;
        this.log.warn(`fluvia CLI exited unexpectedly after ${Math.round(uptime / 1000)}s (code ${code}, signal ${signal})`);
        // A child that ran long enough to be useful gets its budget back; only a
        // crash *loop* should exhaust the retries.
        if (uptime >= RESTART_FORGIVE_MS)
            this.restarts = 0;
        this.scheduleRestart();
    }
    /** Restart with exponential backoff, up to the configured budget. */
    scheduleRestart() {
        if (this.restarts >= this.maxRestarts) {
            this.log.warn(`fluvia CLI will not be restarted: ${this.restarts} consecutive failures reached the limit. Fix the configuration and reload the plugin.`);
            return;
        }
        const delay = Math.min(RESTART_BASE_MS * 2 ** this.restarts, RESTART_MAX_MS);
        this.restarts += 1;
        this.log.info(`restarting the fluvia CLI in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts})`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.stopped)
                return;
            void this.ensureStarted().catch((error) => {
                this.log.warn(`fluvia CLI restart failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, delay);
        this.restartTimer.unref?.();
    }
    /** Reject every waiting submission with one reason. */
    failPending(error) {
        while (this.pending.length > 0)
            this.pending.shift()?.reject(error);
    }
    /** Remove one entry from the queue after it settled on its own. */
    drop(entry) {
        const index = this.pending.indexOf(entry);
        if (index >= 0)
            this.pending.splice(index, 1);
    }
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
export function notifyUrlFor(host, port, path) {
    const reachable = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
    const bracketed = reachable.includes(':') ? `[${reachable}]` : reachable;
    return `http://${bracketed}:${port}${path}`;
}
/** Resolve a possibly-relative path against the CLI's working directory. */
export function resolveAgainstCwd(cwd, value) {
    return isAbsolute(value) ? value : resolve(cwd, value);
}
