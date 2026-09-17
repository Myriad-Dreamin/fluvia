/**
 * The fluvia contract: every module in this repository — the scheduler, the
 * CLI, the notification sinks, the demo driver and the perf renderer — agrees
 * on the shapes declared here and nowhere else.
 *
 * Fluvia is a fully asynchronous dataflow runtime driven from a CLI. An agent
 * writes one JS-syntax call per line; the CLI parses it, binds two variables to
 * the call's two channels (value and error) and returns immediately. Work runs
 * in the background, results arrive as notifications, and later lines may refer
 * to earlier handles by name to build a dependency graph without ever blocking.
 *
 * @module @fluvia/core/types
 */

/** Milliseconds relative to a trace's {@link TraceMeta.origin}. */
export type RelMillis = number

/** Lifecycle of a single call. Terminal states are everything but the first two. */
export type CallState =
  /** Submitted; one or more dependencies have not settled yet. */
  | 'waiting'
  /** Dependencies are ready but the concurrency slot is not (queued). */
  | 'queued'
  /** The implementation is executing. */
  | 'running'
  /** Settled with a value; the value handle is ready and the error handle is void. */
  | 'done'
  /** Settled with an error; the error handle is ready and the value handle is void. */
  | 'failed'
  /** Aborted through `cancel(id)`, or cascaded from a cancelled dependency. */
  | 'cancelled'
  /** Never ran: a dependency settled on the channel this call does not consume. */
  | 'skipped'

/** Terminal call states, i.e. the states that produce a notification. */
export type CallOutcome = Extract<CallState, 'done' | 'failed' | 'cancelled' | 'skipped'>

/** Why a call was skipped without ever running. */
export type SkipReason =
  /** A value handle it consumes belongs to a call that failed. */
  | 'upstream_failed'
  /** An error handle it consumes belongs to a call that succeeded, so no error exists. */
  | 'upstream_ok'
  /** A handle it consumes belongs to a call that was cancelled. */
  | 'upstream_cancelled'
  /** A handle it consumes belongs to a call that was itself skipped. */
  | 'upstream_skipped'

/** The two channels every call publishes. Exactly one of them ever becomes ready. */
export type ChannelKind = 'value' | 'error'

/** A handle is a named, single-assignment cell an agent passes to later calls. */
export interface HandleRecord {
  /** Stable handle id, e.g. `h7`. */
  id: string
  /** Variable name bound in the agent's environment, e.g. `kernel0` or `err0`. */
  name: string
  /** Which channel of {@link HandleRecord.call} this handle carries. */
  kind: ChannelKind
  /** The call that produces it. */
  call: string
  /** The agent whose namespace it is bound in; see `HandleScope`. */
  owner: string
  /** `pending` until the producing call settles, then `ready` (carries data) or `void` (never will). */
  state: 'pending' | 'ready' | 'void'
  /** Short type label for display, e.g. `Kernel`. */
  type?: string
  /** One-line human summary of the payload. */
  summary?: string
}

/** A dependency edge discovered while parsing a call's arguments. */
export interface DepRef {
  /** The handle referenced. */
  handle: string
  /** The variable name as written by the agent. */
  name: string
  /** The referenced handle's channel; decides skip semantics. */
  kind: ChannelKind
  /** The call that produces the referenced handle. */
  from: string
}

/** Everything the runtime knows about one call. Also the unit of analysis. */
export interface CallRecord {
  /** Stable call id, e.g. `c3`. This is what `cancel()` and `inspect()` take. */
  id: string
  /** Submission order, 0-based; also the suffix of the bound variable names. */
  seq: number
  /** The agent that submitted it. */
  agent: string
  /** Registered function name. */
  fn: string
  /** Argument tree with handle references left symbolic (see {@link ArgNode}). */
  args: ArgNode[]
  /** Dependency edges, in argument order. */
  deps: DepRef[]
  /** Variable names bound at submission: the value channel and the error channel. */
  bind: { value: string; error: string }
  /** Handle ids for the two channels. */
  handles: { value: string; error: string }
  /** Current state. */
  state: CallState
  /** Epoch-relative timings; `undefined` while not yet reached. */
  at: { submit: RelMillis; start?: RelMillis; settle?: RelMillis }
  /** Payload once `state === 'done'`. */
  value?: unknown
  /** Failure detail once `state === 'failed'`. */
  error?: CallError
  /** Present once `state === 'skipped'`. */
  skip?: { reason: SkipReason; from: string }
  /** Present once `state === 'cancelled'`. */
  cancel?: { by: string; reason: string }
  /** Progress notes emitted by the implementation while running. */
  progress: { at: RelMillis; note: string; pct?: number }[]
}

