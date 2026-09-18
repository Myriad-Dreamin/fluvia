import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs, so `dist/` works from any path; FLUVIA_BASE pins it
  // for a deployment under a known path (GitHub Pages serves it at /fluvia/).
  base: process.env.FLUVIA_BASE ?? './',
  server: {
    // `@fluvia/core` is a workspace link, so its files live above this package.
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
})
