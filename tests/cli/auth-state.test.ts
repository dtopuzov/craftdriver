/**
 * Saving and restoring authentication state through the agent surface.
 *
 * The headline case is the one the library gets wrong on its own: local
 * storage is origin-scoped, and restoring it onto a page that is not on that
 * origin drops every entry without an error. Measured against the login
 * example, `Browser.launch({ storageState })` restores cookies but returns an
 * empty localStorage, so a state file can look restored while half of it is
 * gone. The CLI refuses that combination rather than reproducing it.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../../src/cli/agentSession';
import { ErrorCode } from '../../src/lib/errors';
import { CraftdriverError } from '../../src/lib/errors';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface StateResult {
  ok: boolean;
  action: string;
  name: string;
  origin: string | null;
  cookies: number;
  origins: string[];
  storageKeys: number;
  note?: string;
}

const LOGIN_URL = `${EXAMPLES_BASE_URL}/login.html`;

describe('authentication / storage state', () => {
  let root: string;
  const previousEnv = process.env.CRAFTDRIVER_STATE_DIR;

  const newSession = (): AgentSession =>
    new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });

  async function logIn(session: AgentSession): Promise<void> {
    await session.run({ cmd: 'go', args: { url: LOGIN_URL } });
    await session.run({ cmd: 'fill', args: { selector: '#username', value: 'testuser' } });
    await session.run({ cmd: 'fill', args: { selector: '#password', value: 'secret123' } });
    await session.run({ cmd: 'click', args: { selector: '#submit' } });
    await session.run({ cmd: 'wait', args: { target: '#welcome', kind: 'selector' } });
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-auth-'));
    process.env.CRAFTDRIVER_STATE_DIR = root;
  });

  afterAll(async () => {
    if (previousEnv === undefined) delete process.env.CRAFTDRIVER_STATE_DIR;
    else process.env.CRAFTDRIVER_STATE_DIR = previousEnv;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves a logged-in session without exposing any secret', async () => {
    const session = newSession();
    try {
      await logIn(session);
      const saved = (await session.run({
        cmd: 'state',
        args: { action: 'save', name: 'alice' },
      })) as StateResult;

      expect(saved.ok).toBe(true);
      expect(saved.cookies).toBeGreaterThan(0);
      // login.html stores lastUser + theme in localStorage.
      expect(saved.storageKeys).toBeGreaterThan(0);
      expect(saved.origins).toContain(new URL(LOGIN_URL).origin);

      // The result an agent sees carries counts, never values.
      const serialized = JSON.stringify(saved);
      expect(serialized).not.toContain('testuser');
      expect(serialized).not.toContain('secret123');

      // The file on disk is a credential: owner-only.
      const file = path.join(root, 'alice.json');
      if (process.platform !== 'win32') {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
      // ...and no temp file was left behind.
      const leftovers = (await fs.readdir(root)).filter((f) => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('refuses to restore storage onto a page that is not on its origin', async () => {
    const session = newSession();
    try {
      // A fresh browser sits on about:blank, which is exactly where an agent
      // would naively "load state, then navigate" — and exactly where the
      // underlying restore silently drops every storage entry.
      await expect(
        session.run({ cmd: 'state', args: { action: 'load', name: 'alice' } }),
      ).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });

      try {
        await session.run({ cmd: 'state', args: { action: 'load', name: 'alice' } });
      } catch (err) {
        const e = err as CraftdriverError;
        expect(e.message).toMatch(/holds storage for/);
        // The fix has to be actionable: name the origin to navigate to.
        expect(e.hint).toContain(new URL(LOGIN_URL).origin);
      }
    } finally {
      await session.close();
    }
  }, 120_000);

  it('restores cookies and local storage after navigating to the origin', async () => {
    const session = newSession();
    try {
      await session.run({ cmd: 'go', args: { url: LOGIN_URL } });
      const loaded = (await session.run({
        cmd: 'state',
        args: { action: 'load', name: 'alice' },
      })) as StateResult;
      expect(loaded.ok).toBe(true);

      // Cookies drive the login; reloading picks them up.
      await session.run({ cmd: 'reload', args: {} });
      const welcome = (await session.run({
        cmd: 'text',
        args: { selector: '#welcome' },
      })) as { text: string };
      expect(welcome.text).toContain('testuser');

      // Local storage is the half that the launch-time path loses.
      const stored = (await session.run({
        cmd: 'eval',
        args: { js: 'return localStorage.getItem("lastUser") + "/" + localStorage.getItem("theme")' },
      })) as { result: string };
      expect(stored.result).toBe('testuser/dark');
    } finally {
      await session.close();
    }
  }, 120_000);

  it('says so when a save from no origin could only capture cookies', async () => {
    const session = newSession();
    try {
      // Saving before navigating anywhere is silently partial: there is no
      // origin to read local storage from. Report it rather than handing back
      // a state file that will restore less than the agent expects.
      const saved = (await session.run({
        cmd: 'state',
        args: { action: 'save', name: 'blank' },
      })) as StateResult;

      expect(saved.origin).toBeNull();
      expect(saved.storageKeys).toBe(0);
      expect(saved.note).toMatch(/no page origin/);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('captures session storage only when asked', async () => {
    const session = newSession();
    try {
      await logIn(session);
      await session.run({
        cmd: 'eval',
        args: { js: 'sessionStorage.setItem("scratch", "temp"); return 1' },
      });

      const without = (await session.run({
        cmd: 'state',
        args: { action: 'save', name: 'nosession' },
      })) as StateResult;
      const withIt = (await session.run({
        cmd: 'state',
        args: { action: 'save', name: 'withsession', sessionStorage: true },
      })) as StateResult;

      expect(withIt.storageKeys).toBeGreaterThan(without.storageKeys);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('invalidates refs, since the document they were issued against is stale', async () => {
    const session = newSession();
    try {
      await session.run({ cmd: 'go', args: { url: LOGIN_URL } });
      await session.run({ cmd: 'snapshot', args: {} });
      await session.run({ cmd: 'state', args: { action: 'load', name: 'alice' } });

      // The baseline is gone, so a ref cannot resolve until a fresh snapshot.
      await expect(
        session.run({ cmd: 'click', args: { selector: 'ref=e1' } }),
      ).rejects.toMatchObject({ code: ErrorCode.STALE_REF });
    } finally {
      await session.close();
    }
  }, 120_000);

  it('lists saved state and reports a missing one by name', async () => {
    const session = newSession();
    try {
      const listed = (await session.run({ cmd: 'state', args: { action: 'list' } })) as {
        states: string[];
        root: string;
      };
      expect(listed.states).toContain('alice');

      await expect(
        session.run({ cmd: 'state', args: { action: 'load', name: 'ghost' } }),
      ).rejects.toThrow(/no saved state named "ghost"/);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('rejects a path-shaped name before touching the filesystem', async () => {
    const session = newSession();
    try {
      await expect(
        session.run({ cmd: 'state', args: { action: 'save', name: '../escape' } }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });

      const escaped = path.join(path.dirname(root), 'escape.json');
      await expect(fs.stat(escaped)).rejects.toThrow();
    } finally {
      await session.close();
    }
  }, 120_000);
});
