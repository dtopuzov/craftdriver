/**
 * Accessibility audits from the CLI and MCP surface.
 *
 * The audit itself is the library's, and `tests/a11y.test.ts` already pins it
 * down. What is new here — and what these tests exist for — is that a
 * violation comes back *actionable*.
 *
 * axe reports a CSS path (`div > p:nth-child(3)`), which is a position, not a
 * handle: an agent holding one has to guess whether it is durable, re-find the
 * element, and hope it picked the right node. So every reported node carries a
 * snapshot ref instead, and the contract those refs keep is the same one the
 * snapshot's own refs keep:
 *
 *   - an element a snapshot already reffed keeps that number, never a second;
 *   - an element a snapshot leaves out still gets one, minted on demand —
 *     which is most violations, since snapshots list only visible interactive
 *     elements and violations land on images, prose, and headings;
 *   - the number is never reissued to a different element after a navigation.
 *
 * Requires the example server on port 8080; the binary case also needs
 * `npm run build`, since the bin shim loads `dist/`.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AgentSession } from '../../src/cli/agentSession';
import type { Browser } from '../../src/lib/browser';
import { ErrorCode } from '../../src/lib/errors';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

interface A11yNode {
  ref?: string;
  target: string;
  html: string;
  failureSummary: string;
}

interface A11yRow {
  id: string;
  impact: string;
  wcag: string[];
  help: string;
  description: string;
  helpUrl: string;
  nodes: A11yNode[];
}

interface A11yReport {
  scope?: string;
  minImpact: string;
  violations: A11yRow[];
  counts: { violations: number; passes: number; incomplete: number };
  truncated: boolean;
  checked?: boolean;
  passed?: boolean;
}

interface SnapshotResult {
  lines: string[];
}

const FIXTURE = `${EXAMPLES_BASE_URL}/a11y.html`;

/** Every node of every reported violation, flattened. */
function allNodes(report: A11yReport): A11yNode[] {
  return report.violations.flatMap((v) => v.nodes);
}

/** The node whose target names `hint`, e.g. `#no-alt`. */
function nodeFor(report: A11yReport, hint: string): A11yNode {
  const found = allNodes(report).find((n) => n.target.includes(hint));
  if (!found) {
    throw new Error(
      `no violation node targeting ${hint} in: ${allNodes(report)
        .map((n) => n.target)
        .join(', ')}`
    );
  }
  return found;
}

function refNumbers(refs: Array<string | undefined>): number[] {
  return refs.filter((r): r is string => typeof r === 'string').map((r) => Number(r.slice(1)));
}

/** Refs present in a rendered snapshot. */
function snapshotRefs(snap: SnapshotResult): string[] {
  return snap.lines
    .map((line) => /^\s*(e\d+):/.exec(line)?.[1])
    .filter((ref): ref is string => Boolean(ref));
}

