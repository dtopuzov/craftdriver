---
name: mapper-update
description: >
  Update the vendored chromium-bidi mapper bundle in craftdriver
  (src/lib/bidi/vendor/) to a newer release. Use when the mapper-watch workflow
  opens an issue, when asked to bump/refresh the BiDi mapper, or when a Chrome
  release breaks the in-process mapper (hybrid Chrome launch).
---

# Updating the vendored chromium-bidi mapper

The bundle is generated from integrity-pinned inputs and checked byte-for-byte
in CI (`npm run mapper:check`). **Never edit `chromium-bidi-mapper.js`,
`chromium-bidi-mapper.api.txt`, the manifest or the `LICENSE.*` files by
hand.** Every mechanical step is in `scripts/mapper/update.mjs`; this skill is
only for the steps that need judgment. Load `craftdriver-engineering` too.

Background: the mapper source lives in Chromium (`third_party/chromium-bidi`);
`GoogleChromeLabs/chromium-bidi` is a mirror. npm releases are Canary-branch
snapshots (`<major>.0.<build>-<n>`). "Eligible" means the exact version the
latest `puppeteer-core` pins, which Puppeteer tests against the Chrome it ships.

## Procedure

1. Branch `chore/mapper-<version>` off `main`. Never work on `main`.
2. `npm run mapper:status` — read the verdict:
   - `up-to-date`: stop, nothing to do.
   - `update-available <v>`: continue.
   - `policy-unresolved`: the eligible version is >2 majors ahead of Chrome
     Stable, or a lookup failed. Report it to the owner; don't pick a
     version yourself.
3. `npm run mapper:update -- --to eligible` (or `--to <version>`). It needs
   network and Chrome; it starts the examples server itself if :8080 is free.
4. Act on the exit code:

| exit | meaning                              | what to do                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | built, gates green                   | Read the "Upstream commits" list. Open commits whose subjects touch what craftdriver relies on: prompt handling / `unhandledPromptBehavior`, `session.new` capabilities, download behaviour (`Browser.setDownloadBehavior` at start), sharedId format (`f.<frame>.d.<loader>.e.<n>`), event names, minimum Chrome version. Summarize the relevant ones (or "none relevant") in the commit body. Commit with the script's suggested message. |
| 20   | build guard                          | A new bundled package: read its licence, confirm it is runtime code (not a parser/type leak), then add it to `bundledPackages` and rerun. **Never accept zod or devtools-protocol**: if upstream now needs them at runtime, stop and escalate to the owner. Size budget: report the delta and the biggest inputs; raising the budget is the owner's call.                                                                                   |
| 30   | upstream API changed                 | Read the printed signature diff. Update `src/lib/bidi/vendor/chromium-bidi-mapper.d.ts` and the worker bootstrap (`WORKER_SOURCE`) in `src/lib/bidi/inProcessMapper.ts`. Then rerun with `--accept-api-change`.                                                                                                                                                                                                                           |
| 40   | `tests/mapper-bundle.test.ts` failed | Reproduce with `npx vitest run tests/mapper-bundle.test.ts`. Bisect across intermediate npm releases with `--to <v>` (each run is cheap). Find the upstream change, fix craftdriver's usage, and add a regression assertion to `tests/mapper-bundle.test.ts`. If upstream is wrong: pin the last good version and note it in the PR.                                                                                                        |
| 50   | hybrid gates failed                  | Same as 40 with `tests/hybrid-launch.test.ts` / `tests/chrome-launcher.test.ts`.                                                                                                                                                                                                                                                                                                                                                            |
| 1    | error                                | Read the message (network, bad version) and retry or report.                                                                                                                                                                                                                                                                                                                                                                                |

After a 40/50 the vendor dir holds the new bundle; `git checkout
   src/lib/bidi/vendor` restores the old one. 5. If the oldest Chrome the mapper supports changed (upstream raised its
minimum, or a test against an older Chrome fails), update
`chromeSupport.minMajor` in the manifest **and** rerun
`npm run mapper:build` so the manifest stays generated output. 6. `npm run mapper:check`, then open a PR whose body carries the script's
report and your upstream-changes summary.

## Never

- Edit generated files, or run the build with a different esbuild than the
  manifest pins without `--esbuild <v>`.
- Add chromium-bidi, zod, devtools-protocol, mitt or esbuild to
  `package.json`. The toolchain lives in a temp dir on purpose.
