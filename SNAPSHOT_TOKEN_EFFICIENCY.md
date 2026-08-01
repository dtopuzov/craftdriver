# AI token efficiency — final merged plan

Supersedes `AI_TOKEN_EFFICIENCY_FINAL_PLAN.md` and the earlier draft of this
file. Merges two independent reviews of the same Copilot benchmark of
CraftDriver `f63a825`. Every number below is measured, either from the retained
command traces or by re-running against the live site.

Status: P0-P5 were implemented, validated, and benchmarked. A later
Codex/Luna-low benchmark exposed two additional cheap-model failure modes; the
post-implementation follow-up below records the evidence and the resulting
P6-P8 changes. Where that follow-up conflicts with an earlier rejected item, the
follow-up is the final decision.

## Decision

Keep `f63a825`. Do not reduce snapshot node coverage. The initial exploration
snapshot is at its safe limit; the remaining wins are in the workflow that
follows it.

Ship in this order. There is **one** multi-agent benchmark, run against the
final commit — not one after P1 and another at the end:

| #   | Item                                                         | Kind           |                 Measured value |
| --- | ------------------------------------------------------------ | -------------- | -----------------------------: |
| P0  | Navigation fence for observed submits                        | code, blocker  |                    correctness |
| P1  | `fill --submit` + skill/doc rewrite                          | code + docs    |  **17,520 B → 5,737 B (-67%)** |
| —   | **Local deterministic validation** — cheap, confirms the 67% |                |                                |
| P2  | Viewport screenshot via BiDi                                 | code           |                    correctness |
| P3  | `MAX_HREF` bound                                             | code           |                ~2% (hardening) |
| P4  | Benchmark harness failure accounting                         | tooling        | **must precede the benchmark** |
| P5  | Skip empty `[aria-live]` nodes                               | code, optional |        ~91 B, consistency only |
| —   | Full test suite, then **one** multi-agent benchmark          |                |                                |

An earlier draft put the expensive benchmark after P1 and P4 last. Both were
wrong. The 67% is measurable locally and deterministically — it does not need a
credit-burning multi-agent run to confirm — and a benchmark taken before P2/P3
is stale the moment they land. P4 cannot come last, because a harness that
miscounts failures cannot validate the "zero failed commands" criterion the
benchmark exists to check.

Rejected in the P0-P5 review: auto-attaching snapshots to `STALE_REF`,
query-string removal, node removal, label/decorative suppression, task-aware
snapshots, reordering, abbreviated roles, and removal of `(container)` markers.
The later P8 decision supersedes only the stale-ref recovery-context rejection;
the other rejections stand.

## Post-implementation benchmark follow-up — P6-P8

The first post-P0-P5 benchmark confirmed that atomic submission and navigation
fencing removed the Wikipedia recovery snapshots and fixed viewport captures.
An exact three-run Codex/Luna-low comparison then exposed a separate
copy-paste issue: inexpensive models often used the snapshot spelling `e9`
directly, matching Playwright's CLI convention, while CraftDriver treated it as
CSS and paid a full selector timeout.

That evidence justified three follow-up changes:

| #   | Item                              | Final behaviour                                                                                                                                                                                             |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6  | Safe bare-ref compatibility       | A previously issued live `eN` aliases `ref=eN`; unknown bare ref-shaped tokens fail immediately with `BARE_REF`; `css=eN` preserves literal CSS.                                                            |
| P7  | Conventional multi-field guidance | The main skill shows earlier fields filled normally and the final single-line field submitted with `fill --submit --observe=delta`, with explicit exclusions for textareas, wizards, and secondary actions. |
| P8  | Bounded recovery context          | `STALE_REF` or `NO_MATCH` on a previously issued ref may include a fresh recovery snapshot capped at 12 KiB. The failed action is never retried.                                                            |

P8 is deliberately narrower than the earlier rejected idea. It applies only to
a ref the session actually issued, is independently bounded, advances the ref
tracker so returned refs are usable, and does not guess or act on a replacement.
If a dialog, browser state, or snapshot failure prevents safe recovery, the
original error is returned unchanged.

