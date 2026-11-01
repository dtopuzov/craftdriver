/**
 * Unit tests for the vendored mapper build (scripts/mapper/*.mjs). The real
 * build needs the network, so the guards are exercised with fake metafiles
 * and the byte-for-byte check against temp copies of the vendor dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkGuards,
  compareWithVendor,
  normalizeDeclarations,
  packageOf,
  SIZE_BUDGET_BYTES,
} from '../scripts/mapper/build.mjs';
import { verifyIntegrity, vendorDir } from '../scripts/mapper/lib.mjs';

const manifest = {
  chromiumBidi: { version: '1.0.0', integrity: 'sha512-bidi' },
  mitt: { version: '3.0.1', integrity: 'sha512-mitt' },
  esbuild: { version: '0.1.0', integrity: 'sha512-esbuild' },
  entryExports: ['BidiServer', 'MapperCdpConnection'],
  bundledPackages: ['chromium-bidi', 'mitt'],
};

const okInputs = {
  'entry.mjs': {},
  'node_modules/chromium-bidi/out/Default/gen/src/bidiMapper/BidiServer.js': {},
  'node_modules/mitt/dist/mitt.mjs': {},
};

function guards(over: Partial<Parameters<typeof checkGuards>[0]> = {}) {
  return checkGuards({
    metafile: { inputs: okInputs },
    code: 'export {}',
    exportNames: ['BidiServer', 'MapperCdpConnection'],
    manifest,
    ...over,
  });
}

describe('mapper build guards', () => {
  it('accepts the expected inputs', () => {
    expect(guards()).toEqual([]);
  });

  it('(a) rejects a package that is not in bundledPackages', () => {
    const failures = guards({
      metafile: { inputs: { ...okInputs, 'node_modules/@scope/newdep/index.js': {} } },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('new transitive runtime dependency: @scope/newdep');
  });

  it('(b) rejects zod, devtools-protocol and the validating parser', () => {
    const failures = guards({
      metafile: {
        inputs: {
          ...okInputs,
          'node_modules/chromium-bidi/out/Default/gen/src/protocol-parser/protocol-parser.js': {},
        },
      },
    });
    expect(failures.join('\n')).toContain('forbidden module');

    const zod = guards({
      manifest: { ...manifest, bundledPackages: [...manifest.bundledPackages, 'zod'] },
      metafile: { inputs: { ...okInputs, 'node_modules/zod/index.js': {} } },
    });
    expect(zod.join('\n')).toContain('node_modules/zod/index.js');
  });

  it('(c) rejects a bundle over the size budget', () => {
    const failures = guards({ code: 'x'.repeat(SIZE_BUDGET_BYTES + 1) });
    expect(failures.join('\n')).toContain('over the');
  });

  it('(d) rejects a missing entry export', () => {
    const failures = guards({ exportNames: ['BidiServer'] });
    expect(failures).toEqual(['entry export missing: MapperCdpConnection']);
  });

  it('maps input paths to package names', () => {
    expect(packageOf('node_modules/mitt/dist/mitt.mjs')).toBe('mitt');
    expect(packageOf('node_modules/@esbuild/darwin-x64/bin/esbuild')).toBe('@esbuild/darwin-x64');
    expect(packageOf('entry.mjs')).toBeNull();
  });
});

describe('mapper API fingerprint', () => {
  it('ignores comments and whitespace but not signatures', () => {
    const a = '/** doc */\nexport declare class A {\n    close(): void; // trailing\n}\n';
    const b = 'export declare class A {\n  close(): void;\n}';
    expect(normalizeDeclarations(a)).toBe(normalizeDeclarations(b));
    expect(normalizeDeclarations(b)).not.toBe(
      normalizeDeclarations(b.replace('close(): void', 'close(force: boolean): void'))
    );
  });
});

describe('mapper toolchain integrity', () => {
  const lock = {
    packages: {
      'node_modules/chromium-bidi': { version: '1.0.0', integrity: 'sha512-bidi' },
      'node_modules/mitt': { version: '3.0.1', integrity: 'sha512-mitt' },
      'node_modules/esbuild': { version: '0.1.0', integrity: 'sha512-esbuild' },
    },
  };

  it('passes when the install matches the manifest', () => {
    expect(verifyIntegrity(manifest, lock)).toEqual([]);
  });

  it('fails loudly on a tampered integrity', () => {
    const problems = verifyIntegrity(
      { ...manifest, mitt: { version: '3.0.1', integrity: 'sha512-tampered' } },
      lock
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('sha512-tampered');
    expect(problems[0]).toContain('sha512-mitt');
  });
});

describe('mapper --check', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function committedFiles() {
    const names = fs.readdirSync(vendorDir).filter((n) => !/\.d\.ts$|NOTICE\.md$/.test(n));
    return Object.fromEntries(
      names.map((n) => [n, fs.readFileSync(path.join(vendorDir, n), 'utf8')])
    );
  }

  it('passes on the committed vendor dir and fails after a 1-byte edit', () => {
    const files = committedFiles();
    expect(compareWithVendor(files)).toEqual([]);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapper-check-'));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    const bundle = path.join(dir, 'chromium-bidi-mapper.js');
    const text = fs.readFileSync(bundle, 'utf8');
    fs.writeFileSync(bundle, text.replace('BidiServer', 'BidiServeR'));

    const problems = compareWithVendor(files, dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^chromium-bidi-mapper\.js: line \d+:/);
  });
});
