#!/usr/bin/env node
/**
 * Update the vendored chromium-bidi mapper bundle. Deterministic: every step
 * prints one line, and the first failure stops with its own exit code so the
 * `mapper-update` skill (or a human) knows exactly what needs judgment.
 *
 * Usage:
 *   node scripts/mapper/update.mjs --status [--json]
 *   node scripts/mapper/update.mjs --to <version|eligible> [--esbuild <v>] [--accept-api-change]
 *   node scripts/mapper/update.mjs --check-only [--json]
 *
 * Exit codes:
 *   0   done / up to date / (--check-only) clean update
 *   1   error (network, bad arguments)
 *   10  (--status) an update is available
 *   20  build guard failed (new bundled package, zod/devtools-protocol, size, missing export)
 *   30  upstream API signatures changed: update chromium-bidi-mapper.d.ts and
 *       the worker bootstrap in inProcessMapper.ts, then rerun with --accept-api-change
 *   40  tests/mapper-bundle.test.ts failed against the new bundle
 *   50  the hybrid launch gates failed against the new bundle
 *
 * Version policy: "eligible" is the exact chromium-bidi version the latest
 * puppeteer-core pins; Puppeteer runs this mapper in Node against the Chrome
 * it ships and tests. It must not be more than 2 majors ahead of Chrome
 * Stable (Chrome for Testing), or the verdict is `policy-unresolved`.
 *
 * Test seams (used by tests/mapper-update.test.ts, never in normal use):
 *   MAPPER_UPDATE_FIXTURE=<file.json>  registry/CfT answers instead of the network
 *   MAPPER_UPDATE_FAIL=<20|30|40|50>   simulate that step failing
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMapper, compareWithVendor, FILES, writeVendor } from './build.mjs';
import { manifestPath, npm, readManifest, repoRoot, vendorDir } from './lib.mjs';

const CFT_LAST_KNOWN_GOOD =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json';
const MIRROR = 'GoogleChromeLabs/chromium-bidi';
const MAX_MAJORS_AHEAD_OF_STABLE = 2;

const EXIT = {
  ok: 0,
  error: 1,
  updateAvailable: 10,
  guard: 20,
  api: 30,
  bundleTest: 40,
  gates: 50,
};

const fixture = process.env.MAPPER_UPDATE_FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.MAPPER_UPDATE_FIXTURE, 'utf8'))
  : undefined;
const simulatedFailure = Number(process.env.MAPPER_UPDATE_FAIL) || undefined;

/** `157.0.8090-0` → [157, 0, 8090, 0]; compares numerically, part by part. */
export function versionParts(v) {
  return v.split(/[.-]/).map(Number);
}

export function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const major = (v) => versionParts(v)[0];

/** The status verdict. Pure, so the policy is unit-tested. */
export function verdict({ pinned, eligible, stableMajor }) {
  if (!eligible || !stableMajor) return 'policy-unresolved';
  if (major(eligible) > stableMajor + MAX_MAJORS_AHEAD_OF_STABLE) return 'policy-unresolved';
  const cmp = compareVersions(eligible, pinned);
  if (cmp === 0) return 'up-to-date';
  if (cmp > 0) return `update-available ${eligible}`;
  return 'pinned-ahead-of-eligible';
}

function npmView(spec, field) {
  if (fixture) {
    const value = fixture.npm?.[`${spec} ${field}`];
    if (value === undefined) throw new Error(`fixture has no npm answer for "${spec} ${field}"`);
    return value;
  }
  const out = npm(['view', spec, field, '--json'], repoRoot).trim();
  return out ? JSON.parse(out) : undefined;
}

async function stableChromeMajor() {
  if (fixture) return fixture.stableMajor;
  const res = await fetch(CFT_LAST_KNOWN_GOOD);
  if (!res.ok) throw new Error(`Chrome for Testing: HTTP ${res.status}`);
  const json = await res.json();
  return major(json.channels.Stable.version);
}

async function status() {
  const manifest = readManifest(manifestPath);
  const pinned = manifest.chromiumBidi.version;
  const latest = npmView('chromium-bidi', 'dist-tags.latest');
  const eligible = npmView('puppeteer-core@latest', 'dependencies.chromium-bidi');
  const stableMajor = await stableChromeMajor();
  return {
    pinned,
    latest,
    eligible,
    stableMajor,
    verdict: verdict({ pinned, eligible, stableMajor }),
  };
}

