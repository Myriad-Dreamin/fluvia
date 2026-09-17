import { defineConfig } from 'vitepress'

/**
 * The fluvia documentation site.
 *
 * Rooted at `docs/`, so every markdown file beside this directory is a page.
 * It deploys to https://myriad-dreamin.github.io/fluvia/, hence the base path.
 */
export default defineConfig({
  title: 'fluvia',
  description: 'Record an agent run once. Cut it anywhere. Swap one piece. Score the difference.',
  base: '/fluvia/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/fluvia/favicon.svg' }]],
  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/cli', activeMatch: '/reference/' },
      { text: 'GitHub', link: 'https://github.com/Myriad-Dreamin/fluvia' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'How it works', link: '/guide/how-it-works' },
          { text: 'Cases', link: '/guide/cases' },
          { text: 'Slices', link: '/guide/slices' },
          { text: 'The runtime', link: '/guide/runtime' },
          { text: 'The browser app', link: '/guide/pi-web' },
          { text: 'DeepSeek Harness', link: '/guide/dsh' },
          { text: 'The skill', link: '/guide/skill' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Case API', link: '/reference/case-api' },
          { text: 'Trace format', link: '/reference/trace' },
          { text: 'Protocol', link: '/reference/protocol' },
          { text: 'Threat model', link: '/reference/threat-model' },
          { text: 'Packages', link: '/reference/packages' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/Myriad-Dreamin/fluvia' }],
    editLink: {
      pattern: 'https://github.com/Myriad-Dreamin/fluvia/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Apache-2.0',
      copyright: '© 2026 Myriad-Dreamin',
    },
    outline: [2, 3],
  },
})
