import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL } from './utils';

describe('Mouse interactions on mouse.html', () => {
  let browser: Browser;
  const base = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${base}/mouse.html`);
  });

  it('drag source fully into target => status success', async () => {
    await browser.mouse.dragAndDrop('#drag-source', '#drag-target');
    await browser.expect('#status').toHaveText('success');
  });

  it('drag source not into target => status fail', async () => {
    await browser.mouse.dragAndDrop('#drag-source', { x: 10, y: 10 });
    await browser.expect('#status').toHaveText('fail');
  });

  it('drag with modifier key (Alt) logs modifiers in drop message', async () => {
    await browser.mouse.dragAndDrop('#drag-source', '#drag-target', { modifiers: ['Alt'] });
    await browser.expect('#log').toHaveText(/drag: drop .* — target=success, modifiers=Alt/);
  });

  it('press and release events are logged', async () => {
    await browser.mouse.move('#press-box');
    await browser.mouse.down();
    await browser.mouse.up();
    await browser.expect('#log').toHaveText(/press-box: pointerdown/);
    await browser.expect('#log').toHaveText(/press-box: pointerup/);
  });

  it('click fire press and release events', async () => {
    await browser.mouse.click('#press-box');
    await browser.expect('#log').toHaveText(/press-box: pointerdown/);
    await browser.expect('#log').toHaveText(/press-box: pointerup/);
  });

  it('context click is logged', async () => {
    await browser.mouse.click('#context-box', { button: 'right' });
    await browser.expect('#log').toHaveText(/context-box: contextmenu \(right click\)/);
  });

  it('hover shows tooltip and logs enter/leave', async () => {
    await browser.mouse.move('#hover-box');
    await browser.expect('#hover-tip').toBeVisible({ timeout: 2000 });
    await browser.expect('#log').toHaveText(/hover-box: enter/);
    await browser.mouse.move({ x: 0, y: 0 }); // Move away to hide tooltip
    await browser.expect('#hover-tip').not.toBeVisible({ timeout: 2000 });
    await browser.expect('#log').toHaveText(/hover-box: leave/);
  });

  it('double click increments counter', async () => {
    await browser.mouse.dblclick('#dblclick-box');
    await browser.expect('#dblcount').toHaveText('1');
  });

  it('wheel scroll logs delta in wheel box', async () => {
    await browser.mouse.click('#wheel-box');
    await browser.mouse.wheel(0, 100, '#wheel-box');
    await browser.expect('#log').toHaveText(/wheel-box: wheel dx=0 dy=100/);
  });
});
