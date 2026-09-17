/**
 * Browser stand-ins for the three Node imports `src/plugins/registry.ts` makes
 * at module top (`node:fs`, `node:path`, `node:url`). Only `preload()` uses
 * them, and slice mode never preloads — the toolbox is registered directly —
 * so these exist to satisfy the import, and fail loudly if ever called.
 *
 * @module pi-web-fluvia/shims/node
 */

function unavailable(name: string): never {
  throw new Error(`${name} is not available in the browser (toolbox preloading is a server-side operation)`)
}

export function existsSync(_path: string): boolean {
  return false
}

export function resolve(..._segments: string[]): string {
  return unavailable('path.resolve')
}

export function pathToFileURL(_path: string): URL {
  return unavailable('url.pathToFileURL')
}

export default { existsSync, resolve, pathToFileURL }
