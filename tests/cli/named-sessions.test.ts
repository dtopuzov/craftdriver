/**
 * Cross-session isolation, against real browsers.
 *
 * `session-registry.test.ts` pins the routing with fakes. This pins the part
 * fakes cannot: that two named sessions really are two browsers with two ref
 * registries and two baselines, and that neither can disturb the other's.
 *
 * Worth stating plainly, because a first draft of this file assumed the
 * opposite: **a ref is a name in one session's namespace, not a global
 * handle.** Two sessions independently issue `e4`, and each resolves its own.
 * craftdriver cannot detect an agent that snapshots one session and then
 * spends the ref against another — that reads as a valid ref there. Refs and
 * `--session` must be kept together by the caller; the guarantee on offer is
 * isolation, not misaddressing detection.
 *
 * Two browsers is the expensive shape of this test and the reason it lives in
 * the single-worker CLI gate.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createSessionRegistry } from '../../src/cli/sessionRegistry.js';
import { AgentSession } from '../../src/cli/agentSession.js';
import { ErrorCode } from '../../src/lib/errors.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface SnapshotResult {
  lines: string[];
  documentId: string;
}

function refFrom(snap: SnapshotResult, needle: string): string {
  const line = snap.lines.find((l) => l.includes(needle));
  if (!line) throw new Error(`no snapshot line matching ${needle} in:\n${snap.lines.join('\n')}`);
  const ref = /^\s*(e\d+):/.exec(line);
  if (!ref) throw new Error(`no ref on line: ${line}`);
  return ref[1];
}

describe('named sessions', () => {
  const registry = createSessionRegistry({
    create: () => new AgentSession({
      launchOptions: { browserName: BROWSER_NAME },
      autoSnapshot: false,
    }),
  });

  beforeAll(async () => {
    await registry.get('alpha').run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
    await registry.get('beta').run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
  });

  afterAll(async () => {
    await registry.closeAll();
  });

  it('gives each session its own navigation state', async () => {
    await registry.get('alpha').run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/selectors.html` } });

    const alpha = (await registry.get('alpha').run({ cmd: 'status' })) as { activeUrl: string };
    const beta = (await registry.get('beta').run({ cmd: 'status' })) as { activeUrl: string };

    expect(alpha.activeUrl).toContain('selectors.html');
    expect(beta.activeUrl).toContain('login.html');
  });

  it('issues refs over its own document, not a shared one', async () => {
    await registry.get('alpha').run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/login.html` } });
    const alphaSnap = (await registry.get('alpha').run({ cmd: 'snapshot' })) as SnapshotResult;
    const betaSnap = (await registry.get('beta').run({ cmd: 'snapshot' })) as SnapshotResult;

    // Same URL, same page, two browsers: document identity is the only thing
    // that distinguishes them, and it must.
    expect(alphaSnap.documentId).not.toBe(betaSnap.documentId);

    // A ref is a name in its own session's namespace. Both sessions issue
    // the same *numbers* — that is not a collision, because neither can see
    // the other's document.
    const alphaRef = refFrom(alphaSnap, 'textbox');
    const betaRef = refFrom(betaSnap, 'textbox');
    await expect(
      registry.get('alpha').run({ cmd: 'is', args: { what: 'visible', selector: `ref=${alphaRef}` } }),
    ).resolves.toMatchObject({ result: true });
    await expect(
      registry.get('beta').run({ cmd: 'is', args: { what: 'visible', selector: `ref=${betaRef}` } }),
    ).resolves.toMatchObject({ result: true });
  });

  it('does not invalidate one session baseline when another navigates', async () => {
    // The sharp edge if the trackers were ever shared: one session's
    // navigation would strand every ref the other session holds. Beta
    // navigates away; alpha must not notice.
    const alphaSnap = (await registry.get('alpha').run({ cmd: 'snapshot' })) as SnapshotResult;
    const alphaRef = refFrom(alphaSnap, 'textbox');
    const betaSnap = (await registry.get('beta').run({ cmd: 'snapshot' })) as SnapshotResult;
    const betaRef = refFrom(betaSnap, 'textbox');

    await registry.get('beta').run({ cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/selectors.html` } });
    await registry.get('beta').run({ cmd: 'snapshot' });

    // Beta's own ref is correctly stale: its document changed.
    await expect(
      registry.get('beta').run({ cmd: 'is', args: { what: 'visible', selector: `ref=${betaRef}` } }),
    ).rejects.toMatchObject({ code: ErrorCode.STALE_REF });

    // Alpha's ref — often the very same number — is untouched.
    await expect(
      registry.get('alpha').run({ cmd: 'is', args: { what: 'visible', selector: `ref=${alphaRef}` } }),
    ).resolves.toMatchObject({ result: true });
  });
});
