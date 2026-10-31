---
name: deps-bump
description: >
  Bump every craftdriver dependency to its latest official release, rebuild the
  lockfile from scratch, and clear `npm audit` findings with overrides only
  where needed. Load when asked to update/bump/refresh dependencies, fix
  `npm audit` findings, replace a pile of dependabot PRs with one manual bump,
  or revisit `overrides` in package.json.
---

# Dependency bump

The mechanical work is in `scripts/deps-bump.mjs` (`npm run deps:bump`). Run it,
read its report, and make only the decisions it hands back. Don't call
`npm view` per package or read `npm audit` output yourself. The script already
does that and prints a compact summary.

## Process

1. **Branch.** Never on `main`.
2. **Bump:** `node scripts/deps-bump.mjs`
   - Removes `overrides` and prints the old ones for reference.
   - Moves every direct dependency to its `latest` dist-tag, never a
     prerelease, and keeps the `^`/`~`/exact prefix.
   - Caps a version that would break another direct dependency's peer range
     and prints why: `[held below X: owner needs pkg@"range"]`.
   - Deletes `package-lock.json` and `node_modules`, then runs `npm install`
     and `npm audit fix`.
   - Classifies what `npm audit` still reports.
   - Exit codes: 0 clean, 1 findings remain, 2 install failed.
   - `--dry-run` shows the plan without changing anything.
3. **If findings remain**, handle each one the way its verdict line says:
   - `override: {...}`: a safe release exists in the installed line. Run
     `node scripts/deps-bump.mjs --apply-overrides` to write all of these,
     reinstall and re-audit.
   - `no safe release in line N … Required by: …`: only a newer major is
     fixed, so you decide. Prefer, in order:
     1. A scoped override under the one parent that needs it, when that parent
        is the only consumer (e.g. `"vitepress": { "vite": "^7.3.7" }`).
     2. A global override to the newest safe release
        (e.g. `"minimatch": "^11.0.3"`).

     Edit `overrides` in package.json by hand, then run
     `rm -rf node_modules package-lock.json && npm i` and
     `node scripts/deps-bump.mjs --audit-only`.

   - `bundled in the npm CLI`: leave it. These live in
     `node_modules/npm/node_modules/` (pulled in by semantic-release), and
     `overrides` cannot reach them. They clear when npm ships a fix.

   **Never** run `npm audit fix --force`. It "fixes" by downgrading majors
   (rimraf 4, semantic-release 21).

4. **Verify** every override that crosses a major. A major bump can break the
   package that requires it:
   - `node scripts/deps-bump.mjs --verify` runs lint, build and docs:check.
     It covers the release toolchain, eslint, rimraf (`prebuild`) and vitepress.
   - After a minimatch/glob override, confirm eslint still lints the same files:
     `npx eslint . --ext .ts -f json | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).length)'`.
     Run it before and after; the count must match.
   - Runtime deps changed? Serve the examples (`npm run serve &`) and run the
     focused gate. Don't run the full suite:
     - `ws`: `BROWSER_NAME=chrome HEADLESS=true npx vitest run tests/chrome-smoke.test.ts`
     - `axe-core`: `… tests/a11y.test.ts`
     - `pngjs` / `yazl`: the tests that import them (`grep -l` in `tests/`)
   - `npm run audit` (production deps only) **must** be 0. A full `npm audit`
     may still list the bundled-in-npm findings.
5. **Keep reasons current.** Every held version and every override needs a
   written reason:
   - A peer cap on `typescript` → update the `ignore` comment in
     `.github/dependabot.yml` with the parser version that still caps it.
   - An override → explain it in the commit message.
6. **Commit** as `chore(deps): …`. In the body include:
   - an `old -> new` table of the direct deps that moved;
   - every held version and the peer range that holds it;
   - every override with the advisory it clears and why that version is
     compatible (how you verified it);
   - what is left unfixed (bundled-in-npm findings) and why;
   - which gates passed.

   See commit `987cf15` for the format.

## Known standing decisions

- **typescript** is held at 6.0.x while `@typescript-eslint/parser` caps its
  peer at `<6.1.0`. The script detects this automatically. Re-check each run;
  the cap disappears the day the parser widens its range.
- **vitepress → vite** must stay on 7.x. vitepress 1.6.4 calls
  `transformWithEsbuild`, which vite 8 dropped, and `docs:build` dies
  rendering pages. Re-check when vitepress 2 goes stable.
