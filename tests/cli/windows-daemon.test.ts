/**
 * The daemon is unsupported on Windows, and says so.
 *
 * It binds a Unix domain socket. On Windows, Node maps a listen path onto a
 * named pipe under `\\.\pipe\`, so the socket path the CLI computes cannot be
 * bound — the daemon has never worked there, and CI could not see it because
 * the Windows job runs a library-level browser smoke only.
 *
 * Rather than surfacing the resulting ENOENT, the CLI refuses up front and
 * names the two socket-free modes. This pins that both of those modes stay
 * reachable on Windows: a guard that also blocked them would be worse than
 * the error it replaced.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { main } from '../../src/cli/index';
import { ErrorCode } from '../../src/lib/errors';

/** Run `main` on a faked platform, capturing stderr. */
async function runAs(platform: string, argv: string[]): Promise<{ code: number; err: string }> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let err = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return { code: await main(argv), err };
  } finally {
    spy.mockRestore();
    stdout.mockRestore();
    Object.defineProperty(process, 'platform', original);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('daemon on Windows', () => {
  it.each([
    ['daemon', 'start'],
    ['daemon', 'status'],
    ['daemon', 'stop'],
  ])('refuses `%s %s` with an operational error', async (...cmd) => {
    const { code, err } = await runAs('win32', cmd);
    expect(code).toBe(1);
    expect(err).toContain('not supported on Windows');
  });

  it('refuses a plain command that would auto-start the daemon', async () => {
    // The failure this replaces: an ENOENT from binding a socket path that
    // Windows cannot interpret, with nothing pointing at a way forward.
    const { code, err } = await runAs('win32', ['go', 'https://example.test']);
    expect(code).toBe(1);
    expect(err).toContain('not supported on Windows');
  });

  it('carries a stable error code and names the socket-free alternatives', async () => {
    const { err } = await runAs('win32', ['daemon', 'status']);
    expect(err).toContain(ErrorCode.UNSUPPORTED);
    expect(err).toContain('--ephemeral');
    expect(err).toContain('mcp');
  });

  it('does not block anything on a supported platform', async () => {
    // `daemon status` on Linux/macOS reports state rather than refusing; the
    // guard must not be reachable there.
    const { err } = await runAs('linux', ['daemon', 'status']);
    expect(err).not.toContain('not supported on Windows');
  });
});