function step(label, detail) {
  console.log(`${label.padEnd(10)} ${detail}`);
}

/** Highest published version of `name` that satisfies `range`. */
function highestMatching(name, range) {
  const found = npmView(`${name}@${range}`, 'version');
  const list = Array.isArray(found) ? found : [found];
  return list.sort(compareVersions).at(-1);
}

/** Line diff of two texts (only changed lines, with +/-), for the API report. */
function lineDiff(before, after) {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  return [
    ...before
      .split('\n')
      .filter((l) => !b.has(l))
      .map((l) => `- ${l}`),
    ...after
      .split('\n')
      .filter((l) => !a.has(l))
      .map((l) => `+ ${l}`),
  ].join('\n');
}

/** Resolve pins and build in memory. Exits 20/30 on guard/API problems. */
async function prepare(target, { esbuild, acceptApiChange }) {
  const current = readManifest(manifestPath);
  const version = target === 'eligible' ? (await status()).eligible : target;
  if (!version) throw new Error('could not resolve the eligible chromium-bidi version');

  const integrity = npmView(`chromium-bidi@${version}`, 'dist.integrity');
  const mittRange = npmView(`chromium-bidi@${version}`, 'dependencies.mitt');
  const mittVersion = highestMatching('mitt', mittRange);
  const next = {
    ...current,
    chromiumBidi: { version, integrity },
    mitt: { version: mittVersion, integrity: npmView(`mitt@${mittVersion}`, 'dist.integrity') },
  };
  if (esbuild) {
    next.esbuild = { version: esbuild, integrity: npmView(`esbuild@${esbuild}`, 'dist.integrity') };
  }
  step(
    'resolve',
    `chromium-bidi ${current.chromiumBidi.version} → ${version}, mitt ${mittVersion}`
  );

  let built;
  try {
    if (simulatedFailure === EXIT.guard) {
      const err = new Error('Mapper bundle guards failed:\n- simulated guard failure');
      err.guardFailures = ['simulated'];
      throw err;
    }
    built = await buildMapper(next);
  } catch (err) {
    if (!err.guardFailures) throw err;
    step('guards', 'FAILED');
    console.error(err.message);
    process.exit(EXIT.guard);
  }
  step(
    'guards',
    `ok (${built.report.bytes} bytes, ${built.report.modules} modules: ${built.report.packages.join(', ')})`
  );

  const apiChanged =
    simulatedFailure === EXIT.api || built.manifest.apiFingerprint !== current.apiFingerprint;
  if (apiChanged && !acceptApiChange) {
    step('api', 'CHANGED');
    const before = fs.readFileSync(path.join(vendorDir, FILES.api), 'utf8');
    console.log(lineDiff(before, built.files[FILES.api]) || '(simulated)');
    console.error(
      'Upstream mapper signatures changed. Update src/lib/bidi/vendor/chromium-bidi-mapper.d.ts ' +
        'and the worker bootstrap in src/lib/bidi/inProcessMapper.ts to match, then rerun with --accept-api-change.'
    );
    process.exit(EXIT.api);
  }
  step('api', apiChanged ? 'changed (accepted)' : 'unchanged');
  return { current, built };
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

/** Run vitest on `files`; starts the examples server when the gates need it. */
async function runVitest(files, { needsServer }) {
  let server;
  if (needsServer && !(await portOpen(8080))) {
    server = spawn('npx', ['http-server', './examples', '-a', '127.0.0.1', '-p', '8080', '-c-1'], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    for (let i = 0; i < 100 && !(await portOpen(8080)); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    const r = spawnSync('npx', ['vitest', 'run', ...files], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, HEADLESS: process.env.HEADLESS ?? 'true' },
      shell: process.platform === 'win32',
    });
    return r.status === 0;
  } finally {
    server?.kill();
  }
}

function upstreamCommits(oldVersion, newVersion) {
  try {
    const times = npmView('chromium-bidi', 'time');
    const [since, until] = [times[oldVersion], times[newVersion]].sort();
    const r = spawnSync(
      'gh',
      [
        'api',
        `repos/${MIRROR}/commits?since=${since}&until=${until}&per_page=100`,
        '--jq',
        '.[] | .sha[0:10] + " " + (.commit.message | split("\\n")[0])',
      ],
      { encoding: 'utf8' }
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim() || '(no mirror commits in that window)';
  } catch (err) {
    return `(could not list commits: ${String(err.message ?? err).split('\n')[0]}; see https://github.com/${MIRROR}/commits)`;
  }
}

async function update(target, opts) {
  const { current, built } = await prepare(target, opts);
  writeVendor(built.files);
  step('write', `src/lib/bidi/vendor/ (${built.manifest.chromiumBidi.version})`);

  // A simulated failure skips the real test runs.
  const bundleOk = simulatedFailure
    ? simulatedFailure !== EXIT.bundleTest
    : await runVitest(['tests/mapper-bundle.test.ts'], { needsServer: false });
  if (!bundleOk) {
    step('bundle', 'FAILED (tests/mapper-bundle.test.ts)');
    process.exit(EXIT.bundleTest);
  }
  step('bundle', 'tests/mapper-bundle.test.ts passed');

  const gates = ['tests/chrome-launcher.test.ts', 'tests/hybrid-launch.test.ts'];
  const gatesOk = simulatedFailure
    ? simulatedFailure !== EXIT.gates
    : await runVitest(gates, { needsServer: true });
  if (!gatesOk) {
    step('gates', `FAILED (${gates.join(', ')})`);
    process.exit(EXIT.gates);
  }
  step('gates', `${gates.join(', ')} passed`);

  const licencesChanged = compareWithVendor(
    Object.fromEntries(Object.entries(built.files).filter(([n]) => n.startsWith('LICENSE.')))
  ).length
    ? 'yes'
    : 'no';
  const oldVersion = current.chromiumBidi.version;
  const newVersion = built.manifest.chromiumBidi.version;
  const delta = built.manifest.output.bytes - current.output.bytes;
  console.log(`
## Report

chromium-bidi ${oldVersion} → ${newVersion}
bundle ${built.manifest.output.bytes} bytes (${delta >= 0 ? '+' : ''}${delta}), ${built.report.modules} modules
bundled packages: ${built.report.packages.join(', ')}
licence files changed: ${licencesChanged}

Upstream commits (${MIRROR}, between the two npm publishes):
${upstreamCommits(oldVersion, newVersion)}

Suggested commit:
chore(mapper): bump bundled chromium-bidi ${oldVersion} → ${newVersion}

Bundle: ${built.manifest.output.bytes} bytes (${delta >= 0 ? '+' : ''}${delta}), ${built.report.modules} modules from ${built.report.packages.join(', ')}.
Gates: tests/mapper-bundle.test.ts, ${gates.join(', ')}.
Relevant upstream changes: <summarize, or "none relevant">
`);
}

async function main(argv) {
  const json = argv.includes('--json');
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.includes('--status')) {
    const s = await status();
    if (json) console.log(JSON.stringify(s, null, 2));
    else {
      step('pinned', s.pinned);
      step('latest', s.latest);
      step('eligible', `${s.eligible} (puppeteer-core@latest pin)`);
      step('stable', `Chrome ${s.stableMajor}`);
      step('verdict', s.verdict);
    }
    return s.verdict.startsWith('update-available') ? EXIT.updateAvailable : EXIT.ok;
  }

  if (argv.includes('--check-only')) {
    const s = await status();
    if (!s.verdict.startsWith('update-available')) {
      console.log(
        json ? JSON.stringify({ ...s, check: 'nothing to do' }) : `verdict: ${s.verdict}`
      );
      return EXIT.ok;
    }
    await prepare(s.eligible, { esbuild: arg('--esbuild') });
    console.log(json ? JSON.stringify({ ...s, check: 'clean' }) : 'clean update');
    return EXIT.ok;
  }

  const target = arg('--to');
  if (target) {
    await update(target, {
      esbuild: arg('--esbuild'),
      acceptApiChange: argv.includes('--accept-api-change'),
    });
    return EXIT.ok;
  }

  console.error(
    'Usage: update.mjs --status [--json] | --check-only [--json] | --to <version|eligible>'
  );
  return EXIT.error;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message);
      process.exit(EXIT.error);
    });
}
