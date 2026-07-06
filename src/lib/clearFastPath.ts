import { CraftdriverError, ErrorCode } from './errors.js';
import type { WebElement } from './webelement.js';

const RECOVERABLE_CLEAR_ERRORS: ReadonlySet<string> = new Set([
  'no such element',
  'stale element reference',
  'element not interactable',
]);

function isRecoverableClearError(err: unknown): boolean {
  if (!CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)) return false;
  const code = err.detail?.webDriverError;
  return typeof code === 'string' && RECOVERABLE_CLEAR_ERRORS.has(code);
}

/**
 * Try the native clear command immediately, then fall back to the previous
 * wait-for-visible clear path for transient find/interactability failures.
 */
export async function clearWithFastPath(
  resolveOnce: () => Promise<WebElement | null>,
  waitForVisible: (timeout: number) => Promise<WebElement>,
  timeout: number
): Promise<void> {
  const deadline = Date.now() + timeout;

  try {
    const el = await resolveOnce();
    if (el) {
      await el.clear();
      return;
    }
  } catch (err) {
    if (!isRecoverableClearError(err)) throw err;
    const remainingAfterError = Math.max(0, deadline - Date.now());
    if (remainingAfterError <= 0) throw err;
  }

  const remaining = Math.max(0, deadline - Date.now());
  const el = await waitForVisible(remaining);
  await el.clear();
}
