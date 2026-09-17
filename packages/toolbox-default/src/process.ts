/**
 * An opt-in toolbox that runs real programs through the process supervisor
 * (src/plugins/processes.ts). It is **not** part of the default toolbox and is
 * never loaded unless `--preload` names it: `exec` runs any command the agent
 * types, on the runtime's host, so preloading it hands the model a shell-grade
 * capability on the unsandboxed side.
 *
 *   exec("sh", ["-c", "sleep 2; echo hello"])
 *   → c0 exec ⇒ process0, err0  [running]
 *   ← c0 exec done (wait 0ms, run 3ms) ⇒ process0 : Process p0 pid 4242 running · sh -c "sleep 2; echo hello"; err0 void
 *   ← c0 processExited(process0) p0 pid 4242 exit code 0 after 2.0s · sh -c "sleep 2; echo hello"
 *       stdout /tmp/fluvia/<session>/p0-c0.stdout.log (6 B)
 *       stderr /tmp/fluvia/<session>/p0-c0.stderr.log (0 B)
 *
 * @module fluvia/toolbox/process
 */

import { FluviaError } from '@fluvia/core/types'
import type { FunctionDef, ProcessInfo } from '@fluvia/core/types'

/** Start a program; the call settles on spawn, the exit arrives as `processExited`. */
export const exec: FunctionDef = {
  name: 'exec',
  out: 'process',
  summary: 'start a program; settles once it spawns, then notifies processExited with stdout/stderr paths',
  params: '(command, [args], { cwd })',
  positional: ['command', 'args'],
  run(input: { command?: unknown; args?: unknown; cwd?: unknown }, cx): Promise<ProcessInfo> {
    const { command, args = [], cwd } = input
    if (typeof command !== 'string' || !command) {
      throw new FluviaError('ArgumentError', 'exec needs a command string')
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      throw new FluviaError('ArgumentError', 'exec args must be an array of strings')
    }
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new FluviaError('ArgumentError', 'exec cwd must be a string')
    }
    return cx.spawn({ command, args, cwd })
  },
}

export const toolbox: FunctionDef[] = [exec]

export default toolbox
