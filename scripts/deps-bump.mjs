#!/usr/bin/env node
/**
 * Bump every direct dependency to its latest official release and rebuild the
 * tree from scratch. The mechanical half of the `deps-bump` skill
 * (.claude/skills/deps-bump/SKILL.md): it makes no judgment calls, it reports
 * what still needs one.
 *
 * Steps, in order:
 *   1. Drop `overrides` from package.json (printed, so they can be restored).
 *   2. Resolve each dependency's `latest` dist-tag. Prereleases never count.
 *      A version that violates another direct dependency's peer range is
 *      capped to the newest release that satisfies it.
 *   3. Rewrite package.json, keeping each spec's prefix (^, ~ or exact pin).
 *   4. Delete package-lock.json and node_modules, `npm install`,
 *      `npm audit fix`.
 *   5. Classify what `npm audit` still reports. Packages bundled inside the
 *      npm CLI cannot be overridden; for the rest, suggest an override pinned
 *      to the newest safe release in the installed major.
 *
 * Usage:
 *   node scripts/deps-bump.mjs                    # steps 1-5
 *   node scripts/deps-bump.mjs --dry-run          # step 2 only, change nothing
 *   node scripts/deps-bump.mjs --audit-only       # step 5 on the current tree
 *   node scripts/deps-bump.mjs --apply-overrides  # write step 5's suggestions,
 *                                                 # reinstall, re-audit
 *   node scripts/deps-bump.mjs --verify           # lint, build, docs:check
 *
 * Exit codes: 0 clean, 1 vulnerabilities remain, 2 install or verify failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pkgFile = path.join(repoRoot, 'package.json');
const lockFile = path.join(repoRoot, 'package-lock.json');
const isWin = process.platform === 'win32';
const execFileAsync = promisify(execFile);

const args = new Set(process.argv.slice(2));
const DEP_FIELDS = ['dependencies', 'devDependencies'];
// Plain registry specs only; git/file/alias/tag specs are left alone.
const REGISTRY_SPEC = /^([\^~]?)\d+\.\d+\.\d+$/;

async function npmJson(...npmArgs) {
  try {
    const { stdout } = await execFileAsync('npm', [...npmArgs, '--json'], {
      cwd: repoRoot,
      shell: isWin,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch (err) {
    // `npm audit` exits non-zero when it finds something; its JSON is still valid.
    if (err.stdout?.trim()) return JSON.parse(err.stdout);
    throw err;
  }
}

// `npm view pkg@range version` answers with a string for one match, an array
// for several, nothing for none. Ascending order.
async function versionsMatching(name, range) {
  const out = await npmJson('view', `${name}@${range}`, 'version');
  return out === undefined ? [] : [].concat(out);
}

function run(cmd, cmdArgs) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, { cwd: repoRoot, stdio: 'inherit', shell: isWin });
  return res.status === 0;
}

const readPkg = () => JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const writePkg = (pkg) => fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

function directDeps(pkg) {
  const deps = [];
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      deps.push({ field, name, spec, match: REGISTRY_SPEC.exec(spec) });
    }
  }
  return deps;
}

async function planBumps(pkg) {
  const deps = directDeps(pkg);
  const registry = deps.filter((d) => d.match);
  const latest = Object.fromEntries(
    await Promise.all(
      registry.map(async (d) => [
        d.name,
        (await npmJson('view', `${d.name}@latest`, 'version')) ?? null,
      ])
    )
  );

  const target = { ...latest };
  const capped = {};
  // Re-check until stable: capping one package changes the peer ranges in play.
  for (let pass = 0; pass < 5; pass++) {
    const peers = await Promise.all(
      registry.map(async (d) => [
        d.name,
        (await npmJson('view', `${d.name}@${target[d.name]}`, 'peerDependencies')) ?? {},
      ])
    );
    let changed = false;
    for (const [owner, peerDeps] of peers) {
      for (const [peer, range] of Object.entries(peerDeps)) {
        if (!(peer in target)) continue;
        const ok = await versionsMatching(peer, range);
        if (ok.includes(target[peer])) continue;
        const best = ok.filter((v) => !v.includes('-')).at(-1);
        if (!best) continue;
        target[peer] = best;
        capped[peer] = `${owner}@${target[owner]} needs ${peer}@"${range}"`;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return deps.map((d) => {
    if (!d.match) return { ...d, skip: 'not a plain registry spec' };
    const current = d.spec.slice(d.match[1].length);
    const next = target[d.name];
    return {
      ...d,
      current,
      latest: latest[d.name],
      next,
      nextSpec: d.match[1] + next,
      capped: capped[d.name],
    };
  });
}

function printPlan(plan) {
  for (const p of plan) {
    if (p.skip) {
      console.log(`  ${p.name.padEnd(30)} ${p.spec}  (skipped: ${p.skip})`);
      continue;
    }
    const arrow = p.current === p.next ? '=' : '->';
    const note = p.capped ? `  [held below ${p.latest}: ${p.capped}]` : '';
    console.log(`  ${p.name.padEnd(30)} ${p.current.padEnd(10)} ${arrow} ${p.next}${note}`);
  }
}

// Caret semantics: 0.x releases are only compatible within their minor.
const compatLine = (version) => {
  const [major, minor] = version.split('.');
  return major === '0' ? `0.${minor}` : major;
};

// Every installed copy of `name`, and the (non-bundled) packages requiring it.
function lockInfo(name) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const found = new Map();
  const requiredBy = new Set();
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    const bundled = key.includes('node_modules/npm/node_modules/');
    if (key.endsWith(`node_modules/${name}`) && meta.version) {
      found.set(`${meta.version}${bundled}`, { version: meta.version, bundled });
    }
    if (!bundled && (meta.dependencies?.[name] || meta.peerDependencies?.[name])) {
      const owner = key === '' ? 'package.json' : key.slice(key.lastIndexOf('node_modules/') + 13);
      requiredBy.add(
        `${owner}@${meta.version ?? ''} (${meta.dependencies?.[name] ?? meta.peerDependencies[name]})`
      );
    }
  }
  return { installs: [...found.values()], requiredBy: [...requiredBy] };
}

async function analyseAudit() {
  const audit = await npmJson('audit');
  const vulns = Object.values(audit.vulnerabilities ?? {});
  const findings = [];
  for (const v of vulns) {
    // Only packages that carry an advisory themselves; the rest are just
    // parents that depend on one and clear when it does.
    const advisories = v.via.filter((x) => typeof x === 'object');
    if (advisories.length === 0) continue;
    const { installs, requiredBy } = lockInfo(v.name);
    // `v.range` is the union of every advisory's range; check each installed
    // copy against it rather than assuming all of them are affected.
    const bad = new Set(await versionsMatching(v.name, v.range));
    const vulnerable = installs.filter((i) => bad.has(i.version));
    const overridable = vulnerable.filter((i) => !i.bundled);
    const finding = {
      name: v.name,
      severity: v.severity,
      range: v.range,
      vulnerable: vulnerable.map((i) => i.version + (i.bundled ? ' (bundled in npm)' : '')),
      titles: [...new Set(advisories.map((a) => a.title))],
    };
    if (overridable.length === 0) {
      finding.verdict =
        'bundled in the npm CLI; overrides cannot reach it, clears when npm ships a fix';
    } else {
      const all = [].concat((await npmJson('view', v.name, 'versions')) ?? []);
      const safe = all.filter((x) => !x.includes('-') && !bad.has(x));
      // Several lines installed (e.g. undici 6 and 7) → scope the override to
      // the vulnerable line so consumers of the other one are left alone.
      const allLines = new Set(
        installs.filter((i) => !i.bundled).map((i) => compatLine(i.version))
      );
      const stuck = [];
      finding.overrides = {};
      for (const line of new Set(overridable.map((i) => compatLine(i.version)))) {
        const pick = safe.filter((x) => compatLine(x) === line).at(-1);
        const key = allLines.size > 1 ? `${v.name}@${line}` : v.name;
        if (pick) finding.overrides[key] = `^${pick}`;
        else stuck.push(line);
      }
      if (stuck.length) {
        finding.verdict =
          `no safe release in line ${stuck.join(', ')} (newest safe overall: ${safe.at(-1) ?? 'none'}); ` +
          `needs a human. Required by: ${requiredBy.join(', ')}`;
      }
    }
    findings.push(finding);
  }
  return { total: audit.metadata?.vulnerabilities?.total ?? 0, findings };
}

function printAudit({ total, findings }) {
  console.log(
    `\nnpm audit: ${total} vulnerable package(s), ${findings.length} with their own advisory`
  );
  for (const f of findings) {
    console.log(
      `  ${f.severity.padEnd(8)} ${f.name} ${f.vulnerable.join(', ')}  (vulnerable ${f.range})`
    );
    for (const t of f.titles) console.log(`             - ${t}`);
    if (f.overrides && Object.keys(f.overrides).length) {
      console.log(`             override: ${JSON.stringify(f.overrides)}`);
    }
    if (f.verdict) console.log(`             ${f.verdict}`);
  }
}

function freshInstall() {
  fs.rmSync(lockFile, { force: true });
  fs.rmSync(path.join(repoRoot, 'node_modules'), { recursive: true, force: true });
  if (!run('npm', ['install'])) return false;
  // `npm audit fix` exits non-zero when anything is left over; that is step 5's job.
  run('npm', ['audit', 'fix']);
  return true;
}

async function auditAndExit() {
  const result = await analyseAudit();
  printAudit(result);
  process.exit(result.total === 0 ? 0 : 1);
}

if (args.has('--verify')) {
  for (const script of ['lint', 'build', 'docs:check']) {
    if (!run('npm', ['run', script])) process.exit(2);
  }
  process.exit(0);
}

if (args.has('--audit-only')) await auditAndExit();

if (args.has('--apply-overrides')) {
  const { findings } = await analyseAudit();
  const pkg = readPkg();
  const add = Object.assign({}, ...findings.map((f) => f.overrides ?? {}));
  if (Object.keys(add).length === 0) {
    console.log('Nothing overridable to add.');
    await auditAndExit();
  }
  pkg.overrides = { ...pkg.overrides, ...add };
  writePkg(pkg);
  console.log(`Added overrides: ${JSON.stringify(add, null, 2)}`);
  // Overrides that change an already-locked version need a clean resolve.
  if (!freshInstall()) process.exit(2);
  await auditAndExit();
}

const pkg = readPkg();
console.log('Planned versions (latest dist-tag, capped by peer ranges):');
const plan = await planBumps(pkg);
printPlan(plan);
if (args.has('--dry-run')) process.exit(0);

if (pkg.overrides) {
  console.log(
    `\nRemoving overrides (restore any still needed after the audit):\n${JSON.stringify(pkg.overrides, null, 2)}`
  );
  delete pkg.overrides;
}
for (const p of plan) if (!p.skip) pkg[p.field][p.name] = p.nextSpec;
writePkg(pkg);

if (!freshInstall()) process.exit(2);
await auditAndExit();
