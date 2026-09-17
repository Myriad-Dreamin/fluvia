import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs, so `dist/` works from any path.
  base: './',
  server: {
    // `@fluvia/core` is a workspace link, so its files live above this package.
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
})
