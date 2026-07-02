---
applyTo: "src/**"
---

# Source code conventions

The shape of the code (what classes exist, how they relate) lives in the
code itself. Read `src/index.ts` and the relevant files before assuming.
What follows are the principles that should hold across refactors.

## Public API

- The public surface is exactly what `src/index.ts` re-exports. Tests and
  user code must not import from `src/lib/*` directly.
- New public types must be fully typed. No `any` on public method
  signatures, parameters, or return types. Internal `any` is acceptable
  with a comment explaining why.
- Don't break callers. New parameters on existing public methods must be
  optional. Renames or removals are major-version changes.
- Before adding a new exported symbol, check whether an existing one can
  be extended. Minimalism is a feature.

## Fastest correct protocol per command

- Capabilities Classic cannot express at all (network mocking/interception,
  console/error log capture, downloads, init scripts, multi-context,
  tracing, `waitForRequest`/`waitForResponse`) belong on BiDi and must throw
  a clear `requires BiDi (enableBiDi: true)` error when BiDi isn't
  connected — don't silently no-op.
- For capabilities Classic *can* express (navigation, load-state waiting,
  element actions), pick whichever protocol is cheapest for the requested
  semantics — the default case usually prefers Classic — and degrade
  gracefully to a Classic-based approximation (e.g. polling
  `document.readyState`) instead of throwing when BiDi is unavailable.
  Reserve the BiDi path for semantics Classic genuinely can't express
  precisely (e.g. `waitUntil: 'networkidle'`). Fall back behind the same
  public method; don't expose two variants.
- Do not add Chrome DevTools Protocol (CDP) calls. We track W3C
  standards (BiDi + Classic) only.

## Auto-waiting and timeouts

- Every action and assertion auto-waits up to a timeout. Never expose a
  non-waiting variant of a user-facing API.
- Timeouts are configurable per-call (`{ timeout }`) and at the
  browser level. The browser-level default must be readable through a
  single mechanism — never duplicate or hardcode the fallback. If you
  find yourself writing a magic number for a default, lift it.
- Per-call options always win over the browser default.

## Errors

Every thrown `Error` should answer: what was expected, what was found,
and (if useful) how to fix it.

```typescript
// ✅
throw new Error(
  `select() can only be used on <select> elements. Found <${tagName}>.`
);

// ❌
throw new Error('Wrong element type');
```

No silent fallbacks. Warn loudly when degrading to a fallback path.

## TypeScript

- `strict` is on. No implicit `any`.
- Caught errors are `unknown`; narrow before use.
- Prefer `private` over `#` for class fields (cleaner stack traces, works
  with the existing codebase style).

## Single responsibility

Each file under `src/lib/` should do one thing well. When you find a
file growing a second responsibility (a `Driver` that knows about
locators, an `expect` that resolves elements itself), split it instead of
piling on. Refactoring the internal layout is encouraged when it
clarifies responsibilities — the public API is what's stable, not the
file tree.

