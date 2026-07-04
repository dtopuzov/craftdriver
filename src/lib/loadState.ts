/**
 * Single source of truth for how a public load-state maps to the BiDi
 * `browsingContext.navigate` `wait` value.
 *
 * Three navigation entry points issue `browsingContext.navigate` — `Browser`'s
 * and `Page`'s `navigateTo()` and `Page.setContent()` — and each used to inline
 * the same three-way ternary. Keeping the mapping here means the wait-semantics
 * contract can't silently drift between them (a class of bug that is easy to
 * introduce and hard to notice: a navigation that returns at the wrong
 * readiness point).
 */

/** Load-states accepted by `navigateTo()` / `setContent()`. */
export type NavigationLoadState = 'load' | 'domcontentloaded' | 'networkidle' | 'none';

/** BiDi `browsingContext.navigate` readiness values. */
export type BiDiNavigateWait = 'none' | 'interactive' | 'complete';

/**
 * Map a public load-state to the BiDi navigate `wait` value.
 *
 * `'load'` and `'networkidle'` both resolve to `'complete'`; `'networkidle'`
 * then layers its own network-quiet wait on top of the completed navigation.
 */
export function bidiWaitFor(waitUntil: NavigationLoadState): BiDiNavigateWait {
  return waitUntil === 'none'
    ? 'none'
    : waitUntil === 'domcontentloaded'
      ? 'interactive'
      : 'complete';
}
