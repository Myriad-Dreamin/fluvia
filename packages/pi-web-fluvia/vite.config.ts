import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const shim = fileURLToPath(new URL('./src/shims/node.ts', import.meta.url))

export default defineConfig({
  // Relative asset URLs, so `dist/` works from any path.
  base: './',
  resolve: {
    // src/plugins/registry.ts imports these at module top; slice mode never
    // calls the code that uses them.
    alias: [{ find: /^node:(fs|path|url)$/, replacement: shim }],
  },
  server: {
    // Slice mode imports the fluvia runtime from the repository root.
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
})
