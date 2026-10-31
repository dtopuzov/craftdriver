# Plan M: bundle the chromium-bidi mapper into craftdriver (+ the update workflow)

Status: **decided** (owner, 2026-10-31). Bundle the mapper. No `zod`, no
`devtools-protocol`, no chromium-bidi in `dependencies` or `devDependencies`.

This is the foundation for [chrome-hybrid-launch.md](chrome-hybrid-launch.md)
(Plan A) and [chrome-driverless.md](chrome-driverless.md) (Plan B). Both
consume the bundle this plan produces. They don't depend on the npm package.

## Read this first (agents)

- Load the `craftdriver-engineering` skill before touching `src/`.
- Task format: **Files**, **Do**, **Done when**. Research tasks (`R`) append
  their findings to "Research log" at the bottom and write no production
  code.
- The bundle is **generated, committed, and never hand-edited**. Every byte
  of it must come out of `scripts/mapper/build.mjs` from pinned inputs, and CI
  proves that on every PR (M1.5).

## Decision record

| question | decision | why |
|---|---|---|
| How craftdriver gets the mapper | Vendor an esbuild bundle of chromium-bidi's mapper into `src/lib/bidi/vendor/` | Keeps ~21.5 MB of install (chromium-bidi 9.7 MB, zod 8.1 MB, devtools-protocol 3.7 MB) and a zod advisory history out of every user's tree |
| What goes into the bundle | `BidiServer` and `MapperCdpConnection` only, plus their transitive code: chromium-bidi and mitt | Measured: 79 modules, 0 from zod, devtools-protocol or `protocol-parser` |
| Command parser | chromium-bidi's built-in no-op parser (the default when `createAndStart` gets no parser) | The validating `BidiParser` is the only importer of zod. Even without it, the mapper still returns W3C error codes for bad input (spike below) |
| Minify? | **No** | Readable diffs on every update (security review); import cost ~22 ms unminified vs ~19 ms minified |
| Where the build tools live | A throwaway temp dir per build, with exact versions pinned in a committed manifest | Nothing chromium-bidi-related enters craftdriver's `node_modules`, so Dependabot, `deps-bump` and `npm audit` never see it |
| Dependency surface for users | None added | The bundle ships inside `dist/` |

## Spike evidence (2026-10-31; chromium-bidi 157.0.8090-0, esbuild 0.25.12, Chrome 156)

Entry: `export { BidiServer } from '…/bidiMapper/BidiMapper.js'; export { MapperCdpConnection } from '…/cdp/CdpConnection.js'`,
bundled with `--bundle --format=esm --platform=node --target=node22`.

Size:

| | bytes | gzip |
|---|---:|---:|
| bundle, unminified | 425,741 | 82,226 |
| bundle, minified | 191,209 | 50,865 |

Contents (from the esbuild metafile): chromium-bidi 597 KB of input, mitt
349 B. zod, devtools-protocol and protocol-parser are all absent.

Cold import, in fresh Node processes:

| | time |
|---|---:|
| bundled | ~22 ms |
| unbundled chromium-bidi + `BidiParser` (zod) | ~152 ms |

The unbundled import was part of the ~143 ms "module import" phase in the
driver-perf cold-start table, so bundling should improve both plans' cold
numbers by roughly 125 ms. That's an estimate; re-measure (M2.2).

Smoke test against real Chrome 156, using the bundle with no parser:
- PASS for `session.new` (`unhandledPromptBehavior: ignore`),
  `session.subscribe`, `getTree`, `navigate`, `script.evaluate`,
  `locateNodes`, `handleUserPrompt`;
- the alert stays open and `userPromptOpened` fires;
- the `load` event fires.

Malformed input still returns W3C errors with the no-op parser:

| input | response |
|---|---|
| `navigate {url: 42}` | `invalid argument` "Invalid URL: 42" |
| unknown command | `unknown command` |
| bad context | `no such frame` |

## Layout (target)

