import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'CraftDriver',
  description:
    'Standards-based browser automation for Node.js, test suites, shell scripts, and AI agents.',
  base: '/craftdriver/',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#b45309' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'CraftDriver' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Playwright-style ergonomics. WebDriver standards. AI friendly.',
      },
    ],
    [
      'meta',
      {
        property: 'og:image',
        content: 'https://dtopuzov.github.io/craftdriver/social-card.svg',
      },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    [
      'meta',
      { name: 'twitter:image', content: 'https://dtopuzov.github.io/craftdriver/social-card.svg' },
    ],
  ],
  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
  themeConfig: {
    logo: '/craftdriver-mark.svg',
    siteTitle: 'CraftDriver',
    outline: {
      level: [2, 3],
    },
    search: {
      provider: 'local',
    },
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'API', link: '/api-reference' },
      { text: 'Recipes', link: '/recipes' },
      { text: 'AI Agents', link: '/agents' },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/dtopuzov/craftdriver' },
          { text: 'npm', link: 'https://www.npmjs.com/package/craftdriver' },
          {
            text: 'Changelog',
            link: 'https://github.com/dtopuzov/craftdriver/blob/main/CHANGELOG.md',
          },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Why CraftDriver?', link: '/why-craftdriver' },
          { text: 'Zero-Config Drivers', link: '/zero-config-drivers' },
          { text: 'WebDriver Standards', link: '/standards' },
          {
            text: 'Recipes',
            link: '/recipes',
            collapsed: true,
            items: [
              { text: 'Find Elements', link: '/recipes/find-elements' },
              { text: 'Vitest Hooks', link: '/recipes/vitest-browser-lifecycle' },
              { text: 'Page Objects', link: '/recipes/page-objects' },
              { text: 'Reuse Login Session', link: '/recipes/login-once-reuse-session' },
              { text: 'Mock APIs', link: '/recipes/mock-api-and-assert-network' },
              { text: 'Multi-User Workflows', link: '/recipes/multi-user-contexts' },
              { text: 'Failure Traces', link: '/recipes/trace-failing-test' },
              { text: 'Accessibility Gates', link: '/recipes/accessibility-gate' },
              { text: 'Console Error Gates', link: '/recipes/console-error-gate' },
              { text: 'Virtual Clock', link: '/recipes/virtual-clock-time-sensitive-ui' },
              { text: 'Files', link: '/recipes/file-upload-download' },
              { text: 'Mobile Flow', link: '/recipes/mobile-flow-with-network-and-logs' },
            ],
          },
        ],
      },
      {
        text: 'Core API',
        items: [
          { text: 'Browser API', link: '/browser-api' },
          { text: 'Selectors', link: '/selectors' },
          { text: 'Element API', link: '/element-api' },
          { text: 'Assertions', link: '/assertions' },
          { text: 'Keyboard and Mouse', link: '/keyboard-mouse' },
          { text: 'Dialogs', link: '/dialogs' },
          { text: 'Error Codes', link: '/error-codes' },
          { text: 'API Reference', link: '/api-reference' },
        ],
      },
      {
        text: 'Browser Capabilities',
        items: [
          { text: 'Driver Configuration', link: '/driver-configuration' },
          { text: 'Browser Contexts', link: '/browser-context' },
          { text: 'Session Management', link: '/session-management' },
          { text: 'Network Mocking', link: '/network' },
          { text: 'Console Logs', link: '/browser-logs' },
          { text: 'Mobile Emulation', link: '/mobile-emulation' },
          { text: 'Emulation', link: '/emulation' },
          { text: 'Screenshots', link: '/screenshots' },
          { text: 'Tracing', link: '/tracing' },
          { text: 'Accessibility', link: '/accessibility' },
          { text: 'Virtual Clock', link: '/clock' },
        ],
      },
      {
        text: 'Agents and Tools',
        items: [
          { text: 'AI Agent Guide', link: '/agents' },
          { text: 'Command-line Interface', link: '/cli' },
          { text: 'MCP Server', link: '/mcp' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/dtopuzov/craftdriver' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/craftdriver' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright (c) Dimitar Topuzov',
    },
  },
});
