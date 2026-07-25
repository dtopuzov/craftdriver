/**
 * Durable locator candidates for an element the agent found by ref.
 *
 * Refs (`e7`) are exploration-only: they are meaningful for one document
 * in one session and must never reach a committed test. But an agent that
 * has just inspected an element still needs to *write* a selector for it,
 * and guessing from a snapshot line is how brittle tests get born.
 *
 * So: take an element, read the evidence the live page actually offers
 * (role, accessible name, label, test id, text, stable attributes), build
 * candidates in durability order, and then — the part that matters —
 * re-resolve every candidate against the current document and report
 * whether it is unique, ambiguous, or missing.
 *
 * A candidate is only ever reported as `unique` when it resolves to
 * exactly one element *and that element is the one asked about*. There is
 * no semantic guessing and no runtime self-healing here: if the page
 * offers nothing durable, that is the honest answer, and the agent should
 * ask for a test id rather than commit a selector that will rot.
 */
import type { Browser } from '../lib/browser.js';
import type { By } from '../lib/by.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { parseSelector, describeSelector } from './selector.js';
import { PAGE_SEMANTICS_JS } from './pageSemantics.js';

/** Ordered best-first; the cap keeps output bounded for agent contexts. */
const MAX_CANDIDATES = 8;
const MAX_NAME = 80;

export type CandidateKind = 'role' | 'label' | 'testid' | 'text' | 'css';
export type CandidateStatus = 'unique' | 'ambiguous' | 'missing';

export interface LocatorCandidate {
  /** CLI/selector form, e.g. `role=button[name=Pay now]`. */
  selector: string;
  /** craftdriver test code for the same target. */
  code: string;
  kind: CandidateKind;
  /** Live re-resolution result against the current document. */
  status: CandidateStatus;
  /** How many elements the candidate matched. */
  matches: number;
}

export interface LocatorReport {
  target: string;
  candidates: LocatorCandidate[];
  /** First candidate that uniquely resolved to the target, if any. */
  best: string | null;
  note?: string;
}

export interface Evidence {
  role: string | null;
  name: string | null;
  label: string | null;
  testid: string | null;
  text: string | null;
  id: string | null;
  nameAttr: string | null;
  tag: string;
  nonce: string;
}

/**
 * Ids and names that are obviously build- or framework-generated. A CSS
 * selector built on one of these looks durable and is not, which is worse
 * than offering no CSS candidate at all.
 */
function looksGenerated(value: string): boolean {
  return (
    /^[0-9]/.test(value) ||
    /[0-9a-f]{8,}/i.test(value) ||
    /^(:r|ember\d|mui-|radix-|headlessui-|react-aria-)/.test(value) ||
    /\d{4,}/.test(value)
  );
}

/**
 * Whether a page-derived string can be used verbatim in an exact-match
 * locator. Long values are rejected rather than truncated: `By.role` and
 * friends match exactly, so an elided value resolves to nothing while
 * looking like a usable candidate.
 */
function usableAsExactMatch(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NAME;
}

/**
 * Whether an accessible name (or text) looks *dynamic* — a value that changes
 * between renders, so a hardcoded exact-match locator built on it will rot.
 *
 * Deliberately cheap and approximate: any Unicode number or currency sign. It
 * flags the common offenders ("Count is 0", "3 items", "$4.99", "٣ items",
 * "₹99", "12:30 PM") and only misses genuinely stable names that happen to
 * carry a number ("COVID-19"). Using `\p{N}`/`\p{Sc}` rather than ASCII `\d`
 * keeps it honest with the localization guidance — a localized numeral is just
 * as dynamic as an ASCII one. A false positive costs nothing but ordering — the
 * name-bearing candidate is demoted, never dropped — so the agent, which saw
 * the live page, can still pick it when it knows the number is stable. This is
 * the automated half of "prefer the most stable *and* meaningful locator": use
 * the semantic value when it is stable, fall to a stable anchor when it is not.
 */
export function looksVolatile(value: string): boolean {
  return /[\p{N}\p{Sc}]/u.test(value);
}

