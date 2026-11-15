# Senior QA architecture review: Chrome hybrid launch

> **Current status — verified follow-up, 15 November 2026:** the original four
> findings below are historical and have now been fixed and verified on Windows.
> Claude's changes were retained, with additional Windows cleanup/line-ending
> fixes and a narrowly scoped screenshot-race fix. See **Independent verification
> and reassessment** at the end for the current conclusion and test evidence.
> The original review and Claude's response are preserved for traceability.

Reviewed 15 November 2026. Branch `feat/chrome-hybrid-launch`, commit `d8a634d4e1b9c3e06c294bf95d241e8d48181ef3`, against local `main` at `987cf150bd9ee28a04c761fa68073aea37ea40f5`. Application source was not modified during the review. This report was subsequently added at the owner's request. Findings and line numbers refer to the reviewed commit, not to any future fixes.

This is a branch review; a matching GitHub PR was not returned by the connected search, so hosted PR approvals and CI status were not verified. The scope was architecture, implementation correctness, completeness, and readiness to merge. The generated third-party mapper was inspected through its packaging, integration, and verification mechanisms; this was not an exhaustive audit of every line of upstream vendor code.

## Recommendation

**Request changes, while keeping the architecture.** The proposal has a credible purpose and a sensible design. The ordinary browser flows work in the focused tests. However, cleanup, custom profiles, fallback coverage, and Windows build tooling have reproducible defects. These require a focused hardening pass before making this the production default. They do not justify throwing the implementation away.

| Area | Assessment | Reason |
| --- | --- | --- |
| Architecture | Keep the direction | The transport boundary and continued use of ChromeDriver avoid an unnecessary rewrite of Classic commands. |
| Implementation | Good structure, incomplete failure handling | Confirmed defects occur at resource ownership and initialization boundaries. |
| Completeness | Feature behavior is substantially implemented | Failure recovery, custom profiles, and Windows verification need finishing. |
| Risk | Material until the findings are addressed | The change becomes the default path, so existing callers encounter it without opting in. |
| Merge recommendation | Request changes | Two high-priority lifecycle/build defects and two compatibility/recovery defects remain. |

The reason for withholding approval is observable behavior, not the size of the diff or a preference for a different design. Most of the diff volume comes from the vendored mapper and planning material. The risk comes from assuming responsibilities previously handled by ChromeDriver and from incomplete coverage of those responsibilities.

## Architecture

The strongest choices are the narrow `BiDiTransport` interface, keeping Classic commands on ChromeDriver, isolating the mapper in a worker, selecting the launch path centrally, retaining a diagnostic override, and restricting automatic hybrid use to a recorded Chrome range. Bundle integrity, license packaging, reproducible-build checks, and upstream/version monitoring show that the new dependency's maintenance was considered.

The main cost is that CraftDriver now owns browser startup, profile preferences, process lifetime, mapper lifetime, and the ordering between two independent connections to Chrome. ChromeDriver previously handled more of these responsibilities. That is manageable, but lifecycle and concurrency become core product contracts rather than incidental implementation details.

`Browser.launch()` now returns before Classic readiness. This is intentional and documented, so it is not itself a defect. It means launch-only timings do not measure the same readiness point as before. Judge the performance benefit using launch through the first useful action, separately for BiDi and Classic. Do not transparently relaunch after returning a Browser to the caller: that could lose user state or repeat actions.

Vendoring is a reasonable tradeoff, but an update watcher is not a vulnerability scanner. Keep an explicit maintenance owner and an upstream security review process. The current documentation correctly says npm audit does not cover the bundle.

## Confirmed findings

### P1: Closing Chrome before the mapper leaks the worker

Location: [src/lib/bidi/inProcessMapper.ts](../src/lib/bidi/inProcessMapper.ts), lines 130–135.

The worker sends `closed` when the CDP connection disappears. The transport sets `closed = true`; a later `close()` returns immediately and never calls `worker.terminate()`. The worker still listens on its parent message port.

Reproduction: start Chrome and its mapper, close Chrome first, then close the transport. Cleanup prints completion, but Node retains a `MessagePort` and fails to exit within an eight-second parent-process timeout. Closing the transport before Chrome exits normally. This affects browser crashes or external browser closure, not just an artificial rejected promise.

Fix: track transport connectivity separately from resource disposal. Always terminate a surviving worker, and make repeated disposal await the same cleanup operation. Add an external-close/crash regression that checks child-process exit.

Evidence: standalone `worker-repro.mjs` in the review evidence directory identified in the appendix. The relevant reproduction sequence is included below.

**Why P1:** the public cleanup operation can appear to succeed while the host process remains alive. A test runner, CLI command, or automation service may hang after a browser crash or external closure. This is a lifecycle defect with operational consequences, not merely a retained object that disappears at normal process exit. The direct reproduction used an orderly external Chrome close; the browser-crash case still needs its own regression test.

**Acceptance criteria:** normal quit and external Chrome closure both allow a child Node process to exit without being killed; calling cleanup repeatedly remains safe; pending commands reject on disconnect; the worker is disposed even when the connection is already closed. Verify on Windows as well as a POSIX platform.

