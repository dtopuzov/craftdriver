import { CraftdriverError, ErrorCode } from './errors.js';
import type { WebElement } from './webelement.js';

const RECOVERABLE_CLICK_ERRORS: ReadonlySet<string> = new Set([
  'no such element',
  'stale element reference',
  'element not interactable',
  'element click intercepted',
  'move target out of bounds',
]);

function isRecoverableClickError(err: unknown): boolean {
  if (!CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)) return false;
  const code = err.detail?.webDriverError;
  return typeof code === 'string' && RECOVERABLE_CLICK_ERRORS.has(code);
}

/**
 * Try one native click immediately, then fall back to the previous
 * wait-for-visible click path only for transient WebDriver click/find failures.
 */
export async function clickWithFastPath(
  resolveOnce: () => Promise<WebElement | null>,
  waitForVisible: (timeout: number) => Promise<WebElement>,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;

  try {
    const el = await resolveOnce();
    if (el) {
      await el.click();
      return;
    }
  } catch (err) {
    if (!isRecoverableClickError(err)) throw err;
    const remainingAfterError = Math.max(0, deadline - Date.now());
    if (remainingAfterError <= 0) throw err;
  }

  const remaining = Math.max(0, deadline - Date.now());
  const el = await waitForVisible(remaining);
  await el.click();
}
