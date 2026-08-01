/** Content evidence must stay useful without hiding controls or values. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../../src/lib/browser';
import { renderDelta, takeSnapshot } from '../../src/cli/snapshot';
import { BROWSER_NAME } from '../utils';

describe('agent snapshot content bounds', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('does not let short prose consume the semantic-control budget', async () => {
    const paragraphs = Array.from(
      { length: 90 },
      (_, i) => `<p>Short introduction ${i + 1}</p>`
    ).join('');
    await browser.setContent(`<!doctype html>${paragraphs}
      <form id="signup">
        <label for="email">Email</label><input id="email">
        <button id="subscribe">Subscribe</button>
      </form>`);

    const snap = await takeSnapshot(browser, 0);
    expect(snap).not.toBeNull();
    expect(snap!.lines.filter((line) => line.includes(': text "'))).toHaveLength(7);
    expect(snap!.lines.some((line) => line.includes('#email'))).toBe(true);
    expect(snap!.lines.some((line) => line.includes('#subscribe'))).toBe(true);
  });

  it('reserves text capacity for evidence after preceding short prose', async () => {
    const tips = Array.from(
      { length: 12 },
      (_, i) => `<p>Tip ${i + 1}: keep your profile up to date.</p>`
    ).join('');
    await browser.setContent(`<!doctype html><title>Settings</title>${tips}
      <button id="save">Save</button>
      <output id="status"></output><p id="log"></p>`);
    const before = await takeSnapshot(browser, 0);

    const page = await browser.activePage();
    await page.evaluate(`
      document.querySelector('#status').textContent = 'Saved successfully';
      document.querySelector('#log').textContent = 'saved';
    `);
    const after = await takeSnapshot(browser, 0);
    const delta = renderDelta(before, after);

    expect(after!.lines.some((line) => line.includes('Saved successfully'))).toBe(true);
    expect(after!.lines.some((line) => line.includes('text "saved" #log'))).toBe(true);
    expect(delta).toContain('Saved successfully');
    expect(delta).toContain('text "saved" #log');
    expect(delta).not.toContain('(no a11y changes)');
  });

  it('preserves multiple evidence lines after ordinary text is exhausted', async () => {
    const hints = Array.from({ length: 8 }, (_, i) => `<p>Helpful form hint ${i + 1}</p>`).join('');
    const errors = Array.from({ length: 5 }, (_, i) => `<p id="field-${i + 1}-error"></p>`).join(
      ''
    );
    await browser.setContent(`<!doctype html>${hints}${errors}`);
    const before = await takeSnapshot(browser, 0);

    const page = await browser.activePage();
    await page.evaluate(`
      for (let i = 1; i <= 5; i += 1) {
        document.querySelector('#field-' + i + '-error').textContent = 'Field ' + i + ' is required';
      }
    `);
    const after = await takeSnapshot(browser, 0);
    const delta = renderDelta(before, after);

    const errorLines = after!.lines.filter((line) => line.includes('is required'));
    expect(errorLines).toHaveLength(5);
    expect(delta).toContain('Field 5 is required');
  });

  it('drops long prose but preserves purpose-built evidence', async () => {
    const long = 'Background prose '.repeat(20);
    await browser.setContent(`<!doctype html>
      <p id="article">${long}</p>
      <output id="result">Important result ${long}</output>
      <button id="continue">Continue</button>`);

    const snap = await takeSnapshot(browser, 0);
    expect(snap).not.toBeNull();
    expect(snap!.lines.some((line) => line.includes('#article'))).toBe(false);
    expect(snap!.lines.some((line) => line.includes('Important result'))).toBe(true);
    expect(snap!.lines.some((line) => line.includes('#continue'))).toBe(true);
  });

  it('suppresses noisy defaults and common secret-like field values', async () => {
    await browser.setContent(`<!doctype html><form>
      <label><input id="terms" type="checkbox">Accept terms</label>
      <label><input id="red" type="radio" name="colour">Red</label>
      <input id="otp" autocomplete="one-time-code" value="483920">
      <input id="card" autocomplete="cc-number" value="4242424242424242">
      <textarea id="apiKey">sk-example-secret</textarea>
      <label for="labelledOtp">One-Time Code</label>
      <input id="labelledOtp" value="991122">
      <label for="labelledCard">Credit card</label>
      <input id="labelledCard" value="4000000000000002">
      <label for="labelledApi">API key</label>
      <textarea id="labelledApi">sk-labelled-secret</textarea>
      <input id="ccNumber" value="4111111111111111">
      <label for="cc">Cc</label><input id="cc" value="copy@example.test">
      <input id="nickname" value="alice">
      <input id="send" type="submit" value="Send it">
    </form>`);

    const snap = await takeSnapshot(browser, 0);
    const text = snap!.lines.join('\n');
    expect(text).not.toContain('value="on"');
    expect(text).not.toContain('483920');
    expect(text).not.toContain('4242424242424242');
    expect(text).not.toContain('sk-example-secret');
    expect(text).not.toContain('991122');
    expect(text).not.toContain('4000000000000002');
    expect(text).not.toContain('sk-labelled-secret');
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('value="Send it"');
    expect(text).toContain('value="copy@example.test"');
    expect(text).toContain('value="alice"');
  });

  it('bounds long href annotations without removing named or nameless links', async () => {
    const longQuery = `?query=${'segment-'.repeat(20)}&page=2`;
    await browser.setContent(`<!doctype html><title>Links</title>
      <a id="named" href="https://example.test/search${longQuery}">Search results</a>
      <a id="nameless" aria-label="" style="display:block;width:10px;height:10px"
        href="https://example.test/download${longQuery}"></a>`);

    const snap = await takeSnapshot(browser, 0);
    const named = snap!.lines.find((line) => line.includes('#named'))!;
    const nameless = snap!.lines.find((line) => line.includes('#nameless'))!;
    expect(named).toContain('href=');
    expect(nameless).toContain('href=');
    const hrefFrom = (line: string): string => {
      const prefix = 'href="';
      const start = line.indexOf(prefix);
      expect(start).toBeGreaterThanOrEqual(0);
      const valueStart = start + prefix.length;
      const end = line.indexOf('"', valueStart);
      expect(end).toBeGreaterThan(valueStart);
      return line.slice(valueStart, end);
    };
    const namedHref = hrefFrom(named);
    const namelessHref = hrefFrom(nameless);

    expect(named).toMatch(/^e\d+: link "Search results"/);
    expect(nameless).toMatch(/^e\d+: link href=/);
    expect(namedHref).toHaveLength(80);
    expect(namelessHref).toHaveLength(80);
    expect(namedHref.endsWith('…')).toBe(true);
    expect(namelessHref.endsWith('…')).toBe(true);
  });

  it('omits empty bare aria-live targets until they contain evidence', async () => {
    await browser.setContent(`<!doctype html><title>Announcements</title>
      <button id="save">Save</button>
      <div id="announcement" aria-live="polite"></div>`);
    const before = await takeSnapshot(browser, 0);
    expect(before!.lines.some((line) => line.includes('#announcement'))).toBe(false);

    await (
      await browser.activePage()
    ).evaluate(`document.querySelector('#announcement').textContent = 'Saved successfully'`);
    const after = await takeSnapshot(browser, 0);

    expect(after!.lines.some((line) => line.includes('Saved successfully'))).toBe(true);
    expect(renderDelta(before, after)).toContain('Saved successfully');
  });
});
