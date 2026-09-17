/**
 * Build the slice-bench demo page into one self-contained HTML file.
 *
 *   fluvia slice page [--trace out/<session>.jsonl.gz] [--out out/bench-page/index.html]
 *
 * React loads from cdnjs as UMD globals; everything else — the fluvia runtime,
 * the page, its stylesheet and the recorded trace — is inlined. Nothing the
 * runtime pulls in reaches for `node:*`: `@fluvia/core` is browser-safe, and
 * the page registers its toolbox directly rather than preloading a module.
 *
 * @module @fluvia/cli/bench/page/build
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import type { Plugin } from 'esbuild'
import { readTrace } from '@fluvia/core/trace'

/**
 * The page's own sources. esbuild reads `app.tsx` and `styles.css` directly
 * rather than anything `tsc` emitted, so this resolves to `src/slice/page/`
 * whether the caller is the built `lib/` copy or the source tree. A published
 * package ships only `lib/`, so this command needs a checkout.
 */
const PAGE_SRC = fileURLToPath(new URL('../../../src/slice/page/', import.meta.url))

/** Build the demo page from `argv` (everything after `fluvia slice page`). */
export async function main(argv: string[]): Promise<void> {
  const here = PAGE_SRC.replace(/\/$/, '')
  if (!existsSync(resolve(here, 'app.tsx'))) {
    throw new Error(`bench-page needs the page sources at ${here}; run it from a fluvia checkout`)
  }
  const cwd = process.cwd()
  const { values } = parseArgs({
    args: argv,
    options: {
      trace: { type: 'string', default: resolve(cwd, 'out/s-20260915-223018.jsonl.gz') },
      out: { type: 'string', default: resolve(cwd, 'out/bench-page/index.html') },
    },
  })

  const events = readTrace(values.trace!).events

  const shims: Plugin = {
    name: 'bench-page-shims',
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'global' }))
      b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: 'react-dom', namespace: 'global' }))
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'global' }))
      b.onResolve({ filter: /^bench:trace$/ }, () => ({ path: 'trace', namespace: 'bench' }))
      b.onLoad({ filter: /.*/, namespace: 'global' }, (args) => ({
        contents:
          args.path === 'react'
            ? 'module.exports = window.React'
            : args.path === 'react-dom'
              ? 'module.exports = window.ReactDOM'
              : `const R = window.React
                 function jsx(type, props, key) { const { children, ...rest } = props || {}; if (key !== undefined) rest.key = key; return children === undefined ? R.createElement(type, rest) : Array.isArray(children) ? R.createElement(type, rest, ...children) : R.createElement(type, rest, children) }
                 module.exports = { jsx, jsxs: jsx, Fragment: R.Fragment }`,
        loader: 'js',
      }))
      b.onLoad({ filter: /.*/, namespace: 'bench' }, () => ({ contents: JSON.stringify(events), loader: 'json' }))
    },
  }

  const result = await build({
    entryPoints: [resolve(here, 'app.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    plugins: [shims],
    logLevel: 'warning',
  })
  const script = result.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script')
  const css = readFileSync(resolve(here, 'styles.css'), 'utf8')

  const html = `<title>Fluvia Slice Bench</title>
<meta name="description" content="Cut a recorded fluvia session and continue it with an agent or a mechanical replay.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap">
<style>${css}</style>
<div id="root"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>${script}</script>
`
  mkdirSync(dirname(values.out!), { recursive: true })
  writeFileSync(values.out!, html)
  process.stdout.write(`${values.out} · ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB · ${events.length} trace events\n`)
}
