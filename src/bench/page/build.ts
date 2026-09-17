/**
 * Build the slice-bench demo page into one self-contained HTML file.
 *
 *   tsx src/bench/page/build.ts [--trace out/<session>.jsonl.gz] [--out out/bench-page/index.html]
 *
 * React loads from cdnjs as UMD globals; everything else — the fluvia runtime,
 * the page, its stylesheet and the recorded trace — is inlined. Node-only
 * imports reachable from the runtime (the module preloader's `node:fs`,
 * `node:path`, `node:url`) are shimmed, because the page registers the toolbox
 * directly and never preloads.
 *
 * @module fluvia/bench/page/build
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import type { Plugin } from 'esbuild'
import { readTrace } from '../../core/trace.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const { values } = parseArgs({
  options: {
    trace: { type: 'string', default: resolve(root, 'out/s-20260915-223018.jsonl.gz') },
    out: { type: 'string', default: resolve(root, 'out/bench-page/index.html') },
  },
})

const events = readTrace(values.trace!).events

const shims: Plugin = {
  name: 'bench-page-shims',
  setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'global' }))
    b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: 'react-dom', namespace: 'global' }))
    b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'global' }))
    b.onResolve({ filter: /^node:(fs|path|url)$/ }, (args) => ({ path: args.path, namespace: 'node-shim' }))
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
    b.onLoad({ filter: /.*/, namespace: 'node-shim' }, () => ({
      contents: 'export const existsSync = () => false; export const resolve = (p) => p; export const pathToFileURL = (p) => ({ href: p }); export const dirname = (p) => p;',
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
