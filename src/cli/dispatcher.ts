/**
 * Command dispatcher — single source of truth for "what each CLI
 * command does to a Browser instance".
 *
 * Pure logic: takes a `cmd` name + `args` object, returns either a
 * JSON-serializable result or throws `CraftdriverError`. The daemon
 * and the ephemeral runner both call into this; an MCP server can
 * reuse it later (different response shape, same dispatch table).
 *
 * Side effects (browser launch / shutdown) live in the caller.
 */
import { Browser, type LaunchOptions } from '../lib/browser.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { parseSelector, describeSelector } from './selector.js';
import { takeSnapshot } from './snapshot.js';
import { AGENT_DEFAULT_TIMEOUT_MS, AGENT_DEFAULT_LIMIT } from './defaults.js';

/** Lazy-initialized browser handle shared by all commands in a session. */
export interface BrowserHandle {
  /** Returns a connected browser, launching it on first call. */
  get(): Promise<Browser>;
  /** Returns the current instance without launching (null if not yet up). */
  peek(): Browser | null;
  /** Close the browser if it has been launched. */
  close(): Promise<void>;
}

export function createBrowserHandle(launch: () => Promise<Browser>): BrowserHandle {
  let inst: Browser | null = null;
  let pending: Promise<Browser> | null = null;
  return {
    async get() {
      if (inst) return inst;
      if (!pending) pending = launch().then((b) => { inst = b; pending = null; return b; });
      return pending;
    },
    peek() { return inst; },
    async close() {
      const b = inst;
      inst = null;
      if (b) await b.quit().catch(() => { /* ignore */ });
    },
  };
}

function ms(args: Record<string, unknown> | undefined, key = 'timeout'): number {
  // Validate-or-fallback to bound timer durations (defends against resource
  // exhaustion from hostile socket input). CodeQL does not treat Math.min
  // as a sanitizer, so we use explicit range checks.
  const MAX_TIMEOUT_MS = 300_000;
  const v = args?.[key];
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIMEOUT_MS) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n <= MAX_TIMEOUT_MS) return n;
  }
  return AGENT_DEFAULT_TIMEOUT_MS;
}

function str(args: Record<string, unknown> | undefined, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `dispatcher: missing required argument "${key}"`,
    );
  }
  return v;
}

