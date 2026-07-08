# Launch Kit

This page is for repo maintainers preparing a public push for CraftDriver. It keeps the non-code polish work in one place.

## Repository Settings

Set these in GitHub after merging the docs work:

| Setting                         | Recommendation                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Website                         | `https://dtopuzov.github.io/craftdriver/`                                        |
| Description                     | `Standards-based browser automation for Node.js, tests, scripts, and AI agents.` |
| Social preview                  | Upload `docs/public/social-card.svg` or a PNG exported from it.                  |
| Discussions                     | Enable if you want a place for questions and recipes outside issues.             |

Recommended topics:

```text
webdriver
webdriver-bidi
browser-automation
e2e-testing
typescript
nodejs
mcp
ai-agents
testing-tools
browser-testing
```

## npm Package

After the next release, check:

- npm page points to the GitHub Pages docs site
- package description matches the README positioning
- README renders with the docs badge and choose-your-path table
- `docs`, `skills`, `bin`, `dist`, `README.md`, `CHANGELOG.md`, and `LICENSE` are present in the packed tarball

Useful command:

```bash
npm pack --dry-run
```

## Announcement Drafts

Short:

```text
CraftDriver is a standards-based browser automation library for Node.js: Playwright-style ergonomics. WebDriver standards. AI friendly.

Docs: https://dtopuzov.github.io/craftdriver/
npm: https://www.npmjs.com/package/craftdriver
GitHub: https://github.com/dtopuzov/craftdriver
```

Developer-focused:

```text
I built CraftDriver for teams that want modern browser automation without leaving WebDriver standards behind.

It supports auto-waiting, semantic locators, assertions, network mocking, sessions, tracing, accessibility checks, mobile emulation, and browser contexts. It also ships a CLI, MCP server, and agent skill pack so coding agents can drive a real browser with the same selectors and error codes as test code.

https://github.com/dtopuzov/craftdriver
```

AI-agent angle:

```text
CraftDriver gives AI coding agents a deterministic browser control surface: CLI commands, MCP tools, compact accessibility snapshots, stable refs, and machine-readable error codes.

The same package also gives humans a TypeScript browser automation API built on WebDriver Classic and BiDi.

https://dtopuzov.github.io/craftdriver/agents
```

## Places To Share

- GitHub release notes
- npm package README
- LinkedIn or X/Twitter
- Reddit communities where self-promotion is allowed
- Hacker News "Show HN" when the docs, examples, and first issues are ready
- Awesome lists related to browser automation, testing, WebDriver, and AI agents

## Follow-Up Content Ideas

- "Why WebDriver BiDi matters for browser automation"
- "How to give an AI coding agent a real browser through MCP"
- "Browser automation without managing chromedriver"
- "CraftDriver vs Selenium, Playwright, and Puppeteer: choosing the right layer"

## Pre-Announcement Checklist

- [ ] GitHub Pages deployment is green.
- [ ] `https://dtopuzov.github.io/craftdriver/` loads.
- [ ] README links to the docs site.
- [ ] npm package page shows the refreshed README after release.
- [ ] Social preview image is uploaded in GitHub repository settings.
- [ ] Issue forms are visible in GitHub.
- [ ] At least one beginner-friendly issue exists.
- [ ] A small "good first recipe" or "help wanted" issue exists for contributors.
