/**
 * The mapper update driver (scripts/mapper/update.mjs): version policy and
 * exit codes. Registry and Chrome for Testing answers come from a fixture;
 * build/test failures are simulated, so nothing here changes the vendor dir.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareVersions, verdict } from '../scripts/mapper/update.mjs';
import { readManifest, vendorDir } from '../scripts/mapper/lib.mjs';

const manifest = readManifest();
const pinned = manifest.chromiumBidi.version;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-update-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(eligible: string, stableMajor = 156): string {
  const file = path.join(dir, `fixture-${eligible}-${stableMajor}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      stableMajor,
      npm: {
        'chromium-bidi dist-tags.latest': '999.0.1-0',
        'puppeteer-core@latest dependencies.chromium-bidi': eligible,
        [`chromium-bidi@${eligible} dist.integrity`]: manifest.chromiumBidi.integrity,
        [`chromium-bidi@${eligible} dependencies.mitt`]: '^3.0.1',
        'mitt@^3.0.1 version': [manifest.mitt.version],
        [`mitt@${manifest.mitt.version} dist.integrity`]: manifest.mitt.integrity,
        'chromium-bidi time': {},
      },
    })
  );
  return file;
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ['scripts/mapper/update.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('mapper version policy', () => {
  it('orders npm snapshot versions numerically', () => {
    expect(compareVersions('157.0.8090-0', '157.0.8103-35')).toBe(-1);
    expect(compareVersions('157.0.8103-35', '157.0.8103-4')).toBe(1);
    expect(compareVersions('159.0.8134-0', '159.0.8134-0')).toBe(0);
  });

  it.each([
    [{ pinned: '157.0.8090-0', eligible: '157.0.8090-0', stableMajor: 156 }, 'up-to-date'],
    [
      { pinned: '157.0.8090-0', eligible: '158.0.8120-0', stableMajor: 156 },
      'update-available 158.0.8120-0',
    ],
    [
      { pinned: '158.0.8120-0', eligible: '157.0.8090-0', stableMajor: 156 },
      'pinned-ahead-of-eligible',
    ],
    [{ pinned: '157.0.8090-0', eligible: '159.0.8134-0', stableMajor: 156 }, 'policy-unresolved'],
    [{ pinned: '157.0.8090-0', eligible: undefined, stableMajor: 156 }, 'policy-unresolved'],
  ])('%j → %s', (input, expected) => {
    expect(verdict(input)).toBe(expected);
  });
});

describe('mapper update exit codes', () => {
  it('--status exits 0 when up to date and 10 when an update is available', () => {
    const same = run(['--status', '--json'], { MAPPER_UPDATE_FIXTURE: fixture(pinned) });
    expect(same.status).toBe(0);
    expect(JSON.parse(same.stdout).verdict).toBe('up-to-date');

    const newer = run(['--status'], { MAPPER_UPDATE_FIXTURE: fixture('157.0.9999-0') });
    expect(newer.status).toBe(10);
    expect(newer.stdout).toContain('update-available 157.0.9999-0');
  });

  it.each([
    ['20', 'guards'],
    ['30', 'api'],
    ['40', 'bundle'],
    ['50', 'gates'],
  ])(
    'a failing %s step stops with exit %s and leaves the vendor dir intact',
    (code, label) => {
      const before = fs.readFileSync(path.join(vendorDir, 'chromium-bidi-mapper.manifest.json'));
      // Same pins as committed, so even the steps that write produce identical bytes.
      const r = run(['--to', pinned], {
        MAPPER_UPDATE_FIXTURE: fixture(pinned),
        MAPPER_UPDATE_FAIL: code,
      });
      expect(r.status, r.stderr).toBe(Number(code));
      expect(r.stdout).toMatch(new RegExp(`^${label}\\s+(FAILED|CHANGED)`, 'm'));
      expect(fs.readFileSync(path.join(vendorDir, 'chromium-bidi-mapper.manifest.json'))).toEqual(
        before
      );
    },
    120_000
  );

  it('rejects a missing mode', () => {
    expect(run([], {}).status).toBe(1);
  });
});
