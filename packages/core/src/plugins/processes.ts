/**
 * The process supervisor. Some calls start work that outlives them: a call that
 * launches a binary settles as soon as the child exists, handing the agent a
 * `Process` handle whose stdout and stderr paths later calls can already read.
 * The child keeps running under this service, and when it exits the agent that
 * spawned it gets a second, independent notification — `processExited` — with
 * the exit status and the two log paths.
 *
 * That split is what keeps a long-running program from blocking the dataflow.
 *
 * The supervisor never runs anything through a shell and never decides *what*
 * may be run; that is the preloaded toolbox's job, on the runtime's side of the
 * boundary.
 *
 * @module fluvia/plugins/processes
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { FluviaError } from '../types.ts'
import type { CallRecord, ProcessExit, ProcessInfo, SpawnRequest } from '../types.ts'
import type { Tracer } from '../trace.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    processes: ProcessSupervisor
  }
}

/** Supervisor configuration, supplied by the CLI or the server. */
export interface SupervisorConfig {
  /** The session tracer. */
  tracer: Tracer
  /** Directory the per-process stdout/stderr logs are written into. */
  dir: string
}

/** A child the supervisor is still waiting on. */
interface Supervised {
  info: ProcessInfo
  child: ChildProcess
  startedAt: number
  exited: Promise<void>
}

export class ProcessSupervisor extends Service {
  static inject = ['notify']

  private readonly live = new Map<string, Supervised>()
  private readonly tracer: Tracer
  private readonly dir: string
  private next = 0

  constructor(ctx: Context, config: SupervisorConfig) {
    super(ctx, 'processes')
    this.tracer = config.tracer
    this.dir = config.dir
  }

  /** Processes that have spawned and not yet exited. */
  running(): ProcessInfo[] {
    return [...this.live.values()].map((entry) => entry.info)
  }

  /**
   * Spawn a child on behalf of `call`. Resolves once the OS reports the spawn,
   * rejects with a `SpawnError` when it cannot start (e.g. unknown command).
   * The handle's summary stays short; the log paths are fields on the value and
   * arrive in full with the exit notification.
   */
  spawn(call: CallRecord, request: SpawnRequest): Promise<ProcessInfo> {
    const id = `p${this.next++}`
    const args = request.args ?? []
    mkdirSync(this.dir, { recursive: true })
    const stdout = join(this.dir, `${id}-${call.id}.stdout.log`)
    const stderr = join(this.dir, `${id}-${call.id}.stderr.log`)
    const outFd = openSync(stdout, 'w')
    const errFd = openSync(stderr, 'w')
    const stdin = request.stdin === 'pipe' ? 'pipe' : 'ignore'

    let child: ChildProcess
    try {
      child = spawn(request.command, args, {
        cwd: request.cwd,
        stdio: [stdin, outFd, errFd],
        detached: request.detached === true,
      })
    } finally {
      // The child holds its own duplicates of both descriptors.
      closeSync(outFd)
      closeSync(errFd)
    }
    const command = [request.command, ...args].map(quote).join(' ')

    return new Promise<ProcessInfo>((resolve, reject) => {
      child.once('error', (error) => {
        // An error before `spawn` means the child never existed; after it, the
        // `close` handler below still reports the exit.
        if (child.pid === undefined) {
          // Nothing will ever be written; don't leave empty logs that look like a run.
          rmSync(stdout, { force: true })
          rmSync(stderr, { force: true })
          reject(new FluviaError('SpawnError', `${request.command}: ${error.message}`, { command }))
        }
      })
      child.once('spawn', () => {
        const pid = child.pid!
        const info: ProcessInfo = {
          $type: 'Process',
          $summary: `${id} pid ${pid} running · ${command}`,
          id,
          pid,
          pgid: processGroupOf(pid),
          call: call.id,
          command,
          stdout,
          stderr,
        }
        const startedAt = this.tracer.now()
        const timers: NodeJS.Timeout[] = []
        const exited = new Promise<void>((done) => {
          child.once('close', (code, signal) => {
            // A deadline that has not fired yet is no longer a deadline; the
            // exit is the answer. Leaving a timer armed would trace a kill for
            // a process that is already gone, and could signal a reused pid.
            for (const timer of timers) clearTimeout(timer)
            this.live.delete(id)
            this.reportExit(call, info, startedAt, code, signal)
            done()
          })
        })
        this.live.set(id, { info, child, startedAt, exited })
        this.tracer.emit('process.spawn', {
          id,
          call: call.id,
          pid,
          pgid: info.pgid,
          command,
          stdout,
          stderr,
        })
        // The deadline: two thresholds, each traced when it actually signals
        // (a child already gone answers `false`, so no phantom kill is left).
        // `unref` keeps a pending deadline from holding the runtime open.
        const deadline = request.deadline
        if (deadline !== undefined) {
          const thresholds: Array<[NodeJS.Signals, number]> = [
            ['SIGTERM', deadline.terminateAfterMs],
            ['SIGKILL', deadline.killAfterMs],
          ]
          for (const [signal, afterMs] of thresholds) {
            const timer = setTimeout(() => {
              void this.signalDeadline(id, signal).then((signalled) => {
                if (signalled) {
                  this.tracer.emit('process.kill', {
                    id,
                    call: call.id,
                    pid,
                    pgid: info.pgid,
                    signal,
                    afterMs,
                  })
                }
              })
            }, afterMs)
            timer.unref()
            timers.push(timer)
          }
        }
        resolve(info)
      })
    })
  }

