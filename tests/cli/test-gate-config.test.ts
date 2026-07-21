/**
 * The two vitest configs must agree about which tests launch browsers.
 *
 * Every file in the single-worker CLI gate also has to be excluded from the
 * default suite. Adding it to one list and not the other leaves it running in
 * the default suite's parallel workers as well, where concurrent chromedriver
 * starts exceed the driver's session-creation timeout — and the failure then
 * surfaces on whichever unrelated file happened to start at the same moment,
 * so the cause is nowhere near the symptom.
 *
 * That drift happened, twice, and cost a debugging session each time. Compare
 * the lists mechanically rather than trusting a comment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..', '..');

/**
 * Test files quoted inside a config's `include:`/`exclude:` array.
 *
 * Matches any `tests/**.test.ts` rather than only `tests/cli/`: the smoke
 * tests live at the top of `tests/` and drive browsers just as hard, and
 * leaving them outside this check is how they stayed in the parallel suite.
 */
function listedPaths(file: string, key: 'include' | 'exclude'): string[] {
  const source = readFileSync(resolve(root, file), 'utf-8');
  const block = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  if (!block) throw new Error(`no ${key} array found in ${file}`);
  return [...block[1].matchAll(/'(tests\/[^']*\.test\.ts)'/g)].map((m) => m[1]);
}

describe('browser-driving CLI tests run in exactly one gate', () => {
  const gated = listedPaths('vitest.cli.config.ts', 'include');
  const excluded = new Set(listedPaths('vitest.config.ts', 'exclude'));

  it('the gate is not empty, so a broken parse cannot pass this vacuously', () => {
    expect(gated.length).toBeGreaterThan(5);
  });

  it.each(gated)('%s is excluded from the default suite', (file) => {
    expect(excluded.has(file)).toBe(true);
  });

  it('the default suite excludes nothing the gate does not run', () => {
    // The other direction: a file excluded from `npm test` but absent from
    // the gate would run nowhere at all.
    const inGate = new Set(gated);
    for (const file of excluded) {
      expect(inGate.has(file)).toBe(true);
    }
  });
});
