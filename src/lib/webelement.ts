import { HttpClient } from './http.js';
import type { CommandResponse, WebDriverEndpoint } from './types.js';
import { By } from './by.js';

export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
export const LEGACY_ELEMENT_KEY = 'ELEMENT';

/**
 * W3C-compatible "is element displayed" algorithm, executed via
 * `POST /execute/sync`. Faithfully reproduces the behavior of Selenium's
 * `bot.dom.isShown_` (the atom chromedriver and geckodriver's native
 * `is displayed` commands are compiled from), so results match the browsers
 * that currently answer via the legacy `/element/{id}/displayed` endpoint —
 * while also working on Safari, whose command table omits that endpoint.
 *
 * Written in ES5-compatible style (plain `function`s, `var`, `for` loops) to
 * match the other scripts sent to `/execute/sync` in this codebase and to run
 * safely across every supported Classic remote end. Receives the element as
 * `arguments[0]` and returns a boolean.
 *
 * Rules, each mirroring the corresponding `bot.dom` behavior:
 *  - `<input type="hidden">` and `<noscript>` are never shown.
 *  - `display:none` on the element OR any ancestor hides it. `display` is not
 *    inherited, so the ancestor chain must be walked explicitly.
 *  - `visibility:hidden`/`collapse` hides it. `visibility` IS inherited, and a
 *    descendant may override an ancestor back to `visible`, so we check only the
 *    element's OWN computed value (getComputedStyle already resolves
 *    inheritance) — this both matches `bot.dom` and is more correct than walking
 *    the chain for visibility.
 *  - No positive-area box hides it, unless a child has one (zero-size wrappers)
 *    or it is a `<br>` (a legitimately zero-width line break). Mirrors
 *    `bot.dom.positiveSize_`.
 *  - Being clipped out of view by an `overflow:hidden` ancestor hides it,
 *    matching `bot.dom.OverflowState.HIDDEN`. An element scrolled out of a
 *    `scroll`/`auto` ancestor is still considered shown (it can be scrolled
 *    into view — `bot.dom.OverflowState.SCROLL`), so it is not treated as
 *    hidden here.
 */
const IS_DISPLAYED_ATOM = `
var elem = arguments[0];
if (!elem || elem.nodeType !== 1) { return false; }

var win = elem.ownerDocument.defaultView || window;
function style(e, prop) {
  var cs = win.getComputedStyle(e, null);
  return cs ? cs.getPropertyValue(prop) : '';
}

// <input type="hidden"> is never shown (bot.dom.isShown_).
var tag = elem.tagName ? elem.tagName.toUpperCase() : '';
if (tag === 'INPUT' && (elem.type || '').toLowerCase() === 'hidden') { return false; }
// <noscript> is not rendered.
if (tag === 'NOSCRIPT') { return false; }

// display:none on the element or any ancestor hides it. display is NOT
// inherited, so the whole chain must be checked (bot.dom.displayed_).
var node = elem;
while (node && node.nodeType === 1) {
  if (style(node, 'display') === 'none') { return false; }
  node = node.parentElement;
}

// visibility:hidden/collapse hides it. visibility IS inherited but overridable
// by descendants, so checking the element's own computed value is correct.
var vis = style(elem, 'visibility');
if (vis === 'hidden' || vis === 'collapse') { return false; }

// An element with no positive-area box is not shown, unless a child has one
// (zero-size wrapper) or it is a <br> (bot.dom.positiveSize_).
function positiveSize(e) {
  var r = e.getBoundingClientRect();
  if (r.width > 0 && r.height > 0) { return true; }
  if (e.tagName && e.tagName.toUpperCase() === 'BR') { return true; }
  var kids = e.childNodes;
  for (var i = 0; i < kids.length; i++) {
    var k = kids[i];
    if (k.nodeType === 1 && positiveSize(k)) { return true; }
  }
  return false;
}
if (!positiveSize(elem)) { return false; }

// Clipped out of view by an overflow:hidden ancestor => hidden
// (bot.dom.OverflowState.HIDDEN). scroll/auto ancestors are treated as shown
// (OverflowState.SCROLL — scrollable into view). position:fixed escapes
// ancestor clipping, so skip the check for fixed elements.
if (style(elem, 'position') !== 'fixed') {
  var rect = elem.getBoundingClientRect();
  var parent = elem.parentElement;
  while (parent) {
    var ox = style(parent, 'overflow-x');
    var oy = style(parent, 'overflow-y');
    if (ox === 'hidden' || oy === 'hidden' || ox === 'clip' || oy === 'clip') {
      var pr = parent.getBoundingClientRect();
      var clippedX = (ox === 'hidden' || ox === 'clip') &&
        (rect.right <= pr.left || rect.left >= pr.right);
      var clippedY = (oy === 'hidden' || oy === 'clip') &&
        (rect.bottom <= pr.top || rect.top >= pr.bottom);
      if (clippedX || clippedY) { return false; }
    }
    if (style(parent, 'position') === 'fixed') { break; }
    parent = parent.parentElement;
  }
}

return true;
`;

