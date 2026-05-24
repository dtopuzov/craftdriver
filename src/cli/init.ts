/**
 * `craftdriver init <flavor>` — write an agent-guide file into the
 * current project. Each flavor maps to one or more well-known paths
 * that a specific AI assistant reads on every turn.
 *
 * One body of text, N filenames. Adapters can prepend a flavor-specific
 * header (e.g. Cursor's `.mdc` frontmatter) but the rules below the
 * header are identical across flavors so every agent on a team gets the
 * same instructions.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';

export type Flavor = 'agents' | 'copilot' | 'claude' | 'cursor' | 'gemini' | 'all';

export const SUPPORTED_FLAVORS: ReadonlyArray<Exclude<Flavor, 'all'>> = [
  'agents',
  'copilot',
  'claude',
  'cursor',
  'gemini',
];

interface Target {
  path: string;
  /** Optional prefix prepended to the shared body (e.g. Cursor frontmatter). */
  header?: string;
}

/**
 * Map a flavor to the paths it writes, relative to the project root.
 * Keep this small and conventional — anything more specific belongs in
 * each tool's own docs.
 */
function targetsFor(flavor: Exclude<Flavor, 'all'>): Target[] {
  switch (flavor) {
    case 'agents':
      // AGENTS.md is the cross-tool convention picked up by Codex,
      // OpenCode, Aider, Amp, and also Cursor.
      return [{ path: 'AGENTS.md' }];
    case 'copilot':
      return [{ path: '.github/copilot-instructions.md' }];
    case 'claude':
      return [{ path: 'CLAUDE.md' }];
    case 'cursor':
      return [
        {
          path: '.cursor/rules/craftdriver.mdc',
          header:
            '---\n' +
            'description: craftdriver — agent rules for browser automation tests\n' +
            'globs: ["**/*.{ts,tsx,js,jsx}"]\n' +
            'alwaysApply: true\n' +
            '---\n\n',
        },
      ];
    case 'gemini':
      return [{ path: 'GEMINI.md' }];
  }
}

