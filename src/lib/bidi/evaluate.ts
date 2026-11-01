import {
  EVAL_REALM_RETRY_ATTEMPTS,
  EVAL_REALM_RETRY_DELAY_MS,
} from '../timing.js';

/** Messages meaning the target realm vanished before the script could run. */
const REALM_GONE = ['execution contexts cleared', 'Cannot find context with specified id'];

/**
 * Retry the one BiDi script failure that is known to happen before execution.
 *
 * A Classic navigation can report the document loaded just before the BiDi
 * side finishes replacing its old realm. Calls in that narrow window fail
 * with "execution contexts cleared"; the browser did not run the script, so
 * retrying cannot duplicate side effects. In-page exceptions are returned as
 * successful protocol responses and never enter this path.
 *
 * The in-process mapper on older Chrome (seen on 140) can surface the same
 * race as CDP's "Cannot find context with specified id": the call targeted an
 * execution context that no longer exists, so it never ran either.
 */
export async function withRealmRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (
        attempt >= EVAL_REALM_RETRY_ATTEMPTS ||
        !REALM_GONE.some((m) => String((err as Error)?.message).includes(m))
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, EVAL_REALM_RETRY_DELAY_MS));
    }
  }
}
