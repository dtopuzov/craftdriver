#!/usr/bin/env node
/**
 * Generate `docs/api-reference.md` — one canonical table of every public
 * symbol re-exported from `src/index.ts`. Designed for humans and AI agents:
 * grouped enough to browse, strict enough that they never invent a method.
 *
 * Usage:
 *   node scripts/gen-api-reference.mjs           # write the file
 *   node scripts/gen-api-reference.mjs --check   # exit 1 if file out of date
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const entryFile = path.join(repoRoot, 'src', 'index.ts');
const outFile = path.join(repoRoot, 'docs', 'api-reference.md');

// Map a symbol's defining filename (basename, no .ts) to the topic doc.
// Anything not listed falls back to a hint that the symbol is library-internal.
const TOPIC_DOC = {
  browser: 'docs/browser-api.md',
  browserContext: 'docs/browser-context.md',
  page: 'docs/browser-api.md',
  frame: 'docs/browser-api.md',
  locator: 'docs/selectors.md',
  elementHandle: 'docs/element-api.md',
  webelement: 'docs/element-api.md',
  by: 'docs/selectors.md',
  keys: 'docs/keyboard-mouse.md',
  keyboard: 'docs/keyboard-mouse.md',
  mouse: 'docs/keyboard-mouse.md',
  tracing: 'docs/tracing.md',
  a11y: 'docs/accessibility.md',
  clock: 'docs/clock.md',
  chrome: 'docs/getting-started.md',
  firefox: 'docs/getting-started.md',
  errors: 'docs/error-codes.md',
  index: 'docs/getting-started.md',
};
const BIDI_SYMBOL_DOC = {
  ConsoleMessage: 'docs/browser-logs.md',
  JavaScriptError: 'docs/browser-logs.md',
  LogMessage: 'docs/browser-logs.md',
  LogMonitor: 'docs/browser-logs.md',
  InterceptedRequest: 'docs/network.md',
  InterceptedResponse: 'docs/network.md',
  MockResponse: 'docs/network.md',
  NetworkInterceptor: 'docs/network.md',
  Cookie: 'docs/session-management.md',
  CookieInput: 'docs/session-management.md',
  SessionState: 'docs/session-management.md',
  SessionStateManager: 'docs/session-management.md',
  StorageStateOptions: 'docs/session-management.md',
};
const BIDI_FILE_DOC = {
  logs: 'docs/browser-logs.md',
  network: 'docs/network.md',
  storage: 'docs/session-management.md',
};
const CATEGORIES = [
  {
    title: 'Browser And Pages',
    description: 'Launch browsers, move between pages and frames, handle dialogs, and wait for navigation.',
    symbols: [
      'Browser',
      'LaunchOptions',
      'LoadState',
      'Page',
      'Frame',
      'Dialog',
      'DialogType',
      'Download',
    ],
  },
  {
    title: 'Locators And Elements',
    description: 'Find page content with semantic locators and selector helpers.',
    symbols: ['By', 'Locator'],
  },
  {
    title: 'Input',
    description: 'Drive keyboard, mouse, and low-level key values.',
    symbols: ['Key', 'Keyboard', 'Mouse'],
  },
  {
    title: 'Contexts And Sessions',
    description: 'Isolate users, manage cookies, and save or restore browser state.',
    symbols: [
      'BrowserContext',
      'BrowserContextConfig',
      'BrowserContextHooks',
      'ClearCookiesFilter',
      'ContextStorageStateOptions',
      'InitScriptHandle',
      'RoutePattern',
      'Cookie',
      'CookieInput',
      'SessionState',
      'SessionStateManager',
      'StorageStateOptions',
    ],
  },
  {
    title: 'Network',
    description: 'Mock, intercept, observe, and assert browser network traffic.',
    symbols: ['NetworkInterceptor', 'MockResponse', 'InterceptedRequest', 'InterceptedResponse'],
  },
  {
    title: 'Logs And Tracing',
    description: 'Capture console output, JavaScript errors, and trace artifacts.',
    symbols: [
      'LogMonitor',
      'ConsoleMessage',
      'JavaScriptError',
      'LogMessage',
      'TraceStartOptions',
      'TraceStopOptions',
      'TraceScreenshotMode',
      'TraceEvent',
    ],
  },
  {
    title: 'Emulation And Time',
    description: 'Configure devices, emulation overrides, and deterministic browser time.',
    symbols: [
      'devices',
      'DeviceMetrics',
      'DeviceName',
      'MobileEmulation',
      'EmulateOptions',
      'Clock',
      'ClockInstallOptions',
      'ClockTime',
    ],
  },
  {
    title: 'Accessibility',
    description: 'Run axe-core accessibility checks and inspect violation details.',
    symbols: [
      'A11y',
      'A11yError',
      'A11yImpact',
      'A11yOptions',
      'A11yResult',
      'A11yViolation',
      'A11yViolationNode',
    ],
  },
  {
    title: 'Errors And Driver Services',
    description: 'Handle stable CraftDriver errors or customize browser driver services.',
    symbols: [
      'CraftdriverError',
      'CraftdriverErrorOptions',
      'ErrorCode',
      'ErrorCodeName',
      'ErrorCodeValue',
      'ChromeService',
      'ChromeServiceOptions',
      'FirefoxService',
      'FirefoxServiceOptions',
    ],
  },
];

function loadProgram() {
  const program = ts.createProgram({
    rootNames: [entryFile],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: false,
      declaration: false,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
    },
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryFile);
  if (!source) throw new Error(`Cannot load ${entryFile}`);
  return { program, checker, source };
}

/** First non-empty line of a JSDoc comment, stripped and squeezed. */
function jsdocSummary(symbol, checker) {
  const docs = symbol.getDocumentationComment(checker);
  const text = ts.displayPartsToString(docs).trim();
  if (!text) return '';
  const firstPara = text.split(/\n\s*\n/)[0];
  return firstPara.replace(/\s+/g, ' ').trim();
}