/** Single source of truth for the body each adapter writes. */
export function buildBody(): string {
  return `# Working with craftdriver

This project uses [craftdriver](https://www.npmjs.com/package/craftdriver),
a BiDi-first WebDriver library for Node.js. Follow these rules whenever
you write or modify browser-automation code in this repo.

## Use craftdriver, not raw Selenium or Playwright

\`\`\`ts
import { Browser, By, expect } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
await browser.navigateTo('https://example.com/login');
await browser.fill('#username', 'alice');
await browser.click('button[type=submit]');
await expect(browser.locator('#welcome')).toHaveText(/welcome/i);
await browser.quit();
\`\`\`

The public surface is whatever \`src/index.ts\` of \`craftdriver\` re-exports.
Anything under \`craftdriver/src/lib/\` is internal — do not import it.

## Selector preference order

Prefer stable, semantic locators. They survive DOM refactors; CSS and
XPath break the moment markup shifts.

\`\`\`
By.testId  >  By.role({ name })  >  By.labelText  >
By.text({ exact: true })  >  By.css  >  By.xpath
\`\`\`

String selectors passed directly to \`browser.click('…')\` etc. are
treated as CSS. Use \`By.*\` helpers or \`browser.getBy*()\` when you
want a semantic locator.

## Auto-waiting — do not add sleeps

Every action and every \`expect(locator).to…()\` already waits up to the
default timeout (30 s in-library, 5 s on the CLI). **Never** add
\`setTimeout\`, \`sleep\`, or hand-rolled \`while (…) { … }\` retry loops.
They are footguns: actions wait for the right condition; sleeps wait
for the wrong amount of time.

\`\`\`ts
// Good
await expect(browser.locator('#status')).toHaveText('Ready');

// Bad
await new Promise(r => setTimeout(r, 2000));
expect(await browser.text('#status')).toBe('Ready');
\`\`\`

## Errors carry a stable \`code\`

Every error thrown by the public API is a \`CraftdriverError\` with a
stable \`code\` field. Match on the code, not the prose:

\`\`\`ts
import { CraftdriverError, ErrorCode } from 'craftdriver';

try {
  await browser.click('#submit');
} catch (e) {
  if (e instanceof CraftdriverError && e.code === ErrorCode.NO_MATCH) {
    // selector matched zero elements — fix the selector
  }
}
\`\`\`

Common codes: \`NO_MATCH\`, \`TIMEOUT_WAITING_VISIBLE\`,
\`TIMEOUT_WAITING_STATE\`, \`TIMEOUT_WAITING_LOAD\`, \`EXPECT_MISMATCH\`,
\`INVALID_ARGUMENT\`, \`UNSUPPORTED\`. Full list in
\`node_modules/craftdriver/docs/error-codes.md\`.

## CLI for exploration and agent loops

For ad-hoc probing from a shell — including agent-driven loops —
craftdriver ships a \`craftdriver\` binary:

\`\`\`bash
npx craftdriver daemon start
npx craftdriver go http://127.0.0.1:8080/login.html
npx craftdriver exists '#submit'        # 0-wait probe; exit 0 = match
npx craftdriver fill '#username' alice
npx craftdriver click 'button[type=submit]'
npx craftdriver text '#welcome'
npx craftdriver daemon stop
\`\`\`

Selectors are CSS by default; switch with \`prefix=value\`
(\`role=button[name=Submit]\`, \`text=Sign In\`, \`label=Email\`,
\`testid=login-btn\`, \`xpath=…\`). Exit codes: \`0\` success,
\`1\` assertion/timeout/no-match, \`2\` usage error.

Probe before acting on a guess: \`craftdriver exists …\` is a 0-wait
check that returns immediately. Don't \`click\` a hallucinated selector
and burn the full timeout.

Full reference: \`node_modules/craftdriver/docs/cli.md\`.

## Pointers

- \`node_modules/craftdriver/docs/api-reference.md\` — every public
  symbol, one row each. Read this before inventing a method.
- \`node_modules/craftdriver/docs/error-codes.md\` — every error code,
  when it fires, recommended recovery.
- \`node_modules/craftdriver/docs/cli.md\` — full CLI reference.
- \`node_modules/craftdriver/skills/craftdriver/\` — agent-facing SKILL
  pack: \`SKILL.md\` (always-on rules), \`cheatsheet.md\` (writing tests),
  \`patterns.md\` (login/upload/network-wait recipes), \`cli.md\` (CLI from
  an agent's POV).
`;
}

export interface InitResult {
  /** Files actually written (or that would be written, in dry-run mode). */
  written: string[];
  /** Files that already existed and were skipped (no --force). */
  skipped: string[];
  /** When true, no files were touched on disk. */
  dryRun: boolean;
}

export interface InitOptions {
  flavor: Flavor;
  cwd: string;
  force?: boolean;
  dryRun?: boolean;
}

/**
 * Resolve the flavor list, render the body once, and write each target.
 * Returns the list of paths so the caller can print a summary.
 */
export function runInit(opts: InitOptions): InitResult {
  const flavors: Exclude<Flavor, 'all'>[] =
    opts.flavor === 'all' ? [...SUPPORTED_FLAVORS] : [opts.flavor];

  const body = buildBody();
  const written: string[] = [];
  const skipped: string[] = [];

  for (const flavor of flavors) {
    for (const target of targetsFor(flavor)) {
      const abs = join(opts.cwd, target.path);
      if (existsSync(abs) && !opts.force) {
        skipped.push(relative(opts.cwd, abs));
        continue;
      }
      const content = (target.header ?? '') + body;
      if (!opts.dryRun) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      }
      written.push(relative(opts.cwd, abs));
    }
  }

  return { written, skipped, dryRun: opts.dryRun === true };
}
