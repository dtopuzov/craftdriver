/**
 * The CLI daemon and MCP server are local dev tools only — they must never
 * launch a `remote` (Selenium Grid / BrowserStack / cloud) session. Both
 * entry points call `assertLocalOnlyLaunch()` synchronously, before any
 * socket/stdio listener starts or `Browser.launch()` is reached.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDaemon } from '../src/cli/daemon.js';
import { runMcpServer } from '../src/cli/mcp/server.js';
import { Browser } from '../src/lib/browser.js';
import { CraftdriverError, ErrorCode } from '../src/lib/errors.js';
import { PassThrough } from 'stream';

const REMOTE_LAUNCH = { remote: { url: 'https://hub.example.com/wd/hub' } } as any;

describe('CLI daemon / MCP server reject remote launches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runDaemon() rejects synchronously and never creates the socket file', async () => {
    const launchSpy = vi.spyOn(Browser, 'launch');
    const socketPath = path.join(os.tmpdir(), `craftdriver-test-${Date.now()}.sock`);
    const pidPath = path.join(os.tmpdir(), `craftdriver-test-${Date.now()}.pid`);

    await expect(runDaemon({ socketPath, pidPath, launch: REMOTE_LAUNCH })).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED,
    });

    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(pidPath)).toBe(false);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('runMcpServer() rejects synchronously and never calls Browser.launch()', async () => {
    const launchSpy = vi.spyOn(Browser, 'launch');
    const input = new PassThrough();
    const output = new PassThrough();

    await expect(
      runMcpServer({ launch: REMOTE_LAUNCH, input, output, snapshot: 'none' })
    ).rejects.toMatchObject({ code: ErrorCode.UNSUPPORTED });

    expect(launchSpy).not.toHaveBeenCalled();
  });

  it('a local launch config does not trip the guard (regression check)', async () => {
    // Only asserts the guard itself doesn't throw for a local config; does
    // not run the full daemon (which would block forever listening).
    const { assertLocalOnlyLaunch } = await import('../src/lib/launchTarget.js');
    expect(() => assertLocalOnlyLaunch({ browserName: 'chrome' })).not.toThrow();
  });
});
