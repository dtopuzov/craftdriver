/**
 * Console and network history through the agent surface.
 *
 * The library's own `waitForConsole` only subscribes, so a message that
 * already arrived is invisible to it (pinned in `journal-wait-race.test.ts`).
 * These cover the shape an agent actually needs: act, then ask.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { AgentSession } from '../../src/cli/agentSession';
import { renderObservedResult } from '../../src/cli/daemon';
import { ErrorCode } from '../../src/lib/errors';
import type { JournalEntry } from '../../src/cli/journal';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface LogsPage {
  entries: JournalEntry[];
  cursor: number;
  dropped: number;
  droppedBeforeCursor: number;
  truncated: boolean;
  capturing: boolean;
  note?: string;
}

const FIXTURE = `${EXAMPLES_BASE_URL}/console-errors.html`;

describe('console and network journal', () => {
  let session: AgentSession;

  const logs = (args: Record<string, unknown> = {}): Promise<LogsPage> =>
    session.run({ cmd: 'logs', args: { action: 'list', ...args } }) as Promise<LogsPage>;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
    await session.run({ cmd: 'logs', args: { action: 'clear' } });
  });

  it('captures a console message after the fact', async () => {
    await session.run({ cmd: 'click', args: { selector: '#btn-console-log' } });
    const found = await session.run({
      cmd: 'logs',
      args: { action: 'wait', contains: 'Hello from console.log', timeout: 10_000 },
    });
    expect(found).toMatchObject({ ok: true });
  }, 120_000);

  it('captures an uncaught exception as an error entry', async () => {
    await session.run({ cmd: 'click', args: { selector: '#btn-throw-error' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', kind: 'error', timeout: 10_000 },
    });

    const page = await logs({ kind: 'error' });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.every((e) => e.kind === 'error')).toBe(true);
  }, 120_000);

  it('answers "what happened since" with a cursor', async () => {
    await session.run({ cmd: 'click', args: { selector: '#btn-console-log' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', contains: 'Hello from console.log', timeout: 10_000 },
    });
    const first = await logs();
    expect(first.entries.length).toBeGreaterThan(0);

    // Nothing new since that cursor.
    expect((await logs({ since: first.cursor })).entries).toEqual([]);

    await session.run({ cmd: 'click', args: { selector: '#btn-console-warn' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', since: first.cursor, contains: 'warn', timeout: 10_000 },
    });
    const next = await logs({ since: first.cursor });
    expect(next.entries.length).toBeGreaterThan(0);
  }, 120_000);

  it('records network requests without headers or bodies', async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/network.html` } });
    const page = await logs({ kind: 'request,response', limit: 50 });

    expect(page.entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(page.entries);
    expect(serialized).not.toContain('cookie');
    expect(serialized).not.toContain('authorization');
    // Shape is a summary, not a capture.
    for (const entry of page.entries) {
      expect(entry).not.toHaveProperty('headers');
      expect(entry).not.toHaveProperty('body');
    }
  }, 120_000);

  it('times out with a usable error rather than hanging', async () => {
    await expect(
      session.run({
        cmd: 'logs',
        args: { action: 'wait', contains: 'this-never-appears', timeout: 1_000 },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
  }, 120_000);

  it('rejects an unknown kind instead of quietly matching nothing', async () => {
    await expect(
      session.run({ cmd: 'logs', args: { action: 'list', kind: 'consle' } }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
  }, 120_000);

  it('clear empties the history but keeps capturing', async () => {
    await session.run({ cmd: 'click', args: { selector: '#btn-console-log' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', contains: 'Hello from console.log', timeout: 10_000 },
    });
    await session.run({ cmd: 'logs', args: { action: 'clear' } });
    expect((await logs()).entries).toEqual([]);

    await session.run({ cmd: 'click', args: { selector: '#btn-console-info' } });
    const after = await session.run({
      cmd: 'logs',
      args: { action: 'wait', contains: 'info', timeout: 10_000 },
    });
    expect(after).toMatchObject({ ok: true });
  }, 120_000);

  it('reports that capture is live', async () => {
    expect((await logs()).capturing).toBe(true);
  }, 120_000);
});

describe('the error tripwire in an observation', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
  });

  /** The observation an agent actually receives, as the transports render it. */
  const observe = async (selector: string): Promise<Record<string, unknown>> =>
    renderObservedResult(
      await session.runDetailed({ cmd: 'click', args: { selector }, observe: 'delta' }),
      'delta',
    ) as Record<string, unknown>;

  it('reports an error the action caused, on an action that changed no a11y node', async () => {
    const result = await observe('#btn-console-error');

    // The defect this closes: the delta says "(no a11y changes)" — nothing
    // visible happened — while the application logged an error. An agent
    // reading only the delta reasonably concludes all-clear.
    expect(result.errors).toBe(1);
    expect(result.logCursor).toEqual(expect.any(Number));

    // And the cursor it hands back reads exactly the window it counted.
    const page = (await session.run({
      cmd: 'logs',
      args: { action: 'list', kind: 'error', since: result.logCursor },
    })) as LogsPage;
    expect(page.entries).toHaveLength(1);
    expect(JSON.stringify(page.entries)).toContain('via console.error');
  }, 120_000);

  it('counts an uncaught exception too, not just console.error', async () => {
    const result = await observe('#btn-throw-error');
    expect(result.errors).toBeGreaterThan(0);
  }, 120_000);

  it('says zero rather than nothing on a clean action', async () => {
    await observe('#btn-console-error');
    // Second observation, quiet action: the count is per-action, so the
    // previous error must not still be reported here.
    const result = await observe('#btn-console-log');

    expect(result.errors).toBe(0);
    expect(result).toHaveProperty('logCursor');
  }, 120_000);
});
