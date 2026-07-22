import {
  EVAL_REALM_RETRY_ATTEMPTS,
  EVAL_REALM_RETRY_DELAY_MS,
} from '../timing.js';

/**
 * Retry the one BiDi script failure that is known to happen before execution.
 *
 * A Classic navigation can report the document loaded just before the BiDi
 * side finishes replacing its old realm. Calls in that narrow window fail
 * with "execution contexts cleared"; the browser did not run the script, so
 * retrying cannot duplicate side effects. In-page exceptions are returned as
 * successful protocol responses and never enter this path.
 */
export async function withRealmRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (
        attempt >= EVAL_REALM_RETRY_ATTEMPTS ||
        !String((err as Error)?.message).includes('execution contexts cleared')
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, EVAL_REALM_RETRY_DELAY_MS));
    }
  }
}
