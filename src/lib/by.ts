import { CraftdriverError, ErrorCode } from './errors.js';

export type Locator = { using: string; value: string };

export interface RoleLocatorOptions {
  name?: string;
  exact?: boolean;
  includeHidden?: boolean;
}

export interface TextLocatorOptions {
  exact?: boolean;
  caseSensitive?: boolean;
  trim?: boolean;
}

export interface ExactLocatorOptions {
  exact?: boolean;
}

/**
 * Semantic intent retained alongside the W3C wire representation.
 *
 * Light-DOM lookup keeps using `using`/`value` for backwards compatibility.
 * Root-aware adapters use this descriptor when XPath is not interoperable
 * (notably inside a ShadowRoot) instead of trying to parse generated XPath.
 */
export type QueryDescriptor =
  | { kind: 'css'; value: string }
  | { kind: 'xpath'; value: string; raw: true }
  | { kind: 'linkText'; value: string; partial: boolean }
  | { kind: 'ref'; value: string }
  | { kind: 'role'; role: string; options: RoleLocatorOptions }
  | { kind: 'text'; value: string; options: TextLocatorOptions }
  | { kind: 'label'; value: string; options: ExactLocatorOptions }
  | {
      kind: 'placeholder' | 'alt' | 'title';
      value: string;
      options: ExactLocatorOptions;
    };

export class By {
  constructor(
    public using: string,
    public value: string,
    /** Internal semantic metadata; public for adapter code, optional for structural compatibility. */
    public readonly descriptor?: QueryDescriptor
  ) { }

  // Base CSS/XPath helpers
  static css(selector: string): By {
    return new By('css selector', selector, { kind: 'css', value: selector });
  }
  static xpath(xpath: string): By {
    return new By('xpath', xpath, { kind: 'xpath', value: xpath, raw: true });
  }

  // Simple attribute-based helpers
  static id(id: string): By {
    return By.css(`#${cssEscape(id)}`);
  }
  static name(name: string): By {
    return By.css(`[name="${cssEscape(name)}"]`);
  }
  static className(cls: string): By {
    return By.css(`.${cssEscape(cls)}`);
  }
  static tagName(tag: string): By {
    return By.css(tag);
  }
  static attr(name: string, value: string): By {
    return By.css(`[${name}="${cssEscape(value)}"]`);
  }
  static dataAttr(name: string, value: string): By {
    return By.css(`[data-${name}="${cssEscape(value)}"]`);
  }
  static aria(name: string, value: string): By {
    return By.css(`[aria-${name}="${cssEscape(value)}"]`);
  }
  static testId(value: string): By {
    return By.css(`[data-testid="${cssEscape(value)}"]`);
  }

  /** Internal agent-snapshot identity reference. Prefer durable locators in tests. */
  static ref(value: string): By {
    return new By('css selector', `[data-craftdriver-ref="${cssEscape(value)}"]`, {
      kind: 'ref',
      value,
    });
  }

  // Text-based locators (XPath)
  /**
   * Match elements by their normalized visible text.
   *
   * - `{ exact: true }` (default) — full-text equality.
   * - `{ exact: false }` — substring match; equivalent to `By.partialText()`.
   *
   * Other options:
   * - `caseSensitive` — defaults to `true`.
   * - `trim` — collapse whitespace via `normalize-space()`. Defaults to `true`.
   */
  static text(text: string, opts?: TextLocatorOptions): By {
    if (opts?.exact === false) {
      return By.partialText(text, opts);
    }
    requireStringValue(text, 'By.text text');
    const cs = opts?.caseSensitive !== false; // default true
    const trim = opts?.trim !== false; // default true
    const nodeExpr = trim ? 'normalize-space(.)' : 'string(.)';
    const valueExpr = trim ? normalizeSpaceLiteral(text) : xpStringLiteral(text);
    const left = cs ? nodeExpr : toLower(nodeExpr);
    const right = cs ? valueExpr : toLower(valueExpr);
    // Prefer the innermost element for symmetry with partialText — a wrapper
    // whose only child carries the same normalized text would otherwise match twice.
    const xpath = `.//*[${left} = ${right} and not(.//*[${left} = ${right}])]`;
    return new By('xpath', xpath, { kind: 'text', value: text, options: { ...opts, exact: true } });
  }