### P1: The new Windows mapper build gate fails during cleanup

Locations: [scripts/mapper/build.mjs](../scripts/mapper/build.mjs), lines 125–147, and [scripts/mapper/lib.mjs](../scripts/mapper/lib.mjs), lines 118–120.

The asynchronous esbuild API leaves its service alive while `withToolchain` recursively removes the service's temporary installation/working directory. `npm run mapper:check` failed twice with EPERM on Windows. The diagnostic reproduction successfully deleted that same directory after calling `esbuild.stop()`.

Fix: stop and settle the esbuild service in a finally block before deleting its toolchain. Verify `mapper:check` on Windows; the new cross-platform CI job invokes it before browser smoke tests.

Evidence: standalone `mapper-cleanup-repro.mjs` in the review evidence directory.

**Why P1:** this is a deterministic failure of a new required verification step on a supported platform. The cross-platform CI workflow runs this check before its browser smoke tests. It prevents the project from obtaining the very compatibility evidence needed to safely enable the new default. This priority concerns release validation; it does not imply that every installed Windows user is unable to launch Chrome.

**Acceptance criteria:** `npm run mapper:check` passes on Windows from a clean checkout and removes its temporary toolchain; failure paths also stop the service and preserve the original diagnostic. Keep the byte-for-byte verification intact rather than suppressing the cleanup error or skipping the Windows check.

### P2: Caller-supplied Chrome profiles ignore downloadsDir

Location: [src/lib/chromeLauncher.ts](../src/lib/chromeLauncher.ts), lines 164–174.

Supplying `--user-data-dir=...` makes the local `userDataDir` undefined, and the preferences write is skipped entirely. Attaching ChromeDriver does not apply the missing launch preferences later.

Reproduction: create an isolated profile with an old download directory, then launch with that profile and a different `downloadsDir`. Hybrid writes `report.txt` to the old directory and `waitForDownload()` times out; the ChromeDriver launch writes to the requested directory and succeeds.

Fix: either route custom profiles through ChromeDriver, or preserve and merge the relevant preferences into the selected profile without deleting caller-owned data. Cover `--profile-directory` too if supporting it on hybrid.

Evidence: standalone `profile-repro.mjs`; both launch paths were tested on this branch.

**Why P2:** this is a concrete compatibility regression for callers who supply a profile. Downloads succeed in Chrome but land outside the directory CraftDriver observes, producing misleading timeout failures. Fresh temporary profiles still work, which limits the affected population but does not make the regression acceptable for a default-path change.

**Acceptance criteria:** a caller-owned profile with an existing download preference honors the launch's `downloadsDir`; downloads are detected successfully; unrelated preferences and profile data survive; quit never deletes the caller-owned profile. A fallback to ChromeDriver is an acceptable first fix if full custom-profile parity would expand scope.

### P2: Automatic fallback ends before BiDi initialization is complete

Location: [src/lib/browser.ts](../src/lib/browser.ts), lines 912–915.

The fallback catch surrounds `launchHybridChrome()`, but initial context discovery and event subscription happen later in `initInProcessBiDi()`. Errors there go through the outer cleanup-and-rethrow block. Thus a hybrid initialization failure before `Browser.launch()` returns can fail the launch instead of trying ChromeDriver, contrary to the documented fallback contract.

Fault injection at this later initialization boundary reproduced rejection with the default route. This is a simulated failure-path test, not a naturally occurring Chrome compatibility failure during the happy-path suite.

Fix: include hybrid-specific BiDi initialization in the pre-return fallback boundary. Keep user configuration errors, such as malformed storage state, outside that retry policy; keep forced hybrid fail-fast. Add a regression at the initial subscription/context-tree stage, beyond the existing mapper-start failure test.

Evidence: standalone `fallback-repro.mjs`.

**Why P2:** the compatibility safety net is narrower than the documented contract. A mapper can start successfully and then fail when initial commands or subscriptions are sent. The default launch should recover from a hybrid-specific initialization failure while no Browser has been exposed to the caller. This finding demonstrates an uncovered failure boundary; it is not evidence that ordinary initialization frequently fails today.

**Acceptance criteria:** inject a failure in initial context discovery or event subscription after mapper startup. Default mode must clean up the failed attempt and launch through ChromeDriver; forced hybrid must reject. Invalid storage-state input must still fail without a pointless relaunch. Do not extend automatic relaunch into commands issued after `Browser.launch()` has returned.

## Completeness and best next steps

Before merge:

1. Fix the four findings and add targeted regressions, including Windows cleanup coverage. Existing process-leak tests skip Windows and mainly cover normal quit.
2. Resolve the mapper unit-suite loading failures observed on Windows, and obtain green build, mapper verification, and targeted integration results on Linux, macOS, and Windows. Run the compatibility matrix on the reviewed revision; its current workflow does not automatically run on pull requests.
3. Exercise cancellation/quit during delayed attach and a failed attach, browser crash, custom profiles, and first-command behavior using the real lifecycle. An HttpClient rejected-promise unit test does not cover all resource ownership around these cases.
4. Close or explicitly document the concurrency contract. The branch's progress log already records an unresolved standalone screenshot-versus-navigation race that may wait for the BiDi timeout; serializing tracer captures covers tracing only.