/** A failure, flattened for the trace and for the LLM-facing notification. */
export interface CallError {
  /** Short machine-ish class, e.g. `KernelCompileError`. */
  kind: string
  /** Human message. */
  message: string
  /** Optional structured detail the toolbox attached via {@link FluviaError.detail}. */
  detail?: unknown
  /** Whether a retry could plausibly succeed; surfaced in notifications. */
  retryable?: boolean
}

/**
 * Argument tree produced by the parser. Handle references stay symbolic so the
 * trace records what the agent wrote, not only what it resolved to.
 */
export type ArgNode =
  | { n: 'lit'; v: string | number | boolean | null }
  | { n: 'ref'; name: string; handle: string }
  | { n: 'arr'; items: ArgNode[] }
  | { n: 'obj'; props: { key: string; value: ArgNode }[] }

/** A preloaded implementation the CLI exposes to agents. */
export interface FunctionDef {
  /** Callable name, exactly as the agent types it. */
  name: string
  /**
   * Base name of the value-channel variable. `out: 'kernel'` on call seq 0
   * binds `kernel0` (value) and `err0` (error).
   */
  out: string
  /**
   * `async` functions are scheduled and notified; `control` functions are
   * inspection commands that answer synchronously and bind nothing.
   */
  kind?: 'async' | 'control'
  /** One-line description for `help()`. */
  summary: string
  /** Signature hint for `help()`, e.g. `({ size, dtype })`. */
  params?: string
  /** Positional parameter names, used to bind positional arguments. */
  positional?: string[]
  /** Implementation. Receives resolved arguments and a per-call context. */
  run(args: any, cx: CallContext): unknown | Promise<unknown>
}

/** Per-call services handed to a running implementation. */
export interface CallContext {
  /** The running call's id. */
  call: string
  /** The submitting agent's id. */
  agent: string
  /** Aborted by `cancel(id)` and on shutdown. */
  signal: AbortSignal
  /** Report a progress note; recorded in the trace and shown by `inspect()`. */
  progress(note: string, pct?: number): void
  /** Abortable sleep; rejects with a cancellation error when the signal fires. */
  sleep(ms: number): Promise<void>
  /** Resolve a handle argument that the implementation wants to inspect further. */
  runtime: RuntimeFacade
  /**
   * Start a supervised child process on behalf of this call. Resolves once the
   * child has spawned, not when it exits: the call may settle with the returned
   * {@link ProcessInfo} while the child keeps running. When the child exits the
   * runtime publishes a `processExited` notification to the same agent.
   */
  spawn(request: SpawnRequest): Promise<ProcessInfo>
}

/** What an implementation asks the process supervisor to run. */
export interface SpawnRequest {
  /** Executable, resolved through `PATH`. Never run through a shell by the supervisor. */
  command: string
  /** Arguments, passed verbatim. */
  args?: string[]
  /** Working directory; defaults to the runtime's. */
  cwd?: string
}

/**
 * A supervised child process, as the handle a call returns. The two log paths
 * exist from the moment the process spawns and grow while it runs, so later
 * calls can read them before it exits.
 */
export interface ProcessInfo extends TaggedValue {
  $type: 'Process'
  $summary: string
  /** Supervisor-assigned id, e.g. `p0`. */
  id: string
  /** OS process id. */
  pid: number
  /** The call that spawned it. */
  call: string
  /** `command args…`, for display. */
  command: string
  /** File the child's stdout is written to. */
  stdout: string
  /** File the child's stderr is written to. */
  stderr: string
}

