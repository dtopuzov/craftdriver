// Runnable proof for docs/recipes/ask-an-agent-to-write-a-test.md.
//
// This recipe is prompt-first, and prompts are not deterministically
// testable — no attempt is made here to assert model behavior. What IS testable
// is every capability claim the recipe makes on CraftDriver's behalf, because
// those are what make an agent's output better than a guess:
//
//   1. `snapshot` returns role + accessible name per element (the block the
//      shell recipe prints verbatim);
//   2. `locators` returns candidates re-checked against the live page, with the
//      role/name candidate ranked `best`, and never a ref;
//   3. the console and network journal explain a failure the DOM does not (the
//      bug-report prompt);
//   4. `browser.a11y.audit()` reports violations with the elements they point
//      at (the accessibility prompt).
//
// If any of those stops being true, the recipe is selling something the tool
// does not do, and this fails.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser } from '../../src';
import { AgentSession } from '../../src/cli/agentSession';
import type { JournalEntry } from '../../src/cli/journal';
import type { LocatorReport } from '../../src/cli/locatorCandidates';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const LOGIN = `${EXAMPLES_BASE_URL}/login.html`;
const CHECKOUT = `${EXAMPLES_BASE_URL}/agent-debug.html`;
const A11Y = `${EXAMPLES_BASE_URL}/a11y.html`;

interface SnapshotResult { lines: string[] }
interface LogsPage { entries: JournalEntry[] }

describe('what an agent can actually learn about a page', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('reads the accessibility tree, not raw HTML', async () => {
    await session.run({ cmd: 'go', args: { url: LOGIN } });
    const snapshot = (await session.run({ cmd: 'snapshot', args: {} })) as SnapshotResult;

    // The recipe prints this block. Role + accessible name is what lets an
    // agent write a semantic locator instead of a structural guess.
    expect(snapshot.lines).toEqual([
      'e1: heading "Login"',
      'e2: form "Username Password Sign in" #login-form',
      'e3: label "Username"',
      'e4: textbox "Username" #username',
      'e5: label "Password"',
      'e6: input "Password" #password',
      'e7: button "Sign in" #submit',
    ]);
  }, 120_000);

  it('converts an element into locators it has re-checked against the page', async () => {
    await session.run({ cmd: 'go', args: { url: LOGIN } });
    const snapshot = (await session.run({ cmd: 'snapshot', args: {} })) as SnapshotResult;

    // Read the ref out of the snapshot the way an agent does. Hardcoding `e7`
    // would pass only on a first navigation: refs are never reused, so the
    // second visit to the same URL numbers the same button differently.
    const ref = snapshot.lines.find((line) => line.includes('button "Sign in"'))?.split(':')[0];
    expect(ref).toMatch(/^e\d+$/);

    const report = (await session.run({
      cmd: 'locators',
      args: { selector: `ref=${ref}` },
    })) as LocatorReport;

    expect(report.best).toBe('role=button[name=Sign in]');
    expect(report.candidates[0].code).toBe('By.role("button", { name: "Sign in" })');
    // "Every ✓ matched exactly one element just now" is the recipe's claim, and
    // the reason its review checklist can say "no ref=eN in the source".
    for (const candidate of report.candidates) {
      expect(candidate.status).toBe('unique');
      expect(candidate.matches).toBe(1);
      expect(candidate.selector).not.toContain('ref=');
    }
  }, 120_000);

  it('the journal explains a failure the DOM does not', async () => {
    await session.run({ cmd: 'go', args: { url: CHECKOUT } });
    await session.run({ cmd: 'logs', args: { action: 'clear' } });
    await session.run({ cmd: 'fill', args: { selector: '#email', value: 'alice@example.test' } });
    await session.run({ cmd: 'click', args: { selector: '#place-order' } });

    // What the user sees, and why the bug report is unactionable.
    const status = (await session.run({
      cmd: 'text',
      args: { selector: '#status' },
    })) as { text: string };
    expect(status.text).toMatch(/went wrong/i);

    // What the agent sees instead.
    const found = (await session.run({
      cmd: 'logs',
      args: { action: 'wait', contains: 'checkout failed', kind: 'error', timeout_ms: 10_000 },
    })) as { entry: { text?: string } };
    expect(found.entry.text).toMatch(/checkout failed: HTTP \d+ from \/api\/checkout/);

    // Console and network events arrive independently, so wait for the
    // completed response before asserting that the journal carries both sides
    // of the diagnosis promised by the recipe.
    await session.run({
      cmd: 'logs',
      args: {
        action: 'wait',
        kind: 'response',
        contains: '/api/checkout',
        timeout_ms: 10_000,
      },
    });
    const responses = (await session.run({
      cmd: 'logs',
      args: { action: 'list', kind: 'response', contains: '/api/checkout' },
    })) as LogsPage;
    expect(
      responses.entries.some(
        (entry) => entry.kind === 'response' && (entry.status ?? 0) >= 400,
      ),
    ).toBe(true);
  }, 120_000);
});

describe('the accessibility prompt', () => {
  it('audit() reports violations with the elements they point at', async () => {
    const browser = await Browser.launch({ browserName: BROWSER_NAME });
    try {
      await browser.navigateTo(A11Y);

      const report = await browser.a11y.audit();

      // The recipe asks the agent to "list the serious and critical violations
      // with the elements they point at", so both halves have to be there.
      expect(Array.isArray(report.violations)).toBe(true);
      expect(report.violations.length).toBeGreaterThan(0);
      for (const violation of report.violations) {
        expect(violation.id).toBeTruthy();
        expect(['serious', 'critical']).toContain(violation.impact);
        expect(violation.nodes.length).toBeGreaterThan(0);
      }

      // And check() is the gate the recipe tells them to add.
      await expect(browser.a11y.check()).rejects.toThrow();
    } finally {
      await browser.quit();
    }
  }, 120_000);
});
