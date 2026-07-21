import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import { ArtifactStore } from '../../src/cli/mcp/artifacts.js';
import { getTool } from '../../src/cli/mcp/tools.js';
import {
  serializeToolFailure,
  serializeToolSuccess,
} from '../../src/cli/mcp/server.js';

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

    await expect(serializeToolSuccess(
      tool,
      value,
      await resultContext(),
    )).resolves.toEqual({
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

    const result = await serializeToolSuccess(
      tool,
      value,
      { ...await resultContext(), delta: '+ e2: status "Saved"' },
    );

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
      await resultContext(20),
    );

    expect(result.content[0].text).toMatch(/full output:/);
    expect(result.structuredContent).toEqual({ result: { text: 'a'.repeat(200) } });
  });

  it('serializes structured CraftdriverError details without stacktrace noise', () => {
    const result = serializeToolFailure(new CraftdriverError(
      ErrorCode.DRIVER_ERROR,
      'invalid selector',
      {
        hint: 'fix the selector',
        detail: { webDriverError: 'invalid selector', stacktrace: 'noise' },
      },
    ));

    expect(result).toEqual({
      isError: true,
      content: [{
        type: 'text',
        text: 'error: invalid selector\ncode:  DRIVER_ERROR\nhint:  fix the selector',
      }],
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
});
