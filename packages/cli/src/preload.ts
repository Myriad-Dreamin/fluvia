/**
 * Turning a module specifier into registered functions.
 *
 * This is the step that decides what an agent may call, so it is deliberately
 * the CLI's job and not the runtime's: it touches the filesystem and the module
 * loader, neither of which exists in a browser, and `@fluvia/core` has to stay
 * importable there. The registry itself only ever holds definitions in memory.
 *
 * @module @fluvia/cli/preload
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FunctionDef } from '@fluvia/core/types'
import type { FunctionRegistry } from '@fluvia/core/plugins/registry'

/** Shapes a preload module may export; all of them yield a list of defs. */
type ToolboxModule =
  | FunctionDef[]
  | { default?: FunctionDef[] | { functions?: FunctionDef[] }; toolbox?: FunctionDef[]; functions?: FunctionDef[] }

/**
 * Import a toolbox module and register everything it exports.
 *
 * @param registry — the runtime's registry, which the definitions land in.
 * @param specifier — a path (absolute, `./`-relative or plain like
 * `./toolbox.ts`) or a package specifier such as `@fluvia/toolbox-default`.
 * Anything that exists on disk is loaded as a file URL; everything else goes to
 * the module resolver unchanged.
 * @returns the names registered from this module.
 */
export async function preload(registry: FunctionRegistry, specifier: string): Promise<string[]> {
  const asPath = resolve(specifier)
  const url = /^[./]|^[A-Za-z]:[\\/]/.test(specifier) || existsSync(asPath) ? pathToFileURL(asPath).href : specifier
  const module = (await import(url)) as ToolboxModule
  const defs = extractDefs(module)
  if (!defs.length) throw new Error(`${specifier}: exports no function definitions`)
  registry.registerAll(defs)
  registry.preloaded.push(specifier)
  return defs.map((def) => def.name)
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

/** The toolbox a fluvia command loads when `--preload` is not given. */
export const DEFAULT_TOOLBOX = '@fluvia/toolbox-default'
