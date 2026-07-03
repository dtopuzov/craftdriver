# PERF-06: Phase 5b — rename/simplify `enableBiDi`

## Status: ❌ Not applicable — its precondition (BiDi/Classic launch parity) doesn't hold

This item is predicated on PERF-05 landing and making BiDi effectively free at
launch, so that `enableBiDi` stops being a speed decision (see Description
below). Neither happened:

- PERF-05 was not implemented (its premise was measured wrong — see PERF-05.md).
- BiDi launch is still measurably slower than Classic: **~2235ms vs ~1860ms
  (~375ms / ~17%)**. That gap is `Driver.create()` — chromedriver enabling its
  BiDi mapper during New Session — and is browser-side, not something a client
  library can remove.

So `enableBiDi: false` remains a **genuine performance escape hatch**, not a
vestigial toggle: local automation that only uses Classic-visible operations
(navigate / click / fill / find / assert — none of which need BiDi) can launch
~375ms faster with `enableBiDi: false`. Renaming or de-emphasizing the option
to imply "always attempt BiDi, no tradeoff" would misrepresent that. There is
no parity to justify the change, so the item is moot until/unless parity ever
materializes (it can't without a browser-side change).

The one useful takeaway is the reverse of this item's intent: **document
`enableBiDi: false` as a launch-speed option** for BiDi-free workloads, rather
than simplifying the flag away.

---

_Original plan (premised on a parity that doesn't exist) preserved below._

## Description

Once PERF-05 lands, `enableBiDi` stops needing to be a performance
decision — `Browser.launch()` no longer blocks on the BiDi handshake, so
there's no longer a meaningful speed cost to attempting BiDi by default.
At that point `enableBiDi` becomes purely "can/should this environment
attempt BiDi at all," not a speed/features tradeoff a user opts into.

This file deliberately does not pick a winner between the two options
below — it's a public API decision on a pre-1.0 project comfortable with
breaking changes, but still something the maintainer should decide once
and deliberately, not have decided for them by an agent.

**Option 1 — keep `enableBiDi: boolean` as-is.** Least churn. Just
re-describe it in docs (this session already rewrote the
`LaunchOptions.enableBiDi` doc comment and the `docs/bidi-features.md`
framing to stop implying BiDi is "the primary protocol" — this option
would mean no further doc changes needed once PERF-05 lands, beyond
noting that non-blocking connect is now the default behavior).

**Option 2 — rename to `bidi: 'auto' | 'off'`.** Clearer intent: `'auto'`
= try, degrade gracefully if negotiation fails; `'off'` = the explicit
escape hatch some users will still want for compliance/CI-image reasons.
Breaking rename, but the project is pre-1.0 and has taken breaking changes
before.

**Either way, one contract does not change:** every BiDi-only feature
keeps throwing its existing clear `"... requires BiDi (enableBiDi: true)"`
-style error when negotiation fails or BiDi is disabled. This item only
changes *when/whether the connection attempt itself blocks the caller*
(that's PERF-05's job) and *what the option is called* — not what happens
when a BiDi-only feature is used without BiDi available.

## Implementation

**Sequencing: do not start this until PERF-05 has landed and been
validated** (re-run the benchmarks, confirm the connect-time win is real
in practice) — implementing a naming/semantics change on top of a
still-blocking `enableBiDi` would be premature and likely to need
rework.

If Option 2 (rename) is chosen:

- Update the `LaunchOptions` type and every internal call site that reads
  `options.enableBiDi`.
- Update every BiDi-only-feature error message's `(enableBiDi: true)` hint
  text to match the new option name/values.
- Update `docs/bidi-features.md` and `README.md` to describe BiDi as an
  always-attempted, transparently-used capability rather than a mode users
  opt into for a speed/features tradeoff — this session already moved both
  docs partway there (removed "BiDi is the primary protocol" framing) but
  they'd need a further pass once the option itself changes shape.
- Check `craftdriver-demos` (the external consumer repo used for
  real-app benchmarking, see `PERF-03`) for any place it passes
  `enableBiDi` explicitly — that's a concrete example of what breaks for
  real consumers, worth checking even though it's not this repo.
- Add a `BREAKING CHANGE:` footer in the commit message per
  `CONTRIBUTING.md`'s conventional-commit rules, so semantic-release
  version-bumps correctly.

If Option 1 (keep as-is) is chosen: this is just a docs pass, no code
changes — update `docs/bidi-features.md`/`README.md` to reflect
non-blocking connect once PERF-05 ships, nothing else.

## Verification

- Type-check + lint clean.
- Full `tests/*.test.ts` suite green — if renamed, every test currently
  passing `enableBiDi: true/false` needs updating, so this is a good forcing
  function to confirm nothing was missed (a leftover `enableBiDi` usage
  would be a type error, not a silent bug).
- If renamed, manually check (or grep) `craftdriver-demos`'s test files for
  `enableBiDi` usage to understand real-world breakage shape before
  publishing.

## Risks

Low code risk in either direction — this is a small, mechanical change
regardless of which option is picked. The actual risk is **making the
naming decision without the maintainer's explicit sign-off**, since it's a
breaking public API surface change with external consumers. Present both
options, get a decision, then implement — don't default to one.