To get more value after correctness is established:

- Add a reproducible hybrid-versus-ChromeDriver comparison with BiDi enabled in both arms. Measure launch-only, first BiDi action, first Classic action, complete user flow, and cleanup; repeat on the three operating systems and record tails as well as medians. The existing launch benchmark compares BiDi enabled/disabled rather than explicitly pairing the two BiDi launch paths. The recorded Mac result is encouraging, but is one run and not independently remeasured here.
- Investigate starting the ChromeDriver attach concurrently with mapper startup: currently the driver service boots concurrently with Chrome, but the attach request starts only after `startInProcessMapper()` resolves. Treat this as an experiment with interop tests, not a correctness blocker or an assumed improvement.
- Surface diagnostic information for unexpected mapper rejections. Worker isolation is useful, but the blanket rejection handler can make internal failures appear only as later timeouts.
- Consolidate stale planning material. Several descriptions retain old options and sequencing; preserve the current launch contract and actionable follow-ups clearly.

Shared workers, a second mapper version, and a fully driverless rewrite are not prerequisites for getting value from this proposal. They would add scope before the current lifecycle is solid.

## Validation

Environment: Windows, Node 24.19.0, installed Chrome 157.0.8103.51, matching-major ChromeDriver 157.0.8103.78 supplied explicitly for browser checks. The initial automatic driver extraction failed because this machine's Windows PowerShell archive module could not load; that extraction code is unchanged by the branch.

- Build and lint passed; `git diff --check` passed.
- Focused hybrid/fallback/Chrome smoke/dialog/evaluate/network tests: 62 passed, 2 skipped.
- Launcher/mapper initial subset: 10 passed, 5 skipped; mapper-build and mapper-update suites failed to load with `Invalid or unexpected token`.
- Broad default suite: 1,596 passed, 19 failed, 38 skipped; the two mapper suite loading failures are additional collection failures, not included in the 19 failed test cases.
- CLI/MCP/trace smoke: 19 passed, 0 failed (`cli-tests.json`).
- Package dry run includes the mapper JavaScript, declarations, manifest, licenses, and notice. Built output was used for the standalone reproductions. A complete installed-package release test was not run.
- No Linux/macOS execution, Firefox execution, or new performance measurements were performed in this review.

Baseline comparison: ran the seven existing test files that failed on the branch against a separate clean main checkout, with the same dependencies and explicit driver. Of the branch's 19 failed test cases, 17 failed by the same test name on main. The other two are driver auto-download tests: on main, browser setup failed before those cases executed; on hybrid, launch returns early, so they run before/against the failed background driver resolution. The unchanged PowerShell archive failure also occurs in main's concurrent-resolution test. Main had one additional popup failure. The mapper unit suites are new and have no main equivalent; their Windows loading failures remain unresolved. Baseline results: 158 passed, 18 failed, 3 skipped across those selected files.

This comparison supports keeping pre-existing Windows/path/permission/popup failures separate from the four findings above. It does not make the entire suite green. Raw results and standalone reproductions are stored outside the repository in the review evidence directory identified below; they are not implied to be adjacent to this Markdown file.

## Reasoning behind the decision

### Why the architecture is worth keeping

1. **The abstraction is at the right boundary.** `BiDiConnection` works through a small transport interface. Higher-level network, evaluation, and browser APIs do not each need their own mapper-specific implementation.
2. **The migration is limited.** Classic behavior still uses ChromeDriver instead of reimplementing the WebDriver command surface. Firefox, remote sessions, and other launch targets retain their established launch routes. The transport refactor is shared code, however, so those paths still need regression verification.
3. **Isolation has a concrete purpose.** Running the mapper in a worker contains upstream unhandled rejections without installing a global rejection handler in the application's main thread. Correct worker disposal and useful diagnostics are necessary to complete that design.
4. **Compatibility management exists.** A recorded Chrome range, a forced diagnostic mode, the established ChromeDriver route, and scheduled compatibility checks are sensible mechanisms for dealing with Chrome/CDP changes.
5. **Maintenance was considered.** The mapper is pinned, its integrity is checked, licenses ship with the package, and there is an update workflow. These are meaningful strengths, even though the Windows build check currently needs repair.

### Why this needs more than small polish

Each confirmed finding changes observable behavior: a process stays alive, a required build check fails, a file lands in the wrong directory, or launch fails where fallback was promised. Naming, formatting, and documentation cleanup cannot repair these outcomes. They require implementation changes and regression tests.

The default-path switch increases the importance of parity. Existing users should not need to discover and set an environment override to regain expected downloads or cleanup. The override is useful for diagnosis and mitigation, but it is not a substitute for fixing reproducible regressions before release.

At the same time, the evidence does not justify describing the entire product as broadly broken. The focused browser and agent-surface checks passed, and the broad suite passed 1,596 cases. Most existing failures were reproduced on main. The defects are concentrated enough to support a targeted repair effort rather than discarding the approach.

