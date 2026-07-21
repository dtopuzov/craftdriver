/**
 * Invalid input is rejected before a browser is started.
 *
 * The packet rule is "validate untrusted CLI, daemon, and MCP input before
 * filesystem, browser, timer, or process effects", and it is easy to violate
 * by accident: the natural way to write a command is to grab the browser
 * first and read arguments where they are used. That costs a full launch on
 * every typo, and reports the failure as a driver error rather than the usage
 * error it is — `trace stop` and `logs --kind <typo>` both did exactly that.
 *
 * The trick here is a launch that always throws. Any command that reaches the
 * browser surfaces that failure; a command that validates first surfaces the
 * usage error instead. Browser-free and instant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Browser } from '../../src/lib/browser.js';
import { AgentSession } from '../../src/cli/agentSession';
import { ErrorCode } from '../../src/lib/errors';

const LAUNCH_MARKER = 'launch-should-not-have-happened';

let launches = 0;
let session: AgentSession;

beforeEach(() => {
  launches = 0;
  session = new AgentSession({
    launchOptions: {},
    launch: async (): Promise<Browser> => {
      launches++;
      throw new Error(LAUNCH_MARKER);
    },
  });
});

/** Assert the command failed on its own argument, not on the browser. */
async function rejectsBeforeLaunch(
  cmd: string,
  args: Record<string, unknown>,
  code: string,
): Promise<void> {
  await expect(session.run({ cmd, args })).rejects.toMatchObject({ code });
  expect(launches).toBe(0);
}

describe('argument validation precedes any browser launch', () => {
  it.each([
    ['logs: unknown kind', 'logs', { action: 'list', kind: 'consle' }],
    ['logs: unknown action', 'logs', { action: 'tail' }],
    ['mock: unknown action', 'mock', { action: 'intercept' }],
    ['mock: missing pattern', 'mock', { action: 'add' }],
    ['mock: bad status', 'mock', { action: 'add', pattern: '**/a*', status: 999 }],
    ['mock: oversized body', 'mock', { action: 'add', pattern: '**/a*', body: 'x'.repeat(70_000) }],
    ['mock: unknown id', 'mock', { action: 'remove', id: 'nope' }],
    ['state: path-shaped name', 'state', { action: 'save', name: '../escape' }],
    ['state: unknown action', 'state', { action: 'destroy', name: 'a' }],
    ['trace: path-shaped name', 'trace', { action: 'start', name: '../escape' }],
  ])('%s', async (_label, cmd, args) => {
    await rejectsBeforeLaunch(cmd, args as Record<string, unknown>, ErrorCode.INVALID_ARGUMENT);
  });

  it('trace stop with nothing recording is a state error, not a driver error', async () => {
    await rejectsBeforeLaunch('trace', { action: 'stop' }, ErrorCode.STATE_INVALID);
  });
});

describe('questions answerable without a browser do not start one', () => {
  it('logs clear empties an in-memory buffer', async () => {
    await expect(session.run({ cmd: 'logs', args: { action: 'clear' } })).resolves.toMatchObject({
      ok: true,
    });
    expect(launches).toBe(0);
  });

  it('mock list reports nothing installed', async () => {
    await expect(session.run({ cmd: 'mock', args: { action: 'list' } })).resolves.toMatchObject({
      count: 0,
    });
    expect(launches).toBe(0);
  });

  it('mock clear with nothing installed has nothing to do', async () => {
    await expect(session.run({ cmd: 'mock', args: { action: 'clear' } })).resolves.toMatchObject({
      cleared: 0,
    });
    expect(launches).toBe(0);
  });

  it('trace status reports that nothing is recording', async () => {
    await expect(session.run({ cmd: 'trace', args: { action: 'status' } })).resolves.toMatchObject({
      running: false,
    });
    expect(launches).toBe(0);
  });

  it('state list reads the directory, not the browser', async () => {
    await expect(session.run({ cmd: 'state', args: { action: 'list' } })).resolves.toHaveProperty(
      'states',
    );
    expect(launches).toBe(0);
  });
});

describe('commands that genuinely need a browser still take one', () => {
  // The guard above must not be satisfied by a command that quietly stopped
  // doing its job.
  it.each([
    ['logs list', 'logs', { action: 'list' }],
    ['mock add', 'mock', { action: 'add', pattern: '**/ok*', status: 200 }],
    ['trace start', 'trace', { action: 'start', name: 'ok' }],
  ])('%s reaches the launch', async (_label, cmd, args) => {
    await expect(session.run({ cmd, args })).rejects.toThrow(LAUNCH_MARKER);
    expect(launches).toBe(1);
  });
});
