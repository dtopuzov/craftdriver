import { CraftdriverError, ErrorCode } from './errors.js';
import type { WebElement } from './webelement.js';

const RECOVERABLE_FILL_ERRORS: ReadonlySet<string> = new Set([
  'no such element',
  'stale element reference',
  'element not interactable',
]);

function isRecoverableFillError(err: unknown): boolean {
  if (!CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)) return false;
  const code = err.detail?.webDriverError;
  return typeof code === 'string' && RECOVERABLE_FILL_ERRORS.has(code);
}

async function fillElement(el: WebElement, text: string): Promise<void> {
  await el.clear();
  await el.sendKeys(text);
}

/**
 * Try the native fill commands immediately, then fall back to the previous
 * wait-for-visible fill path for transient find/interactability failures.
 */
export async function fillWithFastPath(
  resolveOnce: () => Promise<WebElement | null>,
  waitForVisible: (timeout: number) => Promise<WebElement>,
  text: string,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;

  try {
    const el = await resolveOnce();
    if (el) {
      await fillElement(el, text);
      return;
    }
  } catch (err) {
    if (!isRecoverableFillError(err)) throw err;
    const remainingAfterError = Math.max(0, deadline - Date.now());
    if (remainingAfterError <= 0) throw err;
  }

  const remaining = Math.max(0, deadline - Date.now());
  const el = await waitForVisible(remaining);
  await fillElement(el, text);
}
