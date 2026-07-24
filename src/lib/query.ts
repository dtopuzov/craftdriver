import type { By, QueryDescriptor } from './by.js';
import type { BiDiConnection } from './bidi/connection.js';
import type { RemoteValue, ScriptEvaluateResult } from './bidi/types.js';
import type { Driver } from './driver.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import { PAGE_SEMANTICS_JS } from './pageSemantics.js';
import { ClassicShadowRoot } from './shadowRoot.js';
import type { WebElement } from './webelement.js';

export type ContextSwitcher = { in: () => Promise<void>; out: () => Promise<void> };

export interface QueryBiDiContext {
  connection: BiDiConnection;
  contextId: string;
}

export type QueryBiDiProvider = () => QueryBiDiContext | undefined;

export type ElementTargetPlan =
  | { kind: 'locator'; plan: LocatorPlan }
  | { kind: 'fixed'; element: WebElement };

export type SearchRootPlan =
  | { kind: 'document' }
  | { kind: 'element'; target: ElementTargetPlan }
  | { kind: 'shadow'; host: ElementTargetPlan };

export interface LocatorPlan {
  root: SearchRootPlan;
  by: By;
  index: number | 'last' | null;
  filterText: string | RegExp | null;
  filterHas: LocatorPlan | null;
}

type ResolvedRoot =
  | { kind: 'document' }
  | { kind: 'element'; element: WebElement }
  | { kind: 'classicShadow'; root: ClassicShadowRoot }
  | { kind: 'bidiShadow'; sharedId: string; contextId: string; connection: BiDiConnection };

interface BidiLocateResult {
  nodes: RemoteValue[];
}

export function createLocatorPlan(
  by: By,
  root: SearchRootPlan = { kind: 'document' }
): LocatorPlan {
  return { root, by, index: null, filterText: null, filterHas: null };
}

export function cloneLocatorPlan(plan: LocatorPlan): LocatorPlan {
  return {
    ...plan,
    root: cloneRootPlan(plan.root),
    filterHas: plan.filterHas ? cloneLocatorPlan(plan.filterHas) : null,
  };
}

function cloneTargetPlan(target: ElementTargetPlan): ElementTargetPlan {
  return target.kind === 'fixed'
    ? target
    : { kind: 'locator', plan: cloneLocatorPlan(target.plan) };
}

function cloneRootPlan(root: SearchRootPlan): SearchRootPlan {
  if (root.kind === 'document') return root;
  if (root.kind === 'element') return { kind: 'element', target: cloneTargetPlan(root.target) };
  return { kind: 'shadow', host: cloneTargetPlan(root.host) };
}

function sameFilterText(left: string | RegExp | null, right: string | RegExp | null): boolean {
  if (left === right) return true;
  return left instanceof RegExp && right instanceof RegExp &&
    left.source === right.source && left.flags === right.flags;
}

function sameBy(left: By, right: By): boolean {
  return left === right || (
    left.using === right.using &&
    left.value === right.value &&
    JSON.stringify(left.descriptor) === JSON.stringify(right.descriptor)
  );
}

function sameTargetPlan(left: ElementTargetPlan, right: ElementTargetPlan): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'fixed' && right.kind === 'fixed') {
    return left.element.getId() === right.element.getId();
  }
  return left.kind === 'locator' && right.kind === 'locator' &&
    sameLocatorPlan(left.plan, right.plan);
}

function sameRootPlan(left: SearchRootPlan, right: SearchRootPlan): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'document' && right.kind === 'document') return true;
  if (left.kind === 'element' && right.kind === 'element') {
    return sameTargetPlan(left.target, right.target);
  }
  return left.kind === 'shadow' && right.kind === 'shadow' &&
    sameTargetPlan(left.host, right.host);
}

