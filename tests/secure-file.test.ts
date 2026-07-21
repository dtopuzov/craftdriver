/**
 * Unit tests for the credential-file writer used by `saveState` /
 * `saveStorageState`. Pure filesystem logic — no browser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSecureFile } from '../src/lib/secureFile';
import { CraftdriverError, ErrorCode } from '../src';

describe('writeSecureFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-secure-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories and writes the content', async () => {
    const dest = path.join(dir, 'a', 'b', 'state.json');
    await writeSecureFile(dest, '{"ok":true}');
    expect(await fs.readFile(dest, 'utf-8')).toBe('{"ok":true}');
  });

  it.runIf(process.platform !== 'win32')('writes owner-only (0600) permissions', async () => {
    const dest = path.join(dir, 'state.json');
    await writeSecureFile(dest, 'secret');
    const mode = (await fs.stat(dest)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing file and leaves no temp files behind', async () => {
    const dest = path.join(dir, 'state.json');
    await writeSecureFile(dest, 'first');
    await writeSecureFile(dest, 'second');
    expect(await fs.readFile(dest, 'utf-8')).toBe('second');
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses to write through a destination symlink, leaving the target intact',
    async () => {
      const outside = path.join(dir, 'outside.json');
      const link = path.join(dir, 'link.json');
      await fs.writeFile(outside, 'original');
      await fs.symlink(outside, link);

      let err: unknown;
      try {
        await writeSecureFile(link, 'attacker');
      } catch (e) {
        err = e;
      }
      expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT)).toBe(true);
      expect(await fs.readFile(outside, 'utf-8')).toBe('original');
    }
  );

  it('propagates a rename failure and leaves no temp file behind', async () => {
    // The destination is an existing directory, so the atomic rename fails.
    const dest = path.join(dir, 'occupied');
    await fs.mkdir(dest);
    await expect(writeSecureFile(dest, 'data')).rejects.toThrow();
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
