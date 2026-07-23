/**
 * Regression: snapshot refs must bind to element identity.
 *
 * Before the fix, `snapshot` wiped every marker and re-stamped `eN` in
 * document order, so a ref an agent captured before a mutation silently
 * pointed at a *different* element afterwards — the worst possible failure
 * mode, because the agent's next click lands somewhere it never inspected.
 *
 * The contract these tests pin down:
 *   - a surviving node keeps its ref across snapshots;
 *   - a new node gets a fresh, monotonically increasing ref;
 *   - a removed / navigated-away / never-issued ref fails STALE_REF rather
 *     than resolving to whatever now occupies that position.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { AgentSession } from '../../src/cli/agentSession';
import { Browser } from '../../src/lib/browser';
import { takeSnapshot } from '../../src/cli/snapshot';
import { ErrorCode } from '../../src/lib/errors';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface SnapshotResult {
  url: string;
  title: string;
  lines: string[];
  documentId: string;
  revision: number;
}

/** Map "role/name text" -> ref, from the `eN: role "name" hint` line form. */
function refsByBody(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines) {
    const m = /^(e\d+):\s*(.*)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Look an element up by its trailing locator hint (`#pay`), not by name.
 * A container's accessible name concatenates its children's text, so
 * matching on "Pay now" finds the enclosing <form> first.
 */
function refFor(lines: string[], hint: string): string {
  for (const [body, ref] of refsByBody(lines)) {
    if (new RegExp(`\\s${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(body)) {
      return ref;
    }
  }
  throw new Error(`no snapshot line with hint ${JSON.stringify(hint)} in:\n${lines.join('\n')}`);
}

describe('agent snapshot refs bind to element identity', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/agent-ref-shift.html` } });
  });

  it('keeps a surviving element on the same ref after a DOM reorder', async () => {
    const first = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const payRef = refFor(first.lines, '#pay');

    // Inserts a help link *above* the form: every following element shifts.
    await session.run({ cmd: 'click', args: { selector: '#apply' } });

    const second = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    expect(refFor(second.lines, '#pay')).toBe(payRef);

    // And the ref still drives the element the agent actually inspected.
    const value = (await session.run({
      cmd: 'text',
      args: { selector: `ref=${payRef}` },
    })) as { text: string };
    expect(value.text).toContain('Pay now');
  });

  it('gives a newly inserted element a fresh ref, never a recycled one', async () => {
    const first = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const before = new Set(refsByBody(first.lines).values());

    await session.run({ cmd: 'click', args: { selector: '#apply' } });

    const second = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const helpRef = refFor(second.lines, '#help');
    expect(before.has(helpRef)).toBe(false);
    expect(second.revision).toBeGreaterThan(first.revision);
  });

  it('fails STALE_REF when the referenced element is gone', async () => {
    const first = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const payRef = refFor(first.lines, '#pay');

    await session.run({ cmd: 'click', args: { selector: '#remove-pay' } });

    const error = await session
      .run({ cmd: 'click', args: { selector: `ref=${payRef}` } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.STALE_REF);
  });

  it('fails STALE_REF for a ref issued against a previous document', async () => {
    const first = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const payRef = refFor(first.lines, '#pay');

    await session.run({ cmd: 'reload' });

    const error = await session
      .run({ cmd: 'click', args: { selector: `ref=${payRef}` } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.STALE_REF);
  });

  it('fails STALE_REF for a ref that was never issued', async () => {
    await session.run({ cmd: 'snapshot' });

    const error = await session
      .run({ cmd: 'click', args: { selector: 'ref=e9999' } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.STALE_REF);
  });

  // parseSelector lowercases the prefix and trims the value, so these are
  // all refs. Validating a narrower set would let them through unchecked,
  // falling back to the raw attribute lookup that rebinds silently.
  it.each(['REF=e9999', 'ref= e9999', ' ref=e9999 '])(
    'validates %s as a ref rather than letting it bypass the check',
    async (selector) => {
      await session.run({ cmd: 'snapshot' });
      const error = await session
        .run({ cmd: 'click', args: { selector } })
        .catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe(ErrorCode.STALE_REF);
    },
  );

  it('changes document identity on navigation to the same URL', async () => {
    const first = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    await session.run({ cmd: 'reload' });
    const second = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;

    expect(second.documentId).not.toBe(first.documentId);
  });

  it('walks open shadow trees and drives nested descendants by exact ref identity', async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/shadow-dom.html` } });
    const snap = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;

    // The primary card contributes two nested boundaries; the asynchronously
    // inserted card may already exist by the time the snapshot runs and add two
    // more. Either way, every traversed open boundary is explicit.
    expect(snap.lines.filter((line) => line.includes('#shadow-root (open)')).length)
      .toBeGreaterThanOrEqual(2);
    expect(snap.lines.some((line) => line.includes('closed-false-positive'))).toBe(false);
    expect(snap.lines.filter((line) => line.includes('#slotted-summary'))).toHaveLength(1);
    expect(snap.lines.filter((line) => line.includes('#slotted-image'))).toHaveLength(1);

    const cityRef = refFor(snap.lines, '#city');
    const saveRef = refFor(snap.lines, '#nested-save');
    await session.run({ cmd: 'fill', args: { selector: `ref=${cityRef}`, value: 'Sofia' } });
    await session.run({ cmd: 'click', args: { selector: `ref=${saveRef}` } });

    const status = (await session.run({
      cmd: 'text',
      args: { selector: '#status' },
    })) as { text: string };
    expect(status.text).toBe('saved:Sofia');
  });

  it('does not let a cloned diagnostic marker make a live ref ambiguous', async () => {
    const snap = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const payRef = refFor(snap.lines, '#pay');

    await session.run({
      cmd: 'eval',
      args: {
        js: `const clone = document.querySelector('#pay').cloneNode(true); clone.id = 'pay-clone'; document.body.appendChild(clone); return true;`,
      },
    });

    const value = (await session.run({
      cmd: 'text',
      args: { selector: `ref=${payRef}` },
    })) as { text: string };
    expect(value.text).toContain('Pay now');
  });
});

/**
 * The per-document ref cap is bounded by how many refs *this registry*
 * issued, not by the counter value.
 *
 * The counter is seeded from the session-wide high-water mark so numbers
 * are never reused across documents. Comparing that counter against the
 * cap meant a long session — roughly 25 navigations of a busy page — put
 * it permanently over the limit, so every snapshot re-keyed the document
 * and every ref went stale the instant it was handed out.
 */
describe('ref registry bounds', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/agent-ref-shift.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('keeps one document identity when the high-water mark exceeds the cap', async () => {
    const first = await takeSnapshot(browser, 2500);
    const second = await takeSnapshot(browser, 2500);

    expect(first).not.toBeNull();
    expect(second!.documentId).toBe(first!.documentId);
  });

  it('seeds a new document above the high-water mark instead of restarting at e1', async () => {
    // A fresh document, so every ref is newly issued. (Within one
    // document surviving nodes keep their existing refs, which is the
    // whole point of the registry — so this has to navigate to observe
    // the seeding.)
    await browser.reload();

    const snap = await takeSnapshot(browser, 5000);
    expect(snap!.refs.length).toBeGreaterThan(0);
    const numbers = snap!.refs.map((r) => Number(r.slice(1)));
    expect(Math.min(...numbers)).toBeGreaterThan(5000);
  });
});