/** How a supervised process ended. */
export interface ProcessExit {
  /** Supervisor id, matching {@link ProcessInfo.id}. */
  id: string
  pid: number
  command: string
  /** Exit code, or `null` when a signal ended it. */
  code: number | null
  /** Terminating signal, or `null` for a normal exit. */
  signal: string | null
  /** File the child's stdout was written to. */
  stdout: string
  /** File the child's stderr was written to. */
  stderr: string
  /** Bytes written to each log. */
  bytes: { stdout: number; stderr: number }
  /** Spawn-to-exit wall time. */
  runMs: number
}

/** The slice of the runtime an implementation or a sink may read. */
export interface RuntimeFacade {
  /** Snapshot of a call, or `undefined` if the id is unknown. */
  call(id: string): CallRecord | undefined
  /** Snapshot of every call, in submission order. */
  calls(): CallRecord[]
  /** Snapshot of every agent seen this session. */
  agents(): AgentRecord[]
}

/** An agent is a caller identity: one CLI session, or one lane within one. */
export interface AgentRecord {
  /** Agent id as written in the `@agent` line prefix, e.g. `planner`. */
  id: string
  /** When the runtime first saw it. */
  joinedAt: RelMillis
  /** Lines the agent submitted. */
  lines: number
  /** Call ids the agent submitted, in order. */
  calls: string[]
}

/**
 * A completion notice. One is produced per terminal call and handed to every
 * registered {@link NotificationSink}; `fluvia-dsh` is the sink that speaks
 * DeepSeek Harness's notification dialect.
 */
export interface Notification {
  /** Stable notification id, e.g. `n4`. */
  id: string
  /**
   * What happened. `callSettled` is the original notice; `processExited` is
   * pushed when a child spawned by {@link Notification.call} exits, long after
   * that call settled. A process notice still fills the call-shaped fields —
   * `outcome` is `done` for exit code 0 and `failed` otherwise — so a consumer
   * that only knows `callSettled` degrades to a readable line.
   */
  event: 'callSettled' | 'processExited'
  /** Exit detail, present exactly when `event === 'processExited'`. */
  process?: ProcessExit
  /** When the call settled. */
  at: RelMillis
  /** The agent to notify — the one that submitted the call. */
  agent: string
  /** The settled call. */
  call: string
  /** Its function name. */
  fn: string
  /** Its terminal state. */
  outcome: CallOutcome
  /** The variables bound at submission, so the agent can refer back to them. */
  bind: { value: string; error: string }
  /** Which of the two variables now carries data, and what it looks like. */
  ready: { name: string; kind: ChannelKind; type?: string; summary?: string } | null
  /** Failure detail when `outcome === 'failed'`. */
  error?: CallError
  /** Why it never ran, when `outcome === 'skipped'`. */
  skip?: { reason: SkipReason; from: string }
  /** Wall-clock breakdown. */
  timing: { waitedMs: number; runMs: number; totalMs: number }
  /** Calls unblocked by this settlement, so the agent can predict what follows. */
  unblocked: string[]
  /** Rendered, LLM-facing text. Sinks may use it verbatim. */
  text: string
}

/** A delivery target for {@link Notification}s. */
export interface NotificationSink {
  /** Sink name as it appears in `--notify` and in the trace. */
  name: string
  /**
   * Deliver a batch. Sinks that coalesce receive more than one notification
   * per call; sinks that do not receive batches of one.
   */
  deliver(batch: Notification[]): void | Promise<void>
  /**
   * Set by sinks that buffer: for them `deliver()` returning means "accepted",
   * not "delivered", so the hub stops timing it and waits for the sink to
   * report real deliveries through `NotifyHub.recordDelivery`.
   */
  coalescing?: boolean
  /** Flush and release resources at shutdown. */
  close?(): void | Promise<void>
}

/* ------------------------------------------------------------------ trace */

/** Header written as the first line of every trace. */
export interface TraceMeta {
  /** Schema version of the event stream. */
  v: 1
  /** Session id, e.g. `s-20260915-174233`. */
  session: string
  /** Epoch ms at `t = 0`; every event's `t` is relative to this. */
  origin: number
  /** Runtime identification for the perf report header. */
  runtime: { node: string; platform: string; fluvia: string }
  /** Scheduler concurrency limit in force. */
  concurrency: number
  /** Toolbox modules preloaded by the CLI. */
  preload: string[]
  /** Notification sink specs in force. */
  sinks: string[]
}

