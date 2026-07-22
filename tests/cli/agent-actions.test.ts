/**
 * The common Chrome action set, and durable locator candidates.
 *
 * These cover the shared dispatcher commands directly rather than through
 * a transport, because that is where the behavior lives — CLI and MCP only
 * parse and render.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { resolve } from 'node:path';
import { AgentSession } from '../../src/cli/agentSession';
import { ErrorCode } from '../../src/lib/errors';
import type { LocatorReport } from '../../src/cli/locatorCandidates';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('agent action set', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/agent-actions.html` } });
  });

  it('clear empties a prefilled input', async () => {
    await session.run({ cmd: 'clear', args: { selector: '#nickname' } });
    const after = (await session.run({
      cmd: 'value',
      args: { selector: '#nickname' },
    })) as { value: string };
    expect(after.value).toBe('');
  });

  it('check and uncheck are idempotent', async () => {
    const checked = async (): Promise<boolean> => {
      const r = (await session.run({
        cmd: 'is',
        args: { what: 'checked', selector: '#newsletter' },
      })) as { result: boolean };
      return r.result;
    };

    await session.run({ cmd: 'check', args: { selector: '#newsletter' } });
    expect(await checked()).toBe(true);
    // A second check must not toggle it back off.
    await session.run({ cmd: 'check', args: { selector: '#newsletter' } });
    expect(await checked()).toBe(true);

    await session.run({ cmd: 'uncheck', args: { selector: '#newsletter' } });
    expect(await checked()).toBe(false);
    await session.run({ cmd: 'uncheck', args: { selector: '#newsletter' } });
    expect(await checked()).toBe(false);
  });

  it('select picks an option by its value attribute', async () => {
    await session.run({ cmd: 'select', args: { selector: '#plan', value: 'pro' } });
    const after = (await session.run({
      cmd: 'value',
      args: { selector: '#plan' },
    })) as { value: string };
    expect(after.value).toBe('pro');
  });

  it('dblclick fires a double-click handler', async () => {
    await session.run({ cmd: 'dblclick', args: { selector: '#counter' } });
    const count = (await session.run({
      cmd: 'text',
      args: { selector: '#dbl-count' },
    })) as { text: string };
    expect(count.text).toBe('1');
  });

  it('fill targets a field; type goes to whatever has focus', async () => {
    const value = async (): Promise<string> => {
      const r = (await session.run({
        cmd: 'value',
        args: { selector: '#nickname' },
      })) as { value: string };
      return r.value;
    };

    // The fixture ships value="preset"; fill replaces it.
    await session.run({ cmd: 'fill', args: { selector: '#nickname', value: 'alice' } });
    expect(await value()).toBe('alice');

    // `type` takes no selector — it needs focus set first.
    await session.run({ cmd: 'focus', args: { selector: '#nickname' } });
    await session.run({ cmd: 'type', args: { text: '-bob' } });
    expect(await value()).toBe('alice-bob');
  });

  it('focus puts the caret at the end so type appends rather than prepends', async () => {
    await session.run({ cmd: 'focus', args: { selector: '#nickname' } });
    await session.run({ cmd: 'type', args: { text: 'XY' } });
    const after = (await session.run({
      cmd: 'value',
      args: { selector: '#nickname' },
    })) as { value: string };
    // A bare focus() leaves the caret at offset 0, which would give "XYpreset".
    expect(after.value).toBe('presetXY');
  });

  it('type drives the focused field key handlers', async () => {
    await session.run({ cmd: 'focus', args: { selector: '#nickname' } });
    await session.run({ cmd: 'type', args: { text: 'a' } });
    const log = (await session.run({ cmd: 'text', args: { selector: '#log' } })) as { text: string };
    expect(log.text).toBe('keydown seen');
  });

  it('focus does not fire the element click handler', async () => {
    await session.run({ cmd: 'focus', args: { selector: '#save' } });
    const log = (await session.run({ cmd: 'text', args: { selector: '#log' } })) as { text: string };
    // #save's click handler would write "saved"; focusing must not trigger it.
    expect(log.text).not.toBe('saved');
  });

  it('press with a selector focuses it without firing its click handler', async () => {
    // Regression: press used to click the element to focus it, so
    // `press Enter #submit` fired the handler AND sent Enter — a double
    // submit, and a double toggle on a checkbox.
    await session.run({ cmd: 'press', args: { key: 'Tab', selector: '#save' } });
    const log = (await session.run({ cmd: 'text', args: { selector: '#log' } })) as { text: string };
    expect(log.text).not.toBe('saved');
  });

  it('check reports the state the page actually holds', async () => {
    const result = (await session.run({
      cmd: 'check',
      args: { selector: '#newsletter' },
    })) as { checked: boolean };
    expect(result.checked).toBe(true);

    const observed = (await session.run({
      cmd: 'is',
      args: { what: 'checked', selector: '#newsletter' },
    })) as { result: boolean };
    // The command must not simply echo back what was requested.
    expect(result.checked).toBe(observed.result);
  });

  it('key rejects the removed type action and points at the type command', async () => {
    const error = await session
      .run({ cmd: 'key', args: { action: 'type', key: 'a' } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect((error as { hint?: string }).hint).toContain('type <text>');
  });

  it('scroll brings an off-screen element into view', async () => {
    await session.run({ cmd: 'scroll', args: { selector: '#far-below' } });
    const y = (await session.run({
      cmd: 'eval',
      args: { js: 'return window.scrollY' },
    })) as { result: number };
    expect(y.result).toBeGreaterThan(0);
  });

  it('focus moves the active element', async () => {
    await session.run({ cmd: 'focus', args: { selector: '#nickname' } });
    const active = (await session.run({
      cmd: 'eval',
      args: { js: 'return document.activeElement.id' },
    })) as { result: string };
    expect(active.result).toBe('nickname');
  });

  it('mouse click activates an element', async () => {
    await session.run({ cmd: 'mouse', args: { action: 'click', selector: '#save' } });
    const log = (await session.run({ cmd: 'text', args: { selector: '#log' } })) as { text: string };
    expect(log.text).toBe('saved');
  });

  it('mouse wheel scrolls the page', async () => {
    await session.run({ cmd: 'mouse', args: { action: 'wheel', deltaY: 400 } });
    // The actions command completing means the wheel input was dispatched;
    // the browser may apply its default scrolling on a later rendering task.
    await expect
      .poll(async () => {
        const y = (await session.run({
          cmd: 'eval',
          args: { js: 'return window.scrollY' },
        })) as { result: number };
        return y.result;
      })
      .toBeGreaterThan(0);
  });

  it('rejects an unknown sub-action instead of doing something surprising', async () => {
    const error = await session
      .run({ cmd: 'mouse', args: { action: 'teleport' } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('upload rejects a missing file rather than silently uploading nothing', async () => {
    const error = await session
      .run({ cmd: 'upload', args: { selector: '#nickname', files: './definitely-not-here.png' } })
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('upload sets files on a file input and never echoes contents', async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/upload.html` } });
    const file = resolve(process.cwd(), 'tests', 'fixtures', 'sample.txt');

    const result = (await session.run({
      cmd: 'upload',
      args: { selector: '#file-input', files: [file] },
    })) as { ok: boolean; files: string[]; count: number };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    // Paths, never bytes: the fixture's contents must not reach the agent.
    expect(JSON.stringify(result)).not.toContain('hello from craftdriver');
  });
});

describe('durable locator candidates', () => {
  let session: AgentSession;

  beforeAll(async () => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/agent-actions.html` } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('offers role+name first and validates it against the live page', async () => {
    const report = (await session.run({
      cmd: 'locators',
      args: { selector: '#save' },
    })) as LocatorReport;

    expect(report.candidates[0].kind).toBe('role');
    expect(report.candidates[0].selector).toBe('role=button[name=Save changes]');
    const unique = report.candidates.filter((c) => c.status === 'unique');
    expect(unique.length).toBeGreaterThan(0);
    expect(report.best).toBe('role=button[name=Save changes]');
  });

  it('offers the test id and emits usable craftdriver code', async () => {
    const report = (await session.run({
      cmd: 'locators',
      args: { selector: '#save' },
    })) as LocatorReport;

    const testid = report.candidates.find((c) => c.kind === 'testid');
    expect(testid?.selector).toBe('testid=save-button');
    expect(testid?.status).toBe('unique');
    expect(testid?.code).toBe('By.testId("save-button")');
  });

  it('offers the associated label for a form field', async () => {
    const report = (await session.run({
      cmd: 'locators',
      args: { selector: '#nickname' },
    })) as LocatorReport;

    const label = report.candidates.find((c) => c.kind === 'label');
    expect(label?.selector).toBe('label=Nickname');
    expect(label?.status).toBe('unique');
  });

  it('never proposes a generated id as a durable CSS candidate', async () => {
    const report = (await session.run({
      cmd: 'locators',
      args: { selector: '#a1b2c3d4e5f6' },
    })) as LocatorReport;

    expect(report.candidates.some((c) => c.selector.includes('a1b2c3d4e5f6'))).toBe(false);
  });

  it('emits no ref into any candidate', async () => {
    const snap = (await session.run({ cmd: 'snapshot' })) as { lines: string[] };
    const ref = /^(e\d+):/.exec(snap.lines[0].trim())?.[1];
    expect(ref).toBeDefined();

    const report = (await session.run({
      cmd: 'locators',
      args: { selector: `ref=${ref}` },
    })) as LocatorReport;

    // Refs are exploration-only: they may be the *input*, never the output.
    for (const c of report.candidates) {
      expect(c.selector).not.toMatch(/\bref=e\d+/);
      expect(c.code).not.toMatch(/\bref=e\d+/);
      expect(c.code).not.toMatch(/data-craftdriver/);
    }
  });

  it('leaves no probe attribute behind on the page', async () => {
    await session.run({ cmd: 'locators', args: { selector: '#save' } });
    const left = (await session.run({
      cmd: 'eval',
      args: { js: 'return document.querySelectorAll("[data-craftdriver-probe]").length' },
    })) as { result: number };
    expect(left.result).toBe(0);
  });
});
