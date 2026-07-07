import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const apiReference = path.join(repoRoot, 'docs', 'api-reference.md');
const generator = path.join(repoRoot, 'scripts', 'gen-api-reference.mjs');

function exportedNames(source: string): Set<string> {
  const blocks = source.matchAll(/export(?:\s+type)?\s*\{([\s\S]*?)\}/g);
  const names = [...blocks].flatMap(([, block]) =>
    block
      .split(',')
      .map((raw) =>
        raw
          .replace(/\btype\s+/, '')
          .trim()
          .split(/\s+as\s+/)[0]
          .trim()
      )
      .filter(Boolean)
  );
  return new Set(names);
}

describe('docs/api-reference.md', () => {
  it('is in sync with src/index.ts (run `npm run docs:api`)', () => {
    // The --check mode exits non-zero when the file is stale.
    expect(() =>
      execFileSync(process.execPath, [generator, '--check'], {
        cwd: repoRoot,
        stdio: 'pipe',
      })
    ).not.toThrow();
  });

  it('lists every named export from src/index.ts', () => {
    const indexSrc = fs.readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8');
    const names = exportedNames(indexSrc);

    expect(names.size).toBeGreaterThan(0);
    const table = fs.readFileSync(apiReference, 'utf8');
    const missing = [...names].filter((n) => !table.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});