function optStr(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = args?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function bool(args: Record<string, unknown> | undefined, key: string): boolean {
  return args?.[key] === true || args?.[key] === 'true';
}

function int(args: Record<string, unknown> | undefined, key: string, dflt: number): number {
  const v = args?.[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return dflt;
}

/** Best-effort short text snippet for `find` output. */
function snippet(s: string, max = 60): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

export interface DispatchContext {
  handle: BrowserHandle;
  launchOptions: LaunchOptions;
}

export async function dispatch(
  ctx: DispatchContext,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  switch (cmd) {
    // ---- session ---------------------------------------------------------
    case 'status': {
      const b = ctx.handle.peek();
      if (!b) return { browser: null, pid: process.pid, ready: false };
      const page = await b.activePage().catch(() => null);
      const url = page ? await page.url().catch(() => '') : '';
      return {
        browser: ctx.launchOptions.electron ? 'electron' : (ctx.launchOptions.browserName ?? 'chrome'),
        pid: process.pid,
        ready: true,
        activeUrl: url,
      };
    }

    case 'quit': {
      await ctx.handle.close();
      return { ok: true };
    }

    case 'trace-start': {
      const outDir = str(args, 'outDir');
      const b = await ctx.handle.get();
      await b.startTrace({ outDir, title: optStr(args, 'title') });
      return { ok: true, outDir };
    }

    case 'trace-stop': {
      const b = await ctx.handle.get();
      const path = optStr(args, 'path');
      await b.stopTrace(path ? { path } : undefined);
      return { ok: true, path: path ?? null };
    }

    // ---- navigation ------------------------------------------------------
    case 'go': {
      const url = str(args, 'url');
      const b = await ctx.handle.get();
      await b.navigateTo(url);
      const page = await b.activePage();
      return { url: await page.url(), title: await page.title() };
    }

    case 'back': {
      const b = await ctx.handle.get();
      const page = await b.activePage();
      await page.goBack();
      return { url: await page.url() };
    }

    case 'forward': {
      const b = await ctx.handle.get();
      const page = await b.activePage();
      await page.goForward();
      return { url: await page.url() };
    }

    case 'reload': {
      const b = await ctx.handle.get();
      const page = await b.activePage();
      await page.reload();
      return { url: await page.url() };
    }

    // ---- find ------------------------------------------------------------
    case 'find': {
      const by = parseSelector(str(args, 'selector'));
      const all = bool(args, 'all');
      const limit = int(args, 'limit', AGENT_DEFAULT_LIMIT);
      const offset = int(args, 'offset', 0);
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      const total = els.length;
      if (!all) {
        if (total === 0) {
          throw new CraftdriverError(
            ErrorCode.NO_MATCH,
            `find: no element matches ${describeSelector(by)}`,
            { detail: { selector: describeSelector(by) } }
          );
        }
        const first = els[0];
        return {
          count: total,
          truncated: total > 1,
          matches: [
            {
              tag: await first.tagName().catch(() => ''),
              text: snippet(await first.text().catch(() => '')),
              visible: await first.isVisible().catch(() => false),
            },
          ],
        };
      }
      const slice = els.slice(offset, offset + limit);
      const matches = await Promise.all(slice.map(async (el, i) => ({
        index: offset + i,
        tag: await el.tagName().catch(() => ''),
        text: snippet(await el.text().catch(() => '')),
        visible: await el.isVisible().catch(() => false),
      })));
      return {
        count: total,
        offset,
        limit,
        truncated: offset + slice.length < total,
        total,
        next_offset: offset + slice.length < total ? offset + slice.length : null,
        matches,
      };
    }

    case 'exists': {
      const by = parseSelector(str(args, 'selector'));
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      return { exists: els.length > 0, count: els.length };
    }

    // ---- actions ---------------------------------------------------------
    case 'click': {
      const by = parseSelector(str(args, 'selector'));
      const b = await ctx.handle.get();
      await b.click(by, { timeout: ms(args) });
      return { ok: true, selector: describeSelector(by) };
    }

    case 'fill': {
      const by = parseSelector(str(args, 'selector'));
      const value = str(args, 'value');
      const b = await ctx.handle.get();
      await b.fill(by, value, { timeout: ms(args) });
      return { ok: true, selector: describeSelector(by) };
    }

    case 'press': {
      const key = str(args, 'key');
      const b = await ctx.handle.get();
      const sel = optStr(args, 'selector');
      if (sel) {
        const by = parseSelector(sel);
        const els = await b.findAll(by);
        if (els.length === 0) {
          throw new CraftdriverError(
            ErrorCode.NO_MATCH,
            `press: no element matches ${describeSelector(by)}`,
            { detail: { selector: describeSelector(by) } }
          );
        }
        await els[0].click();
      }
      await b.keyboard.press(key);
      return { ok: true, key };
    }

    case 'hover': {
      const by = parseSelector(str(args, 'selector'));
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      if (els.length === 0) {
        throw new CraftdriverError(
          ErrorCode.NO_MATCH,
          `hover: no element matches ${describeSelector(by)}`,
          { detail: { selector: describeSelector(by) } }
        );
      }
      await els[0].hover({ timeout: ms(args) });
      return { ok: true, selector: describeSelector(by) };
    }

    // ---- read ------------------------------------------------------------
    case 'text': {
      const sel = optStr(args, 'selector');
      const b = await ctx.handle.get();
      if (!sel) {
        const page = await b.activePage();
        const body = await page.evaluate('return document.body ? document.body.innerText : "";');
        const limit = int(args, 'limit', 2000);
        const text = String(body);
        return { text: text.length > limit ? text.slice(0, limit) + '…' : text, truncated: text.length > limit, total: text.length };
      }
      const by = parseSelector(sel);
      const els = await b.findAll(by);
      if (els.length === 0) {
        throw new CraftdriverError(
          ErrorCode.NO_MATCH,
          `text: no element matches ${describeSelector(by)}`,
          { detail: { selector: describeSelector(by) } }
        );
      }
      return { text: await els[0].text() };
    }

    case 'attr': {
      const by = parseSelector(str(args, 'selector'));
      const name = str(args, 'name');
      const b = await ctx.handle.get();
      const value = await b.getAttribute(by, name, { timeout: ms(args) });
      return { name, value };
    }

    case 'value': {
      const by = parseSelector(str(args, 'selector'));
      const b = await ctx.handle.get();
      return { value: await b.getValue(by, { timeout: ms(args) }) };
    }

    case 'is': {
      const what = str(args, 'what');
      const by = parseSelector(str(args, 'selector'));
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      if (els.length === 0) {
        if (what === 'visible') return { result: false };
        throw new CraftdriverError(
          ErrorCode.NO_MATCH,
          `is ${what}: no element matches ${describeSelector(by)}`,
          { detail: { selector: describeSelector(by) } }
        );
      }
      const el = els[0];
      switch (what) {
        case 'visible': return { result: await el.isVisible() };
        case 'enabled': return { result: await el.isEnabled() };
        case 'checked': return { result: await el.isChecked() };
        default:
          throw new CraftdriverError(
            ErrorCode.INVALID_ARGUMENT,
            `is: unknown state "${what}". Expected: visible | enabled | checked`,
          );
      }
    }

    // ---- wait ------------------------------------------------------------
    case 'wait': {
      const target = str(args, 'target');
      const kind = optStr(args, 'kind') ?? 'selector';
      const b = await ctx.handle.get();
      if (kind === 'selector') {
        const state = (optStr(args, 'state') ?? 'visible') as
          'visible' | 'hidden' | 'attached' | 'detached';
        await b.waitFor(parseSelector(target), { state, timeout: ms(args) });
        return { ok: true, state };
      }
      if (kind === 'load') {
        await b.waitForLoadState((optStr(args, 'state') as 'load' | 'domcontentloaded' | 'networkidle' | undefined) ?? 'load', { timeout: ms(args) });
        return { ok: true };
      }
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `wait: unknown kind "${kind}". Expected: selector | load`,
      );
    }

    // ---- pages / screenshot ---------------------------------------------
    case 'pages': {
      const b = await ctx.handle.get();
      const pages = await b.pages();
      const out = await Promise.all(pages.map(async (p, i) => ({
        index: i,
        id: p.id(),
        url: await p.url().catch(() => ''),
        title: await p.title().catch(() => ''),
      })));
      return { pages: out, count: out.length };
    }

    case 'screenshot': {
      const b = await ctx.handle.get();
      const fullPage = bool(args, 'fullPage');
      const sel = optStr(args, 'selector');
      const path = optStr(args, 'path');
      const buf = await b.screenshot({
        ...(path ? { path } : {}),
        ...(sel ? { selector: parseSelector(sel) } : {}),
        ...(fullPage ? { fullPage: true } : {}),
        timeout: ms(args),
      });
      return { ok: true, path: path ?? null, bytes: buf.length };
    }

    // ---- snapshot --------------------------------------------------------
    // Sanitized accessibility-tree summary of the active page. Each
    // visible interactive node gets a stable ref (`eN`) which can be
    // used as a selector via `ref=eN` for the next command. Refs
    // invalidate on the next snapshot or on navigation.
    case 'snapshot': {
      const b = await ctx.handle.get();
      const snap = await takeSnapshot(b);
      if (!snap) {
        return { url: '', title: '', lines: [], note: 'no snapshot available' };
      }
      return { url: snap.url, title: snap.title, lines: snap.lines };
    }

    // ---- eval (advanced) -------------------------------------------------
    case 'eval': {
      const code = str(args, 'js');
      const b = await ctx.handle.get();
      const page = await b.activePage();
      // Wrap as function body so callers can pass either an expression
      // ("document.title") or a statement list ("return foo + 1;").
      const body = /\breturn\b/.test(code) ? code : `return (${code});`;
      const result = await page.evaluate(body);
      return { result };
    }

    default:
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `unknown command "${cmd}"`,
        { hint: 'run `craftdriver --help` for the command list' }
      );
  }
}
