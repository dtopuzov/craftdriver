# Engineering infrastructure backlog

Discrete, not-yet-done tasks extracted from the old engineering-roadmap. The
durable *principles* now live in the `craftdriver-engineering` skill
(`.claude/skills/craftdriver-engineering/`); this file is only the actionable
work. **Check items off as they land; delete this file when all are done.**

Current CI baseline (`.github/workflows/ci.yml`): lint → build → `npm test`
(chrome) → `npm run test:firefox`. No bench, API-diff, audit, soak, or scheduled
jobs yet. `release.yml`: build → semantic-release.

## Measurement / regression

- [ ] **Per-scenario bench budgets + CI gate.** Give each `npm run bench`
  scenario an absolute-ms or ratio budget (extend `PERF_BUDGET_RATIO`); run the
  bench in CI on PRs touching `src/`; a red budget blocks merge like a failing
  test. Tighten budgets as numbers improve.
- [ ] **Trend tracking.** Commit bench results JSON per run so a slow
  ~5%/month drift is visible, not just single-commit cliffs.
- [ ] **Competitive tier scheduling.** `craftdriver-perf` repo already exists
  (fixtures + harness, first baseline captured). Remaining: weekly + pre-release
  runs, and file issues (with numbers) from losing scenarios.

## Correctness infrastructure

- [ ] **Nightly soak job.** Run the full suite N times in a loop; races surface
  in repetition, not single runs.
- [ ] **Beta/dev-channel browser job (scheduled).** chrome/firefox beta + dev on
  a cron, so BiDi breakage between releases is caught before users hit it.
- [ ] **Flake quarantine process.** Quarantine list + tracking issue + triage
  cadence. CI currently has no retries — keep it that way (enforcement, not a
  new feature).

## API / docs

- [ ] **Public-API snapshot diff in CI.** Tooling exists (`npm run docs:api:check`
  via `scripts/gen-api-reference.mjs`); just add a CI step so any public-surface
  change fails the build unless the reference is regenerated.
- [ ] **Docs-snippet executable test suite.** Extract code blocks from `docs/`
  and compile+run them against `examples/` pages.
- [ ] **Migration guides.** `docs/`: "coming from selenium-webdriver" and
  "coming from webdriverio" — highest-conversion pages for a challenger library.

## Release discipline

- [ ] **Realapp canary as a release gate.** Run `npm run bench:realapp` + the
  functional suite against the real app before publish.
- [ ] **Changelog perf section + prepublish gate.** Add a "performance (with
  numbers)" section to each release; extend `prepublishOnly` (currently build +
  lint) with full-matrix-green + regression-bench-within-budgets.

## Suggested order

1. Bench budgets + CI gate → 2. Public-API diff in CI (cheap, tooling exists) →
3. Flake quarantine + nightly soak → 4. Competitive scheduling + beta-channel →
5. Docs-snippet tests + migration guides → 6. Release gate + changelog section →
7. Trend tracking; iterate.
