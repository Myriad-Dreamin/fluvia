/**
 * Everything an agent reads. Fluvia's entire interface is text on a terminal,
 * so these renderers are the product surface: an acknowledgement has to say
 * what was scheduled and what it was bound to, and a notification has to say
 * what is now actionable — both in one glance, because an agent pays attention
 * in tokens.
 *
 * @module fluvia/cli/format
 */

import type { ArgNode, CallRecord, FunctionDef, Notification, SkipReason } from '../core/types.ts'
import { formatArg } from '../core/parser.ts'

/** Format a duration compactly: `840µs`, `121ms`, `3.4s`. */
export function ms(value: number): string {
  if (value < 1) return `${Math.round(value * 1000)}µs`
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

/** Render an argument list back to the source the agent wrote. */
export function renderArgs(args: ArgNode[]): string {
  return args.map((arg) => formatArg(arg)).join(', ')
}

/**
 * The line printed the instant a call is accepted. It names the two variables
 * the agent can now pass onward, and what the call is waiting for — the agent
 * should never have to ask "did that land?".
 */
export function renderAck(call: CallRecord): string {
  const waiting = call.deps.length ? `waiting: ${[...new Set(call.deps.map((dep) => dep.name))].join(', ')}` : call.state
  return `→ ${call.id} ${call.fn} ⇒ ${call.bind.value}, ${call.bind.error}  [${waiting}]`
}

/** Why a skipped call never ran, in words an agent can act on. */
export function renderSkip(reason: SkipReason, from: string): string {
  switch (reason) {
    case 'upstream_ok':
      return `${from} succeeded, so the error handle it consumes is void`
    case 'upstream_failed':
      return `${from} failed, so the value handle it consumes is void`
    case 'upstream_cancelled':
      return `${from} was cancelled`
    case 'upstream_skipped':
      return `${from} was itself skipped`
  }
}

/**
 * The LLM-facing body of a notification. Sinks may print this verbatim;
 * `fluvia-dsh` groups several of them into one envelope.
 */
export function renderNotificationText(notification: Notification): string {
  if (notification.event === 'processExited' && notification.process) return renderProcessExit(notification)
  const { call, fn, timing, ready } = notification
  const timings = `wait ${ms(timing.waitedMs)}, run ${ms(timing.runMs)}`
  let head: string
  switch (notification.outcome) {
    case 'done':
      head = `${call} ${fn} done (${timings}) ⇒ ${ready!.name} : ${ready!.type} ${ready!.summary}; ${notification.bind.error} void`
      break
    case 'failed': {
      const error = notification.error!
      const retry = error.retryable ? ', retryable' : ''
      head = `${call} ${fn} failed (${timings}) ⇒ ${notification.bind.error} : ${error.kind} "${error.message}"${retry}; ${notification.bind.value} void`
      break
    }
    case 'cancelled':
      head = `${call} ${fn} cancelled after ${ms(timing.totalMs)}; both handles void`
      break
    case 'skipped':
      head = `${call} ${fn} skipped — ${renderSkip(notification.skip!.reason, notification.skip!.from)}`
      break
  }
  const unblocked = notification.unblocked.length ? `\n  now runnable: ${notification.unblocked.join(', ')}` : ''
  return head + unblocked
}

/**
 * `c0 processExited(process0) p0 exit code 0 after 2.0s` plus the two log
 * paths, each on its own line because they are what the agent acts on next.
 */
function renderProcessExit(notification: Notification): string {
  const exit = notification.process!
  const status = exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`
  return [
    `${notification.call} processExited(${notification.bind.value}) ${exit.id} pid ${exit.pid} ${status} after ${ms(exit.runMs)} · ${exit.command}`,
    `  stdout ${exit.stdout} (${bytes(exit.bytes.stdout)})`,
    `  stderr ${exit.stderr} (${bytes(exit.bytes.stderr)})`,
  ].join('\n')
}

/** Byte counts at a glance: `0 B`, `812 B`, `4.1 KB`, `3.2 MB`. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/** The compact one-liner the `stdout` sink prints. */
export function renderNotificationLine(notification: Notification): string {
  return `← ${notification.text.split('\n').join('\n  ')}`
}

/** Signature line used by `help()` and `defs()`. */
export function renderSignature(def: FunctionDef): string {
  const params = def.params ?? (def.positional?.length ? `(${def.positional.join(', ')}, { … })` : '({ … })')
  return `${def.name}${params}`
}

/** Render a fixed-width table; the inspection commands are built from these. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((row) => row.map((value) => String(value)))]
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => (row[column] ?? '').length)))
  const line = (row: string[]) => row.map((value, column) => value.padEnd(widths[column]!)).join('  ').trimEnd()
  return [line(headers), widths.map((width) => '─'.repeat(width)).join('  '), ...cells.slice(1).map(line)].join('\n')
}

/** Percentile of a sample, linear interpolation, tolerant of empty input. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return low === high ? sorted[low]! : sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low)
}