### Why passing tests are insufficient for approval here

The missing cases are precisely where ownership changed. Normal quit closes the mapper before Chrome, so it cannot expose the reverse-order cleanup bug. A fresh profile accepts the new preference file, so it cannot expose skipped preferences in a supplied profile. A mocked mapper-start failure exercises the earlier catch block, so it cannot prove fallback after later BiDi initialization fails.

Test counts indicate breadth, but they do not replace coverage of these specific state transitions. A few carefully chosen regression tests will provide more assurance than repeatedly running the same successful happy paths.

### What the performance evidence does and does not establish

The branch's progress record reports a macOS comparison with mean startup of approximately 1,560 ms for hybrid and 2,113 ms for the ChromeDriver launch, plus improvements in some other operations. It also records wider tails for some interactions and identifies the measurements as a single run. Those are recorded author measurements, not measurements independently repeated during this review.

The owner previously chose to skip some measurement gates. This review does not present those skipped tasks as forgotten implementation work or claim that the owner must reverse that decision. However, to establish how much value the architecture delivers across supported environments, a reproducible comparison remains the most useful optional follow-up.

Because readiness changed, a faster return from `Browser.launch()` alone is not sufficient evidence of a proportionally faster complete workflow. Measure both paths with the same BiDi capability and include the first Classic operation, complete flow, and teardown. Report failures and tail latency rather than measuring only successful launches.

## Suggested completion order

| Order | Work | Completion evidence |
| --- | --- | --- |
| 1 | Fix worker disposal and Windows mapper cleanup | External-close child exits; Windows mapper verification succeeds and leaves no running toolchain service. |
| 2 | Restore custom-profile download parity and complete pre-return fallback | A/B profile regression passes; fault injection verifies default fallback and forced failure. |
| 3 | Repair new Windows test-loading failures and validate affected lifecycle cases | New suites collect and run; attach failure, delayed attach, quit, and crash cases have explicit results. |
| 4 | Verify the supported platform and Chrome-version gates | Results tied to the candidate commit, including forced hybrid so fallback cannot conceal a failed hybrid path. |
| 5 | Resolve the concurrency contract and update current behavior documentation | Screenshot/navigation behavior is tested or clearly scoped; stale launch options are not presented as current. |
| 6 | Measure additional performance opportunities | Paired end-to-end results before adopting further concurrency or worker-sharing changes. |

The approval criterion is that the identified correctness defects are fixed and verified, with remaining unrelated failures clearly accounted for. Shared workers, multiple mapper versions, and a driverless implementation are not approval conditions.

## Reproduction and evidence appendix

### Evidence provenance

The review's local evidence directory is:

```text
C:\Users\dtopu\Documents\ChatGPT\Craftdriver\qa-hybrid-review
```

It contains:

| File | Purpose |
| --- | --- |
| `worker-repro.mjs` | Normal close versus Chrome-first close reproduction. |
| `mapper-cleanup-repro.mjs` | Records the cleanup error and demonstrates removal succeeding after esbuild stops. |
| `profile-repro.mjs` | Hybrid/ChromeDriver custom-profile download comparison. |
| `fallback-repro.mjs` | Injects a failure at the later BiDi initialization boundary. |
| `full-tests.json`, `full-tests.log` | Broad branch test results. |
| `baseline-tests.json`, `baseline-tests.log` | Selected failing files run against main. |
| `cli-tests.json`, `cli-tests.log` | CLI/MCP/trace smoke results. |
| `mapper-test.json` | Mapper-build suite loading failure. |
| `package-contents.json` | Dry-run package inventory. |

These paths are local review artifacts, not portable repository dependencies. The temporary baseline checkout and the examples server started for the review were removed/stopped afterwards. No application-source changes or fixes were committed as part of the review.

### Commands used for validation

The examples server was started from the repository with:

```powershell
node node_modules/http-server/bin/http-server examples -a 127.0.0.1 -p 8080 -c-1 --cors
```

For browser tests, `HEADLESS=true` and `CRAFTDRIVER_CHROMEDRIVER_PATH` pointed to the explicitly extracted ChromeDriver executable. This avoided the machine's unrelated automatic extraction problem; the auto-download tests deliberately unset that override and still encountered the problem.

```powershell
npm run build
npm run lint
git diff --check main...HEAD
npm run mapper:check

node node_modules/vitest/vitest.mjs run tests/chrome-launcher.test.ts tests/mapper-build.test.ts tests/mapper-update.test.ts tests/mapper-bundle.test.ts --maxWorkers=2

node node_modules/vitest/vitest.mjs run tests/hybrid-launch.test.ts tests/hybrid-fallback.test.ts tests/chrome-smoke.test.ts tests/dialogs.test.ts tests/evaluate.test.ts tests/network.test.ts --maxWorkers=2

node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json --outputFile=<evidence-dir>/full-tests.json

node node_modules/vitest/vitest.mjs run --config vitest.cli.config.ts tests/cli-smoke.test.ts tests/mcp-smoke.test.ts tests/cli/agent-trace.test.ts --maxWorkers=1 --reporter=json --outputFile=<evidence-dir>/cli-tests.json

npm pack --dry-run --json
npm run docs:api:check
```