The exact Codex/Luna-low re-run completed 6/6 CraftDriver and 6/6 Playwright
runs correctly. CraftDriver's scenario-weighted wall time fell from 61.46 s to
42.13 s (-31.5%), CLI calls from 7.5 to 5.5 (-26.7%), and browser-command time
from 24.28 s to 15.65 s (-35.5%). All six CraftDriver command transcripts had
zero failed invocations; one GitHub run exercised bare `e7`/`e9` successfully,
and all three used final-field atomic submission.

## Where the code lives

Load the `craftdriver-engineering` skill first — it carries this project's
evidence discipline, API-review checklist and flake policy, all of which apply
to every item below.

| Item | Entry points                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | `src/cli/agentSession.ts` (`runDetailed`, the post-action snapshot block); `src/lib/browser.ts` (BiDi session/connection, `setViewportSize` shows the send pattern)                                                        |
| P1   | `src/cli/parseArgs.ts` (`COMMAND_SYNTAX`, `KNOWN_FLAGS`, `OPTION_FLAG`); `src/cli/dispatcher.ts` (`case 'fill'`); `src/cli/mcp/tools.ts` (`browser_fill`); `skills/craftdriver/SKILL.md`; `skills/craftdriver/workflow.md` |
| P2   | `src/lib/browser.ts` (`screenshot()` — the default viewport branch calls Classic `driver.screenshotBase64()`; the `fullPage` branch already shows the BiDi call)                                                           |
| P3   | `src/cli/snapshot.ts` (`MAX_NAME` and friends at the top; the `href` annotation is built in `emit`)                                                                                                                        |
| P4   | the `browser-llm-perf` repo, not this one                                                                                                                                                                                  |

Gates: `npm run test:cli` for browser CLI/MCP behaviour, `npx vitest run` for the
full suite, plus `tsc --noEmit` and `npm run lint`.

## Evidence

The retained Copilot Wikipedia run produced ~17.5 KB of browser text:

```text
5,343 B  initial `go --observe=delta`
  329 B  fill, then click a sibling ref the fill had invalidated -> STALE_REF
6,097 B  recovery `snapshot --pretty`
5,513 B  full post-navigation delta, to learn a heading and a canonical URL
  238 B  screenshot and shutdown
```

Filling Wikipedia's searchbox replaces the surrounding autocomplete form, so
`e8`/`e9`/`e10` become `e84`/`e85`/`e86`. The agent followed CraftDriver's own
guidance — `workflow.md` says "do not snapshot after a fill when the next
observed ref is still live" — clicked the old button ref, and paid a model turn
plus 6,097 B to recover.

The target workflow, measured against the same live page:

```text
5,291 B  go Main_Page --observe=delta
   53 B  fill ref=e9 Telerik
  211 B  press Enter --observe=page
   68 B  text h1
  114 B  attr 'link[rel="canonical"]' href
---------
5,737 B  total before screenshot
```

67% less browser text with nothing removed from the exploration snapshot.

## P0 — navigation fence (blocker)

`press Enter --observe=page` does not reliably report the page it navigated to.
Three consecutive live runs:

```text
url=https://en.wikipedia.org/wiki/Telerik     documentChange=changed
url=https://en.wikipedia.org/wiki/Telerik     documentChange=changed
url=https://en.wikipedia.org/wiki/Main_Page   documentChange=same      <- stale
```

In another run `--observe=page` reported `Main_Page` while the next command
(`text h1`) returned `Telerik`, so the navigation happened and the observation
raced it.

**A `readyState` re-probe does not fix this.** An earlier draft of this document
proposed one. It is wrong: when the key is dispatched the _old_ document is
already `complete`, so a re-probe returns immediately and snapshots the page
being navigated away from. The check must be navigation-aware, not
load-state-aware.

Required behaviour for Enter/submit actions that request an observation:

1. Arm navigation detection **before** dispatching the key.
2. Dispatch the action.
3. Wait for navigation to start, or for a bounded detection window to expire.
4. If navigation started, wait for the destination load before observing.
5. If it did not, return the same-document observation promptly — validation
   errors and autocomplete flows legitimately stay put.

**BiDi path.** Subscribe to `browsingContext.navigationStarted` and
`browsingContext.load` for the active top-level context before dispatch, so a
fast navigation cannot emit `load` before the listener exists. Remove both
listeners on every success, no-navigation, error and timeout path.

Correlate on the **navigation id**, not just the context. Both events carry
`navigation`; capture the id from `navigationStarted` and release the fence only
on the `load` bearing that id. Context alone would let a late `load` from a
previous navigation in the same context release the fence early.

One caveat for the implementer: server-side redirects keep the same navigation
id, but a client-side redirect (`location.href`, meta refresh) begins a _new_
navigation with a new id. Strict matching on the original id would then wait out
the ceiling. Treat a later `navigationStarted` in the same context as
superseding — re-arm on the new id — and keep the bounded ceiling as the
backstop.

**Classic fallback.** Capture pre-action URL and document identity, then poll
for the detection window. A URL or document-identity change is the navigation
signal; never treat the old document's `readyState` as completion.

**Window.** Deterministic, no longer than 500 ms, tuned down with a local
delayed-submit fixture. Note this is a real latency cost on submits that do
_not_ navigate, which is why the acceptance criteria below bound that path
separately.

**Scope.** `press Enter` with an observation, and `fill --submit`. Do not delay
ordinary `fill`, typing, or unobserved actions.

## P1 — atomic submit and guidance rewrite

### CLI

```bash
craftdriver fill TARGET VALUE --submit [--observe=page|delta]
```

Resolve and fill `TARGET` once, press Enter through the focused element without
re-resolving the ref, then apply the P0 fence before observing. `fill` without
`--submit` is unchanged.

This is deliberately a mechanism rather than a documentation rule. An agent
followed our documentation into the `STALE_REF` this plan exists to remove, and
the earlier multi-agent report showed Codex following the skill closely while
Claude Haiku did not. Prefer a mechanism wherever both can work.

**Composite action flags stop here.** No `--then-click`, no `--and-wait`. If a
second composite is ever proposed, that is the signal to design a batch command
instead of growing flags.

### MCP

Optional `submit: boolean` on `browser_fill`, same semantics, sharing the CLI
dispatcher path so the two cannot drift.

### Skills and documentation

Replace existing guidance in `skills/craftdriver/SKILL.md` and
`skills/craftdriver/workflow.md` rather than adding to it:

- For searchboxes and single-field forms, prefer `fill TARGET VALUE --submit`
  over filling and clicking a sibling submit ref.
- A reactive `fill` can replace neighbouring controls. When a separate sibling
  action is genuinely needed, use `fill --observe=delta` and act on the fresh
  ref. This replaces the current line that caused the observed failure.
- After a predictable navigation, use `--observe=page` plus targeted `text`,
  `attr` or `value` reads when the required evidence is already known.
- Use `--observe=delta` when the next action depends on discovering what changed.

## P2 — viewport screenshot via BiDi

Measured on one run, headless Chrome, `devicePixelRatio = 1`, layout viewport
set to 1280×800, on a page tall enough to scroll:

```text
Classic viewport screenshot   (driver.screenshotBase64)     756 x  413
BiDi origin: 'document'       (today's --full-page path)   1265 x 4336
BiDi origin: 'viewport'       (the proposed fix)           1265 x  800
```

Each origin is doing exactly what it should: `document` captures the full
scroll height, `viewport` captures the visible area, and Classic captures the
OS window. The 1265 rather than 1280 is the 15 px classic scrollbar — that is
the real visible content width, and the acceptance criteria account for it.

