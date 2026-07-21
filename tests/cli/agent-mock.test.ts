/**
 * Flat network mocking through the agent surface.
 *
 * Only the two rule shapes the public library already supports as data — a
 * fixed response and a block. `network.intercept()` takes a handler function,
 * which a command line cannot express, and inventing a rule language to close
 * that gap is out of scope, so it is simply not offered.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { AgentSession } from '../../src/cli/agentSession';
import { ErrorCode } from '../../src/lib/errors';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface MockResult {
  ok?: boolean;
  id?: string;
  pattern?: string;
  status?: number;
  cleared?: number;
  remaining?: number;
  mocks?: Array<{ id: string; pattern: string; kind: string; status?: number }>;
  count?: number;
}

describe('network mocking', () => {
  let session: AgentSession;

  const mock = (args: Record<string, unknown>): Promise<MockResult> =>
    session.run({ cmd: 'mock', args }) as Promise<MockResult>;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await mock({ action: 'clear' });
  });

  it('serves a fixed response for a matching request', async () => {
    await mock({
      action: 'add',
      pattern: '**/mocked-endpoint*',
      status: 200,
      body: '{"mocked":true}',
      contentType: 'application/json',
    });

    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/network.html` } });
    const fetched = (await session.run({
      cmd: 'eval',
      args: {
        js: 'return fetch("/mocked-endpoint").then(r => r.text())',
      },
    })) as { result: string };

    expect(fetched.result).toContain('"mocked":true');
  }, 120_000);

  it('lists and removes what it installed', async () => {
    const added = await mock({ action: 'add', pattern: '**/a*', status: 204 });
    const blocked = await mock({ action: 'block', pattern: '**/b*' });

    const listed = await mock({ action: 'list' });
    expect(listed.count).toBe(2);
    expect(listed.mocks?.map((m) => m.kind).sort()).toEqual(['block', 'mock']);

    const removed = await mock({ action: 'remove', id: added.id });
    expect(removed.remaining).toBe(1);
    expect((await mock({ action: 'list' })).mocks?.[0].id).toBe(blocked.id);
  }, 120_000);

  it('clear removes every active mock and reports how many', async () => {
    await mock({ action: 'add', pattern: '**/x*' });
    await mock({ action: 'add', pattern: '**/y*' });
    expect((await mock({ action: 'clear' })).cleared).toBe(2);
    expect((await mock({ action: 'list' })).count).toBe(0);
  }, 120_000);

  it('validates the response before installing anything', async () => {
    // A mock installed with a bad status is worse than one refused: the
    // failure then surfaces as an unexplained page error much later.
    await expect(mock({ action: 'add', pattern: '**/z*', status: 999 })).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
    await expect(
      mock({ action: 'add', pattern: '**/z*', body: 'x'.repeat(70_000) }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });

    // Nothing was installed by either rejection.
    expect((await mock({ action: 'list' })).count).toBe(0);
  }, 120_000);

  it('requires a pattern rather than matching everything by default', async () => {
    await expect(mock({ action: 'add' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
  }, 120_000);

  it('rejects an unknown id and an unknown action', async () => {
    await expect(mock({ action: 'remove', id: 'nope' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
    await expect(mock({ action: 'intercept' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
  }, 120_000);

  it('caps how many can be active at once', async () => {
    for (let i = 0; i < 20; i++) await mock({ action: 'add', pattern: `**/cap-${i}*` });
    await expect(mock({ action: 'add', pattern: '**/one-too-many*' })).rejects.toMatchObject({
      code: ErrorCode.STATE_INVALID,
    });
  }, 180_000);
});
