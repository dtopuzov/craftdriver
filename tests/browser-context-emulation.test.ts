/**
 * BrowserContext — identity & device emulation (Milestone C).
 *
 * Real-world scenarios this exercises:
 *
 *   - "Render the German checkout in one context and the Japanese one
 *     in another — same browser session, no interference." → per-context
 *     `locale` and `timezoneId`.
 *   - "Stub the user's location to Berlin for the geofencing test." →
 *     per-context `geolocation` + `grantPermissions(['geolocation'])`.
 *   - "Don't make the test click through the browser's notification
 *     prompt." → per-context `grantPermissions(['notifications'])`.
 *
 * All Milestone-C setters are scoped via BiDi `userContexts: [<id>]`, so
 * pages opened **after** the override is set inherit it automatically —
 * no per-test plumbing for popups or programmatically opened tabs.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, type BrowserContext } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME, IS_CHROMIUM } from './utils';

type NewContextOptions = Parameters<Browser['newContext']>[0];

describe('BrowserContext identity & device (Milestone C)', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  async function withContext<T>(
    run: (ctx: BrowserContext) => Promise<T>,
    options?: NewContextOptions
  ): Promise<T> {
    const ctx = await browser.newContext(options);
    try {
      return await run(ctx);
    } finally {
      await ctx.close();
    }
  }

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  // ── Locale ──────────────────────────────────────────────────────────────

  it('newContext({ locale }) is reported by navigator.language and Intl', async () => {
    await withContext(
      async (ctx) => {
        const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
        const lang = await page.evaluate<string>(`return navigator.language;`);
        expect(lang).toBe('de-DE');

        // The locale should also drive Intl formatting (decimal comma in de-DE).
        const formatted = await page.evaluate<string>(
          `return new Intl.NumberFormat().format(1234.5);`
        );
        expect(formatted).toBe('1.234,5');
      },
      { locale: 'de-DE' }
    );
  });

  it('locale is isolated between contexts', async () => {
    const de = await browser.newContext({ locale: 'de-DE' });
    const ja = await browser.newContext({ locale: 'ja-JP' });
    try {
      const dePage = await de.newPage({ url: `${baseUrl}/login.html` });
      const jaPage = await ja.newPage({ url: `${baseUrl}/login.html` });
      const deLang = await dePage.evaluate<string>(`return navigator.language;`);
      const jaLang = await jaPage.evaluate<string>(`return navigator.language;`);
      expect(deLang).toBe('de-DE');
      expect(jaLang).toBe('ja-JP');
    } finally {
      await de.close();
      await ja.close();
    }
  });

  it('setLocale(null) clears the override at runtime', async () => {
    await withContext(
      async (ctx) => {
        const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
        expect(await page.evaluate<string>(`return navigator.language;`)).toBe('fr-FR');

        await ctx.setLocale(null);
        // Re-read after navigation so the page picks up the cleared override.
        await page.reload();
        const cleared = await page.evaluate<string>(`return navigator.language;`);
        expect(cleared).not.toBe('fr-FR');
      },
      { locale: 'fr-FR' }
    );
  });

  // ── Timezone ────────────────────────────────────────────────────────────

  it('newContext({ timezoneId }) shifts Date / Intl.DateTimeFormat', async () => {
    await withContext(
      async (ctx) => {
        const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
        // JST is UTC+9 year-round (no DST). getTimezoneOffset returns -540.
        const offset = await page.evaluate<number>(`return new Date().getTimezoneOffset();`);
        expect(offset).toBe(-540);

        const resolved = await page.evaluate<string>(
          `return Intl.DateTimeFormat().resolvedOptions().timeZone;`
        );
        expect(resolved).toBe('Asia/Tokyo');
      },
      { timezoneId: 'Asia/Tokyo' }
    );
  });

  it('setTimezone applies to a page opened later in the same context', async () => {
    await withContext(async (ctx) => {
      await ctx.setTimezone('Europe/Berlin');
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      const tz = await page.evaluate<string>(
        `return Intl.DateTimeFormat().resolvedOptions().timeZone;`
      );
      expect(tz).toBe('Europe/Berlin');
    });
  });

  // ── Geolocation + permissions ───────────────────────────────────────────

  // Geolocation needs an origin we can grant the permission for. Firefox's
  // BiDi geolocation coverage is the laggard today; gate just this test.
  it.skipIf(!IS_CHROMIUM)(
    'newContext({ geolocation }) is read by navigator.geolocation once permission is granted',
    async () => {
      await withContext(
        async (ctx) => {
          const origin = baseUrl;
          await ctx.grantPermissions(['geolocation'], { origin });
          const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
          const coords = await page.evaluate<{ lat: number; lon: number }>(`
          return new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(
              (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
              (err) => reject(new Error(err.message)),
              { timeout: 3000 }
            );
          });
        `);
          expect(coords.lat).toBeCloseTo(51.5074, 3);
          expect(coords.lon).toBeCloseTo(-0.1278, 3);
        },
        { geolocation: { latitude: 51.5074, longitude: -0.1278 } }
      );
    }
  );

  it('grantPermissions requires an origin', async () => {
    await withContext(async (ctx) => {
      // @ts-expect-error — testing the runtime guard
      await expect(ctx.grantPermissions(['geolocation'], {})).rejects.toThrow(/origin/);
    });
  });

  it('setGeolocation validates coordinates', async () => {
    await withContext(async (ctx) => {
      await expect(ctx.setGeolocation({ latitude: 200, longitude: 0 })).rejects.toThrow(/latitude/);
    });
  });

  // ── Closed-context safety ───────────────────────────────────────────────

  it('the Milestone-C setters throw after the context is closed', async () => {
    const ctx = await browser.newContext();
    await ctx.close();
    await expect(ctx.setLocale('de-DE')).rejects.toThrow(/closed/);
    await expect(ctx.setTimezone('UTC')).rejects.toThrow(/closed/);
    await expect(ctx.setGeolocation(null)).rejects.toThrow(/closed/);
    await expect(ctx.grantPermissions(['geolocation'], { origin: baseUrl })).rejects.toThrow(
      /closed/
    );
  });
});
