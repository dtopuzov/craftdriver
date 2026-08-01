import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

/**
 * PNG dimensions live in the IHDR chunk: bytes 16..23 are big-endian
 * width and height. We parse them directly so the test does not depend
 * on an image-processing library.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

describe('screenshots', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.setViewportSize({ width: 800, height: 600 });
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/screenshot.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('viewport screenshot matches client dimensions on scrolling and non-scrolling pages', async () => {
    const assertClientSize = async (): Promise<void> => {
      const page = await browser.activePage();
      const css = await page.evaluate<{
        width: number;
        height: number;
        dpr: number;
      }>(`return {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        dpr: devicePixelRatio,
      }`);
      expect(pngSize(await browser.screenshot())).toEqual({
        width: Math.round(css.width * css.dpr),
        height: Math.round(css.height * css.dpr),
      });
    };

    // The fixture is 6000px tall, so its classic scrollbar reduces clientWidth.
    await assertClientSize();
    await browser.setContent(
      `<!doctype html><title>Short page</title><p>Fits in the viewport.</p>`
    );
    await assertClientSize();
  });

  it('fullPage screenshot covers the entire scrollable document', async () => {
    const viewportBuf = await browser.screenshot();
    const fullBuf = await browser.screenshot({ fullPage: true });
    const v = pngSize(viewportBuf);
    const f = pngSize(fullBuf);

    // Both images must have positive dimensions.
    expect(v.width).toBeGreaterThan(0);
    expect(f.width).toBeGreaterThan(0);
    // Full-page must be dramatically taller than the viewport image.
    // (The two captures use different code paths — Classic returns
    // device pixels, BiDi returns CSS pixels — so we don't compare
    // widths directly. The fixture is exactly 6000 CSS px tall, so
    // even with 1x scaling the full-page image must dwarf the viewport.)
    expect(f.height).toBeGreaterThan(v.height * 3);
    // Sanity: we should be in the same order of magnitude as the
    // document height (6000 CSS px), allowing for HiDPI scaling.
    expect(f.height).toBeGreaterThanOrEqual(5000);
    expect(f.height).toBeLessThanOrEqual(20000);
  });

  it('fullPage and selector are mutually exclusive', async () => {
    await expect(browser.screenshot({ fullPage: true, selector: '#s1' })).rejects.toThrow(
      /mutually exclusive/
    );
  });

  it('selector screenshot returns just the element', async () => {
    const buf = await browser.screenshot({ selector: '#s1' });
    const { width, height } = pngSize(buf);
    // Section is 600 CSS px tall; allow HiDPI scaling. Must be smaller
    // than a full-page capture and roughly section-sized.
    expect(height).toBeGreaterThan(100);
    expect(height).toBeLessThan(2500);
    expect(width).toBeGreaterThan(0);
  });
});