function sameLocatorPlan(left: LocatorPlan, right: LocatorPlan): boolean {
  return sameRootPlan(left.root, right.root) &&
    sameBy(left.by, right.by) &&
    left.index === right.index &&
    sameFilterText(left.filterText, right.filterText) &&
    (left.filterHas === right.filterHas ||
      (left.filterHas !== null && right.filterHas !== null &&
        sameLocatorPlan(left.filterHas, right.filterHas)));
}

function rebaseTarget(
  target: ElementTargetPlan,
  base: SearchRootPlan,
  origin?: SearchRootPlan
): ElementTargetPlan {
  if (target.kind === 'fixed') return target;
  return { kind: 'locator', plan: rebaseLocatorPlan(target.plan, base, origin) };
}

function rebaseRoot(
  root: SearchRootPlan,
  base: SearchRootPlan,
  origin?: SearchRootPlan
): SearchRootPlan {
  if (origin && sameRootPlan(root, origin)) return base;
  if (root.kind === 'document') return base;
  if (root.kind === 'element') {
    return { kind: 'element', target: rebaseTarget(root.target, base, origin) };
  }
  return { kind: 'shadow', host: rebaseTarget(root.host, base, origin) };
}

/** Rebase a locator used by `filter({ has })` beneath the candidate element. */
export function rebaseLocatorPlan(
  plan: LocatorPlan,
  base: SearchRootPlan,
  origin?: SearchRootPlan
): LocatorPlan {
  return {
    ...plan,
    root: rebaseRoot(plan.root, base, origin),
    filterHas: plan.filterHas ? rebaseLocatorPlan(plan.filterHas, base, origin) : null,
  };
}

export function describeTarget(target: ElementTargetPlan): string {
  return target.kind === 'fixed' ? `element#${target.element.getId()}` : describeLocatorPlan(target.plan);
}

export function describeRoot(root: SearchRootPlan): string {
  if (root.kind === 'document') return '';
  if (root.kind === 'element') return `${describeTarget(root.target)} -> `;
  return `${describeTarget(root.host)} -> shadowRoot() -> `;
}

export function describeBy(by: By): string {
  const descriptor = by.descriptor;
  if (!descriptor) return `${by.using}=${by.value}`;
  if (descriptor.kind === 'role') {
    return descriptor.options.name === undefined
      ? `role=${JSON.stringify(descriptor.role)}`
      : `role=${JSON.stringify(descriptor.role)}[name=${JSON.stringify(descriptor.options.name)}]`;
  }
  if (descriptor.kind === 'text') return `text=${JSON.stringify(descriptor.value)}`;
  if (descriptor.kind === 'label') return `label=${JSON.stringify(descriptor.value)}`;
  if (descriptor.kind === 'placeholder') return `placeholder=${JSON.stringify(descriptor.value)}`;
  if (descriptor.kind === 'alt') return `alt=${JSON.stringify(descriptor.value)}`;
  if (descriptor.kind === 'title') return `title=${JSON.stringify(descriptor.value)}`;
  if (descriptor.kind === 'linkText') {
    return `${descriptor.partial ? 'partial link text' : 'link text'}=${JSON.stringify(descriptor.value)}`;
  }
  return `${by.using}=${by.value}`;
}

export function describeLocatorPlan(plan: LocatorPlan): string {
  let description = `${describeRoot(plan.root)}${describeBy(plan.by)}`;
  if (plan.filterText !== null) description += ` -> filter(hasText=${String(plan.filterText)})`;
  if (plan.filterHas) description += ` -> filter(has=${describeLocatorPlan(plan.filterHas)})`;
  if (plan.index === 'last') description += ' -> last()';
  else if (typeof plan.index === 'number') description += ` -> nth(${plan.index})`;
  return description;
}

export function isTerminalQueryError(error: unknown): boolean {
  if (
    CraftdriverError.is(error, ErrorCode.NO_OPEN_SHADOW_ROOT) ||
    CraftdriverError.is(error, ErrorCode.UNSUPPORTED)
  ) return true;
  if (!CraftdriverError.is(error, ErrorCode.DRIVER_ERROR)) return false;
  const wire = error.detail?.webDriverError;
  return wire !== 'no such element' &&
    wire !== 'stale element reference' &&
    wire !== 'detached shadow root';
}

