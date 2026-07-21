/**
 * Path, permission and redaction rules for saved authentication state.
 *
 * Browser-free by design: these are the rules that decide whether a credential
 * file can be written outside its root or read back into a page, so they
 * should fail in milliseconds and localize precisely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import {
  stateRoot,
  validateStateName,
  resolveStatePath,
  prepareTempStatePath,
  commitStateFile,
  discardTempStateFile,
  readStateFile,
  summarizeState,
  stateOrigins,
  listStateNames,
} from '../../src/cli/stateStore.js';

let root: string;
let outside: string;
const previousEnv = process.env.CRAFTDRIVER_STATE_DIR;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-state-'));
  root = path.join(base, 'state');
  outside = path.join(base, 'outside');
  await fs.mkdir(outside, { recursive: true });
  process.env.CRAFTDRIVER_STATE_DIR = root;
});

afterEach(async () => {
  if (previousEnv === undefined) delete process.env.CRAFTDRIVER_STATE_DIR;
  else process.env.CRAFTDRIVER_STATE_DIR = previousEnv;
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('state name validation', () => {
  it('accepts plain names', () => {
    expect(validateStateName('alice')).toBe('alice');
    expect(validateStateName('checkout-2')).toBe('checkout-2');
    expect(validateStateName('a_b')).toBe('a_b');
  });

  // Each of these would be a traversal, a hidden file, or a flag if the name
  // reached the filesystem or an argv array unchecked.
  it.each([
    ['traversal', '../escape'],
    ['absolute path', '/etc/passwd'],
    ['windows separator', 'a\\b'],
    ['extension', 'alice.json'],
    ['bare dot', '.'],
    ['hidden file', '.ssh'],
  ])('rejects %s', (_label, name) => {
    expect(() => validateStateName(name)).toThrow(CraftdriverError);
    try {
      validateStateName(name);
    } catch (err) {
      expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
    }
  });

  it('rejects a leading dash so a name cannot be read as a flag', () => {
    expect(() => validateStateName('-rf')).toThrow(/invalid name/);
  });

  it('rejects empty, over-long and non-string names', () => {
    expect(() => validateStateName('')).toThrow(CraftdriverError);
    expect(() => validateStateName('a'.repeat(65))).toThrow(/invalid name/);
    expect(() => validateStateName(42 as unknown as string)).toThrow(CraftdriverError);
    expect(() => validateStateName(undefined)).toThrow(CraftdriverError);
  });
});

describe('state path resolution', () => {
  it('resolves inside the root and creates it owner-only', async () => {
    const target = await resolveStatePath('alice');
    expect(target).toBe(path.join(root, 'alice.json'));

    const mode = (await fs.stat(root)).mode & 0o777;
    // Windows does not model POSIX permission bits.
    if (process.platform !== 'win32') expect(mode).toBe(0o700);
  });

  it('honours CRAFTDRIVER_STATE_DIR over the working directory', () => {
    expect(stateRoot({ CRAFTDRIVER_STATE_DIR: '/tmp/somewhere' })).toBe(path.resolve('/tmp/somewhere'));
    expect(stateRoot({})).toBe(path.resolve(process.cwd(), '.craftdriver', 'state'));
  });

  it('refuses a name whose file symlinks outside the root', async () => {
    if (process.platform === 'win32') return;
    await fs.mkdir(root, { recursive: true });
    const victim = path.join(outside, 'victim.json');
    await fs.writeFile(victim, '{}', 'utf-8');
    // A symlink planted inside the root must not widen it.
    await fs.symlink(victim, path.join(root, 'evil.json'));

    await expect(resolveStatePath('evil')).rejects.toThrow(/outside the state root/);
  });

  it('allows a symlinked root itself, since the user chose it', async () => {
    if (process.platform === 'win32') return;
    const real = path.join(outside, 'real-state');
    await fs.mkdir(real, { recursive: true });
    await fs.symlink(real, root);

    const target = await resolveStatePath('alice');
    expect(target).toBe(path.join(root, 'alice.json'));
  });
});

describe('atomic, owner-only writes', () => {
  it('creates the temp file 0600 before anything is written to it', async () => {
    const target = await resolveStatePath('alice');
    const tmp = await prepareTempStatePath(target);

    expect(existsSync(tmp)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await fs.stat(tmp)).mode & 0o777).toBe(0o600);
    }
    await discardTempStateFile(tmp);
    expect(existsSync(tmp)).toBe(false);
  });

  it('refuses to write through a pre-existing temp path', async () => {
    if (process.platform === 'win32') return;
    const target = await resolveStatePath('alice');
    // Plain `open(..., 'w')` would follow this symlink and ignore the mode,
    // redirecting a credential write and leaving it world-readable. O_EXCL
    // is what makes the 0600 guarantee real rather than best-effort.
    const tmp = await prepareTempStatePath(target);
    await fs.rm(tmp, { force: true });
    await fs.symlink(path.join(outside, 'planted'), tmp);

    await expect(fs.open(tmp, 'wx', 0o600)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(existsSync(path.join(outside, 'planted'))).toBe(false);
  });

  it('gives concurrent saves distinct temp paths', async () => {
    const target = await resolveStatePath('alice');
    const [a, b] = await Promise.all([
      prepareTempStatePath(target),
      prepareTempStatePath(target),
    ]);
    expect(a).not.toBe(b);
    await Promise.all([discardTempStateFile(a), discardTempStateFile(b)]);
  });

  it('publishes by rename, so a reader never sees a partial file', async () => {
    const target = await resolveStatePath('alice');
    await fs.writeFile(target, JSON.stringify({ cookies: [{ name: 'old' }] }), 'utf-8');

    const tmp = await prepareTempStatePath(target);
    await fs.writeFile(tmp, JSON.stringify({ cookies: [{ name: 'new' }] }), 'utf-8');
    // Old content is still fully intact until the rename lands.
    expect(JSON.parse(await fs.readFile(target, 'utf-8')).cookies[0].name).toBe('old');

    await commitStateFile(tmp, target);
    expect(JSON.parse(await fs.readFile(target, 'utf-8')).cookies[0].name).toBe('new');
    expect(existsSync(tmp)).toBe(false);
    if (process.platform !== 'win32') {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it('removes the temp file when the commit fails', async () => {
    const target = await resolveStatePath('alice');
    const tmp = await prepareTempStatePath(target);
    // Renaming onto a directory fails on every supported platform.
    await fs.mkdir(target, { recursive: true });

    await expect(commitStateFile(tmp, target)).rejects.toThrow();
    expect(existsSync(tmp)).toBe(false);
  });
});

describe('reading state files', () => {
  it('reports a missing file by name, not by path', async () => {
    const target = await resolveStatePath('nope');
    await expect(readStateFile(target, 'nope')).rejects.toThrow(/no saved state named "nope"/);
  });

  it.each([
    ['invalid JSON', 'not json at all', /not valid JSON/],
    ['a JSON array', '[]', /plain JSON object/],
    ['a JSON scalar', '"hello"', /plain JSON object/],
    ['null', 'null', /plain JSON object/],
    ['non-array cookies', '{"cookies":{"a":1}}', /cookies must be an array/],
  ])('rejects %s', async (_label, contents, pattern) => {
    const target = await resolveStatePath('bad');
    await fs.writeFile(target, contents, 'utf-8');
    await expect(readStateFile(target, 'bad')).rejects.toThrow(pattern);
  });

  it('accepts a well-formed state file', async () => {
    const target = await resolveStatePath('good');
    await fs.writeFile(
      target,
      JSON.stringify({ cookies: [{ name: 'session', value: 'secret', domain: 'example.test' }] }),
      'utf-8',
    );
    const state = await readStateFile(target, 'good');
    expect(state.cookies).toHaveLength(1);
  });
});

describe('summaries never carry secrets', () => {
  const state = {
    cookies: [
      { name: 'session', value: 'super-secret-token' },
      { name: 'csrf', value: 'another-secret' },
    ],
    localStorage: { 'https://app.test': { authToken: 'bearer-abc', theme: 'dark' } },
    sessionStorage: { 'https://app.test': { scratch: 'tmp-value' } },
  } as never;

  it('counts without naming', () => {
    expect(summarizeState(state)).toEqual({
      cookies: 2,
      origins: ['https://app.test'],
      storageKeys: 3,
    });
  });

  // The real requirement: whatever we print, none of it is a value. Asserting
  // on the serialized summary catches a future field that leaks one.
  it('serializes with no cookie value, token or storage value anywhere', () => {
    const serialized = JSON.stringify(summarizeState(state));
    for (const secret of ['super-secret-token', 'another-secret', 'bearer-abc', 'tmp-value']) {
      expect(serialized).not.toContain(secret);
    }
    // Keys and cookie names are omitted too — they are noise in a transcript.
    for (const key of ['session', 'csrf', 'authToken', 'scratch']) {
      expect(serialized).not.toContain(key);
    }
  });

  it('handles an empty state', () => {
    expect(summarizeState({})).toEqual({ cookies: 0, origins: [], storageKeys: 0 });
    expect(stateOrigins({})).toEqual([]);
  });

  it('merges origins across local and session storage', () => {
    expect(
      stateOrigins({
        localStorage: { 'https://a.test': {} },
        sessionStorage: { 'https://b.test': {}, 'https://a.test': {} },
      }),
    ).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('listing saved state', () => {
  it('returns an empty list when the root does not exist', async () => {
    expect(await listStateNames()).toEqual([]);
  });

  it('lists .json files by name, sorted, ignoring anything else', async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'bob.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(root, 'alice.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(root, 'notes.txt'), 'x', 'utf-8');
    await fs.writeFile(path.join(root, 'alice.json.tmp-1-2'), '{}', 'utf-8');

    expect(await listStateNames()).toEqual(['alice', 'bob']);
  });
});
