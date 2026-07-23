/**
 * Selector syntax for the CLI / agent surface.
 *
 * Agents pick a "kind" by prefixing the selector with one of the
 * known schemes; otherwise the value is treated as a CSS selector
 * (the default everywhere in craftdriver). Examples:
 *
 *   #submit                  → By.css('#submit')
 *   css=button.primary       → By.css('button.primary')
 *   xpath=//button[1]        → By.xpath('//button[1]')
 *   text=Sign In             → By.text('Sign In')
 *   text*=Sign               → By.partialText('Sign')
 *   role=button              → By.role('button')
 *   role=button[name=Submit] → By.role('button', { name: 'Submit' })
 *   label=Email              → By.labelText('Email')
 *   testid=login-btn         → By.testId('login-btn')
 *   placeholder=Search…      → By.placeholder('Search…')
 *   alt=Logo                 → By.altText('Logo')
 *   title=Help               → By.title('Help')
 *   ref=e5                   → By.ref('e5') (resolved through the page identity registry)
 *                              (refs come from `craftdriver snapshot` /
 *                              browser_snapshot; invalidated by detachment,
 *                              navigation, or page replacement)
 */
import { By } from '../lib/by.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';

const ROLE_RE = /^([a-z-]+)(?:\[name=([^\]]+)\])?$/i;

export function parseSelector(input: string): By {
  if (input === undefined || input === null || input === '') {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      'parseSelector: selector is empty',
      { hint: 'pass a CSS selector or a prefixed form like role=button or text=Sign In' }
    );
  }
  const eq = input.indexOf('=');
  if (eq <= 0) return By.css(input);
  const kind = input.slice(0, eq).toLowerCase();
  const valueRaw = input.slice(eq + 1);
  switch (kind) {
    case 'css':
      return By.css(valueRaw);
    case 'xpath':
      return By.xpath(valueRaw);
    case 'id':
      return By.id(valueRaw);
    case 'name':
      return By.name(valueRaw);
    case 'tag':
    case 'tagname':
      return By.tagName(valueRaw);
    case 'class':
    case 'classname':
      return By.className(valueRaw);
    case 'text':
      return By.text(valueRaw);
    case 'text*':
    case 'partialtext':
      return By.partialText(valueRaw);
    case 'role': {
      const m = ROLE_RE.exec(valueRaw.trim());
      if (!m) {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `parseSelector: invalid role syntax "${valueRaw}"`,
          { hint: 'use role=<role> or role=<role>[name=<name>]' }
        );
      }
      const [, role, name] = m;
      return name ? By.role(role, { name }) : By.role(role);
    }
    case 'label':
    case 'labeltext':
      return By.labelText(valueRaw);
    case 'placeholder':
      return By.placeholder(valueRaw);
    case 'alt':
    case 'alttext':
      return By.altText(valueRaw);
    case 'title':
      return By.title(valueRaw);
    case 'testid':
    case 'data-testid':
      return By.testId(valueRaw);
    case 'ref': {
      // Refs resolve through the page's identity registry. The marker
      // attribute is diagnostic only and cannot cross a shadow boundary.
      const v = valueRaw.trim();
      if (!/^e\d+$/.test(v)) {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `parseSelector: invalid ref "${valueRaw}"`,
          { hint: 'refs look like e1, e2, … (take a snapshot to see them)' },
        );
      }
      return By.ref(v);
    }
    default:
      // Treat unknown prefix as part of a CSS selector (e.g. attribute
      // selectors with `=` inside). This is the least-surprising default.
      return By.css(input);
  }
}

/** Short, log-friendly description of a By for error messages. */
export function describeSelector(by: By): string {
  return `${by.using}=${by.value}`;
}
