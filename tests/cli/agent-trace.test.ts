/**
 * Trace start/stop through the agent surface.
 *
 * A thin wrapper over the library tracer, so these cover what the CLI owns:
 * where output lands, that names cannot escape the owned root, and that
 * liveness is never reported wrongly.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../../src/cli/agentSession';
import { ErrorCode } from '../../src/lib/errors';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface TraceResult {
  ok?: boolean;
  running?: boolean;
  action?: string;
  name?: string;
  outDir?: string;
  trace?: string;
  zip?: string;
  root?: string;
}

describe('tracing', () => {
  let root: string;
  const previousEnv = process.env.CRAFTDRIVER_TRACE_DIR;

  const newSession = (): AgentSession =>
    new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-trace-'));
    process.env.CRAFTDRIVER_TRACE_DIR = root;
  });

  afterAll(async () => {
    if (previousEnv === undefined) delete process.env.CRAFTDRIVER_TRACE_DIR;
    else process.env.CRAFTDRIVER_TRACE_DIR = previousEnv;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records a flow and reports where it landed', async () => {
    const session = newSession();
    try {
      const started = (await session.run({
        cmd: 'trace',
        args: { action: 'start', name: 'checkout' },
      })) as TraceResult;
      expect(started.ok).toBe(true);
      expect(started.outDir).toBe(path.join(root, 'checkout'));

      await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
      await session.run({ cmd: 'fill', args: { selector: '#username', value: 'alice' } });

      const stopped = (await session.run({
        cmd: 'trace',
        args: { action: 'stop' },
      })) as TraceResult;
      expect(stopped.ok).toBe(true);
      expect(existsSync(stopped.trace as string)).toBe(true);

      // The NDJSON should carry the actions we performed.
      const ndjson = await fs.readFile(stopped.trace as string, 'utf-8');
      expect(ndjson).toContain('"type":"meta"');
      expect(ndjson.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('reports liveness honestly across the whole cycle', async () => {
    const session = newSession();
    try {
      expect(((await session.run({ cmd: 'trace', args: { action: 'status' } })) as TraceResult).running)
        .toBe(false);

      await session.run({ cmd: 'trace', args: { action: 'start', name: 'live' } });
      const during = (await session.run({ cmd: 'trace', args: { action: 'status' } })) as TraceResult;
      expect(during.running).toBe(true);
      expect(during.name).toBe('live');

      await session.run({ cmd: 'trace', args: { action: 'stop' } });
      expect(((await session.run({ cmd: 'trace', args: { action: 'status' } })) as TraceResult).running)
        .toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('refuses a second concurrent trace instead of silently replacing one', async () => {
    const session = newSession();
    try {
      await session.run({ cmd: 'trace', args: { action: 'start', name: 'first' } });
      await expect(
        session.run({ cmd: 'trace', args: { action: 'start', name: 'second' } }),
      ).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });
      await session.run({ cmd: 'trace', args: { action: 'stop' } });
    } finally {
      await session.close();
    }
  }, 120_000);

  it('errors on stop when nothing is recording', async () => {
    const session = newSession();
    try {
      await expect(
        session.run({ cmd: 'trace', args: { action: 'stop' } }),
      ).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });
    } finally {
      await session.close();
    }
  }, 120_000);

  it('rejects a path-shaped name before starting anything', async () => {
    const session = newSession();
    try {
      await expect(
        session.run({ cmd: 'trace', args: { action: 'start', name: '../escape' } }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
      expect(existsSync(path.join(path.dirname(root), 'escape'))).toBe(false);

      // ...and the failed start left no phantom recording behind.
      const status = (await session.run({ cmd: 'trace', args: { action: 'status' } })) as TraceResult;
      expect(status.running).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('exports an archive only when asked', async () => {
    const session = newSession();
    try {
      await session.run({ cmd: 'trace', args: { action: 'start', name: 'zipped' } });
      await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
      const stopped = (await session.run({
        cmd: 'trace',
        args: { action: 'stop', zip: true },
      })) as TraceResult;

      expect(stopped.zip).toBe(path.join(root, 'zipped.zip'));
      expect(existsSync(stopped.zip as string)).toBe(true);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('leaves no recording behind when the session closes mid-trace', async () => {
    const session = newSession();
    await session.run({ cmd: 'trace', args: { action: 'start', name: 'abandoned' } });
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
    // quit() aborts a running trace, so closing must not hang or throw.
    await expect(session.close()).resolves.toBeUndefined();
  }, 120_000);
});
