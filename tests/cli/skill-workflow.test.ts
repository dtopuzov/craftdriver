/**
 * The exploration-to-test workflow the shipped skill teaches, walked end to
 * end against a deterministic fixture.
 *
 * This is the packet's acceptance criterion, so it deliberately follows
 * `skills/craftdriver/workflow.md` step by step rather than testing commands
 * in isolation. If the workflow stops working, this fails — which is the point:
 * the skill is shipped guidance, and guidance that no longer matches the tool
 * is worse than none.
 *
 * The fixture (`examples/agent-debug.html`) fails the same way every run: it
 * POSTs to an endpoint the static example server does not serve, so the same
 * 4xx comes back every time. Crucially the page renders only "Something went
 * wrong", so a snapshot cannot explain it and the journal can.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentSession } from '../../src/cli/agentSession';
import type { JournalEntry } from '../../src/cli/journal';
import type { LocatorReport } from '../../src/cli/locatorCandidates';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const FIXTURE = `${EXAMPLES_BASE_URL}/agent-debug.html`;

interface SnapshotResult { lines: string[]; url: string; title: string }
interface TextResult { text: string }
interface LogsPage { entries: JournalEntry[]; cursor: number }

describe('exploration-to-test workflow', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'mock', args: { action: 'clear' } });
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
    await session.run({ cmd: 'logs', args: { action: 'clear' } });
  });

  // Step 3 of the workflow: inspect before acting.
  it('exposes the flow through a snapshot', async () => {
    const snap = (await session.run({ cmd: 'snapshot', args: {} })) as SnapshotResult;
    const text = snap.lines.join('\n');
    expect(text).toMatch(/Place order/);
    expect(text).toMatch(/Email/);
  }, 120_000);

  // Step 3, continued: a ref is exploration state; a test needs a durable
  // selector, and craftdriver must validate it against the live page.
  it('turns an element into a durable selector that is not a ref', async () => {
    const report = (await session.run({
      cmd: 'locators',
      args: { selector: '#place-order' },
    })) as LocatorReport;

    expect(report.best).toBeTruthy();
    const best = report.best as string;
    // The whole point of step 3: what goes in the test must not be a ref.
    expect(best).not.toMatch(/ref=/);
    expect(report.candidates.some((c) => c.status === 'unique')).toBe(true);

    // ...and the durable selector actually resolves to the same element.
    const found = (await session.run({ cmd: 'exists', args: { selector: best } })) as {
      exists: boolean;
    };
    expect(found.exists).toBe(true);
  }, 120_000);

  // Step 4: the DOM is not the whole story. This is the failure the fixture
  // exists to produce — opaque on the page, explicit in the journal.
  it('fails with a message the DOM cannot explain', async () => {
    await session.run({ cmd: 'fill', args: { selector: 'label=Email', value: 'a@b.test' } });
    await session.run({ cmd: 'click', args: { selector: 'role=button[name=Place order]' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', kind: 'error', timeout: 10_000 },
    });

    const status = (await session.run({ cmd: 'text', args: { selector: '#status' } })) as TextResult;
    // Everything the page will tell you — no endpoint, no status code.
    expect(status.text).toContain('Something went wrong');
    expect(status.text).not.toMatch(/\b4\d\d\b/);
    expect(status.text).not.toContain('/api/');
  }, 120_000);

  // Step 6: read the evidence before theorising.
  it('explains that failure from the console and network journal', async () => {
    await session.run({ cmd: 'click', args: { selector: 'role=button[name=Place order]' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', kind: 'error', timeout: 10_000 },
    });
    // Console and completed-response events arrive on independent BiDi
    // streams. Seeing the page's console.error does not guarantee that the
    // later network.responseCompleted event is already in the journal. The
    // journal scans retained entries before subscribing, so this remains
    // race-free whichever event arrived first.
    await session.run({
      cmd: 'logs',
      args: {
        action: 'wait',
        kind: 'response',
        contains: '/api/checkout',
        timeout: 10_000,
      },
    });

    const errors = (await session.run({
      cmd: 'logs',
      args: { action: 'list', kind: 'error' },
    })) as LogsPage;
    const errorText = errors.entries.map((e) => ('text' in e ? e.text : '')).join('\n');
    // The diagnosis the page withheld. Asserting on the class of failure
    // rather than the exact code: the static server answers POST with 405,
    // and pinning that would couple this to http-server's behaviour.
    expect(errorText).toMatch(/checkout failed: HTTP 4\d\d/);
    expect(errorText).toMatch(/\/api\/checkout/);

    const responses = (await session.run({
      cmd: 'logs',
      args: { action: 'list', kind: 'response', contains: '/api/checkout' },
    })) as LogsPage;
    expect(responses.entries.length).toBeGreaterThan(0);
    expect(
      responses.entries.some((e) => 'status' in e && (e.status ?? 0) >= 400),
    ).toBe(true);
  }, 120_000);

  // Step 6, continued: confirm a diagnosis by driving the branch directly
  // rather than waiting for a backend to misbehave.
  it('confirms the diagnosis by mocking the endpoint', async () => {
    await session.run({
      cmd: 'mock',
      args: {
        action: 'add',
        pattern: '**/api/checkout*',
        status: 200,
        body: '{"orderId":"A-1001"}',
        contentType: 'application/json',
      },
    });

    await session.run({ cmd: 'go', args: { url: FIXTURE } });
    await session.run({ cmd: 'click', args: { selector: 'role=button[name=Place order]' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', kind: 'response', contains: '/api/checkout', timeout: 10_000 },
    });

    // Same page, same click: only the endpoint's answer changed, which is what
    // proves the endpoint was the cause.
    const status = (await session.run({ cmd: 'text', args: { selector: '#status' } })) as TextResult;
    expect(status.text).toContain('A-1001');
    expect(status.text).not.toContain('Something went wrong');
  }, 120_000);

  // The acceptance criterion: the workflow's final artifact is an ordinary
  // test using durable selectors, and it passes.
  it('produces a test that uses durable selectors and passes', async () => {
    // Exactly what step 5 tells an agent to write, run against the mocked
    // success path — the shape of the committed test, not a CLI transcript.
    await session.run({
      cmd: 'mock',
      args: {
        action: 'add',
        pattern: '**/api/checkout*',
        status: 200,
        body: '{"orderId":"A-1001"}',
        contentType: 'application/json',
      },
    });
    await session.run({ cmd: 'go', args: { url: FIXTURE } });

    await session.run({ cmd: 'fill', args: { selector: 'label=Email', value: 'alice@example.test' } });
    await session.run({ cmd: 'fill', args: { selector: 'label=Card number', value: '4242' } });
    await session.run({ cmd: 'click', args: { selector: 'role=button[name=Place order]' } });
    await session.run({
      cmd: 'logs',
      args: { action: 'wait', kind: 'response', contains: '/api/checkout', timeout: 10_000 },
    });

    const status = (await session.run({ cmd: 'text', args: { selector: '#status' } })) as TextResult;
    expect(status.text).toContain('A-1001');

    // No step of that flow used a ref.
    const errors = (await session.run({
      cmd: 'logs',
      args: { action: 'list', kind: 'error' },
    })) as LogsPage;
    expect(errors.entries).toHaveLength(0);
  }, 120_000);
});

describe('shipped workflow guidance matches the tool', () => {
  const workflow = readFileSync(
    resolve(__dirname, '..', '..', 'skills', 'craftdriver', 'workflow.md'),
    'utf8',
  );

  // Guidance that names a command the CLI does not have is worse than none:
  // an agent following it produces a usage error and no evidence.
  it.each([
    ['console and network evidence', /craftdriver logs --kind/],
    ['traces for what a snapshot cannot explain', /craftdriver trace start/],
    ['mocking to confirm a diagnosis', /craftdriver mock add/],
    ['cleaning mocks up', /mock clear/],
    ['durable selectors over refs', /locators/],
  ])('teaches %s', (_label, pattern) => {
    expect(workflow).toMatch(pattern);
  });

  it('forbids runtime healing in as many words', () => {
    expect(workflow).toMatch(/Never heal a test at runtime/i);
    expect(workflow).toMatch(/explicit source diff/i);
  });
});