`<evidence-dir>` is a placeholder for a chosen output directory, not a literal command argument. The API documentation check reported stale output on the branch; the corresponding test also failed on main, so it was not classified as a hybrid-specific finding.

The baseline run used the same dependency installation and explicit driver, with these files on main:

```text
tests/pages.test.ts
tests/browser-context-hooks.test.ts
tests/api-reference.test.ts
tests/driver-manager.test.ts
tests/electron-fuses.test.ts
tests/cli/init-skill.test.ts
tests/cli/parse-args.test.ts
```

### Minimal worker-close reproduction

After building, save the following as a temporary `.mjs` file in the repository root and run it as a file. These imports target the built implementation. This is the essential sequence from the executed reproduction, with paths made portable:

```javascript
import { launchChrome } from './dist/lib/chromeLauncher.js';
import { findChromeBinary } from './dist/lib/driverManager.js';
import { startInProcessMapper } from './dist/lib/bidi/inProcessMapper.js';

const chrome = await launchChrome({ binary: findChromeBinary(), headless: true });
const transport = await startInProcessMapper(chrome.wsUrl, { capabilities: {} });

if (process.argv.includes('--external-close')) {
  await chrome.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.log('before close: open=', transport.isOpen());
await transport.close();
await chrome.close();
console.log('cleanup finished', process.getActiveResourcesInfo());
```

The normal ordering exited with status 0. The `--external-close` ordering printed `open=false` and retained `MessagePort` in its active-resource output. A parent process running the script with an 8,000 ms timeout received `ETIMEDOUT`. The parent timeout was a diagnostic bound, not a proposed production cleanup timeout.

### Custom-profile download reproduction

The executed A/B sequence was:

1. Create a new isolated profile for each launch mode.
2. Seed `Default/Preferences` with `download.default_directory` pointing to an isolated `old-downloads` directory and `prompt_for_download=false`.
3. Set `CRAFTDRIVER_CHROME_LAUNCH_MODE` to `hybrid` or `chromedriver`.
4. Launch with `args: ['--user-data-dir=<profile>']` and `downloadsDir: '<wanted-downloads>'`.
5. Navigate to the examples server's `/download.html` and click `#download-btn` inside `waitForDownload()`.
6. Inspect both directories and quit the browser.

Observed results:

```text
hybrid: waitForDownload timed out; old-downloads contained report.txt;
        wanted-downloads was empty.
chromedriver: waitForDownload succeeded; old-downloads was empty;
              wanted-downloads contained report.txt.
```

The original run used the default 30-second timeout. The saved reproduction was subsequently shortened to the API's correct `{ timeout: 2000 }` option for convenient reruns; the recorded result above comes from the original run. All profiles and download directories used by this comparison were isolated review data, not the user's normal Chrome profile.

### Fallback fault injection

The executed diagnostic temporarily wrapped `BiDiSession.prototype.connect`, called the original implementation, and then threw for the in-process transport only. This places a failure after mapper creation but before `Browser.launch()` returns, without making the ChromeDriver WebSocket path fail:

```javascript
import { Browser } from './dist/index.js';
import { BiDiSession } from './dist/lib/bidi/index.js';

process.env.HEADLESS = 'true';
delete process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE;

const original = BiDiSession.prototype.connect;
BiDiSession.prototype.connect = async function (endpoint, ...args) {
  const result = await original.call(this, endpoint, ...args);
  if (typeof endpoint === 'object') {
    throw new Error('injected initial BiDi subscription failure');
  }
  return result;
};

try {
  const browser = await Browser.launch();
  try {
    console.log('launch succeeded');
  } finally {
    await browser.quit();
  }
} catch (error) {
  console.log('Browser.launch rejected without fallback:', error.message);
} finally {
  BiDiSession.prototype.connect = original;
}
```

Observed output was `Browser.launch rejected without fallback: injected initial BiDi subscription failure`. The text is the injected diagnostic; it is not an error emitted naturally by Chrome. A permanent regression should inject the failure at the actual context-tree or subscription operation rather than relying solely on this wrapper.

### Windows mapper-cleanup reproduction

Run `npm run mapper:check` on the reviewed Windows environment. Both attempts failed with `EPERM` while deleting a `craftdriver-mapper-*` temporary directory. The diagnostic script intercepted the failed cleanup path, loaded that toolchain's esbuild module, called `esbuild.stop()`, waited briefly, and retried removal of that exact directory. Removal then succeeded.

This establishes the cleanup ordering problem. It does not establish that the full byte-comparison check passes after a production fix; that check must be rerun after correcting service shutdown.

## Limits of confidence

- The four findings have direct code paths and reproduction evidence. The fallback finding uses deliberate fault injection, clearly distinguished from naturally occurring failures.
- The cause of the new mapper unit-suite syntax/loading failures was not established. They remain a verification gap, not a speculative fifth code defect.
- Existing popup failures should still be tracked and triaged, even though baseline comparison prevents assigning them to this branch without further evidence.
- The recorded screenshot/navigation concurrency issue comes from the branch's progress log; it was not separately reproduced in this review.
- The review did not execute Linux/macOS CI, Firefox tests, the complete installed-package release workflow, or a new performance benchmark.
- Approval should be based on the fixed candidate commit and its verification results. This report does not certify later edits automatically.