**This is not a device-pixel-ratio artefact.** DPR is 1, and the BiDi path
returns the correct dimensions on the same machine and the same run. The
default viewport branch of `Browser.screenshot` uses
`this.driver.screenshotBase64()` — Classic WebDriver, which captures the OS
window (756×556 less browser chrome). `setViewportSize` overrides only the
layout viewport via BiDi, so the two disagree.

Use `browsingContext.captureScreenshot` with `origin: 'viewport'` when BiDi is
connected; keep Classic as the fallback. Apply it in the shared browser API so
CLI and MCP inherit it. Element and full-page paths are unchanged.

Agent-visible consequence today: every screenshot taken as visual evidence is
cropped to 59% of the width the agent is reasoning about.

## P3 — bound `href` (hardening, not optimisation)

`href` is the only snapshot annotation with no length cap; `MAX_NAME` bounds
names and values at 80.

Measured over all 143 `href` values in the run (5,009 B of values in 15,530 B of
snapshot text):

|    cap | links trimmed | bytes saved | % of snapshot text |
| -----: | ------------: | ----------: | -----------------: |
|     40 |            36 |       1,098 |               7.1% |
|     60 |            19 |         611 |               3.9% |
| **80** |         **9** |     **324** |           **2.1%** |
|    120 |             4 |          56 |               0.4% |

Use **80**, matching `MAX_NAME`. A cap of 120 trims four links and saves 56 B —
it does not earn its test surface. A cap of 40 truncates a quarter of all links
and starts destroying path information.

Keep the line, accessible name, ref and locator hint unchanged, including for
nameless links. The full value remains available via `attr TARGET href`.

**Do not collapse query strings.** An earlier draft proposed this for an 11.2%
saving. Query values distinguish pagination, search terms, filters, downloads,
auth modes and SPA destinations; the saving does not justify destroying them,
and per-site tracking-parameter rules are worse.

Label this as output-bound hardening. The measured saving lives in P0/P1.

## P4 — fix benchmark failure accounting

The `f63a825` report states "There were no CraftDriver browser errors in either
new scenario." That is false. Both retained Wikipedia runs contain a
`STALE_REF` with `"ok": false` and shell exit code 1:

```text
001-copilot-craftdriver: 5 commands, 1 with "ok":false  -> STALE_REF ref=e10
002-copilot-craftdriver: 5 commands, 1 with "ok":false  -> STALE_REF ref=e10
```

The same report criticises the harness for missing _Playwright's_ failures
inside composite shells. The blind spot is symmetric and hid CraftDriver's own
failures too.

Fix in `browser-llm-perf` before any comparison that cites failed commands:
recognise structured `{"ok": false}` responses and non-zero completion codes
embedded in shell events, and report agent tool turns separately from individual
CLI invocations — the optimised workflow groups several reads into one turn.

## P5 — one trivial consistency fix (optional, marginal)

**Skip an element that matches only `[aria-live]` and has no accessible name.**
GitHub's login page emits two:

```text
e21: div #js-global-screen-reader-notice
e22: div #js-global-screen-reader-notice-assertive
```

Empty announcement targets carrying no information. The `contentOnly` path
already drops empty `<output>`/`<p>` for exactly this reason; `[aria-live]`
divs take the semantic path and miss the rule. Populated regions still appear
as added lines in the next delta, which is the behaviour we want.

Worth **91 B** on the one page measured where it applies, and 0 elsewhere. This
is a consistency fix, not an optimisation. Do it if the file is open for P3;
skip it otherwise.

### Rejected: suppressing labels that duplicate their control

An earlier revision proposed suppressing `label` lines whose name matches the
adjacent control:

```text
e6: label "Username or email address"
e7: textbox "Username or email address" #login_field
```

Dropped for two reasons, the second decisive.

**It destroys a real signal.** The label _line_ is what tells an agent a genuine
`<label>` element exists, and therefore that `By.labelText` is an available
strategy. An accessible name can equally come from `aria-label`,
`aria-labelledby`, `placeholder` or `title`, none of which support
`label=`. After suppression the agent cannot distinguish "labelled, line
hidden" from "not labelled". `craftdriver locators ref=eN` does recover it —
verified, it returns `label=Username` as a validated candidate alongside
`#username` and `role=textbox[name=Username]` — but that is a recovery, not a
reason the signal was free to discard.