  /** Resolve once every supervised process has exited. */
  async drain(): Promise<void> {
    while (this.live.size) await Promise.all([...this.live.values()].map((entry) => entry.exited))
  }

  /** Signal every live child; their exits are still reported. */
  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const entry of this.live.values()) entry.child.kill(signal)
  }

  /**
   * Write to a supervised child's stdin.
   *
   * Only a child spawned with `stdin: 'pipe'` has one; for any other child this
   * answers `false` rather than pretending the bytes went somewhere. It also
   * answers `false` for a child that is no longer supervised.
   */
  write(id: string, data: string): boolean {
    const stdin = this.live.get(id)?.child.stdin
    if (stdin === null || stdin === undefined) return false
    return stdin.write(data)
  }

  /**
   * End a supervised child **and everything it forked**, deepest member first —
   * and answer whether any signal went out.
   *
   * The order is the point. `kill(-pgid)` ends the group in whatever order the
   * kernel picks, and when a parent is picked before its children they are
   * orphaned: in a container whose PID 1 does not reap, a child that dies after
   * that stays a zombie nobody can collect. Signalling leaf-first lets each
   * parent collect its own child and exit on its own.
   *
   * Only a child spawned `detached` leads the group this ends (`pgid === pid`);
   * for any other child the group is this runtime's own, so this refuses rather
   * than signal the runtime with itself. A child that is no longer supervised
   * answers `false` too — nothing here keeps a group alive past its leader.
   *
   * All of it is pid analysis: depth comes from `ppid`, membership from `pgid`,
   * read from `/proc`. Nothing reads the command text — no pattern over it can
   * enumerate a `&`, a subshell, a `nohup`, a `setsid`, or a program's own fork.
   */
  async killGroup(id: string, signal: NodeJS.Signals = 'SIGTERM', graceMs = 500): Promise<boolean> {
    const entry = this.live.get(id)
    if (entry === undefined) return false
    const { pid, pgid } = entry.info
    if (pgid !== pid) return false // not this child's own group: leave it alone

    const members = groupMembers(pgid)
    if (members.length === 0) return entry.child.kill(signal)
    return this.walkGroup(pgid, signal, graceMs)
  }

  /**
   * One leaf-first walk of a process group.
   *
   * Depth inside the group is how many of its own ancestors are members; each
   * layer is signalled deepest-first and given time to die before the layer
   * above it is signalled, so a parent can still collect its own child.
   * Signalling the group as a whole (`kill(-pgid)`) cannot do that, and a child
   * that dies after its parent is orphaned — a zombie nobody can collect in a
   * container whose PID 1 does not reap.
   */
  private async walkGroup(pgid: number, signal: NodeJS.Signals, graceMs: number): Promise<boolean> {
    const members = groupMembers(pgid)
    if (members.length === 0) return false
    const byPid = new Map(members.map((member) => [member.pid, member]))
    const depthOf = (member: GroupMember): number => {
      let depth = 0
      let cursor = member.ppid
      while (byPid.has(cursor)) {
        depth += 1
        cursor = byPid.get(cursor)!.ppid
      }
      return depth
    }
    const layers = new Map<number, GroupMember[]>()
    for (const member of members) {
      const depth = depthOf(member)
      layers.set(depth, [...(layers.get(depth) ?? []), member])
    }

    let signalled = false
    for (const depth of [...layers.keys()].sort((a, b) => b - a)) {
      const layer = layers.get(depth)!
      for (const member of layer) {
        try {
          process.kill(member.pid, signal)
          signalled = true
        } catch {
          // Already gone: a signal that cannot be sent is not a different outcome.
        }
      }
      // Let this layer die, and the parents above a moment to collect what they
      // just lost, before their own signal arrives.
      const deadline = Date.now() + graceMs
      while (Date.now() < deadline) {
        if (layer.every((member) => !exists(member.pid))) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    return signalled
  }

  /**
   * Deliver one deadline signal to a supervised child. A detached child leads
   * its own group, so the whole group is ended — a program that forked is
   * covered; otherwise the group is this runtime's own and only the child is
   * signalled. Answers whether a signal went out, so a child that is already
   * gone leaves no phantom `process.kill` in the trace.
   */
  private async signalDeadline(id: string, signal: NodeJS.Signals): Promise<boolean> {
    const entry = this.live.get(id)
    if (entry === undefined) return false
    const { pid, pgid } = entry.info
    if (pgid !== pid) return entry.child.kill(signal)
    if (signal !== 'SIGKILL') return this.killGroup(id, signal)
    // `SIGKILL` cannot be ignored, so the only member that can outlive one walk
    // is one forked *during* it — a program that notices its child die and
    // starts another. The leader is gone after the first walk, so the group
    // stops growing: walk again until nothing is left, bounded, so a member
    // that somehow keeps appearing cannot spin this forever.
    let signalled = false
    for (let pass = 0; pass < 4; pass++) {
      if (groupMembers(pgid).length === 0) break
      if (await this.walkGroup(pgid, 'SIGKILL', 50)) signalled = true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return signalled
  }

  /** Trace the exit and push the `processExited` notification. */
  private reportExit(
    call: CallRecord,
    info: ProcessInfo,
    startedAt: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const runMs = Math.round((this.tracer.now() - startedAt) * 1000) / 1000
    const exit: ProcessExit = {
      id: info.id,
      pid: info.pid,
      pgid: info.pgid,
      command: info.command,
      code,
      signal,
      stdout: info.stdout,
      stderr: info.stderr,
      bytes: { stdout: size(info.stdout), stderr: size(info.stderr) },
      runMs,
    }
    this.tracer.emit('process.exit', { id: info.id, call: call.id, code, signal, runMs })
    this.ctx.notify.publishProcessExit(call, exit)
  }
}

/** Size of a log file, 0 if it vanished. */
function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Quote an argv element for display only; nothing is ever run through a shell. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)
}

