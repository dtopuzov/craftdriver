import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import { ArtifactStore } from '../../src/cli/mcp/artifacts.js';
import { getTool } from '../../src/cli/mcp/tools.js';
import { serializeToolFailure, serializeToolSuccess } from '../../src/cli/mcp/server.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resultContext(spillBytes = 2048) {
  const root = await mkdtemp(join(tmpdir(), 'craftdriver-result-seam-'));
  roots.push(root);
  return { artifacts: new ArtifactStore(root), spillBytes };
}

describe('MCP tool result serialization', () => {
  it('serializes a transport-neutral success without a transport or session', async () => {
    const tool = getTool('browser_status')!;
    const value = { browser: null, pid: 42, ready: false };

    await expect(serializeToolSuccess(tool, value, await resultContext())).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: { result: value },
    });
  });

  it('serializes snapshot text and a precomputed post-action delta', async () => {
    const tool = getTool('browser_snapshot')!;
    const value = {
      url: 'https://example.test',
      title: 'Example',
      lines: ['e1: button "Save"'],
    };

    const result = await serializeToolSuccess(tool, value, {
      ...(await resultContext()),
      delta: '+ e2: status "Saved"',
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'page: Example — https://example.test\ne1: button "Save"' },
      { type: 'text', text: '+ e2: status "Saved"' },
    ]);
    expect(result.structuredContent).toEqual({ result: value });
  });

  it('preserves current artifact spilling behavior at the serializer seam', async () => {
    const tool = getTool('browser_read')!;
    const result = await serializeToolSuccess(
      tool,
      { text: 'a'.repeat(200) },
      await resultContext(20)
    );

    expect(result.content[0].text).toMatch(/full output:/);
    expect(result.structuredContent).toEqual({ result: { text: 'a'.repeat(200) } });
  });

  it('spills an a11y report to an artifact instead of the context window', async () => {
    // A full-page audit routinely clears the 2 KB spill threshold — three
    // violations of three nodes each, with html and failure summaries, is
    // already past it. Inlining that on every call is what the artifact store
    // exists to prevent, and the preview has to keep the path to the rest.
    const tool = getTool('browser_a11y')!;
    const value = {
      violations: Array.from({ length: 3 }, (_, v) => ({
        id: `rule-${v}`,
        impact: 'serious',
        wcag: ['wcag2aa', 'wcag143'],
        help: 'Elements must meet minimum color contrast ratio thresholds',
        description: 'Ensure the contrast between foreground and background colors meets WCAG 2 AA',
        helpUrl: `https://dequeuniversity.com/rules/axe/4.12/rule-${v}`,
        nodes: Array.from({ length: 3 }, (_, n) => ({
          ref: `e${v * 3 + n}`,
          target: `#node-${v}-${n}`,
          html: `<p class="bad-contrast" id="node-${v}-${n}">${'x'.repeat(80)}</p>`,
          failureSummary: `Fix any of the following: ${'y'.repeat(180)}`,
        })),
      })),
      counts: { violations: 3, passes: 41, incomplete: 2 },
      truncated: false,
    };

    const result = await serializeToolSuccess(tool, value, await resultContext());

    expect(JSON.stringify(value).length).toBeGreaterThan(2048);
    expect(result.content[0].text).toMatch(/full output:/);
    // The preview still names the first rule, so a glance is enough to decide
    // whether the file is worth opening.
    expect(result.content[0].text).toContain('rule-0');
  });

  it('leaves a small a11y report inline', async () => {
    const tool = getTool('browser_a11y')!;
    const value = { violations: [], counts: { violations: 0, passes: 15, incomplete: 0 }, truncated: false };

    const result = await serializeToolSuccess(tool, value, await resultContext());

    expect(result.content[0].text).toBe(JSON.stringify(value));
    expect(result.content[0].text).not.toMatch(/full output:/);
  });

  it('serializes structured CraftdriverError details without stacktrace noise', () => {
    const result = serializeToolFailure(
      new CraftdriverError(ErrorCode.DRIVER_ERROR, 'invalid selector', {
        hint: 'fix the selector',
        detail: { webDriverError: 'invalid selector', stacktrace: 'noise' },
      })
    );

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'error: invalid selector\ncode:  DRIVER_ERROR\nhint:  fix the selector',
        },
      ],
      structuredContent: {
        error: {
          code: ErrorCode.DRIVER_ERROR,
          message: 'invalid selector',
          hint: 'fix the selector',
          detail: { webDriverError: 'invalid selector' },
        },
      },
    });
  });

  it('maps unknown failures to the existing driver error result', () => {
    expect(serializeToolFailure(new Error('boom'))).toMatchObject({
      isError: true,
      structuredContent: { error: { code: ErrorCode.DRIVER_ERROR, message: 'boom' } },
    });
  });

  it('includes bounded stale-ref recovery context in text and structured output', () => {
    const result = serializeToolFailure(
      new CraftdriverError(ErrorCode.STALE_REF, 'ref=e7 is stale', {
        recoverySnapshot: 'page: Updated\ne8: button "Continue"',
      })
    );

    expect(result.content[0].text).toContain('recovery snapshot:\npage: Updated');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: ErrorCode.STALE_REF,
        recoverySnapshot: 'page: Updated\ne8: button "Continue"',
      },
    });
  });
});