**The saving is largest exactly where the payload is already smallest.**

| page                        | snapshot | label saving |
| --------------------------- | -------: | -----------: |
| wikipedia Main_Page         |  4,754 B |      **0 B** |
| github.com/login            |  1,290 B |         66 B |
| examples/login.html         |    207 B |         45 B |
| examples/selectors.html     |  1,041 B |         52 B |
| examples/agent-actions.html |    390 B |         60 B |

The 21.7% headline on `login.html` is 45 bytes. Content-heavy pages — the ones
that actually cost tokens — save nothing, because their labels are not adjacent
to their controls. Against P0+P1's measured 11,783 B on the Wikipedia scenario,
this is roughly 0.3%. Trading an accessibility signal for 45 bytes is a bad
trade at any risk level.

## Explicit non-goals

- Automatically retrying a failed `STALE_REF`/`NO_MATCH` action or selecting a
  replacement on the agent's behalf. P8 returns bounded context only.
- Query-string removal, node removal, label or decorative suppression.
- Lower semantic-node or text-evidence budgets.
- Task-aware or region-guessing snapshots; reordering that breaks hierarchy.
- Abbreviated role names or a compressed grammar — models read `textbox`
  fluently, and `snapshotLineInfo` in `src/cli/dispatcher.ts` parses these
  lines to produce `NOT_EDITABLE`.
- Removing `(container)` markers or indentation. That ~6% bought the Wikipedia
  fix: 46% fewer browser calls and 40% fewer output tokens versus `b64a8cf`.

## Test plan

A deterministic local reactive-search fixture that replaces its input and submit
control after `fill`, navigates on Enter after a controllable delay, can instead
stay put with a validation message, and exposes a known heading and canonical
URL on the destination.

1. `press Enter --observe=page` reports the destination in 10/10 runs.
2. `fill --submit --observe=page` reports the destination in 10/10 runs.
3. A no-navigation validation result returns promptly and reports the same
   document.
4. A reactive rerender produces no `STALE_REF` for atomic submit.
5. `fill` without `--submit` is unchanged.
6. CLI and MCP submit behaviour match.
7. Dialog-open paths stay bounded and attempt no blocking snapshot.
8. A viewport screenshot matches `clientWidth`/`clientHeight` × DPR, covering
   both a scrolling and a non-scrolling page.
9. A query-heavy `href` is truncated with an ellipsis; its link and ref remain.
10. A nameless link stays identifiable after bounding.
11. The GitHub username/password submit flow does not regress.
12. A client-side redirect after submit resolves the fence on the final
    destination, not an intermediate one.

Run focused CLI tests, MCP tests, screenshot tests, `tsc`, lint, and the full
suite before benchmarking. Note the full suite has a known chromedriver-download
flake that clears on re-run; do not read a single red file as a regression.

## Acceptance criteria

### Gate A — local validation, after P1

Cheap and deterministic. No agent credits. Confirms the workflow saving before
building on it.

- observed Enter/submit navigation reports the destination in 10/10 runs
  against the local fixture;
- **navigation-fence overhead** on a submit that does _not_ navigate stays under
  ~150 ms. This is the fence's own cost measured inside a persistent session —
  **not** `npx craftdriver` wall time, which is dominated by Node startup.
  Correctness wins if reliable cross-platform detection needs more; 500 ms
  remains the hard ceiling;
- the Wikipedia flow runs with zero failed commands and no recovery snapshot;
- Wikipedia browser text ≤ 7 KB, down from ~17.5 KB.

### Gate B — before the one multi-agent benchmark

