import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, VisualMismatchError, ErrorCode, CraftdriverError } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';
import { PNG } from 'pngjs';

describe('expectScreenshot (browser)', () => {
  let browser: Browser;
  let dir: string;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.setViewportSize({ width: 800, height: 600 });
    dir = await mkdtemp(join(tmpdir(), 'craftdriver-visual-'));
  });

  afterAll(async () => {
    await browser.quit();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/screenshot.html`);
  });

  it('a baseline of a static element matches itself', async () => {
    const baseline = join(dir, 'section.png');
    // Let element rendering settle before baselining — the very first element
    // capture after navigation can differ from later stable ones (fonts/layout).
    await browser.screenshot({ selector: '#s1' });
    await browser.screenshot({ selector: '#s1', path: baseline });
    const result = await browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' } });
    expect(result.matches).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('auto-creates a full-page baseline through settling, then matches it', async () => {
    const baseline = join(dir, 'full.png');
    // No manual screenshot()/warm-up — the first assertion must handle the
    // settling itself. On Linux, Chromium's first full-page BiDi capture can hide
    // the classic scrollbar and expand the document from 785px to the 800px
    // viewport; the create path captures until two consecutive frames match, so
    // it writes the stabilized layout rather than that first transient frame.
    const created = await browser.expectScreenshot(baseline, { screenshot: { fullPage: true } });
    expect(created.baseline).toBe('created');
    expect(created.matches).toBe(true);

    // A second run compares against the settled baseline rather than recreating it.
    const matched = await browser.expectScreenshot(baseline, { screenshot: { fullPage: true } });
    expect(matched.baseline).toBe('matched');
  });

  it('a viewport baseline matches itself', async () => {
    const baseline = join(dir, 'viewport.png');
    await browser.screenshot({ path: baseline });
    const result = await browser.expectScreenshot(baseline);
    expect(result.matches).toBe(true);
  });

  it('auto-creates a missing baseline (no manual bootstrap), then matches it', async () => {
    const baseline = join(dir, 'auto-created.png');
    // No prior screenshot() call — the first assertion writes the baseline itself.
    const created = await browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' } });
    expect(created.baseline).toBe('created');
    expect(created.matches).toBe(true);

    // A real PNG now exists on disk…
    const bytes = await readFile(baseline);
    expect(PNG.sync.read(bytes).width).toBeGreaterThan(0);

    // …and a second run compares against it rather than recreating it.
    const matched = await browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' } });
    expect(matched.baseline).toBe('matched');
  });

  it('overwrites a differing baseline only under CRAFTDRIVER_UPDATE_VISUAL_BASELINES', async () => {
    const baseline = join(dir, 'auto-updated.png');
    await browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' } }); // creates it
    const before = await readFile(baseline);

    await browser.evaluate(() => {
      const el = document.querySelector('#s1') as HTMLElement | null;
      if (el) el.style.background = 'magenta';
    });

    // Without the flag, the change fails and the baseline is left untouched.
    await expect(
      browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' }, timeout: 500 })
    ).rejects.toBeInstanceOf(VisualMismatchError);
    expect((await readFile(baseline)).equals(before)).toBe(true);

    // With the flag, the same change is accepted and the baseline is rewritten.
    const prev = process.env.CRAFTDRIVER_UPDATE_VISUAL_BASELINES;
    process.env.CRAFTDRIVER_UPDATE_VISUAL_BASELINES = 'true';
    try {
      const updated = await browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' }, timeout: 500 });
      expect(updated.baseline).toBe('updated');
    } finally {
      if (prev === undefined) delete process.env.CRAFTDRIVER_UPDATE_VISUAL_BASELINES;
      else process.env.CRAFTDRIVER_UPDATE_VISUAL_BASELINES = prev;
    }
    expect((await readFile(baseline)).equals(before)).toBe(false);

    // The rewritten baseline now matches the changed page.
    const matched = await browser.expectScreenshot(baseline, { screenshot: { selector: '#s1' }, timeout: 500 });
    expect(matched.baseline).toBe('matched');
  });

  it('a real visual change throws VisualMismatchError with actual + diff buffers', async () => {
    const baseline = join(dir, 'change.png');
    await browser.screenshot({ selector: '#s1', path: baseline });

    // Repaint the section so its pixels no longer match the baseline.
    await browser.evaluate(() => {
      const el = document.querySelector('#s1') as HTMLElement | null;
      if (el) el.style.background = 'magenta';
    });

    const err = (await browser
      .expectScreenshot(baseline, { screenshot: { selector: '#s1' }, timeout: 500 })
      .catch((e: unknown) => e)) as VisualMismatchError;

    expect(err).toBeInstanceOf(VisualMismatchError);
    expect(err.code).toBe(ErrorCode.VISUAL_MISMATCH);
    expect(Buffer.isBuffer(err.actual)).toBe(true);
    expect(Buffer.isBuffer(err.diff)).toBe(true);
    // The diff PNG must decode and report the same dimensions the browser produced.
    const diff = PNG.sync.read(err.diff);
    expect(diff.width).toBeGreaterThan(0);
    expect(err.comparison.diffPixels).toBeGreaterThan(0);
  });

  it('auto-retries until a changed element reverts to the baseline', async () => {
    const baseline = join(dir, 'revert.png');
    await browser.screenshot({ selector: '#s1' }); // settle before baselining
    await browser.screenshot({ selector: '#s1', path: baseline });

    const original = (await browser.evaluate(() => {
      const el = document.querySelector('#s1') as HTMLElement;
      const prev = el.style.background;
      el.style.background = 'magenta';
      return prev;
    })) as string;
    expect(typeof original).toBe('string');

    // Revert only after the assertion has captured the changed frame. A fixed
    // timer made this test load-sensitive: when the first browser screenshot
    // took longer than the timer, it legitimately matched on attempt one.
    const screenshot = browser.screenshot.bind(browser);
    let assertionCaptures = 0;
    const screenshotSpy = vi.spyOn(browser, 'screenshot').mockImplementation(async (options) => {
      const image = await screenshot(options);
      assertionCaptures++;
      if (assertionCaptures === 1) {
        await browser.evaluate((background) => {
          const el = document.querySelector('#s1') as HTMLElement;
          el.style.background = background;
        }, original);
      }
      return image;
    });

    try {
      const result = await browser.expectScreenshot(baseline, {
        screenshot: { selector: '#s1' },
        timeout: 5000,
      });
      expect(result.matches).toBe(true);
      expect(result.attempts).toBeGreaterThan(1);
    } finally {
      screenshotSpy.mockRestore();
    }
  });

  it('full-page comparison propagates the existing BiDi requirement on a Classic-only session', async () => {
    const noBidi = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await noBidi.setViewportSize({ width: 800, height: 600 });
      await noBidi.navigateTo(`${baseUrl}/screenshot.html`);
      // A baseline must exist so the failure comes from capture, not disk.
      const baseline = join(dir, 'classic.png');
      await noBidi.screenshot({ path: baseline });
      // Full-page capture surfaces the same error as browser.screenshot({ fullPage: true }).
      await expect(
        noBidi.expectScreenshot(baseline, { screenshot: { fullPage: true } })
      ).rejects.toThrow(/requires BiDi/);
    } finally {
      await noBidi.quit();
    }
  });

  it('selector capture at timeout 0 still captures a present element (no spurious TIMEOUT)', async () => {
    const baseline = join(dir, 'zero.png');
    await browser.screenshot({ selector: '#s1' }); // settle
    await browser.screenshot({ selector: '#s1', path: baseline });
    // timeout 0 leaves ~0 ms of visibility-wait budget; a present element must
    // still be captured on the immediate check rather than throwing TIMEOUT.
    const result = await browser.expectScreenshot(baseline, {
      screenshot: { selector: '#s1' },
      timeout: 0,
    });
    expect(result.matches).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('rejects a malformed screenshot scope at runtime', async () => {
    const baseline = join(dir, 'viewport.png');
    await browser.screenshot({ path: baseline });
    const err = (await browser
      .expectScreenshot(baseline, {
        // @ts-expect-error — fullPage must be a boolean.
        screenshot: { fullPage: 'yes' },
      })
      .catch((e: unknown) => e)) as CraftdriverError;
    expect(err.code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('rejects fullPage + selector at runtime for JavaScript callers', async () => {
    const baseline = join(dir, 'viewport.png');
    await browser.screenshot({ path: baseline });
    const err = (await browser
      .expectScreenshot(baseline, {
        // @ts-expect-error — the TS union forbids this; we assert the runtime guard too.
        screenshot: { fullPage: true, selector: '#s1' },
      })
      .catch((e: unknown) => e)) as CraftdriverError;
    expect(err.code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});
