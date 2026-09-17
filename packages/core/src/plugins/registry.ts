/**
 * The function registry holds the **preloaded implementations** an agent may
 * call. Fluvia never evaluates agent-supplied code: the toolbox is registered
 * once at startup, and a line is executable only if its callee is a name in
 * here. That is the whole security and reproducibility story of the CLI, so the
 * registry is also what `help()` and `defs()` read.
 *
 * Registration is in-memory only — turning a module specifier into definitions
 * needs a filesystem and a module loader, which is `@fluvia/cli`'s `preload()`.
 * Keeping that out of here is what lets the same registry run in a browser.
 *
 * @module @fluvia/core/plugins/registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { FunctionDef } from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    functions: FunctionRegistry
  }
}

export class FunctionRegistry extends Service {
  private readonly defs = new Map<string, FunctionDef>()

  /**
   * Module specifiers preloaded so far, for the trace header. Whoever loads a
   * module appends to this once its definitions are registered.
   */
  readonly preloaded: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'functions')
  }

  /** Register one definition, replacing any earlier one with the same name. */
  register(def: FunctionDef): void {
    this.defs.set(def.name, def)
  }

  /** Register a list of definitions. */
  registerAll(defs: Iterable<FunctionDef>): void {
    for (const def of defs) this.register(def)
  }

  /** Look one up by the name the agent typed. */
  get(name: string): FunctionDef | undefined {
    return this.defs.get(name)
  }

  /** Every definition, sorted so `defs()` and `help()` read consistently. */
  list(): FunctionDef[] {
    return [...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Names close to a misspelling, so an unknown callee can suggest the
   * intended one instead of only refusing.
   */
  suggest(name: string): string[] {
    const target = name.toLowerCase()
    return this.list()
      .map((def) => ({ name: def.name, distance: distance(target, def.name.toLowerCase()) }))
      .filter((entry) => entry.distance <= Math.max(2, Math.floor(target.length / 3)))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map((entry) => entry.name)
  }
}

/** Levenshtein distance, capped in practice by the short names it compares. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}