export function isDetachedShadowError(error: unknown): error is CraftdriverError {
  return CraftdriverError.is(error, ErrorCode.DETACHED_SHADOW_ROOT);
}

/** Attach retry diagnostics when detachment remained the terminal outcome. */
export function withShadowRetryAttempts(error: unknown, attempts: number): unknown {
  if (!isDetachedShadowError(error)) return error;
  return new CraftdriverError(error.code, error.message, {
    detail: { ...(error.detail ?? {}), attempts },
    cause: error,
    hint: error.hint,
  });
}

function shadowError(
  code: typeof ErrorCode.NO_OPEN_SHADOW_ROOT | typeof ErrorCode.DETACHED_SHADOW_ROOT,
  message: string,
  queryPath: string,
  transport: 'classic' | 'bidi',
  cause?: unknown,
  extraDetail?: Record<string, unknown>
): CraftdriverError {
  return new CraftdriverError(code, message, {
    detail: { queryPath, transport, ...extraDetail },
    cause,
    hint:
      code === ErrorCode.NO_OPEN_SHADOW_ROOT
        ? 'Verify the host is correct and that the component attaches its root with mode: "open".'
        : 'The component replaced or detached its shadow tree; use a stable host locator and retry the action.',
  });
}

function mapClassicShadowError(
  error: unknown,
  queryPath: string,
  phase: 'open' | 'query'
): never {
  if (CraftdriverError.is(error, ErrorCode.DRIVER_ERROR)) {
    const wire = error.detail?.webDriverError;
    if (wire === 'unknown command' || wire === 'unsupported operation') {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        `WebDriver Classic does not support Shadow DOM ${phase === 'open' ? 'root access' : 'lookup'} at ${queryPath}`,
        {
          detail: {
            feature: 'shadow-dom',
            transport: 'classic',
            operation: phase === 'open' ? 'open-root' : 'find-from-root',
            queryPath,
            webDriverError: wire,
          },
          cause: error,
        }
      );
    }
    if (wire === 'no such shadow root') {
      throw shadowError(
        phase === 'open' ? ErrorCode.NO_OPEN_SHADOW_ROOT : ErrorCode.DETACHED_SHADOW_ROOT,
        phase === 'open'
          ? `No open shadow root is attached at ${queryPath}`
          : `Shadow root detached while resolving ${queryPath}`,
        queryPath,
        'classic',
        error
      );
    }
    if (wire === 'detached shadow root' || wire === 'stale element reference') {
      throw shadowError(
        ErrorCode.DETACHED_SHADOW_ROOT,
        `Shadow root detached while resolving ${queryPath}`,
        queryPath,
        'classic',
        error
      );
    }
  }
  throw error;
}

function isUnsupportedBidiError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    text.includes('unknown command') ||
    text.includes('unsupported operation') ||
    text.includes('method not found') ||
    text.includes('invalid argument') && text.includes('sharedid')
  );
}

function isDetachedBidiError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return text.includes('no such node') || text.includes('stale') || text.includes('detached');
}

function bidiDriverError(
  error: unknown,
  operation: 'open-root' | 'locate-nodes',
  queryPath: string,
  contextId: string
): CraftdriverError {
  return new CraftdriverError(
    ErrorCode.DRIVER_ERROR,
    `WebDriver BiDi ${operation} failed while resolving ${queryPath}: ${error instanceof Error ? error.message : String(error)}`,
    {
      detail: {
        feature: 'shadow-dom',
        transport: 'bidi',
        operation,
        queryPath,
        contextId,
      },
      cause: error,
    }
  );
}

/** Internal signal: discard the BiDi root id and restart the complete plan through Classic. */
class RetryWithClassicShadowQuery extends Error {}

