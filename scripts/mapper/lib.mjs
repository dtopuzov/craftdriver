/**
 * Shared helpers for the vendored chromium-bidi mapper bundle.
 *
 * The build tools (chromium-bidi, mitt, esbuild) never enter craftdriver's
 * node_modules: every build installs them into a throwaway temp dir from the
 * exact versions and integrity hashes in the committed manifest, so
 * Dependabot, `npm audit` and deps-bump never see them.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..', '..');
export const vendorDir = path.join(repoRoot, 'src', 'lib', 'bidi', 'vendor');
export const manifestPath = path.join(vendorDir, 'chromium-bidi-mapper.manifest.json');

/** Packages the toolchain installs, in manifest key → npm name order. */
export const TOOLCHAIN = [
  ['chromiumBidi', 'chromium-bidi'],
  ['mitt', 'mitt'],
  ['esbuild', 'esbuild'],
];

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function readManifest(file = manifestPath) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Stable JSON: 2-space indent, trailing newline (matches prettier's output). */
export function formatManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Run npm and return stdout. Throws with npm's stderr on failure. */
export function npm(args, cwd) {
  try {
    return execFileSync(npmCmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (err) {
    throw new Error(`npm ${args.join(' ')} failed:\n${err.stderr || err.message}`);
  }
}

/**
 * Compare the integrity npm recorded in the temp lockfile with the manifest.
 * Returns a list of human-readable mismatches (empty when everything matches).
 */
export function verifyIntegrity(manifest, lock) {
  const problems = [];
  for (const [key, name] of TOOLCHAIN) {
    const want = manifest[key];
    const got = lock.packages?.[`node_modules/${name}`];
    if (!got) {
      problems.push(`${name}: not installed`);
      continue;
    }
    if (got.version !== want.version) {
      problems.push(`${name}: installed ${got.version}, manifest pins ${want.version}`);
    }
    if (got.integrity !== want.integrity) {
      problems.push(
        `${name}@${want.version}: integrity mismatch\n  manifest:  ${want.integrity}\n  installed: ${got.integrity}`
      );
    }
  }
  return problems;
}

/**
 * Install the pinned toolchain into a temp dir, verify integrity, run
 * `fn(dir)`, and always remove the dir afterwards.
 *
 * `--legacy-peer-deps` keeps chromium-bidi's types-only `devtools-protocol`
 * peer out of the install. `--ignore-scripts` skips esbuild's postinstall: its
 * platform binary arrives through optionalDependencies, so the JS API works
 * without it.
 */
export async function withToolchain(manifest, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-mapper-'));
  try {
    const dependencies = Object.fromEntries(
      TOOLCHAIN.map(([key, name]) => [name, manifest[key].version])
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'mapper-toolchain', private: true, dependencies }, null, 2)
    );
    npm(
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--save-exact',
      ],
      dir
    );
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    const problems = verifyIntegrity(manifest, lock);
    if (problems.length) {
      throw new Error(`Toolchain does not match the manifest:\n${problems.join('\n')}`);
    }
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Integrity of a published package version, straight from the registry. */
export function registryIntegrity(name, version) {
  return npm(['view', `${name}@${version}`, 'dist.integrity'], os.tmpdir()).trim();
}
