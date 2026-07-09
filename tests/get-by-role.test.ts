import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

// Regression coverage for By.role resolving IMPLICIT ARIA roles, not just an
// explicit role= attribute (matches Playwright/wdio getByRole).
describe('getByRole — implicit ARIA roles', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('matches a native <button> by its text', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    await browser.getByLabel('Username').fill('alice');
    await browser.getByLabel('Password').fill('secret');
    await browser.getByRole('button', { name: 'Sign in' }).click();
    await browser.expect('#welcome').toContainText('Welcome back, alice!');
  });

  it('matches a native heading by its text', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    expect(await browser.getByRole('heading', { name: 'Login' }).tagName()).toBe('h1');
  });

  it('still matches an explicit role= attribute', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    // <div role="button" aria-label="Aria Name" id="by-role">button aria</div>
    expect(await browser.getByRole('button', { name: 'Aria Name' }).getAttribute('id')).toBe(
      'by-role'
    );
  });

  it('supports substring name matching with { exact: false }', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    expect(await browser.getByRole('button', { name: 'Sign', exact: false }).tagName()).toBe(
      'button'
    );
  });

  it('matches common accessible-name sources for form controls', async () => {
    await browser.setContent(`
      <!doctype html>
      <label for="email">Email</label>
      <input id="email" type="email" />
      <label>Remember me <input id="remember" type="checkbox" /></label>
    `);

    expect(await browser.getByRole('textbox', { name: 'Email' }).getAttribute('id')).toBe(
      'email'
    );
    expect(await browser.getByRole('checkbox', { name: 'Remember me' }).getAttribute('id')).toBe(
      'remember'
    );
  });

  it('matches a simple aria-labelledby accessible name', async () => {
    await browser.setContent(`
      <!doctype html>
      <button id="save" aria-labelledby="save-label"></button>
      <span id="save-label">Save draft</span>
    `);

    expect(await browser.getByRole('button', { name: 'Save draft' }).getAttribute('id')).toBe(
      'save'
    );
  });

  it('does not match a native implicit role when an explicit role overrides it', async () => {
    await browser.setContent(`
      <!doctype html>
      <a id="menu-action" href="#" role="button">Open menu</a>
    `);

    expect(await browser.locator(By.role('button', { name: 'Open menu' })).count()).toBe(1);
    expect(await browser.locator(By.role('link', { name: 'Open menu' })).count()).toBe(0);
  });

  it('uses the first explicit role token for multi-token role attributes', async () => {
    await browser.setContent(`
      <!doctype html>
      <a id="multi-role" href="#" role="button link">Open menu</a>
    `);

    expect(await browser.locator(By.role('button', { name: 'Open menu' })).count()).toBe(1);
    expect(await browser.locator(By.role('link', { name: 'Open menu' })).count()).toBe(0);
  });

  it('maps a plain <select> to combobox, not listbox', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    const comboIds = await browser
      .locator(By.role('combobox'))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(comboIds).toContain('single-select');
    expect(comboIds).not.toContain('multi-select');
  });

  it('maps a <select multiple> to listbox, not combobox', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    const listboxIds = await browser
      .locator(By.role('listbox'))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(listboxIds).toContain('multi-select');
    expect(listboxIds).not.toContain('single-select');
  });

  it('maps a standalone <header> to banner but not a <header> nested in <article>', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    const bannerIds = await browser
      .locator(By.role('banner'))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(bannerIds).toContain('page-header');
    expect(bannerIds).not.toContain('article-header');
  });

  it('uses the first ancestor role token when mapping header/banner', async () => {
    await browser.setContent(`
      <!doctype html>
      <div role="region navigation"><header id="nested-header">Nested</header></div>
      <header id="page-header">Page</header>
    `);

    const bannerIds = await browser
      .locator(By.role('banner'))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(bannerIds).toEqual(['page-header']);
  });

  it('maps a standalone <footer> to contentinfo but not a <footer> nested in <article>', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    const contentinfoIds = await browser
      .locator(By.role('contentinfo'))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(contentinfoIds).toContain('page-footer');
    expect(contentinfoIds).not.toContain('article-footer');
  });

  it('excludes an element under an aria-hidden ancestor by default', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    // #hidden-btn sits inside <div aria-hidden="true">; #visible-btn does not.
    // Both are visually rendered and share the accessible name "Ghost".
    const ids = await browser
      .locator(By.role('button', { name: 'Ghost' }))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(ids).toEqual(['visible-btn']);
  });

  it('includes ancestor-hidden elements with includeHidden: true', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
    const ids = await browser
      .locator(By.role('button', { name: 'Ghost', includeHidden: true }))
      .all()
      .then((hs) => Promise.all(hs.map((h) => h.getAttribute('id'))));
    expect(ids).toContain('hidden-btn');
    expect(ids).toContain('visible-btn');
  });
});