function fallBackToClassicShadowQueries(
  driver: Driver,
  operation: 'root access' | 'descendant lookup'
): void {
  if (!driver.disableBiDiShadowQueries()) return;
  console.warn(
    `[craftdriver] WebDriver BiDi Shadow DOM ${operation} is unavailable; ` +
    'using WebDriver Classic shadow-root commands for this session.'
  );
}

function remoteNodeSharedIds(value: RemoteValue | undefined): string[] {
  if (!value) return [];
  if (value.type === 'node') {
    return typeof value.sharedId === 'string' ? [value.sharedId] : [];
  }
  if (value.type === 'array' || value.type === 'set') {
    return (value.value ?? []).flatMap((entry) => remoteNodeSharedIds(entry));
  }
  return [];
}

const SEMANTIC_QUERY_BODY = `
${PAGE_SEMANTICS_JS}
function normalized(value, options) {
  let result = value == null ? '' : String(value);
  if (options && options.trim !== false) result = result.trim().replace(/\\s+/g, ' ');
  if (options && options.caseSensitive === false) result = result.toLowerCase();
  return result;
}
function matchesValue(actual, expected, options) {
  const left = normalized(actual, options);
  const right = normalized(expected, options);
  return options && options.exact === false ? left.includes(right) : left === right;
}
function matchesAttribute(actual, expected, options) {
  return matchesValue(actual, expected, Object.assign({}, options, {
    trim: false,
    caseSensitive: true
  }));
}
function composedParent(el) {
  if (el.parentElement) return el.parentElement;
  const tree = el.getRootNode ? el.getRootNode() : null;
  return tree && tree.host ? tree.host : null;
}
function ariaHiddenInScope(el) {
  for (let current = el; current; current = composedParent(current)) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}
function matches(el) {
  if (query.kind === 'text') {
    return matchesValue(el.textContent || '', query.value, query.options);
  }
  if (query.kind === 'role') {
    if (ariaRole(el) !== query.role) return false;
    if (!query.options.includeHidden && ariaHiddenInScope(el)) return false;
    if (query.options.name) return matchesValue(accName(el), query.options.name, query.options);
    return true;
  }
  if (query.kind === 'label') {
    return matchesValue(associatedLabel(el) || '', query.value, query.options);
  }
  if (query.kind === 'placeholder') {
    const tag = el.tagName.toLowerCase();
    return (tag === 'input' || tag === 'textarea') &&
      matchesAttribute(el.getAttribute('placeholder') || '', query.value, query.options);
  }
  if (query.kind === 'alt') {
    const tag = el.tagName.toLowerCase();
    const supported = tag === 'img' || tag === 'area' ||
      (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image');
    return supported && matchesAttribute(el.getAttribute('alt') || '', query.value, query.options);
  }
  if (query.kind === 'title') {
    return el.hasAttribute('title') &&
      matchesAttribute(el.getAttribute('title') || '', query.value, query.options);
  }
  if (query.kind === 'linkText') {
    return el.tagName.toLowerCase() === 'a' && matchesValue(el.innerText || '', query.value, {
      exact: !query.partial,
      trim: true,
      caseSensitive: true
    });
  }
  return false;
}
const candidates = Array.from(root.querySelectorAll('*'));
const matched = candidates.filter(matches);
if (query.kind !== 'text') return matched;
return matched.filter((candidate) => !Array.from(candidate.querySelectorAll('*')).some(matches));
`;

const CLASSIC_SEMANTIC_SCRIPT = `
const root = arguments[0];
const query = arguments[1];
${SEMANTIC_QUERY_BODY}
`;

// The function source is static. User-controlled locator values cross the
// protocol boundary as a string argument and are parsed strictly as data.
const BIDI_SEMANTIC_FUNCTION = `(root, queryJson) => {
const query = JSON.parse(queryJson);
${SEMANTIC_QUERY_BODY}
}
`;

