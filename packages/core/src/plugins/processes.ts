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
import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs'
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

    let child: ChildProcess
    try {
      child = spawn(request.command, args, { cwd: request.cwd, stdio: ['ignore', outFd, errFd] })
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
        const info: ProcessInfo = {
          $type: 'Process',
          $summary: `${id} pid ${child.pid} running · ${command}`,
          id,
          pid: child.pid!,
          call: call.id,
          command,
          stdout,
          stderr,
        }
        const startedAt = this.tracer.now()
        const exited = new Promise<void>((done) => {
          child.once('close', (code, signal) => {
            this.live.delete(id)
            this.reportExit(call, info, startedAt, code, signal)
            done()
          })
        })
        this.live.set(id, { info, child, startedAt, exited })
        this.tracer.emit('process.spawn', { id, call: call.id, pid: info.pid, command, stdout, stderr })
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
