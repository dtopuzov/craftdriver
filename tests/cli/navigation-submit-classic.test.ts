/** The observed-submit fence must degrade to document-aware Classic polling. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSession } from '../../src/cli/agentSession';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('Classic observed submit fallback', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({
      launchOptions: { browserName: BROWSER_NAME, enableBiDi: false },
      autoSnapshot: false,
    });
  });

  afterAll(async () => {
    await session.close();
  });

  it('observes a delayed destination instead of the old complete document', async () => {
    const fixture = `${EXAMPLES_BASE_URL}/reactive-search.html?delay=40`;
    await session.run({ cmd: 'go', args: { url: fixture } });
    const result = await session.runDetailed({
      cmd: 'fill',
      args: { selector: '#query', value: 'Classic', submit: true },
      observe: 'page',
    });

    expect(result.page?.url).toContain('destination=1&q=Classic');
    expect(result.delta).toContain('heading "Classic"');
  });
});
