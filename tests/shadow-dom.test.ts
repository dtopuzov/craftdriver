import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Browser, By, CraftdriverError, ErrorCode } from '../src';
import { BROWSER_NAME, EXAMPLES_BASE_URL } from './utils';

describe('open Shadow DOM', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/shadow-dom.html`);
  });

  it('uses an explicit root boundary for CSS actions', async () => {
    const root = browser.locator('#card').shadowRoot();
    expect(await root.locator('.action').count()).toBe(2);
    expect(await root.locator('.missing').count()).toBe(0);
    await expect(root.locator('.missing').click({ timeout: 0 }))
      .rejects.toMatchObject({ code: ErrorCode.NO_MATCH });

    await root.locator('.action').first().click();
    await browser.expect('#status').toHaveText('edited');

    await root.locator('.action').last().click();
    await browser.expect('#status').toHaveText('deleted');
  });

  it('supports semantic locators and nested open roots', async () => {
    const card = browser.locator('#card').shadowRoot();
    expect(await card.getByRole('region', { name: 'Account' }).count()).toBe(1);
    expect(await card.getByText('Profile link').count()).toBe(1);
    expect(await card.getByAltText('User avatar').count()).toBe(1);
    expect(await card.locator(By.linkText('Profile link')).count()).toBe(1);

    const address = card
      .locator('address-form')
      .shadowRoot();

    const city = address.getByLabel('City');
    await city.fill('Sofia');
    await city.expect().toHaveValue('Sofia');
    expect(await address.getByPlaceholder('Enter city').count()).toBe(1);
    expect(await address.getByTitle('Delivery city').count()).toBe(1);
    expect(await address.getByTitle('Delivery city ').count()).toBe(0);
    expect(await address.getByText('Save address').count()).toBe(1);

    await address.getByRole('button', { name: 'Save address' }).click();
    await browser.expect('#status').toHaveText('saved:Sofia');
  });

  it('asserts focus inside a nested open shadow root', async () => {
    const address = browser
      .locator('#card')
      .shadowRoot()
      .locator('address-form')
      .shadowRoot();
    const city = address.getByLabel('City');

    await city.click();
    await city.expect().toBeFocused();
    await address.getByRole('button', { name: 'Save address' }).expect().not.toBeFocused();
  });

  it('applies hidden-role semantics across the shadow host boundary', async () => {
    const card = browser.locator('#card').shadowRoot();
    const page = await browser.activePage();
    await page.evaluate(`document.querySelector('#card').setAttribute('aria-hidden', 'true')`);

    expect(await card.getByRole('button', { name: 'Edit' }).count()).toBe(0);
    expect(await card.getByRole('button', { name: 'Edit', includeHidden: true }).count()).toBe(1);
  });

  it('supports page-bound roots and waits for an asynchronously inserted host', async () => {
    const page = await browser.activePage();
    const late = page.locator('#late-card').shadowRoot();

    await late.getByRole('button', { name: 'Fallback action' }).waitFor({ state: 'attached' });
    expect(await late.getByRole('button', { name: 'Fallback action' }).count()).toBe(1);
    await late.getByRole('button', { name: 'Edit' }).click();
    await page.expect('#status').toHaveText('edited');
  });

  it('supports the ElementHandle search style', async () => {
    const edit = browser.find('#card').shadowRoot().find(By.role('button', { name: 'Edit' }));
    await edit.click();
    await edit.expect().toBeVisible();
    expect(await browser.find('#status').text()).toBe('edited');
  });

  it('re-resolves the host and root after replacement', async () => {
    const edit = browser.locator('#card').shadowRoot().getByRole('button', { name: 'Edit' });
    await edit.click();
    await browser.click('#replace-card');
    await edit.click();
    expect(await browser.find('#status').text()).toBe('edited');
  });

  it('restarts the complete plan while waiting for a delayed nested descendant', async () => {
    const address = browser
      .locator('#card')
      .shadowRoot()
      .locator('address-form')
      .shadowRoot();

    await address.getByRole('button', { name: 'Delayed shadow action' }).click();
    await browser.expect('#status').toHaveText('delayed');
  });

  it('keeps nested locator assertions scoped to the complete plan', async () => {
    await browser.locator('#card').shadowRoot().locator('#edit').expect().toHaveText('Edit');
    await browser.locator('#card').locator('#slotted-summary').expect().toHaveText('Slotted summary');
  });

  it('applies filters, indexing, and descendant lookup within the root', async () => {
    const root = browser.locator('#card').shadowRoot();
    const account = root
      .locator('section')
      .filter({ has: root.locator('address-form') })
      .filter({ hasText: 'Edit' });

    expect(await account.count()).toBe(1);
    await account.locator('.action').nth(1).click();
    await browser.expect('#status').toHaveText('deleted');
  });

  it('returns a precise error for missing and closed roots', async () => {
    for (const selector of ['#no-root', '#closed-card']) {
      const error = await browser
        .locator(selector)
        .shadowRoot()
        .locator('button')
        .click()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CraftdriverError);
      expect((error as CraftdriverError).code).toBe(ErrorCode.NO_OPEN_SHADOW_ROOT);
    }
  });
});

describe('open Shadow DOM over explicit Classic WebDriver', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/shadow-dom.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('locates and acts through nested roots without BiDi', async () => {
    const card = browser.locator('#card').shadowRoot();
    expect(await card.getByAltText('User avatar').count()).toBe(1);
    expect(await card.locator(By.linkText('Profile link')).count()).toBe(1);
    const address = card
      .locator('address-form')
      .shadowRoot();
    await address.getByLabel('City').fill('Classic');
    expect(await address.getByPlaceholder('Enter city').count()).toBe(1);
    expect(await address.getByTitle('Delivery city ').count()).toBe(0);
    await address.getByRole('button', { name: 'Save address' }).click();
    await browser.expect('#status').toHaveText('saved:Classic');
  });
});