export async function locatorCandidates(
  browser: Browser,
  by: By,
  limit = 5,
): Promise<LocatorReport> {
  const els = await browser.findAll(by);
  if (els.length === 0) {
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `locators: no element matches ${describeSelector(by)}`,
      { detail: { selector: describeSelector(by) } },
    );
  }

  // Mark the target, then read its evidence from page scope. The mark is
  // what lets validation prove a candidate resolved back to *this* node.
  const nonce = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await els[0].evaluate((node: unknown, stamp: unknown) => {
    (node as { setAttribute(n: string, v: string): void })
      .setAttribute('data-craftdriver-probe', stamp as string);
  }, nonce);

  try {
    const page = await browser.activePage();
    const raw = await page.evaluate(jsEvidence(nonce));
    if (!raw || typeof raw !== 'object') {
      return { target: describeSelector(by), candidates: [], best: null, note: 'element not readable' };
    }
    const evidence = raw as Evidence;
    const proposed = propose(evidence);
    const validated: LocatorCandidate[] = [];
    for (const candidate of proposed.slice(0, MAX_CANDIDATES)) {
      validated.push(await validate(browser, candidate, nonce));
      if (validated.filter((c) => c.status === 'unique').length >= limit) break;
    }
    const best = validated.find((c) => c.status === 'unique') ?? null;
    const dynamicNote =
      evidence.name && looksVolatile(evidence.name)
        ? `accessible name "${evidence.name}" looks dynamic (contains a number); ` +
          'a hardcoded name will break when the value changes — prefer a stable locator'
        : undefined;
    return {
      target: describeSelector(by),
      candidates: validated.slice(0, Math.max(limit, 1) + 2),
      best: best ? best.selector : null,
      ...(best
        ? dynamicNote
          ? { note: dynamicNote }
          : {}
        : {
          note:
            dynamicNote ??
            'no durable locator resolved uniquely; add a data-testid to this element ' +
              'rather than committing a positional selector',
        }),
    };
  } finally {
    // Never leave the probe attribute on the page — it would show up in
    // the agent's next snapshot and in any DOM the user inspects.
    await els[0]
      .evaluate((node: unknown) => {
        (node as { removeAttribute(n: string): void })
          .removeAttribute('data-craftdriver-probe');
      })
      .catch(() => undefined);
  }
}

/**
 * Page-side evidence extraction. Runs as a string body (the build has no
 * DOM lib) and reads only what the live document actually offers.
 * `nonce` is generated here and JSON-encoded, so it cannot break out.
 *
 * Role and name come from the shared extractor, so a candidate can never
 * describe the element differently from the snapshot the agent just read.
 * `role` is deliberately the ARIA role or nothing: proposing `role=` for an
 * element that has no ARIA role produces a locator that resolves to zero
 * elements, which is worse than offering no role candidate at all.
 */
function jsEvidence(nonce: string): string {
  return `
${PAGE_SEMANTICS_JS}
const el = document.querySelector('[data-craftdriver-probe=' + ${JSON.stringify(JSON.stringify(nonce))} + ']');
if (!el) return null;
const tag = el.tagName.toLowerCase();
const name = accName(el);
const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
return {
  role: ariaRole(el),
  name: name || null,
  label: associatedLabel(el),
  testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
  text: text || null,
  id: el.id || null,
  nameAttr: el.getAttribute('name'),
  tag: tag,
  nonce: ${JSON.stringify(nonce)}
};
`;
}

/**
 * Build candidates in durability order.
 *
 * Two axes decide the order. The **semantic** axis is the base preference:
 * role+name, label, test id, text, then CSS — how meaningful each is to a user.
 * The **stability** axis then partitions them: any candidate whose matched value
 * looks dynamic ({@link looksVolatile}) sinks below every stable one, keeping its
 * semantic rank only within its group. So a stable role+name leads, but a
 * dynamic name — *or a dynamic label, judged on its own value* — drops beneath a
 * stable anchor like `#id` or a test id. Volatile candidates are demoted, never
 * dropped: the agent that saw the live page may know the number is stable.
 *
 * A value's stability is judged per candidate — a label reading "Seats
 * remaining 3" is exactly as brittle as a name reading the same, so it cannot
 * ride to the top just because it is a label.
 */