## Follow-up: what was fixed and what was not

Added 15 November 2026, after the review. The fixes are in commit `6b65111` on `claude/project-thread-ntqskb`. The same changes are uncommitted in the local `feat/chrome-hybrid-launch` checkout. Verified on Linux with Chrome 153 and a matching ChromeDriver. Nothing was run on Windows.

### Fixed

All four confirmed findings hold up against the code. Each fix has a regression test, and each test fails when its fix is reverted.

| Finding | Fix | Regression test |
| --- | --- | --- |
| P1: closing Chrome before the mapper leaks the worker | Reproduced on Linux: the process hung on a `MessagePort` and was killed by an 8 s timeout. `WorkerMapperTransport.close()` now always terminates the worker, also when the connection was already closed. Repeated calls share one disposal promise. `closed` now tracks only connectivity. | `tests/hybrid-launch.test.ts`, "in-process mapper cleanup": closes Chrome first, then calls `close()` several times, and checks the worker is terminated exactly once. Not skipped on Windows. |
| P1: Windows `mapper:check` fails during cleanup | `buildMapper` calls `esbuild.stop()` in a `finally` block before `withToolchain` removes the toolchain directory. The byte-for-byte check is unchanged. | No new test. `npm run mapper:check` passes on Linux and leaves no `craftdriver-mapper-*` directory behind. **Still needs a run on Windows.** |
| P2: caller-supplied profiles ignore `downloadsDir` | Uses the first fix the review allows: `args` containing `--user-data-dir=` route to chromedriver, which merges its prefs into the existing profile. Hybrid does not write into a caller-owned profile. The list in `docs/driver-configuration.md` is updated. | A routing-table row, plus an end-to-end A/B test: a seeded profile with an old download directory and a different `downloadsDir`. It checks the file lands in `downloadsDir`, the old directory stays empty, and the profile survives `quit()`. |
| P2: automatic fallback ends before BiDi initialization is complete | `Browser.launch` creates the hybrid `Browser` early and runs `initInProcessBiDi` (context tree and subscriptions) inside the fallback boundary. On failure it quits that attempt, records the binary as failed (as a mapper-start failure already did), and launches through chromedriver. Forced hybrid still rejects. `storageState` parsing and restore stay outside the boundary, so bad input fails without a relaunch. No relaunch happens after `launch()` has returned. | New `tests/hybrid-fallback-init.test.ts`: makes the real mapper's `session.subscribe` return a BiDi error. The default route falls back to chromedriver with BiDi working. The forced route rejects. Both close the failed transport. |

On Linux the broad suite had 1,650 passes and 6 failures. Five of those also fail on the unchanged branch: driver auto-download and popup tests. The sixth is a popup test in `browser-context-hooks` that passed in 3 out of 3 reruns, so it is treated as load flakiness.

### Not fixed: not a valid problem for this branch

- **`Browser.launch()` returns before Classic readiness.** The review itself says this is intentional and documented, and not a defect.
- **Performance comparison (hybrid vs. ChromeDriver with BiDi in both arms, across OSes, with tails).** This is a useful measurement, but it is not a correctness problem. The owner already chose to skip those measurement gates.
- **Starting the ChromeDriver attach at the same time as mapper startup.** This is an optimization experiment, as the review says. It is not a defect.
- **Vendoring needs a maintenance owner and an upstream security review process.** This is a process decision, not a code defect. The docs already say `npm audit` does not cover the bundle.
- **`docs:api:check` reports stale output.** It also fails on `main`, and these fixes do not change the public API. It is not specific to the hybrid branch.
- **Pre-existing Windows failures (PowerShell archive extraction, path/permission, popup).** The baseline comparison shows they also happen on `main`. They need tracking, but they belong to another change.

### Not fixed: may be valid, but not confident enough to change

- **Mapper unit suites fail to load on Windows (`Invalid or unexpected token`).** They load and pass on Linux (28/28). The tests import `scripts/mapper/*.mjs`, which start with a `#!/usr/bin/env node` shebang. A CRLF checkout of those files is one plausible cause, but that is a guess without Windows access. It needs a Windows reproduction first.
- **CI green on Linux, macOS and Windows, and the compatibility matrix not running on pull requests.** Getting green results on all three platforms before merge is reasonable. Whether the matrix should run on every PR is a CI cost and policy decision for the owner, not something to change silently.
- **Lifecycle coverage: quit or cancel during a delayed attach, failed attach, browser crash, first command.** The worker-disposal fix and its test cover external close. A dedicated crash test (killing Chrome rather than closing it) and a quit-during-delayed-attach test would add assurance. The review gives no failing scenario for them, though, and none was found here. The existing repeated-quit cleanup test already quits before the attach finishes.
- **Screenshot vs. navigation race.** This comes from the branch's progress log, and it was not reproduced by the review or here. It needs a reproduction before it can be fixed or scoped in the docs.
- **Surfacing diagnostics for unexpected mapper rejections.** The worker's blanket `unhandledRejection` handler can hide internal errors until a later timeout. This is plausible, but there is no concrete case yet. Logging every rejection would be noisy because the mapper rejects routinely when targets close. It is a design choice (for example, forwarding them only with `CRAFTDRIVER_DEBUG=1`), not a clear fix.
- **Stale planning material.** This is possibly valid, but the review does not say which passages are out of date. Rewriting planning documents without that risks losing the owner's recorded decisions.

