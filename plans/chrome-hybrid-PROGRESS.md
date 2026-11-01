# Progress: bundled mapper + hybrid Chrome launch (lazy attach)

Single source of truth for where the implementation stands. Update it in the
same commit as the work it describes.

- **Branch:** `feat/chrome-hybrid-launch` (off `plans/chrome-mapper-in-node`, local).
- **Plans:** [chrome-mapper-bundle.md](chrome-mapper-bundle.md) (Plan M),
  [chrome-hybrid-launch.md](chrome-hybrid-launch.md) (Plan A).
- **Owner decisions (2026-11-01):**
  - Skip all measurement gates. Plan A G0/A1.1 and Plan M M2.2 are **not done
    by decision**, not pending. Don't add perf claims to docs/CHANGELOG
    without numbers (engineering skill); describe behaviour only.
  - Build the bundle (Plan M), then ship hybrid **with lazy attach** (A3.3
    is in scope, not optional).

## How to resume

1. `git checkout feat/chrome-hybrid-launch && git log --oneline main..`
2. Find the first unchecked box below; read its "Notes" line.
3. Load the `craftdriver-engineering` skill before touching `src/`.

## Status

Legend: `[x]` done, `[ ]` todo, `[~]` in progress, `[-]` skipped by decision.

### Plan M: bundle

- [x] M1.1 `scripts/mapper/lib.mjs` temp toolchain
- [x] M1.2 `scripts/mapper/build.mjs` + guards + `--check`
- [x] M1.3 `.d.ts` + `src/lib/bidi/mapperBundle.ts`
- [x] M1.4 ship in `dist/` (postbuild copy, `.prettierignore`)
- [x] M1.5 `mapper:check` in CI
- [x] M1.6 first import commit
- [x] M2.1 `tests/mapper-bundle.test.ts`
- [-] M2.2 re-measure cold (owner: no measuring)
- [ ] R-M1 no-op parser error parity
- [ ] R-M2 version policy / `chromeSupport.minMajor`
- [ ] R-M3 changelog source
- [ ] M3.1 `scripts/mapper/update.mjs`
- [ ] M3.2 `mapper-update` skill
- [ ] M3.3 `mapper-watch.yml`
- [ ] M3.4 deps-bump note

### Plan A: hybrid + lazy attach

- [-] A1.1 CI measurement / G0 (owner: no measuring)
- [ ] A1.2 R1 attach semantics
- [ ] A1.3 R2 downloads
- [ ] A1.4 R3 launch-time caps
- [ ] A1.6 R5 lazy attach (design only; no measuring)
- [ ] A1.7 R6 process lifecycle
- [x] A2.1 BiDi transport seam
- [x] A2.2 `ChromeLauncher`
- [x] A2.3 in-process mapper transport
- [ ] A2.4 hybrid launch path + routing + `chromeLaunchMode`
- [ ] A2.5 downloads / emulation / prefs
- [ ] A3.3 lazy attach
- [ ] A3.1 CI matrix leg
- [-] A3.2 perf arm (owner: no measuring)
- [ ] A4.1 docs

## Log

(Newest last. Date, task, what changed, commit, anything the next session
must know.)

- 2026-11-01 M1.1–M1.6: bundle pipeline landed. `npm run mapper:build` /
  `mapper:check` (scripts/mapper/{lib,build,copy-to-dist}.mjs), vendor dir
  `src/lib/bidi/vendor/`, loader `src/lib/bidi/mapperBundle.ts`, unit tests
  `tests/mapper-build.test.ts` (guards a–d, integrity, 1-byte tamper).
  chromium-bidi 157.0.8090-0 (= puppeteer-core@25.16.0 pin), esbuild 0.28.2:
  422,476 bytes, 78 modules, packages chromium-bidi + mitt only.
  Notes: `--ignore-scripts` works for esbuild (M1.1 research answer: its
  binary comes via optionalDependencies). Added `chromium-bidi-mapper.api.txt`
  (normalized upstream .d.ts) so `update.mjs` can diff API changes; the
  fingerprint is its sha256. `.gitattributes` marks the vendor dir `-text`
  so Windows checkouts keep LF. CI runs `mapper:check` on ubuntu + macOS +
  Windows (drop the non-Linux ones once green twice).
  `chromeSupport.minMajor` = 156 (only Chrome verified so far; R-M2 may lower it).

- 2026-11-01 A2.1–A2.3 + M2.1: `src/lib/bidi/transport.ts` (BiDiTransport +
  WebSocketTransport; BiDiConnection.connectTransport, BiDiSession.connect
  accepts a transport), `src/lib/chromeLauncher.ts` (launchChrome, chromedriver
  156's exact switch list, Preferences-file prefs, exit-hook kill, temp profile
  removal), `driverManager.findChromeBinary()`, `src/lib/bidi/inProcessMapper.ts`
  (startInProcessMapper → BiDiTransport; session.new sent internally as id 0).
  Tests: `tests/chrome-launcher.test.ts` (9), `tests/mapper-bundle.test.ts` (6;
  merges M2.1 and A2.3's planned test — it is the update gate). No-regression
  gate for the seam: evaluate/network/logs/dialogs/browser-context/chrome-smoke
  62/62 on the chromedriver path. Flag capture: chromedriver adds NO
  `--window-size` (driver-perf's list had one; the craftdriver constant doesn't).
