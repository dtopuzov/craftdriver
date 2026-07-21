/**
 * Regression: explicit and automatic snapshots share one baseline.
 *
 * Before the fix the MCP adapter owned a private `previous` snapshot that
 * only mutating tools advanced. An explicit `snapshot` showed the agent the
 * current page but left that baseline stale, so the *next* post-action diff
 * re-reported changes the agent had already been shown — and attributed
 * them to an action that did not cause them.
 *
 * The baseline belongs to the session, so every snapshot (explicit or
 * automatic) advances exactly one baseline, and a failed mutation advances
 * nothing.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { AgentSession } from '../../src/cli/agentSession';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('snapshot baseline ownership', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('does not re-report a change an explicit snapshot already showed', async () => {
    await session.run({
      cmd: 'go',
      args: { url: `${EXAMPLES_BASE_URL}/agent-late-mutation.html` },
    });
    // The fixture injects "Late arrival" ~800ms after load, with no action.
    await session.run({
      cmd: 'wait',
      args: { target: '#late', kind: 'selector', state: 'visible' },
    });

    const explicit = (await session.run({ cmd: 'snapshot' })) as { lines: string[] };
    expect(explicit.lines.join('\n')).toContain('Late arrival');

    // A later mutation must diff against what the agent was just shown.
    const hover = await session.runDetailed({
      cmd: 'hover',
      args: { selector: '#go' },
    });
    expect(hover.delta ?? '').not.toContain('Late arrival');
  });

  it('advances the baseline from an automatic post-action snapshot', async () => {
    await session.run({
      cmd: 'go',
      args: { url: `${EXAMPLES_BASE_URL}/agent-ref-shift.html` },
    });

    const click = await session.runDetailed({
      cmd: 'click',
      args: { selector: '#apply' },
    });
    // The click adds the help link, so its own diff reports it once...
    expect(click.delta ?? '').toContain('coupon rejected');

    const hover = await session.runDetailed({
      cmd: 'hover',
      args: { selector: '#apply' },
    });
    // ...and never again.
    expect(hover.delta ?? '').not.toContain('coupon rejected');
  });

  it('does not advance the baseline when a mutation fails', async () => {
    await session.run({
      cmd: 'go',
      args: { url: `${EXAMPLES_BASE_URL}/agent-ref-shift.html` },
    });
    await session.run({ cmd: 'snapshot' });

    await session
      .run({ cmd: 'click', args: { selector: '#does-not-exist', timeout: 500 } })
      .catch(() => undefined);

    // The failed click changed nothing, so the next successful action must
    // still diff against the pre-failure page rather than a corrupted one.
    const click = await session.runDetailed({
      cmd: 'click',
      args: { selector: '#apply' },
    });
    expect(click.delta ?? '').toContain('coupon rejected');
  });

  it('reports a full snapshot rather than a diff when the document changes', async () => {
    await session.run({
      cmd: 'go',
      args: { url: `${EXAMPLES_BASE_URL}/agent-ref-shift.html` },
    });
    await session.run({ cmd: 'snapshot' });

    const nav = await session.runDetailed({
      cmd: 'go',
      args: { url: `${EXAMPLES_BASE_URL}/agent-late-mutation.html` },
    });
    expect(nav.delta ?? '').toContain('Dashboard');
    expect(nav.delta ?? '').not.toMatch(/^[-+] /m);
  });
});
