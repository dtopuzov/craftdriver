export type Locator = { using: string; value: string };

export class By {
  constructor(
    public using: string,
    public value: string
  ) { }

  // Base CSS/XPath helpers
  static css(selector: string): By {
    return new By('css selector', selector);
  }
  static xpath(xpath: string): By {
    return new By('xpath', xpath);
  }

  // Simple attribute-based helpers
  static id(id: string): By {
    return new By('css selector', `#${cssEscape(id)}`);
  }
  static nameAttr(name: string): By {
    return new By('css selector', `[name="${cssEscape(name)}"]`);
  }
  static className(cls: string): By {
    return new By('css selector', `.${cssEscape(cls)}`);
  }
  static tag(tag: string): By {
    return new By('css selector', tag);
  }
  static attr(name: string, value: string): By {
    return new By('css selector', `[${name}="${cssEscape(value)}"]`);
  }
  static dataAttr(name: string, value: string): By {
    return new By('css selector', `[data-${name}="${cssEscape(value)}"]`);
  }
  static aria(name: string, value: string): By {
    return new By('css selector', `[aria-${name}="${cssEscape(value)}"]`);
  }
  static testId(value: string): By {
    return new By('css selector', `[data-testid="${cssEscape(value)}"]`);
  }

  // Text-based locators (XPath)
  static text(text: string, opts?: { caseSensitive?: boolean; trim?: boolean }): By {
    const cs = opts?.caseSensitive !== false; // default true
    const trim = opts?.trim !== false; // default true
    const nodeExpr = trim ? 'normalize-space(.)' : 'string(.)';
    const valueExpr = trim ? normalizeSpaceLiteral(text) : xpStringLiteral(text);
    const left = cs ? nodeExpr : toLower(nodeExpr);
    const right = cs ? valueExpr : toLower(valueExpr);
    const xpath = `//*[${left} = ${right}]`;
    return By.xpath(xpath);
  }

  static partialText(substring: string, opts?: { caseSensitive?: boolean; trim?: boolean }): By {
    const cs = opts?.caseSensitive !== false; // default true
    const trim = opts?.trim !== false; // default true
    const nodeExpr = trim ? 'normalize-space(.)' : 'string(.)';
    const valueExpr = trim ? normalizeSpaceLiteral(substring) : xpStringLiteral(substring);
    const left = cs ? nodeExpr : toLower(nodeExpr);
    const right = cs ? valueExpr : toLower(valueExpr);
    // Prefer the innermost element containing the substring to avoid matching large containers
    const xpath = `//*[contains(${left}, ${right}) and not(.//*[contains(${left}, ${right})])]`;
    return By.xpath(xpath);
  }

  // Accessibility-inspired helpers (approximate)
  static role(
    role: string,
    opts?: { name?: string; exact?: boolean; includeHidden?: boolean }
  ): By {
    const conditions: string[] = [`@role=${xpStringLiteral(role)}`];
    const visibleGuard = opts?.includeHidden
      ? ''
      : ' and not(@hidden) and not(@aria-hidden="true")';
    if (opts?.name) {
      const nameLit = normalizeSpaceLiteral(opts.name);
      const eq = opts.exact !== false; // default exact
      const cand = 'normalize-space(@aria-label)';
      const textNode = 'normalize-space(.)';
      const pred = eq
        ? `(${cand} = ${nameLit} or ${textNode} = ${nameLit})`
        : `(contains(${cand}, ${nameLit}) or contains(${textNode}, ${nameLit}))`;
      conditions.push(pred);
    }
    const xpath = `//*[( ${conditions.join(' and ')} )${visibleGuard}]`;
    return By.xpath(xpath);
  }

  static labelText(text: string, opts?: { exact?: boolean }): By {
    const eq = opts?.exact !== false; // default exact
    const lit = normalizeSpaceLiteral(text);
    const labelMatch = eq ? `normalize-space(.) = ${lit}` : `contains(normalize-space(.), ${lit})`;
    // Inputs referenced by @for, or wrapped controls
    const byFor = `//*[@id=//label[${labelMatch}]/@for]`;
    const wrapped = `//label[${labelMatch}]//*[self::input or self::textarea or self::select]`;
    return By.xpath(`(${byFor} | ${wrapped})`);
  }

  static placeholder(text: string, opts?: { exact?: boolean }): By {
    const eq = opts?.exact !== false;
    const lit = xpStringLiteral(text);
    const pred = eq ? `@placeholder = ${lit}` : `contains(@placeholder, ${lit})`;
    return By.xpath(`//*[(self::input or self::textarea) and ${pred}]`);
  }

  static altText(text: string, opts?: { exact?: boolean }): By {
    const eq = opts?.exact !== false;
    const lit = xpStringLiteral(text);
    const pred = eq ? `@alt = ${lit}` : `contains(@alt, ${lit})`;
    return By.xpath(
      `//*[(self::img or self::area or (self::input and @type='image')) and ${pred}]`
    );
  }

  static title(text: string, opts?: { exact?: boolean }): By {
    const eq = opts?.exact !== false;
    const lit = xpStringLiteral(text);
    const pred = eq ? `@title = ${lit}` : `contains(@title, ${lit})`;
    return By.xpath(`//*[@title and ${pred}]`);
  }
}

// Helpers
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
