/**
 * Coalescing settled calls: arrivals inside a short sliding window become one
 * delivery, so eight calls settling in the same second wake the agent once.
 *
 * @module pi-web-fluvia/coalesce
 */

/** Sliding window. */
export const WINDOW_MS = 150
/** The oldest buffered item is never held longer than this. */
export const HOLD_MS = 600

export class Coalescer<T> {
  private buffer: T[] = []
  private window: ReturnType<typeof setTimeout> | undefined
  private hold: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly emit: (batch: T[]) => void,
    private readonly windowMs = WINDOW_MS,
    private readonly holdMs = HOLD_MS,
  ) {}

  add(item: T): void {
    this.buffer.push(item)
    if (this.window) clearTimeout(this.window)
    this.window = setTimeout(() => this.flush(), this.windowMs)
    if (!this.hold) this.hold = setTimeout(() => this.flush(), this.holdMs)
  }

  flush(): void {
    if (this.window) clearTimeout(this.window)
    if (this.hold) clearTimeout(this.hold)
    this.window = this.hold = undefined
    if (!this.buffer.length) return
    const batch = this.buffer
    this.buffer = []
    this.emit(batch)
  }

  /** Drop anything buffered and stop. */
  dispose(): void {
    this.buffer = []
    this.flush()
  }
}