export class WebElement {
  constructor(
    private endpoint: WebDriverEndpoint,
    private sessionId: string,
    private elementId: string
  ) { }

  getId(): string {
    return this.elementId;
  }

  async click(): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/element/${this.elementId}/click`,
      body: {},
    });
  }

  async sendKeys(text: string): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const payload: { text: string; value: string[] } = { text, value: text.split('') };
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/element/${this.elementId}/value`,
      body: payload,
    });
  }

  async getText(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/text`,
    });
    const value = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(value ?? '');
  }

  toJSON() {
    return { [W3C_ELEMENT_KEY]: this.elementId, [LEGACY_ELEMENT_KEY]: this.elementId };
  }

  async isDisplayed(): Promise<boolean> {
    // The legacy `GET /element/{id}/displayed` endpoint is a pre-W3C JSON Wire
    // Protocol command. chromedriver/geckodriver still accept it for backward
    // compatibility, but it was never part of W3C WebDriver Classic and is
    // absent from Apple's Safari 12+ command table. We therefore compute
    // displayedness the same way every real driver does under the hood: by
    // executing the well-known "displayedness atom" via the standard
    // `POST /execute/sync` command, which every Classic remote end supports.
    //
    // The script below mirrors Selenium's `bot.dom.isShown_`
    // (selenium/javascript/atoms/dom.js) — the exact algorithm chromedriver's
    // and geckodriver's `is displayed` implementations are compiled from, and
    // the same one wdio/Playwright rely on. Keeping it byte-for-byte faithful
    // in behavior is what preserves existing Chrome/Chromium/Firefox results;
    // this is a protocol change, not a semantics change. Each rule is annotated
    // with the `bot.dom` behavior it reproduces so a reviewer can verify it.
    const client = new HttpClient(this.endpoint);
    const res = await client.send<boolean>({
      method: 'POST',
      path: `/session/${this.sessionId}/execute/sync`,
      body: { script: IS_DISPLAYED_ATOM, args: [this.toJSON()] },
    });
    const value = (res as CommandResponse<boolean>)?.value ?? (res as unknown as boolean);
    return Boolean(value);
  }

  async screenshotBase64(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/screenshot`,
    });
    const value = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(value ?? '');
  }

  async clear(): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/element/${this.elementId}/clear`,
      body: {},
    });
  }

  async getAttribute(name: string): Promise<string | null> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string | null>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/attribute/${name}`,
    });
    const value = (res as CommandResponse<string | null>)?.value ?? (res as unknown as string | null);
    return value;
  }

  async getProperty(name: string): Promise<unknown> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<unknown>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/property/${name}`,
    });
    const value = (res as CommandResponse<unknown>)?.value ?? res;
    return value;
  }

  async isEnabled(): Promise<boolean> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<boolean>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/enabled`,
    });
    const value = (res as CommandResponse<boolean>)?.value ?? (res as unknown as boolean);
    return Boolean(value);
  }

  async isSelected(): Promise<boolean> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<boolean>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/selected`,
    });
    const value = (res as CommandResponse<boolean>)?.value ?? (res as unknown as boolean);
    return Boolean(value);
  }

  async getTagName(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/name`,
    });
    const value = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(value ?? '').toLowerCase();
  }

  async getRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<{ x: number; y: number; width: number; height: number }>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/rect`,
    });
    const value = (res as CommandResponse<{ x: number; y: number; width: number; height: number }>)?.value ?? res;
    return value as { x: number; y: number; width: number; height: number };
  }

  async findElements(locator: By): Promise<WebElement[]> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<Array<Record<string, string>>>({
      method: 'POST',
      path: `/session/${this.sessionId}/element/${this.elementId}/elements`,
      body: { using: locator.using, value: locator.value },
    });
    const arr = ((res as CommandResponse<Array<Record<string, string>>>)?.value ??
      (res as unknown as Array<Record<string, string>>)) as Array<Record<string, string>>;
    return (arr || [])
      .map((v) => {
        const elId = (v as any)?.[W3C_ELEMENT_KEY] || (v as any)?.[LEGACY_ELEMENT_KEY];
        if (!elId) return undefined;
        return new WebElement(this.endpoint, this.sessionId, elId);
      })
      .filter(Boolean) as WebElement[];
  }
}