/** Classify a symbol into one of: class / function / type / const / enum / namespace. */
function classify(symbol) {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Enum) return 'enum';
  if (f & ts.SymbolFlags.TypeAlias) return 'type';
  if (f & ts.SymbolFlags.Interface) return 'type';
  if (f & ts.SymbolFlags.Variable) return 'const';
  if (f & ts.SymbolFlags.Module) return 'namespace';
  return 'value';
}

/** Where is this symbol defined? Returns repo-relative file path or null. */
function definingFile(symbol) {
  const decl = symbol.declarations?.[0];
  if (!decl) return null;
  const file = decl.getSourceFile().fileName;
  const relative = path.relative(repoRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

/** Pick a topic doc for the symbol based on its defining file. */
function topicLink(definingPath, symbolName) {
  if (!definingPath) return null;
  if (BIDI_SYMBOL_DOC[symbolName]) return BIDI_SYMBOL_DOC[symbolName];
  const base = path.basename(definingPath, '.ts');
  const portablePath = definingPath.split(path.sep).join('/');
  if (portablePath.includes('/bidi/')) return BIDI_FILE_DOC[base] ?? null;
  return TOPIC_DOC[base] ?? null;
}

function collectExports() {
  const { checker, source } = loadProgram();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error('No module symbol for src/index.ts');
  const exports = checker.getExportsOfModule(moduleSymbol);

  return exports
    .map((symbol) => {
      // Follow aliases (re-exports) to the real declaration.
      let target = symbol;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        target = checker.getAliasedSymbol(symbol);
      }
      const definingPath = definingFile(target);
      return {
        name: symbol.getName(),
        kind: classify(target),
        summary: jsdocSummary(target, checker) || jsdocSummary(symbol, checker),
        topic: topicLink(definingPath, symbol.getName()),
        definingPath,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderTable(rows) {
  const lines = [];
  lines.push('# API reference');
  lines.push('');
  lines.push('Every symbol re-exported from [`src/index.ts`](../src/index.ts), grouped by the feature area most users look for first.');
  lines.push('Generated by `scripts/gen-api-reference.mjs` — do not edit by hand.');
  lines.push('');
  lines.push('Run `npm run docs:api` to regenerate. CI fails when this file is out of date.');
  lines.push('');

  lines.push('Start with [`Browser`](./browser-api.md), [`By`](./selectors.md) / [`Locator`](./selectors.md), and the feature guide that matches the job you are automating.');
  lines.push('');

  const rowByName = new Map(rows.map((row) => [row.name, row]));
  const rendered = new Set();

  for (const category of CATEGORIES) {
    const categoryRows = category.symbols
      .map((name) => rowByName.get(name))
      .filter(Boolean);
    if (categoryRows.length === 0) continue;

    lines.push(`## ${category.title}`);
    lines.push('');
    lines.push(category.description);
    lines.push('');
    renderRows(lines, categoryRows);
    for (const row of categoryRows) rendered.add(row.name);
  }

  const remaining = rows.filter((row) => !rendered.has(row.name));
  if (remaining.length > 0) {
    lines.push('## Other Exports');
    lines.push('');
    lines.push('Exports that are public but not yet assigned to a feature group.');
    lines.push('');
    renderRows(lines, remaining);
  }

  lines.push(`Total exports: **${rows.length}**.`);
  lines.push('');
  return lines.join('\n');
}

function renderRows(lines, rows) {
  lines.push('| Symbol | Kind | Summary | Docs |');
  lines.push('|---|---|---|---|');
  for (const r of rows) {
    const summary = r.summary
      ? r.summary.replace(/[\\|]/g, '\\$&')
      : '—';
    // The output file lives in docs/, so link targets are relative to docs/.
    const docLink = r.topic
      ? `[${path.basename(r.topic, '.md')}](${path.relative('docs', r.topic)})`
      : '—';
    lines.push(`| \`${r.name}\` | ${r.kind} | ${summary} | ${docLink} |`);
  }
  lines.push('');
}

function main() {
  const check = process.argv.includes('--check');
  const rows = collectExports();
  const next = renderTable(rows);
  if (check) {
    const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    if (current !== next) {
      console.error('docs/api-reference.md is out of date. Run: npm run docs:api');
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(outFile, next);
  console.log(`Wrote ${path.relative(repoRoot, outFile)} (${rows.length} symbols).`);
}

main();