## Independent verification and reassessment

### Current conclusion

I accept Claude's architectural choices and the fixes for worker disposal,
custom-profile downloads, and initialization fallback. The proposed esbuild
shutdown was necessary but incomplete on Windows; that was corrected during
this follow-up. The two new mapper suites now load and pass on Windows, and
the build verification passes. A separate, smaller screenshot/navigation race
was reproduced and fixed with targeted regression tests.

**The verified implementation is committed as `94eab1f` (`fix(chrome): harden
hybrid launch and Windows mapper tooling`). I no longer consider the four
original findings outstanding merge blockers.** Before merging, use the
repository's existing CI checks. This recommendation does not claim that all
unrelated tests on main are green, or that this Windows run substitutes for
Linux/macOS results.

My earlier report could have distinguished mandatory correctness fixes from
assurance work and optional improvements more clearly. Early launch return,
performance experiments, maintenance ownership, and pre-existing failures
were not new defects. The reassessment below makes that distinction explicit.

### Verification of Claude's implementation

| Change | Independent result | Additional work |
| --- | --- | --- |
| Worker disposal after Chrome closes | Accepted. The standalone child-process reproduction now exits with status 0 and no retained MessagePort. | Extended the integration test to kill Chrome's process as well as close it gracefully, and ensured test cleanup disposes the transport even if an assertion fails. Both cases passed on Windows. |
| esbuild service shutdown | Incomplete initially: `mapper:check` still failed with EPERM on Windows with Claude's `stop()` change. | Replaced synchronous toolchain removal with awaited asynchronous removal. `stop()` initiates child shutdown; asynchronous cleanup allows process/pipe closure callbacks to run while Windows handles are released. Mapper verification and the existing update failure-path tests now pass. |
| Custom-profile downloads | Accepted. Routing `--user-data-dir=` launches through ChromeDriver preserves existing-profile preference handling. | The real-browser regression passed on Windows, including the requested download destination and preservation of the caller-owned profile. |
| Fallback after mapper startup | Accepted. Initial BiDi setup is inside the fallback boundary; storage-state validation remains outside. | Added checks that invalid storage state does not cause fallback or disable future hybrid launches, and that initialization failures are remembered for subsequent launches. Mocked the verified range in this initialization-specific suite so newer compatibility-matrix browsers exercise this boundary rather than bypassing it. |

The new fallback-initialization test was added to the **existing**
cross-platform smoke and Chrome compatibility workflow test lists. No new
workflow trigger, PR matrix requirement, or merge policy was introduced.

### Reconsideration of each disputed or uncertain item

| Item | Reassessed position | Evidence or action |
| --- | --- | --- |
| `launch()` returns before Classic readiness | Agree with Claude: intentional behavior, not a defect. | A controlled delayed-driver probe confirmed launch returns with BiDi ready; quit waits for the attach, then closes Chrome successfully. |
| Performance comparison across both launch paths | Agree: optional measurement work, not a correctness blocker. | The owner's decision to skip measurement gates remains respected. No new performance claims were made. |
| Attach concurrently with mapper startup | Agree: an optimization hypothesis, not an established defect. | No scheduling changes made. It still requires measurement and interop validation before implementation. |
| Vendored-mapper security/maintenance owner | Agree: a process recommendation, not a code defect. | The existing audit limitation is already documented. No new approval or ownership policy imposed. |
| Stale API-reference output and baseline Windows failures | Agree: keep separate from this branch's fixes. | The earlier baseline comparison already established these distinctions. No unrelated API-doc, PowerShell, permission, or popup changes were made. |
| Mapper suites cannot load on Windows | Confirmed and fixed. Claude's CRLF/shebang hypothesis was correct for this checkout. | Both suites failed to collect with `Invalid or unexpected token`. Converting the two imported CLI scripts to LF allowed collection; `.gitattributes` now preserves LF for `scripts/mapper/*.mjs`. All 22 mapper build/update tests passed after cleanup was corrected. |
| Green CI on three platforms / matrix on every PR | Agree on the distinction: supported-platform evidence matters, but scheduling and required-check policy belong to the owner. | Existing workflows remain in place. Only the missing regression file was added to their test lists. I am not requiring a full three-platform suite or the version matrix on every PR. |
| Crash, delayed attach, failed attach, first command | Coverage recommendations, not evidence that those paths were broken. | Actual process-kill regression passed. Delayed-attach and failed-start probes both cleaned up Chrome; first Classic command surfaced the injected driver error. No additional lifecycle defect was found. |
| Screenshot/navigation race | Partly agree: the historical 30-second stall remains unconfirmed on the current build. However, a smaller concrete race was reproduced. | See the detailed A/B evidence below. Added the existing narrow realm-loss retry to viewport and full-page capture and tested error discrimination. |
| Swallowed mapper rejections | Agree that blanket logging would be noisy and a diagnostic design choice. | No new concrete hang attributable to a swallowed rejection was established. Debug-only diagnostics remain an optional follow-up; no logging behavior changed. |
| Stale planning documentation | Valid, but my earlier report lacked precise examples. | Updated the exact stale status and next-step text listed below, preserving original design decisions and historical logs. |

