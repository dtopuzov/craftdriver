/**
 * Tab/page targeting.
 *
 * Before this, the CLI could *see* a second tab via `pages` but could not
 * act on it — every command stayed pinned to whichever window the driver
 * happened to have focused, so a popup's content was simply unreachable.
 * An agent could tell something had opened and had no way to work with it.
 *
 * The contract here: selection is explicit, ambiguity fails closed rather
 * than guessing a tab, and switching or closing a tab drops the ref
 * registry — a ref issued against the old document must never resolve
 * against the new one.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { AgentSession } from '../../src/cli/agentSession';
import { ErrorCode } from '../../src/lib/errors';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface PageList {
  pages: Array<{ index: number; id: string; url: string; title: string }>;
  count: number;
  active: string | null;
}

describe('page targeting', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/popup.html` } });
    // Collapse back to a single tab so each test starts from a known state.
    const list = (await session.run({ cmd: 'page', args: { action: 'list' } })) as PageList;
    for (const page of list.pages.slice(1)) {
      await session.run({ cmd: 'page', args: { action: 'close', target: page.id } });
    }
  });

  it('lists open pages and marks the active one', async () => {
    await session.run({ cmd: 'click', args: { selector: '#open-popup' } });

    const list = (await session.run({ cmd: 'page', args: { action: 'list' } })) as PageList;
    expect(list.count).toBe(2);
    expect(list.active).toBe(list.pages[0].id);
    expect(list.pages[1].url).toContain('popup-target.html');
  });

  it('reaches content in a second tab only after selecting it', async () => {
    await session.run({ cmd: 'click', args: { selector: '#open-popup' } });

    // Pinned to the opener until told otherwise.
    const before = await session
      .run({ cmd: 'text', args: { selector: '#popup-heading' } })
      .catch((e: unknown) => e);
    expect((before as { code?: string }).code).toBe(ErrorCode.NO_MATCH);

    await session.run({ cmd: 'page', args: { action: 'select', target: 1 } });
    const after = (await session.run({
      cmd: 'text',
      args: { selector: '#popup-heading' },
    })) as { text: string };
    expect(after.text).toBe('Popup Window');
  });

  it('selects by page id as well as index', async () => {
    await session.run({ cmd: 'click', args: { selector: '#open-popup' } });
    const list = (await session.run({ cmd: 'page', args: { action: 'list' } })) as PageList;

    const selected = (await session.run({
      cmd: 'page',
      args: { action: 'select', target: list.pages[1].id },
    })) as { id: string };
    expect(selected.id).toBe(list.pages[1].id);
  });

  it('opens a tab and makes it the target', async () => {
    const opened = (await session.run({
      cmd: 'page',
      args: { action: 'open', url: `${EXAMPLES_BASE_URL}/popup-target.html` },
    })) as { id: string; url: string };
    expect(opened.url).toContain('popup-target.html');

    const text = (await session.run({
      cmd: 'text',
      args: { selector: '#popup-heading' },
    })) as { text: string };
    expect(text.text).toBe('Popup Window');
  });

  it('closes a tab and reports what is left', async () => {
    await session.run({ cmd: 'click', args: { selector: '#open-popup' } });

    const closed = (await session.run({
      cmd: 'page',
      args: { action: 'close', target: 1 },
    })) as { remaining: number };
    expect(closed.remaining).toBe(1);

    // The surviving tab is still usable — a close must not leave the
    // driver pointing at a window that no longer exists.
    const text = (await session.run({
      cmd: 'text',
      args: { selector: '#popup-result' },
    })) as { text: string };
    expect(typeof text.text).toBe('string');
  });

  it('drops refs when the target tab changes', async () => {
    const snap = (await session.run({ cmd: 'snapshot' })) as { lines: string[] };
    const ref = /^(e\d+):/.exec(snap.lines[0].trim())![1];

    await session.run({ cmd: 'page', args: { action: 'open' } });

    // The ref belongs to the previous document; it must not resolve here.
    const error = await session
      .run({ cmd: 'click', args: { selector: `ref=${ref}` } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.STALE_REF);
  });

  it.each([
    ['an out-of-range index', { action: 'select', target: 99 }],
    ['an unknown id', { action: 'select', target: 'not-a-real-handle' }],
  ])('fails closed on %s rather than guessing a tab', async (_label, args) => {
    const error = await session.run({ cmd: 'page', args }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.NO_MATCH);
  });

  it('requires a target for select', async () => {
    const error = await session
      .run({ cmd: 'page', args: { action: 'select' } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('rejects an unknown sub-action', async () => {
    const error = await session
      .run({ cmd: 'page', args: { action: 'teleport' } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});