/* --------------------------------------------------------------- /proc ---- */

/** One member of a process group, as `/proc` reports it. */
interface GroupMember {
  pid: number
  ppid: number
}

/** The `/proc/<pid>/stat` fields the supervisor reads. */
interface ProcStat {
  ppid: number
  pgid: number
}

/**
 * `/proc/<pid>/stat`, as much of it as the supervisor uses.
 *
 * `comm` may hold spaces and parentheses, so the fields begin after the last
 * `)`. A pid the machine has already reaped reads as `undefined`: "it is gone"
 * is a fact, not a failure.
 */
function readStat(pid: number): ProcStat | undefined {
  let raw: string
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
  return { ppid: Number(fields[1]), pgid: Number(fields[2]) }
}

/** The process group a pid runs in; the pid itself when `/proc` cannot say. */
function processGroupOf(pid: number): number {
  return readStat(pid)?.pgid ?? pid
}

/**
 * The members of one process group, read from `/proc`.
 *
 * This is the only complete answer to "what did this call start": a shell can
 * hide work behind `&`, a subshell, `nohup`, `setsid`, or a program can fork on
 * its own, so no reading of the command text can enumerate it — the process
 * group cannot hide a member.
 */
function groupMembers(pgid: number): GroupMember[] {
  if (pgid <= 0) return []
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return [] // no `/proc`: nothing to read, and no claim to make
  }
  const members: GroupMember[] = []
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue
    const pid = Number(entry)
    const stat = readStat(pid)
    if (stat !== undefined && stat.pgid === pgid) members.push({ pid, ppid: stat.ppid })
  }
  return members
}

/** Is that pid still on the machine at all (alive or a not-yet-reaped zombie)? */
function exists(pid: number): boolean {
  return readStat(pid) !== undefined
}
