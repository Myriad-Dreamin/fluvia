/**
 * A virtual clock for replaying a session. Timers fire in deadline order, and
 * between two deadlines every microtask the runtime queued is allowed to run,
 * so a recorded session re-executes with the same causal order it had live —
 * without waiting for real time to pass, and without the scheduling jitter of
 * the host that recorded it.
 *
 * Time only moves when the replay moves it. That is what lets an agent think
 * for thirty seconds at a cut point while the runtime it is driving sees no
 * time pass at all.
 *
 * @module @fluvia/core/bench/clock
 */

import type { Timers } from '../plugins/scheduler.ts'

interface Pending {
  id: number
  at: number
  fn: () => void
}

/** Run one macrotask, which drains every microtask queued before it. */
function macrotask(): Promise<void> {
  type Port = { onmessage: (() => void) | null; close(): void; postMessage(value: unknown): void }
  const g = globalThis as unknown as {
    setImmediate?: (fn: () => void) => void
    MessageChannel?: new () => { port1: Port; port2: Port }
  }
  if (typeof g.setImmediate === 'function') return new Promise((resolve) => g.setImmediate!(resolve))
  if (typeof g.MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new g.MessageChannel!()
      channel.port1.onmessage = () => {
        channel.port1.close()
        resolve()
      }
      channel.port2.postMessage(0)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class VirtualClock implements Timers {
  private t = 0
  private nextId = 1
  private timers: Pending[] = []

  /** Milliseconds of virtual time since the replay started. */
  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.push({ id, at: this.t + Math.max(0, Number(ms) || 0), fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle)
  }

  /** Deadline of the earliest pending timer, if any. */
  nextAt(): number | undefined {
    let best: Pending | undefined
    for (const timer of this.timers) if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer
    return best?.at
  }

  /** Let the runtime finish reacting to what just happened. */
  async settle(): Promise<void> {
    await macrotask()
  }

  /**
   * Advance to `target`, firing every timer due on the way in deadline order
   * (ties in creation order) and settling after each one.
   */
  async advanceTo(target: number): Promise<void> {
    await this.settle()
    for (;;) {
      const at = this.nextAt()
      if (at === undefined || at > target) break
      const index = this.timers.findIndex((timer) => timer.at === at)
      // Earliest id among those due at `at`: creation order breaks ties.
      let pick = index
      for (let i = index; i < this.timers.length; i++) {
        if (this.timers[i]!.at === at && this.timers[i]!.id < this.timers[pick]!.id) pick = i
      }
      const [timer] = this.timers.splice(pick, 1)
      this.t = Math.max(this.t, timer!.at)
      timer!.fn()
      await this.settle()
    }
    this.t = Math.max(this.t, target)
    await this.settle()
  }
}