export function propose(e: Evidence): Array<Omit<LocatorCandidate, 'status' | 'matches'>> {
  type Candidate = Omit<LocatorCandidate, 'status' | 'matches'>;
  const stable: Candidate[] = [];
  const volatile: Candidate[] = [];
  const add = (candidate: Candidate, isVolatile: boolean): void => {
    (isVolatile ? volatile : stable).push(candidate);
  };

  // Role + accessible name — survives restyling and DOM reshuffles, and states
  // what a user perceives. Never truncate a value destined for an exact-match
  // locator: an ellipsis guarantees it resolves to nothing. Skip instead, and
  // let a later candidate carry the element. `]` would also break the
  // `role=x[name=y]` grammar, which has no escape for it.
  if (e.role && e.name && usableAsExactMatch(e.name) && !e.name.includes(']')) {
    add(
      {
        kind: 'role',
        selector: `role=${e.role}[name=${e.name}]`,
        code: `By.role(${JSON.stringify(e.role)}, { name: ${JSON.stringify(e.name)} })`,
      },
      looksVolatile(e.name),
    );
  }

  // Associated label — the thing a user reads for a form field. Usually stable
  // as the field's *value* changes, but the label text itself can be dynamic
  // ("Seats remaining 3"), so it is judged on its own value, not assumed stable.
  if (e.label && usableAsExactMatch(e.label)) {
    add(
      { kind: 'label', selector: `label=${e.label}`, code: `By.labelText(${JSON.stringify(e.label)})` },
      looksVolatile(e.label),
    );
  }

  // Test id — durable by contract, but only when the app already ships one.
  if (e.testid) {
    add({ kind: 'testid', selector: `testid=${e.testid}`, code: `By.testId(${JSON.stringify(e.testid)})` }, false);
  }

  // Text — durable only where it is unique, which validation decides. Shares the
  // dynamic fate of the name: a button reading "Count is 0" has volatile text.
  if (e.text && usableAsExactMatch(e.text)) {
    add(
      { kind: 'text', selector: `text=${e.text}`, code: `By.text(${JSON.stringify(e.text)})` },
      looksVolatile(e.text),
    );
  }

  // Minimal CSS from an existing, non-generated id or name attribute — a stable
  // anchor that is not test-only markup. The id has to survive being written
  // bare into a selector: `.`, `:` and friends are CSS syntax, so `#user.email`
  // silently means "id user AND class email", and a quote breaks the code.
  // `looksGenerated` already strips build-hashed ids, so what remains is stable.
  if (e.id && !looksGenerated(e.id) && /^[A-Za-z][A-Za-z0-9_-]*$/.test(e.id)) {
    add({ kind: 'css', selector: `#${e.id}`, code: `By.css(${JSON.stringify('#' + e.id)})` }, false);
  }
  if (e.nameAttr && !looksGenerated(e.nameAttr)) {
    const css = `${e.tag}[name=${JSON.stringify(e.nameAttr)}]`;
    add({ kind: 'css', selector: `css=${css}`, code: `By.css(${JSON.stringify(css)})` }, false);
  }

  return [...stable, ...volatile];
}

/**
 * Re-resolve a candidate against the live document.
 *
 * Uniqueness alone is not enough — a selector can match exactly one
 * element that is not the one the agent asked about. The probe attribute
 * settles identity.
 */
async function validate(
  browser: Browser,
  candidate: Omit<LocatorCandidate, 'status' | 'matches'>,
  nonce: string,
): Promise<LocatorCandidate> {
  try {
    const els = await browser.findAll(parseSelector(candidate.selector));
    if (els.length === 0) return { ...candidate, status: 'missing', matches: 0 };
    if (els.length > 1) return { ...candidate, status: 'ambiguous', matches: els.length };
    const hit = await els[0].getAttribute('data-craftdriver-probe').catch(() => null);
    return hit === nonce
      ? { ...candidate, status: 'unique', matches: 1 }
      : { ...candidate, status: 'ambiguous', matches: 1 };
  } catch {
    return { ...candidate, status: 'missing', matches: 0 };
  }
}