  /**
   * Match elements whose normalized text contains `substring`. Prefer
   * `By.text(s, { exact: false })` for symmetry with the other locators;
   * this lower-level entry point is kept for explicit use.
   */
  static partialText(
    substring: string,
    opts?: Omit<TextLocatorOptions, 'exact'>
  ): By {
    requireStringValue(substring, 'By.partialText substring');
    const cs = opts?.caseSensitive !== false; // default true
    const trim = opts?.trim !== false; // default true
    const nodeExpr = trim ? 'normalize-space(.)' : 'string(.)';
    const valueExpr = trim ? normalizeSpaceLiteral(substring) : xpStringLiteral(substring);
    const left = cs ? nodeExpr : toLower(nodeExpr);
    const right = cs ? valueExpr : toLower(valueExpr);
    // Prefer the innermost element containing the substring to avoid matching large containers
    const xpath = `.//*[contains(${left}, ${right}) and not(.//*[contains(${left}, ${right})])]`;
    return new By('xpath', xpath, {
      kind: 'text',
      value: substring,
      options: { ...opts, exact: false },
    });
  }

  // Accessibility-inspired helpers (approximate)
  /**
   * Match elements by ARIA role, resolving **implicit** roles for common native
   * elements — so `role('button')` matches `<button>` and `<input type="submit">`,
   * not only `[role="button"]`.
   *
   * The accessible-name approximation (`opts.name`) checks common sources:
   * `aria-label`, single-id `aria-labelledby`, visible text, associated labels
   * for form controls, `value` (native buttons/inputs), `alt` (images),
   * `placeholder` (form controls), and `title`. `name` defaults to an exact
   * match; pass `{ exact: false }` for a substring match.
   *
   * Coverage is a documented approximation of the common roles, not the full
   * ARIA algorithm; unmapped roles still match an explicit `role=` attribute.
   */
  static role(
    role: string,
    opts?: RoleLocatorOptions
  ): By {
    // An element matches the role if it carries role="<role>" OR is a native
    // element whose implicit role is <role>. When an explicit role is present,
    // it overrides the native implicit role for this approximation.
    const roleTests = [roleTokenEquals(role)];
    const implicit = IMPLICIT_ROLE_XPATH[role];
    if (implicit) roleTests.push(`(not(normalize-space(@role)) and (${implicit.join(' or ')}))`);
    const conditions: string[] = [`(${roleTests.join(' or ')})`];

    // `hidden` / `aria-hidden="true"` on ANY ancestor (not just the element
    // itself) removes the whole subtree from the accessibility tree, so the
    // default guard walks ancestor-or-self. CSS-based hiding (display:none via
    // a stylesheet) is deliberately not covered — XPath can't read computed
    // style — but the Locator's visible-resolution path filters those via the
    // driver's displayedness check.
    const visibleGuard = opts?.includeHidden
      ? ''
      : ' and not(ancestor-or-self::*[@hidden]) and not(ancestor-or-self::*[@aria-hidden="true"])';
    if (opts?.name) {
      const name = requireStringValue(opts.name, 'By.role name');
      const nameLit = normalizeSpaceLiteral(name);
      const eq = opts.exact !== false; // default exact
      // Approximate accessible-name sources, widest-first. This deliberately
      // covers common cases without trying to implement the full AccName spec.
      const candidates = [
        'normalize-space(@aria-label)',
        'normalize-space(.)',
        'normalize-space(@value)',
        'normalize-space(@alt)',
        'normalize-space(@placeholder)',
        'normalize-space(@title)',
      ];
      const stringPred = candidates
        .map((c) => (eq ? `${c} = ${nameLit}` : `contains(${c}, ${nameLit})`))
        .join(' or ');
      const labelMatch = eq
        ? `normalize-space(.) = ${nameLit}`
        : `contains(normalize-space(.), ${nameLit})`;
      const formControl = 'self::input or self::textarea or self::select';
      const labelPred = [
        `@aria-labelledby = //*[${labelMatch}]/@id`,
        `((${formControl}) and @id = //label[${labelMatch}]/@for)`,
        `((${formControl}) and ancestor::label[${labelMatch}])`,
      ].join(' or ');
      conditions.push(`(${stringPred} or ${labelPred})`);
    }
    // Leading `.//` (not `//`) so this stays scoped when used as a child of
    // another Locator/element — a bare `//` is document-root-anchored in XPath
    // regardless of the context node the "Find Element(s) From Element"
    // WebDriver endpoint passes in, which would otherwise search the whole
    // document instead of the parent's subtree.
    const xpath = `.//*[( ${conditions.join(' and ')} )${visibleGuard}]`;
    return new By('xpath', xpath, { kind: 'role', role, options: { ...opts } });
  }