```
src/lib/bidi/vendor/
  chromium-bidi-mapper.js         # GENERATED. Starts with a /*! header (versions, licences, "do not edit")
  chromium-bidi-mapper.d.ts       # hand-written, minimal types for the 2 exports (no devtools-protocol)
  chromium-bidi-mapper.manifest.json
  LICENSE.chromium-bidi           # Apache-2.0, copied from the package
  LICENSE.mitt                    # MIT, copied from the package
  NOTICE.md                       # what is vendored, from where, how to rebuild
scripts/mapper/
  build.mjs                       # deterministic build + --check
  update.mjs                      # deterministic update driver (status / to <version>)
  lib.mjs                         # shared helpers (temp install, integrity, fingerprint)
.claude/skills/mapper-update/SKILL.md   # the AI half of an update
.github/workflows/mapper-watch.yml      # weekly: is a new eligible mapper out? → issue
```

Manifest shape (all fields written by the scripts, never by hand):

```json
{
  "chromiumBidi": { "version": "157.0.8090-0", "integrity": "sha512-…" },
  "mitt": { "version": "3.0.1", "integrity": "sha512-…" },
  "esbuild": "0.25.12",
  "entryExports": ["BidiServer", "MapperCdpConnection"],
  "bundledPackages": ["chromium-bidi", "mitt"],
  "output": { "bytes": 425741, "sha256": "…" },
  "apiFingerprint": "sha256 of the normalized public signatures (see M1.2)",
  "chromeSupport": { "minMajor": 0, "source": "see R-M2" }
}
```

---

## Phase M1: build pipeline

### M1.1 `scripts/mapper/lib.mjs`: temp toolchain

- **Do:** `withToolchain(manifest, fn)`:
  1. Create a temp dir and write a `package.json` with **exact** versions of
     `chromium-bidi`, `mitt` and `esbuild` from the manifest.
  2. Run `npm install --no-audit --no-fund --legacy-peer-deps` there.
     `--legacy-peer-deps` keeps `devtools-protocol`, a types-only peer, from
     even being installed.
  3. Verify each installed package's `integrity` (from the temp
     `package-lock.json`) equals the manifest's. If not, fail with both
     values.
  4. Call `fn(tempDir)`, and always remove the temp dir afterwards.
- Check whether esbuild needs its install script. Its platform binary
  normally comes through `optionalDependencies`, so try `--ignore-scripts`
  first and keep it if the build works. Record the answer in the Research log.
- **Done when:** a unit-level run installs into a temp dir and verifies
  integrity, a tampered manifest integrity fails loudly, and nothing is
  written outside the temp dir.

### M1.2 `scripts/mapper/build.mjs`: build and `--check`

