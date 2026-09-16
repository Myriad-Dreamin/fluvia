/**
 * The function registry holds the **preloaded implementations** an agent may
 * call. Fluvia never evaluates agent-supplied code: the toolbox is loaded once
 * at startup from a module path, and a line is executable only if its callee is
 * a name in here. That is the whole security and reproducibility story of the
 * CLI, so the registry is also what `help()` and `defs()` read.
 *
 * @module fluvia/plugins/registry
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { FunctionDef } from '../core/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    functions: FunctionRegistry
  }
}

/** Shapes a preload module may export; all of them yield a list of defs. */
type ToolboxModule =
  | FunctionDef[]
  | { default?: FunctionDef[] | { functions?: FunctionDef[] }; toolbox?: FunctionDef[]; functions?: FunctionDef[] }

export class FunctionRegistry extends Service {
  private readonly defs = new Map<string, FunctionDef>()

  /** Module specifiers preloaded so far, for the trace header. */
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

  /**
   * Import a toolbox module and register everything it exports.
   *
   * @param specifier — a path (absolute, `./`-relative or plain like
   * `src/toolbox/default.ts`) or a package specifier. Anything that exists on
   * disk is loaded as a file URL, so `tsx` can import a `.ts` toolbox without a
   * build step; everything else goes to the module resolver unchanged.
   * @returns the names registered from this module.
   */
  async preload(specifier: string): Promise<string[]> {
    const asPath = resolve(specifier)
    const url = /^[./]|^[A-Za-z]:[\\/]/.test(specifier) || existsSync(asPath) ? pathToFileURL(asPath).href : specifier
    const module = (await import(url)) as ToolboxModule
    const defs = extractDefs(module)
    if (!defs.length) throw new Error(`${specifier}: exports no function definitions`)
    this.registerAll(defs)
    this.preloaded.push(specifier)
    return defs.map((def) => def.name)
  }
}

/** Pull the definition list out of whichever export shape a toolbox used. */
function extractDefs(module: ToolboxModule): FunctionDef[] {
  if (Array.isArray(module)) return module
  const candidates = [
    Array.isArray(module.default) ? module.default : undefined,
    !Array.isArray(module.default) ? module.default?.functions : undefined,
    module.toolbox,
    module.functions,
  ]
  const found = candidates.find((value): value is FunctionDef[] => Array.isArray(value) && value.length > 0)
  return found ?? []
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