### Screenshot investigation: what was actually reproduced

A standalone probe ran viewport and full-page screenshots concurrently with
Classic navigation, using delays of 0, 1, 5, 15, and 30 ms before navigation.
It used the same Chrome and driver on both launch paths: ten combinations per
path, twenty total.

Before the additional fix:

- Hybrid: two of ten captures rejected with
  `BiDi error [unknown error]: Cannot find context with specified id`, at the
  1 ms delay for both viewport and full-page capture. Navigation succeeded.
- ChromeDriver launch: ten of ten combinations succeeded.
- No 30-second stall occurred. The failures completed in approximately 30–34 ms.

The mapper evaluates document geometry before capture. A concurrent navigation
can replace that execution context. The fix reuses the existing bounded
`withRealmRetry` helper around the BiDi capture command. It retries only the
known realm-disappeared errors; it does not retry arbitrary screenshot errors
or relaunch the browser.

After the fix, all twenty combinations completed successfully. Four
deterministic regression cases inject the two recognized errors for viewport
and full-page capture, then require a real PNG. A fifth case verifies that
`no such frame` is surfaced immediately rather than retried.

This verifies recovery from the reproduced error. It does **not** establish
that the historical stalled-capture behavior is fixed or that concurrent
screenshots have atomic before-navigation semantics. Await the screenshot
before navigating when the image must capture the preceding page.

### Exact planning-document corrections

The following were current-facing stale statements, rather than merely old
entries in a historical log:

- `plans/chrome-hybrid-launch.md` said **"Status: proposed ... Owner decision
  needed at gates G0 and G3"**, despite the recorded owner decision to skip
  measurement gates and enable hybrid by default. The status now identifies
  the implementation and labels the original proposal as design history.
- That proposal describes the removed `LaunchOptions.chromeLaunchMode` and
  a `loadMapper()` function that is not the current loader. The historical
  proposal is preserved, with an explicit notice that those names are not
  current API/implementation guidance.
- `plans/chrome-hybrid-PROGRESS.md` under **"Next steps"** directed readers to
  watch a non-blocking `chrome-hybrid` job. The actual workflow has the default
  Chrome suite, `chrome-chromedriver-launch`, and cross-platform smoke. That
  current next-step instruction was corrected and linked to this verification.

No historical owner decisions were deleted or reversed.

### Follow-up verification results and limits

Environment: Windows, Node 24.19.0, Chrome 157.0.8103.51, and explicitly selected
ChromeDriver 157.0.8103.78. Results apply to implementation commit `94eab1f`,
not only the original `d8a634d` review target.

| Check | Result |
| --- | --- |
| Build, lint, whitespace validation | Passed. |
| `npm run mapper:check` | Passed on Windows after both shutdown and asynchronous cleanup changes. |
| Mapper build/update unit suites | 22 passed. |
| Focused launch, fallback, launcher, mapper, screenshot, evaluate, dialog, network, and authentication-state suites | 104 passed, 7 skipped across 11 files. |
| Extended fallback-initialization suite, rerun after adding invalid-state and memoization assertions | 3 passed; this supersedes its earlier two-case result within the focused run. |
| CLI/MCP/trace smoke | 19 passed. |
| Original external-close child-process reproduction | Exit status 0 within the eight-second bound. |
| Delayed attach / failing driver-start probes | Quit completed and Chrome was no longer alive in both cases. |
| Screenshot/navigation A/B probe after the fix | 20 of 20 combinations succeeded; regression tests also passed. |

The first focused browser run was interrupted by Windows sleep. The System
event log recorded sleep at 19:56:08 and a return from a low-power state at
20:12:52 (Europe/Sofia); nominal 30-second tests recorded roughly 1,000 seconds
elapsed. That run's three failures were retained as an interrupted-run result,
not silently converted into a pass. The affected gate was rerun after the
environment interruption was identified. No automatic test retries were added.

A second full broad suite was not run: the relevant changed areas have named
gates, and unrelated main failures were already investigated. No new
Linux/macOS execution or performance measurement was performed in this
follow-up. Claude's Linux claims above remain attributed to Claude.

Additional local evidence is under the original evidence directory's
`followup/` subdirectory: `hybrid-tests.json`, `final-browser-tests.json`,
`cli-tests.json`, `screenshot-race.mjs`, `screenshot-race.log`,
`screenshot-race-after.log`, and `attach-lifecycle.mjs`. These are local
diagnostic artifacts, not required repository dependencies.
