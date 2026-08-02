import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import { CraftdriverError, ErrorCode } from './errors.js';

/** Severity buckets reported by axe-core. */
export type A11yImpact = 'minor' | 'moderate' | 'serious' | 'critical';

/** axe-core selector path through one or more open shadow boundaries. */
export type A11yShadowSelector = [string, string, ...string[]];

/** A light-DOM selector or axe-core's nested selector path for Shadow DOM. */
export type A11yTarget = string | A11yShadowSelector;

export interface A11yOptions {
  /**
   * Rule IDs to skip entirely. The common case — most projects maintain
   * a small constant list of rules the team knowingly waives.
   */
  disableRules?: string[];
  /** Only run these rule IDs. Mutually exclusive with `disableRules`. */
  rules?: string[];
  /** Minimum impact reported. Defaults to `'serious'`. */
  minImpact?: A11yImpact;
  /** Escape hatch: raw axe-core run options merged last (overrides everything else). */
  axeOptions?: Record<string, unknown>;
}

export interface A11yViolationNode {
  /** CSS targets; nested arrays describe paths through open shadow roots. */
  target: A11yTarget[];
  /** HTML snippet of the violating node. */
  html: string;
  /** Human-readable summary of why this node failed. */
  failureSummary: string;
}

export interface A11yViolation {
  /** Rule ID, e.g. `'color-contrast'`. */
  id: string;
  impact: A11yImpact;
  description: string;
  /**
   * axe-core's own tags, verbatim: conformance levels (`wcag2a`, `wcag21aa`),
   * success criteria (`wcag111` = WCAG 1.1.1), and categories (`cat.forms`).
   *
   * Kept raw rather than reduced to a craftdriver severity scale — the tag set
   * is axe's contract and changes with its rule catalogue, so re-encoding it
   * here would just be a second thing to keep in step.
   */
  tags: string[];
  /** One-line remediation summary, e.g. `'Images must have alternate text'`. */
  help: string;
  /** Link to the axe-core rule documentation. */
  helpUrl: string;
  nodes: A11yViolationNode[];
}

export interface A11yResult {
  violations: A11yViolation[];
  passes: number;
  incomplete: number;
  inapplicable: number;
}