/** Fields present on every trace event. */
export interface TraceEventBase {
  /** Monotonic event number, 0-based. */
  seq: number
  /** Milliseconds since {@link TraceMeta.origin}. */
  t: RelMillis
}

/**
 * The event stream. One JSON object per line, gzip-compressed on disk
 * (`out/<session>.jsonl.gz`), discriminated by `k`.
 */
export type TraceEvent = TraceEventBase &
  (
    | { k: 'session.start'; meta: TraceMeta }
    | { k: 'agent.join'; agent: string }
    | { k: 'agent.input'; agent: string; line: string }
    | { k: 'cli.output'; agent: string; level: 'info' | 'error' | 'notify'; text: string }
    | {
        k: 'call.submit'
        agent: string
        call: string
        fn: string
        args: ArgNode[]
        deps: DepRef[]
        bind: { value: string; error: string }
        handles: { value: string; error: string }
      }
    /**
     * Dependencies are satisfied and the call is waiting for a concurrency
     * slot. Splitting this out of `call.start` is what lets a report separate
     * time lost to the dataflow from time lost to scheduler pressure.
     */
    | { k: 'call.queued'; call: string; blockedMs: number }
    | { k: 'call.start'; call: string; waitedMs: number }
    | { k: 'call.progress'; call: string; note: string; pct?: number }
    | {
        k: 'call.settle'
        call: string
        outcome: CallOutcome
        runMs: number
        totalMs: number
        value?: { type?: string; summary?: string }
        error?: CallError
        skip?: { reason: SkipReason; from: string }
        cancel?: { by: string; reason: string }
      }
    | { k: 'call.cancel'; call: string; by: string; reason: string }
    | {
        k: 'handle.settle'
        handle: string
        name: string
        call: string
        kind: ChannelKind
        state: 'ready' | 'void'
        type?: string
        summary?: string
      }
    | { k: 'process.spawn'; id: string; call: string; pid: number; command: string; stdout: string; stderr: string }
    | { k: 'process.exit'; id: string; call: string; code: number | null; signal: string | null; runMs: number }
    | { k: 'notify.emit'; id: string; call: string; agent: string; outcome: CallOutcome; event?: Notification['event'] }
    | { k: 'notify.deliver'; id: string[]; sink: string; agent: string; latencyMs: number; bytes: number }
    | { k: 'session.end'; reason: string; stats: SessionStats }
  )

/** Roll-up written at `session.end` and recomputed by the perf renderer. */
export interface SessionStats {
  /** Total calls submitted. */
  calls: number
  /** Count per terminal state. */
  outcomes: Record<CallOutcome, number>
  /** Agents seen. */
  agents: number
  /** Notifications emitted. */
  notifications: number
  /** Wall-clock length of the session. */
  wallMs: number
  /** Sum of every call's run time; divided by `wallMs` this is the mean parallelism. */
  busyMs: number
}

/** A value rendered for display and for the trace. */
export interface ValueDigest {
  /** Short type label, e.g. `Kernel`, `number`, `Array(8)`. */
  type: string
  /** One-line summary. */
  summary: string
}

/**
 * Convention for toolbox return values: an implementation may tag its result to
 * control how handles are displayed. Untagged values are described structurally.
 */
export interface TaggedValue {
  /** Type label shown next to the handle. */
  $type?: string
  /** One-line summary shown next to the handle. */
  $summary?: string
  [key: string]: unknown
}

/** Error class toolboxes throw to attach structured detail to a failure. */
export class FluviaError extends Error {
  constructor(
    /** Short machine-ish class, e.g. `KernelCompileError`. */
    public kind: string,
    message: string,
    /** Structured detail carried into the trace and the notification. */
    public detail?: unknown,
    /** Whether a retry could plausibly succeed. */
    public retryable = false,
  ) {
    super(message)
    this.name = kind
  }
}
