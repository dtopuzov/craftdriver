/**
 * Registry integrity: every advertised tool is real, and its metadata is true.
 *
 * `browser_trace` advertised itself for months while dispatching `trace-start`,
 * a command that had been replaced — a tool can be perfectly well-formed and
 * still map to nothing. Reading the dispatcher's own switch is what makes this
 * drift-proof: a hand-maintained list of valid commands could go stale the
 * same way the tool did.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOOLS, inputSchemaFor, validateToolArgs } from '../../src/cli/mcp/tools.js';
import { isMutating } from '../../src/cli/dispatcher.js';
import type { ParamSpec } from '../../src/cli/mcp/params.js';

/** Command labels the dispatcher's switch actually handles. */
const DISPATCHER_COMMANDS: Set<string> = (() => {
  const source = readFileSync(
    resolve(__dirname, '..', '..', 'src', 'cli', 'dispatcher.ts'),
    'utf8'
  );
  return new Set([...source.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
})();

/** A plausible value for a parameter, used to exercise `toDispatch`. */
function sampleFor(spec: ParamSpec): unknown {
  switch (spec.type) {
    case 'string':
      return spec.enum ? spec.enum[0] : 'x';
    case 'number':
      return spec.integer ? (spec.min ?? 1) : (spec.min ?? 1);
    case 'boolean':
      return true;
    case 'string[]':
      return ['x'];
  }
}

/**
 * Every argument combination worth dispatching: one per value of an `action`
 * enum, since that is what selects the command. A tool whose third action
 * mapped to a typo would otherwise pass on the strength of its first.
 */
function argVariants(tool: (typeof TOOLS)[number]): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tool.params)) {
    if (spec.required) base[name] = sampleFor(spec);
  }

  const action = tool.params.action;
  if (action && action.type === 'string' && action.enum) {
    return action.enum.map((value) => ({ ...base, action: value }));
  }
  return [base];
}

describe('every tool is well-formed', () => {
  it('has a unique, prefixed name', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('browser_'))).toBe(true);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s has a description and title', (_n, tool) => {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.annotations.title.length).toBeGreaterThan(0);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))('%s advertises a usable schema', (_n, tool) => {
    const schema = inputSchemaFor(tool) as { type: string; additionalProperties: boolean };
    expect(schema.type).toBe('object');
    // Enforced at runtime, so it must be advertised too.
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('every tool dispatches a command that exists', () => {
  it('found the dispatcher switch, so this cannot pass vacuously', () => {
    expect(DISPATCHER_COMMANDS.size).toBeGreaterThan(20);
    expect(DISPATCHER_COMMANDS.has('click')).toBe(true);
  });

  const cases = TOOLS.flatMap((tool) =>
    argVariants(tool).map((args) => [tool.name, tool, args] as const)
  );

  it.each(cases)('%s → a real command', (_name, tool, args) => {
    // Round-trip through validation first: if the sample arguments are not
    // even valid, the mapping below would be testing a fiction.
    const validated = validateToolArgs(tool, args);
    const { cmd } = tool.toDispatch(validated);
    expect(DISPATCHER_COMMANDS.has(cmd)).toBe(true);
  });
});

describe('annotations tell the truth', () => {
  const cases = TOOLS.flatMap((tool) =>
    argVariants(tool).map((args) => [tool.name, tool, args] as const)
  );

  // The check that makes readOnlyHint meaningful: a client may auto-approve
  // on it, so a read-only tool must never reach a command the dispatcher
  // itself considers page-mutating.
  it.each(cases)('%s: readOnlyHint matches what it dispatches', (_name, tool, args) => {
    const { cmd } = tool.toDispatch(validateToolArgs(tool, args));
    if (tool.annotations.readOnlyHint) {
      expect(isMutating(cmd)).toBe(false);
    }
  });

  it('marks the tools that can destroy work as destructive', () => {
    const destructive = TOOLS.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    // eval can rewrite the page; state load replaces cookies and storage.
    expect(destructive).toContain('browser_advanced_eval');
    expect(destructive).toContain('browser_state');
  });

  it('does not claim a read-only tool is destructive', () => {
    for (const tool of TOOLS) {
      if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it('marks status as closed-world, since it touches nothing external', () => {
    const status = TOOLS.find((t) => t.name === 'browser_status');
    expect(status?.annotations.openWorldHint).toBe(false);
  });
});

describe('parity with the landed CLI surface', () => {
  // The packet maps landed shared commands; these are the ones AIWEB-01/05/06
  // added that an agent needs to run the documented workflow.
  it.each([
    ['durable selectors', 'locators'],
    ['tabs', 'page'],
    ['console and network evidence', 'logs'],
    ['network mocking', 'mock'],
    ['login state', 'state'],
    ['tracing', 'trace'],
    ['dialogs', 'dialog'],
    ['file upload', 'upload'],
    ['keyboard', 'key'],
    ['mouse', 'mouse'],
    ['typing into focus', 'type'],
  ])('exposes %s', (_label, cmd) => {
    const reachable = TOOLS.some((tool) =>
      argVariants(tool).some((args) => {
        try {
          return tool.toDispatch(validateToolArgs(tool, args)).cmd === cmd;
        } catch {
          return false;
        }
      })
    );
    expect(reachable).toBe(true);
  });

  it('does not expose named sessions, which MCP cannot honour', () => {
    // One stdio server is one session; a --session argument would promise
    // routing that does not exist here.
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain('browser_session');
    for (const tool of TOOLS) {
      expect(Object.keys(tool.params)).not.toContain('session');
    }
  });

  it('maps browser_fill submit onto the shared dispatcher flag', () => {
    const tool = TOOLS.find((candidate) => candidate.name === 'browser_fill')!;
    const validated = validateToolArgs(tool, {
      selector: '#query',
      value: 'Telerik',
      submit: true,
    });

    expect(tool.toDispatch(validated)).toMatchObject({
      cmd: 'fill',
      args: { selector: '#query', value: 'Telerik', submit: true },
    });
  });
});