describe('a11y audits carry actionable refs', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = new AgentSession({ launchOptions: { browserName: BROWSER_NAME } });
  });

  afterAll(async () => {
    await session.close();
  });

  beforeEach(async () => {
    await session.run({ cmd: 'go', args: { url: FIXTURE } });
  });

  const audit = (args: Record<string, unknown> = {}): Promise<A11yReport> =>
    session.run({ cmd: 'a11y', args }) as Promise<A11yReport>;

  it('reports the seeded rules with impact, WCAG tags, and a help URL', async () => {
    const report = await audit();
    const ids = report.violations.map((v) => v.id);
    expect(ids).toContain('image-alt');
    expect(ids).toContain('button-name');
    expect(ids).toContain('color-contrast');
    expect(ids).toContain('heading-order');
    expect(report.minImpact).toBe('minor');

    const imageAlt = report.violations.find((v) => v.id === 'image-alt')!;
    expect(imageAlt.impact).toBe('critical');
    // The success criterion is the part axe drops on the floor without this;
    // `wcag2a` is the conformance level, `wcag111` is criterion 1.1.1.
    expect(imageAlt.wcag).toContain('wcag2a');
    expect(imageAlt.wcag).toContain('wcag111');
    expect(imageAlt.help).toMatch(/alternat/i);
    expect(imageAlt.helpUrl).toMatch(/^https?:\/\//);
    expect(report.counts.passes).toBeGreaterThan(0);
    expect(report.truncated).toBe(false);
  });

  it('reports nothing for the clean region and echoes the scope', async () => {
    const report = await audit({ selector: '#good' });
    expect(report.violations).toEqual([]);
    expect(report.counts.violations).toBe(0);
    expect(report.scope).toBe('#good');
  });

  it('gives every reported node a ref that drives another command', async () => {
    const report = await audit();
    const nodes = allNodes(report);
    expect(nodes.length).toBeGreaterThan(2);
    for (const node of nodes) expect(node.ref).toMatch(/^e\d+$/);

    // The ref is accepted bare, which only works if the session recorded it as
    // issued — an audit-minted ref must not trip the BARE_REF guard.
    const target = nodeFor(report, '#no-alt');
    await expect(
      session.run({ cmd: 'attr', args: { selector: target.ref, name: 'id' } })
    ).resolves.toMatchObject({ value: 'no-alt' });
  });

  it('turns a violation ref into a durable selector', async () => {
    const report = await audit();
    const target = nodeFor(report, '#no-alt');
    const locators = (await session.run({
      cmd: 'locators',
      args: { selector: `ref=${target.ref}` },
    })) as { best: string | null; candidates: Array<{ selector: string; status: string }> };

    expect(locators.best).toBe('#no-alt');
    expect(locators.candidates.some((c) => c.status === 'unique')).toBe(true);
    // The point of the loop: what goes in a committed test never contains a ref.
    for (const candidate of locators.candidates) expect(candidate.selector).not.toMatch(/^ref=/);
  });

  it('reuses the ref a preceding snapshot already issued', async () => {
    const snap = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const fromSnapshot = snap.lines.find((line) => line.includes('#no-alt'));
    const snapshotRef = /^\s*(e\d+):/.exec(fromSnapshot!)![1];

    const report = await audit();
    expect(nodeFor(report, '#no-alt').ref).toBe(snapshotRef);
  });

  it('mints a ref for a violating element the snapshot leaves out', async () => {
    // Long prose is deliberately absent from the snapshot — it belongs to the
    // `text` command. This is the case that makes on-demand minting necessary:
    // there is no snapshot ref to join against, and most real violations look
    // like this rather than like a button.
    const snap = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    expect(snap.lines.some((line) => line.includes('#long-copy'))).toBe(false);
    const before = snapshotRefs(snap);

    const report = await audit();
    const minted = nodeFor(report, '#long-copy');
    expect(minted.ref).toMatch(/^e\d+$/);
    expect(before).not.toContain(minted.ref);

    await expect(
      session.run({ cmd: 'attr', args: { selector: `ref=${minted.ref}`, name: 'id' } })
    ).resolves.toMatchObject({ value: 'long-copy' });
  });

  it('resolves a violation behind an open shadow boundary', async () => {
    const report = await audit();
    const shadow = nodeFor(report, '#shadow-no-alt');
    // axe reports a nested selector path for open shadow roots; the label keeps
    // the boundary visible rather than flattening it into a plain CSS selector.
    expect(shadow.target).toContain('>>>');
    expect(shadow.ref).toMatch(/^e\d+$/);

    await expect(
      session.run({ cmd: 'attr', args: { selector: `ref=${shadow.ref}`, name: 'id' } })
    ).resolves.toMatchObject({ value: 'shadow-no-alt' });
  });

  it('reports the page markup, not craftdriver’s own diagnostic marker', async () => {
    await session.run({ cmd: 'snapshot' });
    const report = await audit();
    for (const node of allNodes(report)) {
      expect(node.html).not.toContain('data-craftdriver-ref');
      expect(node.html.length).toBeLessThanOrEqual(160);
      expect(node.failureSummary.length).toBeLessThanOrEqual(240);
      // axe writes the summary as a colon-terminated heading plus one line per
      // remedy. The lines become separators, but not straight after the colon.
      expect(node.failureSummary).not.toContain(':;');
      expect(node.failureSummary).toMatch(/following: \S/);
    }
  });

  it('truncates to --limit and --nodes and says so', async () => {
    const full = await audit();
    expect(full.violations.length).toBeGreaterThan(1);

    const bounded = await audit({ limit: 1, nodes: 1 });
    expect(bounded.violations).toHaveLength(1);
    expect(bounded.violations[0].nodes).toHaveLength(1);
    expect(bounded.truncated).toBe(true);
    // The counts describe the audit, not the slice that was printed.
    expect(bounded.counts.violations).toBe(full.counts.violations);
  });

  it('checks the whole audit, so a limit cannot turn a failure green', async () => {
    const checked = await audit({ check: true, limit: 1, nodes: 1 });
    expect(checked.checked).toBe(true);
    expect(checked.passed).toBe(false);

    const clean = await audit({ selector: '#good', check: true });
    expect(clean.checked).toBe(true);
    expect(clean.passed).toBe(true);
  });

  it('omits the check verdict in report mode', async () => {
    const report = await audit();
    expect(report.checked).toBeUndefined();
    expect(report.passed).toBeUndefined();
  });

  it('uses one minimum impact for both reports and checks', async () => {
    const moderate = await audit({ selector: '#bad', rules: 'heading-order', check: true });
    expect(moderate.minImpact).toBe('minor');
    expect(moderate.violations.map((v) => v.id)).toEqual(['heading-order']);
    expect(moderate.passed).toBe(false);

    const serious = await audit({
      selector: '#bad',
      rules: 'heading-order',
      minImpact: 'serious',
      check: true,
    });
    expect(serious.minImpact).toBe('serious');
    expect(serious.violations).toEqual([]);
    expect(serious.passed).toBe(true);
  });

  it('honours --rules and --disable-rules', async () => {
    const only = await audit({ rules: 'button-name' });
    expect(only.violations.map((v) => v.id)).toEqual(['button-name']);

    const without = await audit({ disableRules: 'image-alt,color-contrast' });
    const ids = without.violations.map((v) => v.id);
    expect(ids).not.toContain('image-alt');
    expect(ids).not.toContain('color-contrast');
    expect(ids).toContain('button-name');
  });

  it('never reissues an audit-minted number to a new document', async () => {
    const report = await audit();
    const minted = Math.max(...refNumbers(allNodes(report).map((n) => n.ref)));

    await session.run({ cmd: 'reload' });
    const snap = (await session.run({ cmd: 'snapshot' })) as SnapshotResult;
    const after = refNumbers(snapshotRefs(snap));

    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after)).toBeGreaterThan(minted);
  });
});