- **Do (build):**
  1. In `withToolchain`, write the entry file (the two exports above, deep
     paths).
  2. Run esbuild through its JS API with `bundle`, `format: 'esm'`,
     `platform: 'node'`, `target: 'node22'`, `minify: false`,
     `legalComments: 'eof'`, `metafile: true`, `absWorkingDir: tempDir`.
     Setting `absWorkingDir` keeps the path comments in the output identical
     on every machine.
  3. **Guards.** Fail with a clear message when any of these is true:
     - (a) the metafile contains any package not in
       `manifest.bundledPackages` (it lists the offenders and says "new
       transitive runtime dependency: review its licence and add it
       deliberately");
     - (b) any input path matches `/node_modules/zod/`,
       `/devtools-protocol/` or `/protocol-parser/`;
     - (c) the output exceeds a size budget of 1 MB;
     - (d) an entry export is missing.
  4. Write `chromium-bidi-mapper.js` as a `/*!` header followed by the
     esbuild output. The header carries the package versions and licences, a
     "GENERATED by scripts/mapper/build.mjs — do not edit" note, and the
     regenerate command.
  5. Copy the `LICENSE` files of every bundled package.
  6. Compute the API fingerprint. Normalize (strip comments and whitespace)
     these upstream `.d.ts` declarations:
     - `BidiServer.createAndStart` (from `bidiMapper/BidiServer.d.ts`);
     - `BidiServer.close`;
     - `MapperCdpConnection`'s constructor, `createBrowserSession` and
       `close` (from `cdp/CdpConnection.d.ts`);
     - the `BidiTransport` and `Transport` interfaces.

     Then sha256 them.
  7. Update `manifest.output` and `manifest.apiFingerprint`.
- **Do (`--check`):** build into a temp output, then byte-compare against the
  committed bundle, licences and manifest. On mismatch, print the first
  differing line and exit 1. Never write to `src/`.
- **Done when:**
  - Two consecutive builds produce identical bytes.
  - `--check` passes on a clean tree.
  - `--check` fails after a 1-byte edit to the bundle.
  - Each guard (a)–(d) is covered by a test that feeds a fake metafile or
    entry.

### M1.3 Types and loader seam

- **Files:**
  - `src/lib/bidi/vendor/chromium-bidi-mapper.d.ts`, minimal hand-written
    types: `BidiServer.createAndStart(bidiTransport, cdpConnection, browserClient, selfTargetId: string): Promise<BidiServer>`,
    `close(): void`, `MapperCdpConnection`, `MapperTransport`,
    `BidiTransport`. Use `unknown` for CDP payloads; no devtools-protocol.
  - New `src/lib/bidi/mapperBundle.ts`: `loadMapper()`, a cached dynamic
    `import('./vendor/chromium-bidi-mapper.js')`. It's lazy so users who
    never take the hybrid or driverless path never parse it.
- **Done when:** `tsc` typechecks `mapperBundle.ts` against the `.d.ts`, and
  `src/index.ts` exports nothing from the vendor dir (internal only; run the
  API-review checklist).

### M1.4 Ship it in `dist/`, keep tools off it

- **Files:**
  - `package.json`: add
    `"postbuild": "node scripts/mapper/copy-to-dist.mjs"`. It copies
    `src/lib/bidi/vendor/*.{js,d.ts}` plus the licences and NOTICE into
    `dist/lib/bidi/vendor/`. (`tsc` has no `allowJs` here, so it won't copy
    them.)
  - New `.prettierignore` (none exists today; `npm run format` runs
    `prettier --write .`) with `src/lib/bidi/vendor/`.
  - `eslint.config.js` already lints only `**/*.ts`, so add nothing; note it
    in NOTICE.md.
- **Done when:**
  - `npm run build && node -e "import('./dist/lib/bidi/mapperBundle.js').then(m=>m.loadMapper()).then(x=>console.log(Object.keys(x)))"`
    prints both exports.
  - `npm pack --dry-run` lists the bundle, its licences and NOTICE.
  - `npm run format` leaves the bundle untouched.

### M1.5 CI integrity gate

- **Files:** `.github/workflows/ci.yml` and `package.json` scripts:
  - `mapper:build` → `node scripts/mapper/build.mjs`;
  - `mapper:check` → `node scripts/mapper/build.mjs --check`;
  - `mapper:status` / `mapper:update` → `node scripts/mapper/update.mjs …`.
- **Do:** run `npm run mapper:check` in the existing lint/build job on
  ubuntu-latest. Add one macOS run of it, then drop it once it has passed
  twice: that proves the build is byte-identical across OSes.
- **Done when:** CI is red if anyone hand-edits the bundle or changes the
  manifest without rebuilding.

### M1.6 First import

- **Do:** `npm run mapper:build` at the version chosen by R-M2. Commit the
  bundle, `.d.ts`, manifest, licences and NOTICE in one commit:
  `feat(bidi): vendor chromium-bidi mapper <version>`. The body must give the
  size, module count and import time, and confirm zod and devtools-protocol
  are absent (paste the guard output).

---

## Phase M2: verify the bundle drives Chrome

### M2.1 Integration test

- **Files:** new `tests/mapper-bundle.test.ts`. It uses `ChromeLauncher` from
  Plan A task A2.2. If that hasn't landed yet, use a local spawn helper
  inside the test, copied from driver-perf's `lib/chrome-direct.mjs`.
- **Assert:**
  - everything in the spike: `session.new` with the prompt-ignore map, the
    subscriptions, `getTree`, `navigate`, `evaluate`, `locateNodes`,
    alert-stays-open plus `userPromptOpened`, `handleUserPrompt`, and the
    `load` event;
  - the three malformed-input error codes.
- This test is the **update gate**: `scripts/mapper/update.mjs` runs it.

### M2.2 Import cost and cold start

- Re-run driver-perf's cold table with the bundle in place of the npm
  package. Add a `MAPPER_BUNDLE=/path` switch to its `lib/chrome-direct.mjs`.
- Record the new cold deltas for hybrid and driverless in Plans A and B's
  "Why" tables.

### R-M1 No-op parser error parity

- Today, error codes for commands with bad user input come from
  chromedriver's validating mapper. With the no-op parser they come from the
  mapper's processors (spike: still W3C codes).
- **Do:** list every BiDi command craftdriver sends that can carry user input
  (`grep "send(\\|send<" src/lib`). For each, send representative bad inputs
  through chromedriver BiDi and through the bundle, and diff `error` and
  `message`.
- Classify each diff:
  - same code, different message: fine;
  - different code: craftdriver must map or validate it client-side;
  - no error with the no-op parser where the validating one errored: add a
    targeted client-side check in craftdriver, **not** a zod dependency.
- **Done when:** the table is in the Research log, and any "different code"
  row has an owner-approved fix that becomes a task in Plan A or B.

### R-M2 Which mapper version for which Chrome

Facts established on 2026-10-31 (verify they still hold):

- **Where the source lives.** It moved into Chromium:
  `chromium/src/third_party/chromium-bidi`. GitHub
  `GoogleChromeLabs/chromium-bidi` is a mirror (its README says so; commits
  arrive prefixed `[chromium-bidi]`).
- **npm releases are Canary snapshots.** `chromium-bidi@<M>.0.<B>-<n>` matches
  Chromium `<M>.0.<B>.0`. For example, npm latest `159.0.8134-0` = Canary
  `159.0.8134.0`. The first such release was `157.0.8080-0` (2026-09-30);
  before it came `17.0.2` (2026-07-06). Inside Chromium the in-tree
  `package.json` still says `17.0.2` (checked at tag `157.0.8090.0`).
- **No npm release exists for the branch Stable ships.** Chrome for Testing
  on 2026-10-31 had Stable 156.0.8078.80, Beta 158, Dev and Canary 159. So
  "pin exactly what Stable's chromedriver embeds" is **not available from
  npm**.
- **Puppeteer runs a newer mapper than Stable.** `puppeteer-core`'s
  `dependencies['chromium-bidi']` is an exact pin, `157.0.8090-0` on
  2026-10-31. Puppeteer runs the mapper in Node (`BidiOverCdp.ts`) against
  the Chrome it ships and tests, so its pin is a tested
  "mapper ↔ recent Chrome" pairing. The mapper source also carries
  explicit compat branches for older Chromium ("In chromium before
  `145.0.7578.0` …"), so supporting a few majors back is by design.

Recommended algorithm (verify, then implement in `update.mjs --status`):

1. `eligible = npm view puppeteer-core@latest dependencies.chromium-bidi`.
   This is deterministic, and it delegates the compatibility judgment to the
   team that already tests the in-Node mapper.
2. Sanity check: `major(eligible) ≤ CfT Stable major + 2`. Otherwise report
   `policy-unresolved`.
3. Set `chromeSupport.minMajor` empirically. Run `tests/mapper-bundle.test.ts`
   against CfT Stable, Stable−1, −2 and −3 (CfT JSON endpoints, already used
   by `src/lib/driverManager.ts`). The oldest passing major goes in the
   manifest. Plan A/B routing falls back to the chromedriver path below it.

**Done when:** the algorithm is confirmed, or replaced with the reason in the
Log. Record a CfT Stable/Stable−N pass/fail matrix for the first pinned
version. Also record whether Chromium's gitiles JSON log is reachable from
CI: from a dev machine it returned `Forbidden` on 2026-10-31 for
`+log/157.0.8080.0..157.0.8090.0/third_party/chromium-bidi?format=JSON`.

### R-M3 Changelog source for the update skill

- GitHub tags stop at `chromium-bidi-v17.0.2`, so a tag compare URL won't
  work for `157.x`+.
- Candidate: list the mirror's commits between the two versions' npm publish
  times, using `npm view chromium-bidi time --json` for both timestamps, then
  `gh api "repos/GoogleChromeLabs/chromium-bidi/commits?since=<t_old>&until=<t_new>&per_page=100"`.
- Verify that this window matches the Chromium range: spot-check two commits
  against `chromium.googlesource.com/chromium/src/+log/<old>..<new>/third_party/chromium-bidi`
  (HTML view).
- **Done when:** `update.mjs` can print the commit list deterministically, or
  the Log says what the skill reads instead.

---

## Phase M3: the update workflow

Goal: updating the mapper is one command when nothing upstream changed shape,
and one skill invocation when something did. Deterministic first; AI only
for judgment.

### M3.1 `scripts/mapper/update.mjs` (deterministic)

- **`--status [--json]`:**
  - Pinned version (manifest).
  - Latest chromium-bidi on npm.
  - The **eligible** version per the R-M2 algorithm (recommended: the
    current `puppeteer-core` pin).
  - Chrome Stable from CfT.
  - The verdict, one of `up-to-date` / `update-available <v>` /
    `pinned-ahead-of-stable` / `policy-unresolved`.
  - Exit 0 when up to date, 10 when an update is available, 1 on error.
- **`--to <version|eligible>`:** each step prints a one-line result, and the
  first failure stops with a distinct exit code.
  1. Resolve the version and fetch its `dist.integrity`
     (`npm view chromium-bidi@<v> dist.integrity`), and mitt's resolved
     version and integrity.
  2. Write the new manifest pins. esbuild only changes when you pass
     `--esbuild <v>`.
  3. Run `build.mjs`. Guard failures → **exit 20**: a new bundled package,
     forbidden module, size budget or missing export.
  4. Compare the API fingerprint with the previous one. Changed → **exit 30**:
     print a unified diff of the normalized upstream signatures and **stop
     before tests**, because the hand-written `.d.ts` and `mapperBundle.ts`
     may need updating.
  5. Run `npx vitest run tests/mapper-bundle.test.ts`. Failure → **exit 40**.
  6. Run the focused hybrid/driverless gates that exist at that time (Plan A
     A2.3/A2.4 tests; Plan B parity tests). Failure → **exit 50**.
  7. Print the report:
     - old → new version;
     - output bytes and delta;
     - module count;
     - bundled packages;
     - licence files changed (yes/no);
     - the upstream commit list between the two versions, per R-M3: one line
       per commit, `[chromium-bidi]` subjects;
     - a ready-to-paste commit body.
  - Exit 0.
- **`--check-only`:** steps 1–4 against a temp copy, with no writes. Used by
  the watch workflow to say "clean update" vs "needs the skill".
- **Done when:** each exit code is tested with a faked step (inject failures
  through env vars in tests, not by breaking real files), and `--status`
  output is covered by a fixture test with mocked npm/CfT responses.

### M3.2 `.claude/skills/mapper-update/SKILL.md` (AI + the script)

Frontmatter description:

> Update the vendored chromium-bidi mapper bundle in craftdriver to a newer
> release. Use when mapper-watch opens an issue, when asked to bump/refresh
> the BiDi mapper, or when a Chrome release breaks the in-process mapper.

Body: the procedure below, kept short and pointing at the script for every
mechanical step.

1. Branch `chore/mapper-<version>`. Never on `main`.
2. `npm run mapper:status`, then `npm run mapper:update -- --to eligible`.
3. **Exit 0:**
   - Read the upstream commit list the script printed (R-M3), and open the
     commits whose subjects look relevant. Look only for changes that touch
     what craftdriver relies on:
     - prompt handling and `unhandledPromptBehavior`;
     - `Browser.setDownloadBehavior` at server start (Plan A R2);
     - `session.new` capability handling;
     - sharedId format (the `f.<frame>.d.<loader>.e.<n>` interop that
       `query.ts` relies on);
     - event names;
     - minimum Chrome version.
   - Summarize the relevant items in the commit body, or write "no relevant
     changes".
   - Commit `chore(mapper): bump bundled chromium-bidi <old> → <new>` with the
     script's report.
4. **Exit 20 (guard):**
   - A new bundled package means read its licence, confirm it's needed at
     runtime (not a parser/type leak), then add it to `bundledPackages`
     deliberately and copy its licence. **Never add zod or devtools-protocol;**
     if upstream now pulls zod into the runtime path, stop and report: that
     needs an owner decision.
   - Size budget: report the delta and the biggest new inputs from the
     metafile; raising the budget is an owner decision.
5. **Exit 30 (API changed):**
   - Read the printed signature diff.
   - Update `chromium-bidi-mapper.d.ts` and `src/lib/bidi/mapperBundle.ts`
     (plus the in-process transport from Plan A A2.3) to the new shape.
   - Rerun `--to` with the same version.
   - Never edit the bundle itself.
6. **Exit 40/50 (behavior):**
   - Reproduce with the single failing test.
   - Bisect across intermediate chromium-bidi releases with `--to <v>`; the
     script makes each step cheap.
   - Find the upstream change, fix craftdriver's usage, and add a regression
     assertion to `tests/mapper-bundle.test.ts`.
   - If upstream is at fault: pin to the last good version, open an upstream
     issue, and note it in the Research log.
7. Open a PR. Its body carries the script report and the changelog summary.

### M3.3 `.github/workflows/mapper-watch.yml` (deterministic notifier)

- Weekly cron, plus `workflow_dispatch`.
- Runs `npm run mapper:status -- --json`, then on `update-available` runs
  `--check-only`.
- Opens or updates a single issue labelled `mapper-update`, titled
  "chromium-bidi <v> eligible (clean | needs mapper-update skill:
  <reason>)", with the status JSON in the body.
- Never pushes code.
- **Done when:** a manual run with a manifest pinned one version back
  produces the issue, and a run at the current version produces nothing.

### M3.4 Keep the other dependency tooling out of the way

- `deps-bump` (`scripts/deps-bump.mjs`) and Dependabot only see
  `package.json`. chromium-bidi, mitt and esbuild live only in the manifest,
  so neither tool touches them. No config change is needed: confirm it, and
  add one line to the `deps-bump` skill saying "the vendored BiDi mapper is
  updated by the `mapper-update` skill, not by this one".

## Risks

| risk | mitigation |
|---|---|
| Upstream security fix lands but users don't get it (no `npm audit` signal for vendored code) | mapper-watch weekly issue; the skill's changelog read; vendoring is called out in NOTICE.md and the README dependency note |
| Someone hand-edits the bundle | `mapper:check` in CI is a byte-for-byte rebuild from integrity-pinned inputs |
| Upstream starts importing zod/devtools-protocol at runtime | Guard (b) fails the build; the skill stops and escalates |
| Deep entry paths move upstream | Build fails at entry resolution (guard d) → the skill's exit-30 path |
| Upstream moved into Chromium; npm releases are Canary snapshots, newer than Stable | R-M2 policy (follow Puppeteer's tested pin) plus the empirical `chromeSupport.minMajor` from CfT Stable−N runs; Plan A/B route older Chrome to chromedriver |
| Builds differ across OSes or esbuild versions | `absWorkingDir`; esbuild pinned in the manifest; the M1.5 macOS-vs-Linux check |
| Apache-2.0 obligations | LICENSE and NOTICE shipped in `dist/` next to the bundle; the header names both licences |

## Research log

(Append findings here: date, task id, evidence, decision.)