- viewport screenshots match `document.documentElement.clientWidth/clientHeight`
  × DPR — **not** `innerWidth`/`innerHeight`, and not the requested viewport
  size. `innerWidth` includes the classic scrollbar; the captured content
  excludes it. Measured at DPR 1 with a 1280×800 viewport:

  | page          | `innerWidth` | `clientWidth` | captured |
  | ------------- | -----------: | ------------: | -------: |
  | scrolling     |         1280 |      **1265** | **1265** |
  | non-scrolling |         1280 |      **1280** | **1280** |

  `clientWidth` matches in both cases; `innerWidth` only when no scrollbar is
  present. Cover both pages, or the test passes by luck on one and fails on the
  other;

- long `href` annotations bounded without removing their links;
- **P4 landed** — the harness counts structured `{"ok": false}` and non-zero
  shell completion codes. Without this the benchmark cannot validate its own
  "zero failed commands" criterion;
- GitHub scenario correctness and command count do not regress;
- build, lint, focused tests and the full suite pass;
- the five-run deterministic scenario exists — two runs per scenario cannot
  distinguish a 2% change from noise, and P3 is a 2% change.

Then run **one** multi-agent benchmark against that exact commit.

Do not change snapshot node policy on two-run live-site evidence. Require
repeated agreement across multiple agents and scenarios first.

## Decision record

Two independent reviews produced this plan. Recording what each contributed and
what was rejected, so the reasoning survives.

**Adopted from the Codex (Sol) plan, correcting this document's earlier draft.**
The navigation-fence design in P0 — the earlier `readyState` re-probe proposed
here was simply wrong, because the old document is already `complete` when the
key is dispatched. `fill --submit` as a mechanism rather than a documentation
rule, which applies this document's own "prefer mechanism over instruction"
principle better than its own P1 did. The refusal to collapse query strings. The
harness failure-accounting fix.

**Adopted from this document.** The unbounded `href` finding, the observation
that our own `workflow.md` guidance caused the failure, and the measured target
workflow.

**Found by verification, predicted by neither.** The navigation race itself
(1 in 3 live runs), the DPR-1 screenshot evidence refuting the retina
hypothesis, and the fact that _both_ benchmark runs contained a `STALE_REF`
while the report claims zero errors.

**Changed against the Codex plan.** `MAX_HREF` 120 → **80**: measured, 120 trims
4 of 143 links for 56 B. An explicit bound on the no-navigation path so the
500 ms detection window is actually tuned rather than left at its ceiling. An
explicit stop on composite action flags.

An earlier revision also proposed splitting the benchmark so P0+P1 shipped and
were benchmarked before P2/P3. That was withdrawn — see the second-round
adoptions below. Local validation gives the same signal for free; the expensive
run happens once, on the final commit.

**Initially dropped, then superseded by measured follow-up evidence.** The
P0-P5 review rejected automatically attaching a snapshot to every `STALE_REF`.
The later Codex/Luna-low run showed that cheap-model recovery remained a real
cost, so P8 adopted the narrower conditional form: only previously issued refs,
12 KiB maximum, and no automatic retry. See the P6-P8 follow-up above.

**Adopted from the Codex review of this document (second round).** Separating
cheap local validation from the expensive multi-agent benchmark, and running the
latter once against the final commit — the earlier "benchmark after P1" would
have been stale the moment P2/P3 landed, and spent credits twice. Moving P4
ahead of the benchmark rather than last. Defining the 150 ms target as
navigation-fence overhead inside a session rather than end-to-end CLI wall time,
with correctness taking precedence and 500 ms as the ceiling. Replacing the
ambiguous screenshot evidence table.

**Adopted from the Codex review (third round).** Asserting screenshots against
`documentElement.clientWidth` rather than `innerWidth` — verified: on a
scrolling page `innerWidth` is 1280 while both `clientWidth` and the capture are
1265, and on a non-scrolling page all three are 1280, so only `clientWidth`
holds in both. Correlating the BiDi `load` event with the navigation id from
`navigationStarted` rather than context alone. Both are correct and neither was
in this document before.

**Agreed by both.** The exploration snapshot is at its safe limit; the remaining
wins are workflow and observation choices; after these changes, benchmark once
rather than keep optimising speculatively.