export class QueryEnvironment {
  private contextSwitcher?: ContextSwitcher;
  private bidiProvider?: QueryBiDiProvider;

  constructor(
    readonly driver: Driver,
    options?: { contextSwitcher?: ContextSwitcher; bidiProvider?: QueryBiDiProvider }
  ) {
    this.contextSwitcher = options?.contextSwitcher;
    this.bidiProvider = options?.bidiProvider;
  }

  setContextSwitcher(switcher: ContextSwitcher): void {
    this.contextSwitcher = switcher;
  }

  setBiDiProvider(provider: QueryBiDiProvider): void {
    this.bidiProvider = provider;
  }

  async withContext<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.contextSwitcher) return operation();
    await this.contextSwitcher.in();
    try {
      return await operation();
    } finally {
      await this.contextSwitcher.out();
    }
  }

  async resolveTarget(target: ElementTargetPlan): Promise<WebElement | null> {
    if (target.kind === 'fixed') return target.element;
    const plan = target.plan;
    if (
      plan.root.kind === 'document' &&
      plan.index === null &&
      plan.filterText === null &&
      plan.filterHas === null
    ) {
      // Preserve ElementHandle's established singular lookup path. Besides
      // avoiding an unnecessary array response, this matters to lightweight
      // WebDriver intermediaries that implement /element but not /elements.
      try {
        return await this.driver.findElement(plan.by);
      } catch (error) {
        if (
          CraftdriverError.is(error, ErrorCode.NO_MATCH) ||
          (CraftdriverError.is(error, ErrorCode.DRIVER_ERROR) &&
            error.detail?.webDriverError === 'no such element')
        ) return null;
        throw error;
      }
    }
    const elements = await this.resolveAll(target.plan);
    return elements[0] ?? null;
  }

  async resolveAll(plan: LocatorPlan): Promise<WebElement[]> {
    let elements: WebElement[];
    try {
      const root = await this.resolveRoot(plan.root);
      if (!root) return [];
      elements = await this.findFromRoot(root, plan.by, describeLocatorPlan(plan));
    } catch (error) {
      if (error instanceof RetryWithClassicShadowQuery) return this.resolveAll(plan);
      throw error;
    }

    if (plan.filterText !== null) {
      const pattern = plan.filterText;
      const texts = await Promise.all(elements.map((element) => element.getText()));
      elements = elements.filter((_, index) => {
        if (pattern instanceof RegExp) {
          pattern.lastIndex = 0;
          return pattern.test(texts[index]);
        }
        return texts[index].includes(pattern);
      });
    }

    if (plan.filterHas) {
      const kept: WebElement[] = [];
      for (const element of elements) {
        const rebased = rebaseLocatorPlan(
          plan.filterHas,
          {
            kind: 'element',
            target: { kind: 'fixed', element },
          },
          plan.root
        );
        if ((await this.resolveAll(rebased)).length > 0) kept.push(element);
      }
      elements = kept;
    }

    if (plan.index === 'last') return elements.length ? [elements[elements.length - 1]] : [];
    if (typeof plan.index === 'number') return elements[plan.index] ? [elements[plan.index]] : [];
    return elements;
  }

  private async resolveRoot(plan: SearchRootPlan): Promise<ResolvedRoot | null> {
    if (plan.kind === 'document') return { kind: 'document' };
    if (plan.kind === 'element') {
      const element = await this.resolveTarget(plan.target);
      return element ? { kind: 'element', element } : null;
    }
    const host = await this.resolveTarget(plan.host);
    if (!host) return null;
    return this.openShadowRoot(host, `${describeTarget(plan.host)} -> shadowRoot()`);
  }

  private async openShadowRoot(host: WebElement, queryPath: string): Promise<ResolvedRoot> {
    const bidi = this.driver.canUseBiDiShadowQueries() ? this.bidiProvider?.() : undefined;
    if (bidi) {
      try {
        const response = await bidi.connection.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration: '(host) => host.shadowRoot',
          awaitPromise: false,
          target: { context: bidi.contextId },
          arguments: [{ sharedId: host.getId() }],
          resultOwnership: 'none',
        });
        if (response.type === 'exception') {
          throw new Error(response.exceptionDetails?.text ?? 'BiDi shadow-root getter threw');
        }
        if (!response.result || response.result.type === 'null') {
          throw shadowError(
            ErrorCode.NO_OPEN_SHADOW_ROOT,
            `No open shadow root is attached at ${queryPath}`,
            queryPath,
            'bidi',
            undefined,
            { host: describeTarget({ kind: 'fixed', element: host }), contextId: bidi.contextId }
          );
        }
        if (response.result.type !== 'node' || typeof response.result.sharedId !== 'string') {
          throw new Error('BiDi returned a shadow root without a sharedId');
        }
        return {
          kind: 'bidiShadow',
          sharedId: response.result.sharedId,
          contextId: bidi.contextId,
          connection: bidi.connection,
        };
      } catch (error) {
        if (isTerminalQueryError(error)) throw error;
        if (isUnsupportedBidiError(error) || String(error).includes('without a sharedId')) {
          fallBackToClassicShadowQueries(this.driver, 'root access');
        } else if (isDetachedBidiError(error)) {
          throw shadowError(
            ErrorCode.DETACHED_SHADOW_ROOT,
            `Shadow host detached while resolving ${queryPath}`,
            queryPath,
            'bidi',
            error,
            { contextId: bidi.contextId }
          );
        } else {
          throw bidiDriverError(error, 'open-root', queryPath, bidi.contextId);
        }
      }
    }

    try {
      const root = await this.driver.executeScript<ClassicShadowRoot | null>(
        'return arguments[0].shadowRoot;',
        [host]
      );
      if (root === null) {
        throw shadowError(
          ErrorCode.NO_OPEN_SHADOW_ROOT,
          `No open shadow root is attached at ${queryPath}`,
          queryPath,
          'classic'
        );
      }
      if (!(root instanceof ClassicShadowRoot)) {
        // Some remote ends expose the public getter but do not serialize a
        // ShadowRoot returned by Execute Script. The getter above is still the
        // open/closed privacy gate; only after it succeeds may we use the
        // dedicated W3C get-root endpoint.
        return { kind: 'classicShadow', root: await this.driver.getElementShadowRoot(host) };
      }
      return { kind: 'classicShadow', root };
    } catch (error) {
      if (CraftdriverError.is(error, ErrorCode.NO_OPEN_SHADOW_ROOT)) throw error;
      if (
        CraftdriverError.is(error, ErrorCode.DRIVER_ERROR) &&
        error.detail?.webDriverError !== 'stale element reference' &&
        error.detail?.webDriverError !== 'detached shadow root' &&
        error.detail?.webDriverError !== 'no such shadow root'
      ) {
        // A few intermediaries cannot serialize a ShadowRoot as an Execute
        // Script result. Re-check the public getter as a boolean privacy gate,
        // then use the dedicated W3C endpoint.
        try {
          const exposed = await this.driver.executeScript<boolean>(
            'return arguments[0].shadowRoot !== null;',
            [host]
          );
          if (!exposed) {
            throw shadowError(
              ErrorCode.NO_OPEN_SHADOW_ROOT,
              `No open shadow root is attached at ${queryPath}`,
              queryPath,
              'classic',
              error
            );
          }
          return { kind: 'classicShadow', root: await this.driver.getElementShadowRoot(host) };
        } catch (fallbackError) {
          if (CraftdriverError.is(fallbackError, ErrorCode.NO_OPEN_SHADOW_ROOT)) {
            throw fallbackError;
          }
          return mapClassicShadowError(fallbackError, queryPath, 'open');
        }
      }
      return mapClassicShadowError(error, queryPath, 'open');
    }
  }

  private async findFromRoot(
    root: ResolvedRoot,
    by: By,
    queryPath: string
  ): Promise<WebElement[]> {
    if (root.kind === 'document') return this.driver.findElements(by);
    if (root.kind === 'element') return root.element.findElements(by);
    if (root.kind === 'classicShadow') {
      try {
        if (needsSemanticEvaluation(by.descriptor)) {
          return await this.driver.executeScript<WebElement[]>(CLASSIC_SEMANTIC_SCRIPT, [
            root.root,
            by.descriptor,
          ]);
        }
        return await root.root.findElements(by);
      } catch (error) {
        return mapClassicShadowError(error, queryPath, 'query');
      }
    }

    try {
      if (needsSemanticEvaluation(by.descriptor)) {
        return this.findSemanticFromBidiRoot(root, by.descriptor!);
      }

      const descriptor = by.descriptor;
      const locator =
        descriptor?.kind === 'css'
          ? { type: 'css', value: descriptor.value }
          : descriptor?.kind === 'xpath'
            ? { type: 'xpath', value: descriptor.value }
            : by.using === 'css selector'
              ? { type: 'css', value: by.value }
              : by.using === 'xpath'
                ? { type: 'xpath', value: by.value }
                : null;
      if (!locator) {
        // Link-text and custom wire strategies are consistently evaluated by
        // the shared page function rather than translated approximately.
        const fallbackDescriptor: QueryDescriptor =
          descriptor ?? { kind: 'linkText', value: by.value, partial: by.using === 'partial link text' };
        return this.findSemanticFromBidiRoot(root, fallbackDescriptor);
      }
      const response = await root.connection.send<BidiLocateResult>('browsingContext.locateNodes', {
        context: root.contextId,
        locator,
        startNodes: [{ sharedId: root.sharedId }],
      });
      return (response.nodes ?? [])
        .flatMap((node) => remoteNodeSharedIds(node))
        .map((id) => this.driver.webElementFromId(id));
    } catch (error) {
      if (isUnsupportedBidiError(error)) {
        fallBackToClassicShadowQueries(this.driver, 'descendant lookup');
        // Re-open from the host through Classic. One attempt never combines a
        // BiDi root id with a Classic find-from-shadow operation.
        throw new RetryWithClassicShadowQuery(
          `Retry ${queryPath} through Classic after unsupported BiDi lookup`,
          { cause: error }
        );
      }
      if (isDetachedBidiError(error)) {
        throw shadowError(
          ErrorCode.DETACHED_SHADOW_ROOT,
          `Shadow root detached while resolving ${queryPath}`,
          queryPath,
          'bidi',
          error,
          { contextId: root.contextId }
        );
      }
      throw bidiDriverError(error, 'locate-nodes', queryPath, root.contextId);
    }
  }

  private async findSemanticFromBidiRoot(
    root: Extract<ResolvedRoot, { kind: 'bidiShadow' }>,
    descriptor: QueryDescriptor
  ): Promise<WebElement[]> {
    const response = await root.connection.send<ScriptEvaluateResult>('script.callFunction', {
      functionDeclaration: BIDI_SEMANTIC_FUNCTION,
      awaitPromise: false,
      target: { context: root.contextId },
      arguments: [
        { sharedId: root.sharedId },
        { type: 'string', value: JSON.stringify(descriptor) },
      ],
      resultOwnership: 'none',
      serializationOptions: { maxObjectDepth: 1 },
    });
    if (response.type === 'exception') {
      throw new Error(response.exceptionDetails?.text ?? 'BiDi semantic shadow query threw');
    }
    return remoteNodeSharedIds(response.result).map((id) => this.driver.webElementFromId(id));
  }
}

function needsSemanticEvaluation(descriptor: QueryDescriptor | undefined): boolean {
  return !!descriptor && descriptor.kind !== 'css' && descriptor.kind !== 'xpath';
}