/** Thrown by `A11y.check()` when violations are found. */
export class A11yError extends CraftdriverError {
  readonly violations: A11yViolation[];
  readonly result: A11yResult;
  constructor(message: string, result: A11yResult) {
    super(ErrorCode.A11Y_VIOLATIONS, message, {
      detail: {
        violationCount: result.violations.length,
        rules: result.violations.map((v) => v.id),
      },
    });
    this.name = 'A11yError';
    this.violations = result.violations;
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Internal — axe-core loader
// ---------------------------------------------------------------------------

const IMPACT_RANK: Record<A11yImpact, number> = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

let _axeSourceCache: string | null = null;

async function loadAxeSource(): Promise<string> {
  if (_axeSourceCache) return _axeSourceCache;
  let mod: unknown;
  try {
    mod = await import('axe-core');
  } catch (e) {
    // axe-core ships as a direct dependency of craftdriver; if this fails
    // the install is broken — surface the underlying error.
    throw new Error(
      `craftdriver: failed to load axe-core. Try reinstalling dependencies. ` +
      `Underlying error: ${(e as Error)?.message ?? String(e)}`
    );
  }
  const candidate =
    (mod as { source?: unknown })?.source ??
    (mod as { default?: { source?: unknown } })?.default?.source;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(
      'craftdriver: the installed axe-core build does not expose a `.source` string.'
    );
  }
  _axeSourceCache = candidate;
  return candidate;
}

function buildAxeRunOptions(opts: A11yOptions): Record<string, unknown> {
  if (opts.disableRules?.length && opts.rules?.length) {
    throw new Error(
      'craftdriver a11y: `disableRules` and `rules` are mutually exclusive. ' +
      'Pick one or use `axeOptions` directly.'
    );
  }
  const out: Record<string, unknown> = {};
  if (opts.disableRules?.length) {
    out.rules = Object.fromEntries(
      opts.disableRules.map((id) => [id, { enabled: false }])
    );
  }
  if (opts.rules?.length) {
    out.runOnly = { type: 'rule', values: opts.rules };
  }
  // Caller-provided axeOptions win — escape hatch by design.
  return { ...out, ...(opts.axeOptions ?? {}) };
}

function formatViolations(violations: A11yViolation[]): string {
  return violations
    .map((v) => {
      const nodeCount = v.nodes.length;
      const nodeLabel = nodeCount === 1 ? '1 node' : `${nodeCount} nodes`;
      return (
        `  • ${v.id} (${v.impact}) — ${v.description}\n` +
        `      ${nodeLabel} · ${v.helpUrl}`
      );
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Internal configuration object describing how an `A11y` instance should
 * locate its target. Not part of the public API — produced by the
 * `.a11y` accessor on `Browser`, `ElementHandle`, and `Locator`.
 */
export interface A11ySource {
  driver: Driver;
  /** Resolve the target element (omit for document-level audits). */
  resolveTarget?: () => Promise<WebElement>;
  /** Frame context switching for frame-bound locators. */
  withContext?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * Ergonomic wrapper around axe-core. Obtain instances via the `.a11y`
 * accessor on `Browser`, `ElementHandle`, or `Locator` — never construct
 * directly.
 *
 * - `audit(options?)` returns the report.
 * - `check(options?)` throws an `A11yError` when violations exist.
 */
export class A11y {
  constructor(private source: A11ySource) { }

  /** Run an accessibility audit and return the report. */
  async audit(options: A11yOptions = {}): Promise<A11yResult> {
    const axeOptions = buildAxeRunOptions(options);
    const minImpact = options.minImpact ?? 'serious';
    const withContext = this.source.withContext ?? (<T>(fn: () => Promise<T>) => fn());

    return withContext(async () => {
      const axeSource = await loadAxeSource();
      const target = this.source.resolveTarget
        ? await this.source.resolveTarget()
        : null;

      const raw = await this.source.driver.executeAsyncScript<{
        ok: boolean;
        error?: string;
        result?: A11yResult;
      }>(AUDIT_SCRIPT, [target, axeSource, JSON.stringify(axeOptions)]);

      if (!raw || !raw.ok) {
        throw new Error(
          `craftdriver a11y: audit failed in the page — ${raw?.error ?? 'unknown error'}`
        );
      }

      const threshold = IMPACT_RANK[minImpact];
      const filtered = (raw.result ?? { violations: [], passes: 0, incomplete: 0, inapplicable: 0 });
      return {
        ...filtered,
        violations: filtered.violations.filter((v) => IMPACT_RANK[v.impact] >= threshold),
      };
    });
  }

  /**
   * Run an audit and throw an `A11yError` if any violation is found.
   *
   * The thrown error carries the full `result` and `violations` for
   * programmatic inspection.
   */
  async check(options: A11yOptions = {}): Promise<void> {
    const result = await this.audit(options);
    if (result.violations.length === 0) return;
    const count = result.violations.length;
    const noun = count === 1 ? 'violation' : 'violations';
    throw new A11yError(
      `Accessibility check found ${count} ${noun}:\n${formatViolations(result.violations)}`,
      result
    );
  }
}

// ---------------------------------------------------------------------------
// Page-side script — kept as a constant so it's easy to audit.
// ---------------------------------------------------------------------------

const AUDIT_SCRIPT = `
  var target = arguments[0];
  var axeSource = arguments[1];
  var optsJson = arguments[2];
  var done = arguments[arguments.length - 1];
  try {
    if (!window.__craftdriverAxeLoaded) {
      // eslint-disable-next-line no-new-func
      (new Function(axeSource)).call(window);
      window.__craftdriverAxeLoaded = true;
    }
    var ctx = target || document;
    var opts = JSON.parse(optsJson);
    window.axe.run(ctx, opts).then(function (r) {
      done({
        ok: true,
        result: {
          violations: (r.violations || []).map(function (v) {
            return {
              id: v.id,
              impact: v.impact || 'minor',
              description: v.description,
              tags: (v.tags || []).map(String),
              help: v.help || '',
              helpUrl: v.helpUrl,
              nodes: (v.nodes || []).map(function (n) {
                return {
                  target: (n.target || []).map(function (part) {
                    return Array.isArray(part) ? part.map(String) : String(part);
                  }),
                  html: n.html,
                  failureSummary: n.failureSummary || '',
                };
              }),
            };
          }),
          passes: (r.passes || []).length,
          incomplete: (r.incomplete || []).length,
          inapplicable: (r.inapplicable || []).length,
        },
      });
    }, function (err) {
      done({ ok: false, error: (err && err.message) ? err.message : String(err) });
    });
  } catch (e) {
    done({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
`;
