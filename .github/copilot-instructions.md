# Copilot guidelines for craftdriver

Principles for working in this repo. Sources of truth (the API, the file
layout) live in the code itself — read it before assuming.

---

## What this project is

A pragmatic WebDriver automation library for Node.js that picks the
fastest correct protocol — Classic or BiDi — per command, keeping
BiDi-only capabilities (network mocking, log capture, tracing,
multi-context, downloads) available and easy to use.
Vision: **Playwright's ergonomics, WebDriver's standards-compliance, only
the API users actually need.** Minimal surface, powerful internals.

When implementing a feature, use the current code in `src/`, the public
exports in `src/index.ts`, the tests in `tests/`, and the user docs in
`docs/` as the source of truth.

## How to find your way around

Don't take a stale repo map's word for it — these are the only stable rules:

- **Public API:** what `src/index.ts` exports. If it isn't exported there,
  it isn't public.
- **Source:** all library code lives under `src/lib/`. BiDi-specific code
  in `src/lib/bidi/`.
- **Tests:** `tests/*.test.ts`, one file per feature. Conventions in
  `.github/instructions/tests.instructions.md`.
- **Test fixtures:** static HTML pages in `examples/`, served by
  `npm run examples:start` on `127.0.0.1:8080`.
- **User docs:** `docs/*.md`. Each doc page maps to a feature area.
  Only document **shipped** features here.
- **Research / future-work plans:** `research/*.md`. Forward-looking
  proposals, gap analyses, and design notes for unimplemented features
  live here, not in `docs/`. Promote a research note to `docs/` only
  when the feature ships.

When in doubt about the API surface, run `cat src/index.ts` — never
trust documentation that contradicts it.

## Dev workflow

```bash
npm run examples:start   # terminal 1 — keep running before any test
npm test                 # terminal 2
npm run lint
```

The examples server **must be running** before `npm test`. Tests fetch
HTML pages from `127.0.0.1:8080`; without the server you get
`ECONNREFUSED`, not a useful failure.

## Adding a feature — the only checklist that matters

A change is not done until **all** of these are true:

- [ ] Code lives under `src/lib/`; new public symbols re-exported from `src/index.ts`.
- [ ] Tests in `tests/<feature>.test.ts` cover happy path, options, and error paths.
- [ ] If tests need a target page, the HTML fixture exists in `examples/`.
- [ ] User-facing docs in `docs/` updated with a working snippet.
- [ ] `npm run lint` passes with zero errors.
- [ ] `npm test` passes with the examples server running.
- [ ] The commit uses a conventional type (`feat:`, `fix:`, etc.) so
      semantic-release can generate the changelog entry.

## Design principles

These survive refactors. Honour them when adding *or* changing code.

1. **Pragmatic minimalism.** Before adding a public symbol, check whether
   an existing one can be extended. One good concept beats three ad-hoc
   helpers. Don't grow the API just because Playwright has the feature.

2. **Fastest correct protocol per command.** Capabilities Classic can't
   express at all (network, logs, downloads, init scripts, multi-context,
   tracing) belong on BiDi and throw a clear error when it's unavailable.
   For commands Classic *can* do (navigation, load-state waits), pick
   whichever protocol is cheapest for the requested semantics and degrade
   gracefully to Classic instead of throwing when BiDi isn't connected.

3. **Auto-waiting is the default.** Every action and assertion waits up
   to a configurable timeout. Never expose a "non-waiting" variant of a
   user-facing API; that's a footgun.

4. **The user-facing API is the contract.** Internals can be rewritten
   freely. Public methods, options, and exported types must not break
   without a major-version bump.

5. **Errors are signposts.** Every thrown `Error` should say what was
   expected, what was found, and (if useful) how to fix it. No silent
   fallbacks; warn loudly when degrading to a fallback path.

## Working with refactors

- Treat one-line "we always do X" claims with skepticism. Verify against
  the current code (`src/`) before relying on them.
- Update docs and tests as part of the same change. Stale docs are worse
  than missing docs.
- Prefer small, API-preserving refactors unless a breaking change is
  explicitly intended and documented.

## Scoped instructions

More specific rules live in `.github/instructions/*.instructions.md`,
auto-attached by VS Code when you edit matching files:

- `tests/**` → test conventions and the testing philosophy.
- `examples/**` → fixture HTML conventions.
- `src/**` → source-code conventions.

Read the scoped file when working in that area. Don't duplicate its
content here.

## Self-verification before reporting done

Before saying a task is complete:

1. `npm run lint` — must exit 0.
2. `npm test` with the examples server running — must exit 0.
3. Re-read the changed docs/tests/API surface and confirm they still match.
4. List the exact files changed in the response.

If any step fails, fix it. Don't mark the task complete on green CI alone.
