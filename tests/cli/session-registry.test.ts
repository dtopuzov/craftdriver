/**
 * Named session registry and daemon routing.
 *
 * Before this, the daemon owned exactly one `AgentSession`, so two agents
 * (or two workflows driven by one agent) sharing a daemon shared a browser,
 * a page selection, a snapshot baseline and a ref registry. There was no way
 * to ask for a second one short of running a second daemon.
 *
 * The contract here: a name is validated before it reaches a socket or the
 * filesystem, sessions are created lazily and bounded, each owns its own
 * `SnapshotTracker`, and the queues progress independently.
 *
 * Browser-free by construction — the registry is handed a fake session
 * factory — so this stays in the default suite.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../src/lib/errors.js';
import { handleDaemonRequest } from '../../src/cli/daemon.js';
import {
  createSessionRegistry,
  DEFAULT_SESSION,
  MAX_SESSIONS,
  validateSessionName,
} from '../../src/cli/sessionRegistry.js';
import type { AgentSessionRunner } from '../../src/cli/agentSession.js';

function fakeSession(): AgentSessionRunner & { name?: string } {
  return {
    run: vi.fn(async (command) => ({ cmd: command.cmd, args: command.args ?? {} })),
    runDetailed: vi.fn(async (command) => ({ value: { cmd: command.cmd, args: command.args ?? {} } })),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function registryWithFakes() {
  const created: string[] = [];
  const sessions = new Map<string, AgentSessionRunner>();
  const registry = createSessionRegistry({
    create: (name) => {
      created.push(name);
      const session = fakeSession();
      sessions.set(name, session);
      return session;
    },
  });
  return { registry, created, sessions };
}

describe('session name validation', () => {
  it('accepts conservative names and rejects everything else', () => {
    // JSON has no `undefined`, so an omitted wire field arrives as either.
    expect(validateSessionName(undefined)).toBe(DEFAULT_SESSION);
    expect(validateSessionName(null)).toBe(DEFAULT_SESSION);
    expect(validateSessionName('checkout')).toBe('checkout');
    expect(validateSessionName('admin-2')).toBe('admin-2');
    expect(validateSessionName('a_b')).toBe('a_b');

    // Path traversal and separators: the auth/storage slice turns a session
    // name into a directory component, so these must never get that far.
    for (const bad of ['..', '.', 'a/b', 'a\\b', '~root', 'a b', '', 'a'.repeat(33), '-lead', 'a\0b']) {
      expect(() => validateSessionName(bad), `expected ${JSON.stringify(bad)} to be rejected`)
        .toThrowError(expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }));
    }
    // Non-strings from an untrusted socket peer.
    for (const bad of [42, {}, [], true]) {
      expect(() => validateSessionName(bad)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_ARGUMENT }),
      );
    }
  });
});

describe('session registry', () => {
  it('creates a session lazily, once per name', () => {
    const { registry, created } = registryWithFakes();

    expect(created).toEqual([]);
    const first = registry.get('checkout');
    const again = registry.get('checkout');

    expect(created).toEqual(['checkout']);
    expect(again).toBe(first);
    expect(registry.get('admin')).not.toBe(first);
    expect(created).toEqual(['checkout', 'admin']);
  });

  it('bounds the number of live sessions and names the limit', () => {
    const { registry } = registryWithFakes();

    for (let i = 0; i < MAX_SESSIONS; i++) registry.get(`s${i}`);

    let thrown: unknown;
    try {
      registry.get('one-too-many');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: ErrorCode.STATE_INVALID });
    expect((thrown as Error).message).toContain(String(MAX_SESSIONS));
    // An existing session still resolves — the cap is on creation only.
    expect(() => registry.get('s0')).not.toThrow();
  });

  it('frees a slot when a session is closed', async () => {
    const { registry, sessions } = registryWithFakes();
    for (let i = 0; i < MAX_SESSIONS; i++) registry.get(`s${i}`);

    await expect(registry.close('s0')).resolves.toBe(true);
    expect(sessions.get('s0')!.close).toHaveBeenCalledTimes(1);
    // Idempotent: closing an unknown or already-closed session is not an error.
    await expect(registry.close('s0')).resolves.toBe(false);
    expect(() => registry.get('one-more')).not.toThrow();
  });

  it('lists live sessions without launching anything', () => {
    const { registry, created } = registryWithFakes();
    expect(registry.list()).toEqual([]);

    registry.get('checkout');
    registry.get(DEFAULT_SESSION);

    expect(registry.list().map((s) => s.name)).toEqual(['checkout', DEFAULT_SESSION]);
    expect(created).toEqual(['checkout', DEFAULT_SESSION]);
  });

  it('closes every session on shutdown', async () => {
    const { registry, sessions } = registryWithFakes();
    registry.get('a');
    registry.get('b');

    await registry.closeAll();

    for (const session of sessions.values()) {
      expect(session.close).toHaveBeenCalledTimes(1);
    }
    expect(registry.list()).toEqual([]);
  });
});

describe('daemon session routing', () => {
  it('routes every unnamed request to the one default session', async () => {
    const { registry, created, sessions } = registryWithFakes();

    await expect(handleDaemonRequest(registry, { id: 1, cmd: 'status' })).resolves.toEqual({
      id: 1,
      ok: true,
      result: { cmd: 'status', args: {} },
    });
    await expect(handleDaemonRequest(registry, {
      id: 2,
      cmd: 'go',
      args: { url: 'https://example.test' },
    })).resolves.toEqual({
      id: 2,
      ok: true,
      result: { cmd: 'go', args: { url: 'https://example.test' } },
    });

    expect(created).toEqual([DEFAULT_SESSION]);
    const runDetailed = sessions.get(DEFAULT_SESSION)!.runDetailed as ReturnType<typeof vi.fn>;
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(runDetailed.mock.calls[0][0]).toEqual({ cmd: 'status', args: {} });
    expect(runDetailed.mock.calls[1][0]).toEqual({ cmd: 'go', args: { url: 'https://example.test' } });
  });

  it('routes named requests to their own session and never to another', async () => {
    const { registry, sessions } = registryWithFakes();

    await handleDaemonRequest(registry, { id: 1, cmd: 'go', session: 'checkout', args: { url: 'https://a.test' } });
    await handleDaemonRequest(registry, { id: 2, cmd: 'go', session: 'admin', args: { url: 'https://b.test' } });

    expect(sessions.get('checkout')!.runDetailed).toHaveBeenCalledTimes(1);
    expect(sessions.get('checkout')!.runDetailed).toHaveBeenCalledWith({
      cmd: 'go',
      args: { url: 'https://a.test' },
    });
    expect(sessions.get('admin')!.runDetailed).toHaveBeenCalledTimes(1);
    expect(sessions.get('admin')!.runDetailed).toHaveBeenCalledWith({
      cmd: 'go',
      args: { url: 'https://b.test' },
    });
    expect(sessions.has(DEFAULT_SESSION)).toBe(false);
  });

  it('returns a requested atomic page observation without changing normal results', async () => {
    const runDetailed = vi.fn().mockResolvedValue({
      value: { ok: true, selector: 'ref=e7' },
      delta: 'page: Done — https://example.test/done',
      page: {
        url: 'https://example.test/done',
        title: 'Done',
        documentId: 'd2',
        revision: 4,
        documentChange: 'changed',
      },
    });
    const registry = createSessionRegistry({
      create: () => ({ run: vi.fn(), runDetailed, close: vi.fn().mockResolvedValue(undefined) }),
    });

    await expect(handleDaemonRequest(registry, {
      id: 1,
      cmd: 'click',
      args: { selector: 'ref=e7', observe: 'page' },
    })).resolves.toEqual({
      id: 1,
      ok: true,
      result: {
        ok: true,
        selector: 'ref=e7',
        page: {
          url: 'https://example.test/done',
          title: 'Done',
          documentId: 'd2',
          revision: 4,
          documentChange: 'changed',
        },
      },
    });
    expect(runDetailed).toHaveBeenCalledWith({
      cmd: 'click', args: { selector: 'ref=e7' }, observe: 'page',
    });

    await expect(handleDaemonRequest(registry, {
      id: 2,
      cmd: 'click',
      args: { selector: 'ref=e7', observe: 'delta' },
    })).resolves.toMatchObject({
      id: 2,
      ok: true,
      result: { ok: true, selector: 'ref=e7', delta: 'page: Done — https://example.test/done' },
    });
  });

  it('returns an observation warning when page state is unavailable', async () => {
    const runDetailed = vi.fn().mockResolvedValue({
      value: { ok: true, selector: '#show-alert' },
      delta: 'dialog open: Hello from alert',
    });
    const registry = createSessionRegistry({
      create: () => ({ run: vi.fn(), runDetailed, close: vi.fn().mockResolvedValue(undefined) }),
    });

    await expect(handleDaemonRequest(registry, {
      id: 1,
      cmd: 'click',
      args: { selector: '#show-alert', observe: 'page' },
    })).resolves.toMatchObject({
      id: 1,
      ok: true,
      result: {
        ok: true,
        selector: '#show-alert',
        warning: 'dialog open: Hello from alert',
      },
    });
  });

  it('rejects an invalid daemon observation before dispatching it', async () => {
    const { registry, sessions } = registryWithFakes();
    await expect(handleDaemonRequest(registry, {
      id: 1,
      cmd: 'click',
      args: { selector: '#save', observe: 'all' },
    })).resolves.toMatchObject({ id: 1, ok: false, error: { code: ErrorCode.INVALID_ARGUMENT } });
    expect(sessions.has(DEFAULT_SESSION)).toBe(false);
  });

  it('rejects a bad session name from the socket before creating anything', async () => {
    const { registry, created } = registryWithFakes();

    const resp = await handleDaemonRequest(registry, { id: 7, cmd: 'go', session: '../../etc' });

    expect(resp).toMatchObject({ id: 7, ok: false, error: { code: ErrorCode.INVALID_ARGUMENT } });
    expect(created).toEqual([]);
  });

  it('lets sessions progress independently instead of sharing one queue', async () => {
    // The daemon-wide FIFO was the point of a single session. Named sessions
    // are only useful if a slow command in one does not stall the other.
    const slow = { resolve: () => {} };
    const slowPromise = new Promise<void>((r) => { slow.resolve = r; });
    const registry = createSessionRegistry({
      create: (name) => ({
        run: vi.fn(async (command) => {
          if (name === 'slow') await slowPromise;
          return { cmd: command.cmd, session: name };
        }),
        runDetailed: vi.fn(async (command) => {
          if (name === 'slow') await slowPromise;
          return { value: { cmd: command.cmd, session: name } };
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const blocked = handleDaemonRequest(registry, { id: 1, cmd: 'click', session: 'slow' });
    const other = handleDaemonRequest(registry, { id: 2, cmd: 'click', session: 'quick' });

    await expect(other).resolves.toMatchObject({ id: 2, ok: true });
    slow.resolve();
    await expect(blocked).resolves.toMatchObject({ id: 1, ok: true });
  });

  it('serves session list and close without dispatching a browser command', async () => {
    const { registry, sessions } = registryWithFakes();
    registry.get('checkout');

    const listed = await handleDaemonRequest(registry, { id: 1, cmd: 'session:list' });
    expect(listed).toMatchObject({
      id: 1,
      ok: true,
      result: { sessions: [{ name: 'checkout' }], count: 1, limit: MAX_SESSIONS },
    });

    const closed = await handleDaemonRequest(registry, { id: 2, cmd: 'session:close', args: { target: 'checkout' } });
    expect(closed).toMatchObject({ id: 2, ok: true, result: { closed: true, name: 'checkout' } });
    expect(sessions.get('checkout')!.close).toHaveBeenCalledTimes(1);
    expect(sessions.get('checkout')!.run).not.toHaveBeenCalled();

    // Idempotent, and still validated.
    await expect(
      handleDaemonRequest(registry, { id: 3, cmd: 'session:close', args: { target: 'checkout' } }),
    ).resolves.toMatchObject({ id: 3, ok: true, result: { closed: false } });
    await expect(
      handleDaemonRequest(registry, { id: 4, cmd: 'session:close', args: { target: '../x' } }),
    ).resolves.toMatchObject({ id: 4, ok: false, error: { code: ErrorCode.INVALID_ARGUMENT } });
  });

  it('preserves daemon ping, stop and structured command errors', async () => {
    const runs: Array<ReturnType<typeof vi.fn>> = [];
    const registry = createSessionRegistry({
      create: () => {
        const runDetailed = vi.fn().mockRejectedValue(new Error('dispatch failed'));
        runs.push(runDetailed);
        return { run: vi.fn(), runDetailed, close: vi.fn().mockResolvedValue(undefined) };
      },
    });
    const onStop = vi.fn();

    await expect(handleDaemonRequest(registry, { id: 3, cmd: 'daemon:ping' })).resolves.toEqual({
      id: 3,
      ok: true,
      result: { pong: true, pid: process.pid },
    });
    await expect(handleDaemonRequest(registry, { id: 4, cmd: 'go' })).resolves.toEqual({
      id: 4,
      ok: false,
      error: { code: ErrorCode.DRIVER_ERROR, message: 'dispatch failed' },
    });
    await expect(
      handleDaemonRequest(registry, { id: 5, cmd: 'daemon:stop' }, onStop),
    ).resolves.toEqual({ id: 5, ok: true, result: { stopping: true, pid: process.pid } });
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));

    // Only the `go` reached a session: ping and stop never dispatch, and
    // never cause a browser to be created for them.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveBeenCalledTimes(1);
  });
});
