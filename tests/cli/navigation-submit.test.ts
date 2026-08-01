/** Observed Enter/submit actions must snapshot the destination, not the old complete document. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSession, type AgentDetailedResult } from '../../src/cli/agentSession';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const FIXTURE = `${EXAMPLES_BASE_URL}/reactive-search.html`;

function pageResult(result: AgentDetailedResult, query: string): void {
  expect(result.page?.url).toContain(`destination=1&q=${encodeURIComponent(query)}`);
  expect(result.page?.documentChange).not.toBe('same');
  expect(result.delta).toContain(`heading "${query}"`);
}

describe('observed Enter and atomic fill submit', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({
      launchOptions: { browserName: BROWSER_NAME },
      autoSnapshot: false,
    });
  });

  afterAll(async () => {
    await session.close();
  });

  it('observes the destination after Enter in ten consecutive delayed navigations', async () => {
    for (let run = 0; run < 10; run += 1) {
      const query = `Enter-${run}`;
      await session.run({ cmd: 'go', args: { url: `${FIXTURE}?delay=40&run=${run}` } });
      await session.run({ cmd: 'fill', args: { selector: '#query', value: query } });
      const result = await session.runDetailed({
        cmd: 'press',
        args: { key: 'Enter' },
        observe: 'page',
      });
      pageResult(result, query);
    }
  });

  it('atomically submits a stale-ref-prone reactive field in ten consecutive runs', async () => {
    for (let run = 0; run < 10; run += 1) {
      const query = `Atomic-${run}`;
      await session.run({ cmd: 'go', args: { url: `${FIXTURE}?delay=40&run=${run}` } });
      const snapshot = (await session.run({ cmd: 'snapshot' })) as { lines: string[] };
      const searchbox = snapshot.lines.find((line) => line.includes(': searchbox "Search"'));
      expect(searchbox).toBeTruthy();
      const ref = /^(e\d+):/.exec(searchbox!.trimStart())![1];

      const result = await session.runDetailed({
        cmd: 'fill',
        args: { selector: `ref=${ref}`, value: query, submit: true },
        observe: 'page',
      });

      expect(result.value).toMatchObject({ ok: true, selector: `ref=${ref}`, submitted: true });
      pageResult(result, query);
    }
  });

  it('returns a same-document validation result promptly when submit does not navigate', async () => {
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
    await session.run({ cmd: 'snapshot' });
    const started = Date.now();
    const result = await session.runDetailed({
      cmd: 'fill',
      args: { selector: '#query', value: 'invalid', submit: true },
      observe: 'delta',
    });
    const elapsed = Date.now() - started;

    expect(result.page?.documentChange).toBe('same');
    expect(result.delta).toContain('Enter a valid search term');
    // Includes the fill, fence, and snapshot; generous enough for CI while
    // still catching an accidental wait for the 500 ms hard ceiling.
    expect(elapsed).toBeLessThan(450);
  });

  it('submits a conventional multi-field form from its final field', async () => {
    await session.run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
    const snapshot = (await session.run({ cmd: 'snapshot' })) as { lines: string[] };
    const refFor = (hint: string): string => {
      const line = snapshot.lines.find((candidate) => candidate.includes(hint));
      expect(line).toBeTruthy();
      return /^(e\d+):/.exec(line!.trimStart())![1];
    };
    const usernameRef = refFor('#username');
    const passwordRef = refFor('#password');

    await session.run({
      cmd: 'fill',
      args: { selector: usernameRef, value: 'invalid@example.test' },
    });
    const result = await session.runDetailed({
      cmd: 'fill',
      args: { selector: passwordRef, value: 'wrong-password', submit: true },
      observe: 'delta',
    });

    expect(result.value).toMatchObject({
      ok: true,
      selector: `ref=${passwordRef}`,
      submitted: true,
    });
    expect(result.page?.url).toBe(`${EXAMPLES_BASE_URL}/login.html?failed=1`);
    expect(result.page?.documentChange).toBe('changed');
    expect(result.delta).toContain('alert "Invalid email or password"');
  });

  it('leaves ordinary fill unchanged while the reactive control is replaced', async () => {
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
    const result = await session.run({
      cmd: 'fill',
      args: { selector: '#query', value: 'No submit' },
    });
    const value = await session.run({
      cmd: 'eval',
      args: { js: `document.querySelector('#query').value` },
    });

    expect(result).toEqual({ ok: true, selector: '#query' });
    expect(value).toMatchObject({ result: 'No submit' });
  });

  it('waits through a client-side redirect and observes its final destination', async () => {
    await session.run({ cmd: 'go', args: { url: `${FIXTURE}?delay=20` } });
    const result = await session.runDetailed({
      cmd: 'fill',
      args: { selector: '#query', value: 'redirect', submit: true },
      observe: 'page',
    });

    pageResult(result, 'redirect');
    expect(result.page?.url).not.toContain('intermediate=1');
  });

  it('distinguishes a real same-URL reload from delayed events for the previous go', async () => {
    const fixture = `${FIXTURE}?delay=20&same-url-case=1`;
    await session.run({ cmd: 'go', args: { url: fixture } });
    await session.run({ cmd: 'snapshot' });
    const result = await session.runDetailed({
      cmd: 'fill',
      args: { selector: '#query', value: 'same-url', submit: true },
      observe: 'page',
    });

    expect(result.page?.url).toBe(fixture);
    expect(result.page?.documentChange).toBe('changed');
  });

  it('keeps a dialog-opening submit bounded and skips its blocked snapshot', async () => {
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
    const started = Date.now();
    const result = await session.runDetailed({
      cmd: 'fill',
      args: { selector: '#query', value: 'dialog', submit: true },
      observe: 'page',
    });

    expect(Date.now() - started).toBeLessThan(450);
    expect(result.delta).toContain('dialog open: Search confirmation required');
    await session.run({ cmd: 'dialog', args: { action: 'dismiss' } });
  });
});