/**
 * Its own suite so only one browser is alive at a time — this gate is
 * single-worker precisely because concurrent chromedriver starts exceed the
 * driver's session-creation timeout.
 */
describe('a11y establishes its own ref baseline', () => {
  it('hands back usable refs with no preceding snapshot in the session', async () => {
    // Nothing has snapshotted, so there is no ref-issuing document on record.
    // The audit has to establish one, or every ref it returns would fail
    // STALE_REF the first time the agent used it.
    const session = new AgentSession({
      launchOptions: { browserName: BROWSER_NAME },
      autoSnapshot: false,
    });
    try {
      await session.run({ cmd: 'go', args: { url: FIXTURE } });
      const report = (await session.run({ cmd: 'a11y' })) as A11yReport;
      const target = nodeFor(report, '#no-alt');
      expect(target.ref).toMatch(/^e\d+$/);
      await expect(
        session.run({ cmd: 'attr', args: { selector: `ref=${target.ref}`, name: 'id' } })
      ).resolves.toMatchObject({ value: 'no-alt' });
    } finally {
      await session.close();
    }
  });
});

describe('a11y arguments are rejected before a browser starts', () => {
  const rejects = async (args: Record<string, unknown>, code: string): Promise<void> => {
    let launched = 0;
    const session = new AgentSession({
      launchOptions: {},
      launch: async (): Promise<Browser> => {
        launched += 1;
        throw new Error('browser must not launch');
      },
    });
    try {
      await expect(session.run({ cmd: 'a11y', args })).rejects.toMatchObject({ code });
      expect(launched).toBe(0);
    } finally {
      await session.close();
    }
  };

  it('refuses --rules together with --disable-rules', async () => {
    await rejects({ rules: 'image-alt', disableRules: 'button-name' }, ErrorCode.INVALID_ARGUMENT);
  });

  it('refuses an impact outside axe’s four buckets', async () => {
    await rejects({ minImpact: 'blocker' }, ErrorCode.INVALID_ARGUMENT);
  });

  it('refuses an unusable rule filter', async () => {
    await rejects({ rules: 'x'.repeat(65) }, ErrorCode.INVALID_ARGUMENT);
    await rejects(
      { disableRules: Array.from({ length: 51 }, (_, i) => `rule-${i}`).join(',') },
      ErrorCode.INVALID_ARGUMENT
    );
  });
});

describe('a11y exit codes through the shipped binary', () => {
  const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'craftdriver.mjs');

  /** Run an ephemeral script through the real bin and return its exit code. */
  async function run(script: string): Promise<{ exitCode: number; stdout: string }> {
    return new Promise((done, fail) => {
      const child = spawn('node', [CLI_BIN, '--ephemeral', '--browser', BROWSER_NAME], {
        env: { ...process.env, HEADLESS: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
      child.stderr.on('data', () => {});
      child.on('error', fail);
      child.on('close', (code) => done({ exitCode: code ?? 0, stdout }));
      child.stdin.end(script);
    });
  }

  it('exits 0 for a report and 1 only in check mode', async () => {
    const report = await run(`go ${FIXTURE}\na11y\n`);
    // A report is not an assertion. Exiting non-zero by default would break
    // `a11y | jq` and tell an agent the command itself is broken.
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain('image-alt');

    const check = await run(`go ${FIXTURE}\na11y --check --pretty\n`);
    expect(check.exitCode).toBe(1);
    expect(check.stdout).toContain('FAIL:');
    expect(check.stdout).toContain('Fix any of the following:');
    // The clean-region case is covered in-process above (`passed: true`);
    // a third browser launch here would only re-prove the same mapping.
  }, 180_000);
});