  static labelText(text: string, opts?: ExactLocatorOptions): By {
    requireStringValue(text, 'By.labelText text');
    const eq = opts?.exact !== false; // default exact
    const lit = normalizeSpaceLiteral(text);
    const labelMatch = eq ? `normalize-space(.) = ${lit}` : `contains(normalize-space(.), ${lit})`;
    // Inputs referenced by @for, or wrapped controls. The outer step of each
    // branch is `.//` so the *returned element* is always scoped to the
    // parent context. The `@for` branch's inner `//label` lookup stays
    // document-rooted on purpose: inside a predicate, `.` rebinds to the
    // candidate `*` node being tested, not the outer scope, so it cannot be
    // scoped without XPath 2.0 variables. In realistic markup the label and
    // its target live in the same container, so this is a narrow, documented
    // approximation rather than the general nested-scope bug.
    const byFor = `.//*[@id=//label[${labelMatch}]/@for]`;
    const wrapped = `.//label[${labelMatch}]//*[self::input or self::textarea or self::select]`;
    return new By('xpath', `(${byFor} | ${wrapped})`, {
      kind: 'label',
      value: text,
      options: { ...opts },
    });
  }

  static placeholder(text: string, opts?: ExactLocatorOptions): By {
    requireStringValue(text, 'By.placeholder text');
    const eq = opts?.exact !== false;
    const lit = xpStringLiteral(text);
    const pred = eq ? `@placeholder = ${lit}` : `contains(@placeholder, ${lit})`;
    return new By('xpath', `.//*[(self::input or self::textarea) and ${pred}]`, {
      kind: 'placeholder',
      value: text,
      options: { ...opts },
    });
  }

  static altText(text: string, opts?: ExactLocatorOptions): By {
    requireStringValue(text, 'By.altText text');
    const eq = opts?.exact !== false;
    const lit = xpStringLiteral(text);
    const pred = eq ? `@alt = ${lit}` : `contains(@alt, ${lit})`;
    return new By(
      'xpath',
      `.//*[(self::img or self::area or (self::input and @type='image')) and ${pred}]`,
      { kind: 'alt', value: text, options: { ...opts } }
    );
  }

  static title(text: string, opts?: ExactLocatorOptions): By {
    requireStringValue(text, 'By.title text');
    const eq = opts?.exact !== false;
    const lit = xpStringLiteral(text);
    const pred = eq ? `@title = ${lit}` : `contains(@title, ${lit})`;
    return new By('xpath', `.//*[@title and ${pred}]`, {
      kind: 'title',
      value: text,
      options: { ...opts },
    });
  }

  // Link-text locators — the native W3C "link text" / "partial link text"
  // location strategies, matching Selenium's By.linkText / By.partialLinkText.
  // Unlike the XPath text helpers these match the browser-computed *rendered*
  // text of `<a>` elements (so CSS text-transform is respected), and they
  // scope correctly under a parent element in find-from-element, since the
  // strategy is resolved by the driver rather than as a document-rooted XPath.
  /** Match an `<a>` whose (trimmed) rendered text exactly equals `text`. */
  static linkText(text: string): By {
    return new By('link text', text, { kind: 'linkText', value: text, partial: false });
  }

  /** Match an `<a>` whose (trimmed) rendered text contains `text`. */
  static partialLinkText(text: string): By {
    return new By('partial link text', text, { kind: 'linkText', value: text, partial: true });
  }
}

// True when the candidate has an ancestor that is sectioning content (or
// carries the explicit-role equivalent) — the condition that strips header/
// footer of their banner/contentinfo role per HTML-AAM.
const HAS_SECTIONING_ANCESTOR =
  'ancestor::article or ancestor::aside or ancestor::main or ancestor::nav or ancestor::section' +
  ` or ancestor::*[${[
    'article',
    'complementary',
    'main',
    'navigation',
    'region',
  ].map(roleTokenEquals).join(' or ')}]`;

