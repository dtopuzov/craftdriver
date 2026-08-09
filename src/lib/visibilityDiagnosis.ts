import { CraftdriverError, ErrorCode } from './errors.js';
import type { WebElement } from './webelement.js';

/**
 * Give a failed visibility wait the same diagnosis `Locator` already produces.
 *
 * `driver.wait(until.elementIsVisible(by))` polls a boolean. When it gives up
 * it has no idea *why*: "nothing ever matched that selector" and "the element
 * is right there but hidden" both arrive as a bare
 * `TIMEOUT: Wait timed out after 4980ms`, naming neither the selector nor the
 * state. Both are documented as having their own codes — `NO_MATCH` and
 * `TIMEOUT_WAITING_VISIBLE` — so the generic one is a contract violation, and
 * the caller has to spend another round trip on `exists` / `is visible` to
 * learn what the driver already knew.
 *
 * One `findElements` on the failure path settles it. The success path is not
 * touched, so this costs nothing when the action works.
 */
export async function waitForVisibleDiagnosed(
  waitForVisible: (timeout: number) => Promise<WebElement>,
  findMatches: () => Promise<WebElement[]>,
  selector: string,
  timeout: number
): Promise<WebElement> {
  try {
    return await waitForVisible(timeout);
  } catch (err) {
    // Only the generic polling miss is ambiguous. A specific code (stale ref,
    // detached shadow root, a driver fault) already says what happened and
    // must reach the caller unchanged.
    if (!CraftdriverError.is(err, ErrorCode.TIMEOUT)) throw err;

    let matched: number;
    try {
      matched = (await findMatches()).length;
    } catch {
      // The page moved under us, or the driver is unhappy. The original
      // timeout is still true and still the better answer.
      throw err;
    }

    const detail = { ...(err.detail ?? {}), selector, timeout };
    if (matched > 0) {
      throw new CraftdriverError(
        ErrorCode.TIMEOUT_WAITING_VISIBLE,
        `Timed out after ${timeout}ms waiting for "${selector}" to become visible ` +
          `(element exists but is not displayed)`,
        {
          detail: { ...detail, matched },
          cause: err,
          hint: 'The element matched but never became visible — wait for the containing view (modal, accordion, etc.) to open first.',
        }
      );
    }
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `No element matched "${selector}" within ${timeout}ms`,
      {
        detail: { ...detail, matched: 0 },
        cause: err,
        hint: 'Selector matched zero elements. Verify the selector against the page; consider By.role / By.testId / By.labelText for resilience.',
      }
    );
  }
}