// Implicit ARIA roles for common native elements. Each value is a list of XPath
// `self::` node tests; an element matches the role if it has `role="<role>"` or
// satisfies one of these. An approximation of the ARIA-in-HTML mapping covering
// the roles people actually query — not the full algorithm.
const IMPLICIT_ROLE_XPATH: Record<string, string[]> = {
  button: [
    'self::button',
    "self::input[@type='button' or @type='submit' or @type='reset' or @type='image']",
    'self::summary',
  ],
  link: ['self::a[@href]', 'self::area[@href]'],
  checkbox: ["self::input[@type='checkbox']"],
  radio: ["self::input[@type='radio']"],
  searchbox: ["self::input[@type='search']"],
  spinbutton: ["self::input[@type='number']"],
  slider: ["self::input[@type='range']"],
  textbox: [
    'self::textarea',
    "self::input[not(@type) or @type='text' or @type='email' or @type='tel' or @type='url']",
  ],
  heading: ['self::h1', 'self::h2', 'self::h3', 'self::h4', 'self::h5', 'self::h6'],
  img: ['self::img'],
  list: ['self::ul', 'self::ol'],
  listitem: ['self::li'],
  table: ['self::table'],
  row: ['self::tr'],
  cell: ['self::td'],
  columnheader: ['self::th'],
  navigation: ['self::nav'],
  main: ['self::main'],
  form: ['self::form'],
  // header/footer are only banner/contentinfo when not nested in sectioning
  // content (article/aside/main/nav/section, or an element with the
  // equivalent explicit role) — per the HTML-AAM mapping.
  banner: [`self::header[not(${HAS_SECTIONING_ANCESTOR})]`],
  contentinfo: [`self::footer[not(${HAS_SECTIONING_ANCESTOR})]`],
  article: ['self::article'],
  // A <select> is combobox unless it's a multi-select or has size > 1, in
  // which case its implicit role is listbox (HTML-AAM).
  combobox: ["self::select[not(@multiple) and (not(@size) or number(@size) <= 1)]"],
  listbox: ['self::select[@multiple or (@size and number(@size) > 1)]'],
};

// Helpers

// Guard the text/name arguments that get compiled into XPath string literals.
// Passing a RegExp is the common mistake — role/name and the text family match
// via XPath, which has no regex operator, so a RegExp would otherwise blow up
// deep inside the literal builder with an opaque "s.indexOf is not a function".
// Fail early at the public entry point with a stable code and a real fix.
function requireStringValue(value: unknown, context: string): string {
  if (typeof value === 'string') return value;
  const received =
    value instanceof RegExp
      ? 'a RegExp'
      : value === null
        ? 'null'
        : Array.isArray(value)
          ? 'an array'
          : `a ${typeof value}`;
  const hint =
    value instanceof RegExp
      ? `${context} matches text through XPath, which has no regular-expression ` +
        `operator. Use { exact: false } for a substring match, or a data-testid ` +
        `for dynamic or localized text.`
      : undefined;
  throw new CraftdriverError(
    ErrorCode.INVALID_ARGUMENT,
    `${context} must be a string, but received ${received}.`,
    hint ? { detail: { context }, hint } : { detail: { context } }
  );
}

function cssEscape(s: string): string {
  // Minimal escape for quotes and backslashes in our usage
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function xpStringLiteral(s: string): string {
  if (s.indexOf("'") === -1) return `'${s}'`;
  // If it doesn't contain double quotes, we can safely use double quotes
  if (s.indexOf('"') === -1) return `"${s}"`;
  // Otherwise, use concat with embedded single-quote literals
  const parts = s.split("'").map((p) => `'${p}'`);
  // join with , "'", to inject a single quote between parts
  return `concat(${parts.join(', "\'", ')})`;
}

function normalizeSpaceLiteral(s: string): string {
  // normalize-space('text')
  return `normalize-space(${xpStringLiteral(s)})`;
}

function toLower(expr: string): string {
  return `translate(${expr}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
}

function roleTokenEquals(role: string): string {
  return `substring-before(concat(normalize-space(@role), ' '), ' ') = ${xpStringLiteral(role)}`;
}
