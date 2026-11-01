/**
 * Hybrid Chrome launch: craftdriver starts Chrome itself, runs the BiDi mapper
 * in-process, and attaches chromedriver to the running browser for Classic
 * commands.
 *
 * `Browser.launch` resolves as soon as BiDi is ready. chromedriver keeps
 * attaching in the background; the first Classic command waits for it (see
 * `WebDriverEndpoint.pendingSession`). It is the default for local,
 * chrome-family, BiDi launches on a Chrome version the mapper is verified
 * against. Everything else, and any hybrid launch that fails before
 * `Browser.launch` returns, uses chromedriver to launch Chrome as before.
 */

import crypto from 'node:crypto';
import { launchChrome, type LaunchedChrome } from './chromeLauncher.js';
import type { ChromeService } from './chrome.js';
import { Driver } from './driver.js';
import { findChromeBinary, invalidateChromeDriverAutoResolutionCache } from './driverManager.js';
import { isChromeDriverVersionMismatch } from './builder.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import type { BiDiTransport } from './bidi/transport.js';
import { startInProcessMapper } from './bidi/inProcessMapper.js';
import manifest from './bidi/vendor/chromium-bidi-mapper.manifest.json' with { type: 'json' };
import type { WebDriverEndpoint } from './types.js';

/**
 * Troubleshooting override, not a setting. Unset, craftdriver picks the
 * launch path itself. `chromedriver` always lets chromedriver launch Chrome
 * (to work around a hybrid-launch bug). `hybrid` forces hybrid on any Chrome
 * version and fails instead of falling back (compatibility testing, bug
 * reports).
 */
export const CHROME_LAUNCH_MODE_ENV = 'CRAFTDRIVER_CHROME_LAUNCH_MODE';

const OVERRIDES = ['chromedriver', 'hybrid'] as const;

/** Chrome majors (inclusive) the vendored mapper is verified against. */
export function mapperChromeRange(): { min: number; max: number } {
  return { min: manifest.chromeSupport.minMajor, max: manifest.chromeSupport.maxMajor };
}

/** Where a Chrome major sits relative to the verified range. */
export type ChromeVersionVerdict = 'verified' | 'newer' | 'older' | 'unknown';

export function chromeVersionVerdict(
  major: number | undefined,
  range: { min: number; max: number }
): ChromeVersionVerdict {
  if (major === undefined) return 'unknown';
  if (major < range.min) return 'older';
  if (major > range.max) return 'newer';
  return 'verified';
}

export interface ChromeLaunchRouteInput {
  kind: 'browser' | 'electron' | 'remote';
  browserName: string;
  bidiRequested: boolean;
  /** `process.env[CHROME_LAUNCH_MODE_ENV]`. */
  env?: string;
  mobileEmulation: boolean;
  args?: readonly string[];
}

export type ChromeLaunchRoute =
  { path: 'hybrid'; forced: boolean } | { path: 'chromedriver'; reason: string };

/** Why a launch can't take the hybrid path, or undefined when it can. */
function hybridBlocker(input: ChromeLaunchRouteInput): string | undefined {
  if (input.kind !== 'browser') return `${input.kind} launches always use their own driver`;
  if (input.browserName !== 'chrome' && input.browserName !== 'chromium') {
    return `it only launches Chrome/Chromium (got "${input.browserName}")`;
  }
  if (!input.bidiRequested) return 'it needs BiDi (enableBiDi is false)';
  if (input.mobileEmulation) {
    return 'mobileEmulation is applied by chromedriver when it launches Chrome';
  }
  if (input.args?.some((a) => /^--remote-debugging-(port|pipe|address)\b/.test(a))) {
    return 'args set their own --remote-debugging-* endpoint';
  }
  return undefined;
}

/**
 * Pick the Chrome launch path. Pure, so the routing table is unit-tested.
 *
 * Local Chrome/Chromium launches with BiDi take the hybrid path; launches it
 * can't serve (Firefox, mobile emulation, ...) use chromedriver, also when
 * the override forces hybrid, since it applies to a whole run.
 */
export function chooseChromeLaunchPath(input: ChromeLaunchRouteInput): ChromeLaunchRoute {
  const env = input.env || undefined;
  if (env !== undefined && !(OVERRIDES as readonly string[]).includes(env)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `${CHROME_LAUNCH_MODE_ENV} must be ${OVERRIDES.map((m) => `'${m}'`).join(' or ')} (got ${JSON.stringify(env)}).`
    );
  }
  if (env === 'chromedriver') {
    return { path: 'chromedriver', reason: `${CHROME_LAUNCH_MODE_ENV} is 'chromedriver'` };
  }
  const blocker = hybridBlocker(input);
  if (blocker) return { path: 'chromedriver', reason: blocker };
  return { path: 'hybrid', forced: env === 'hybrid' };
}

/**
 * The hybrid path does not apply to this launch (Chrome outside the verified
 * range, no Chrome binary to launch). Expected, so the fallback is silent.
 */
export class HybridUnavailableError extends Error {}

const notices = new Set<string>();

/**
 * Report a fallback to chromedriver. Expected ones only show with
 * `CRAFTDRIVER_DEBUG=1`; a failed hybrid launch prints once per process.
 */
export function noticeHybridFallback(err: unknown): void {
  if (err instanceof HybridUnavailableError) {
    debugChromeLaunch(`chromedriver (${err.message})`);
    return;
  }
  const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
  const text =
    `[craftdriver] Hybrid Chrome launch failed, using chromedriver instead: ${message}\n` +
    `[craftdriver] Please report this. ${CHROME_LAUNCH_MODE_ENV}=chromedriver skips the hybrid attempt.\n`;
  if (notices.has(text)) return;
  notices.add(text);
  process.stderr.write(text);
}

/** `CRAFTDRIVER_DEBUG=1`: which path a Chrome launch took and why. */
export function debugChromeLaunch(detail: string): void {
  if (process.env.CRAFTDRIVER_DEBUG !== '1' && process.env.CRAFTDRIVER_DEBUG !== 'true') return;
  process.stderr.write(`[craftdriver:chrome] launch=${detail}\n`);
}

export interface HybridLaunchInput {
  /** Resolved custom browser binary; the system Chrome when undefined. */
  browserBinary?: string;
  headless: boolean;
  args?: string[];
  /** Chrome profile prefs (downloads), written before Chrome starts. */
  prefs: Record<string, unknown>;
  service: ChromeService;
  /** Used for both the Classic session and the mapper's `session.new`. */
  unhandledPromptBehavior: unknown;
  /** Forced by the override: any Chrome version, failures are not remembered. */
  forced: boolean;
}

export interface HybridLaunch {
  driver: Driver;
  transport: BiDiTransport;
  chrome: LaunchedChrome;
}

/**
 * Chrome's major version and its initial tab (the `data:,` page), read before
 * anything else opens targets. Best-effort: undefined fields on failure.
 */
async function inspectChrome(
  chrome: LaunchedChrome
): Promise<{ major?: number; initialTab?: string }> {
  const get = async <T>(path: string): Promise<T | undefined> => {
    try {
      return (await (await fetch(`http://${chrome.debuggerAddress}${path}`)).json()) as T;
    } catch {
      return undefined;
    }
  };
  const [version, targets] = await Promise.all([
    get<{ Browser?: string }>('/json/version'),
    get<Array<{ id: string; type: string }>>('/json/list'),
  ]);
  const major = /\/(\d+)\./.exec(version?.Browser ?? '')?.[1];
  const pages = targets?.filter((t) => t.type === 'page') ?? [];
  return {
    major: major ? Number(major) : undefined,
    initialTab: pages.length === 1 ? pages[0].id : undefined,
  };
}

/**
 * Chrome majors seen per binary in this process, so a binary known to be
 * outside the verified range falls back before Chrome is launched for
 * nothing. A stale entry (Chrome updated under a long-lived process) can only
 * cause an unneeded fallback: in-range launches are re-checked after launch.
 */
const knownMajors = new Map<string, number>();

/**
 * Binaries whose hybrid launch failed in this process. Later launches go
 * straight to chromedriver instead of failing the same way again.
 */
const failedBinaries = new Set<string>();

function checkChromeVersion(major: number | undefined, input: HybridLaunchInput): void {
  if (input.forced) return;
  const range = mapperChromeRange();
  const verdict = chromeVersionVerdict(major, range);
  if (verdict === 'older' || verdict === 'newer') {
    throw new HybridUnavailableError(
      `Chrome ${major} is outside the Chrome versions verified for hybrid launch (${range.min}-${range.max})`
    );
  }
}

/**
 * Attach chromedriver to the running Chrome and return the session id.
 * Mirrors `Builder`'s one retry after a stale cached chromedriver.
 */
async function attachChromedriver(
  service: ChromeService,
  caps: Record<string, unknown>,
  chrome: LaunchedChrome,
  initialTab: string | undefined
): Promise<{ sessionId: string; endpoint: WebDriverEndpoint }> {
  for (let attempt = 1; ; attempt++) {
    try {
      await service.start();
      const driver = await Driver.create(service.getEndpoint(), caps);
      // An attaching chromedriver picks its current window from whatever tabs
      // exist by then (launch-time work such as storageState restore can open
      // more). Point it at the tab BiDi treats as the default page, as a
      // chromedriver-launched session would be. Tab ids and window handles
      // are the same string.
      if (initialTab) await driver.switchToWindow(initialTab).catch(() => {});
      return { sessionId: driver.getSessionId(), endpoint: service.getEndpoint() };
    } catch (err) {
      if (
        attempt === 1 &&
        isChromeDriverVersionMismatch(err) &&
        invalidateChromeDriverAutoResolutionCache(service.getCommand())
      ) {
        await service.stop().catch(() => {});
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      const driverTail = service.getOutputTail().trim();
      const chromeTail = chrome.getOutputTail().trim();
      throw new CraftdriverError(
        ErrorCode.DRIVER_ERROR,
        `chromedriver could not attach to Chrome at ${chrome.debuggerAddress}: ${message}` +
          (driverTail ? `\nDriver output (tail):\n${driverTail}` : '') +
          (chromeTail ? `\nChrome output (tail):\n${chromeTail.slice(-4096)}` : ''),
        { detail: { debuggerAddress: chrome.debuggerAddress }, cause: err }
      );
    }
  }
}

/**
 * Launch Chrome, start the in-process mapper, and begin the chromedriver
 * attach without waiting for it. Cleans up everything it started on failure.
 */
export async function launchHybridChrome(input: HybridLaunchInput): Promise<HybridLaunch> {
  const binary = input.browserBinary ?? findChromeBinary();
  if (!binary) {
    const message = 'no Chrome/Chromium installation found to launch';
    throw input.forced
      ? new CraftdriverError(ErrorCode.DRIVER_ERROR, `Hybrid Chrome launch: ${message}.`)
      : new HybridUnavailableError(message);
  }

  // Before launching anything: a binary seen earlier needs no second launch.
  if (!input.forced && failedBinaries.has(binary)) {
    throw new HybridUnavailableError(
      'hybrid launch already failed for this Chrome in this process'
    );
  }
  const known = knownMajors.get(binary);
  if (known !== undefined) checkChromeVersion(known, input);

  // chromedriver resolution and boot overlap Chrome's boot.
  const serviceStart = input.service.start();
  serviceStart.catch(() => {});

  let chrome: LaunchedChrome | undefined;
  let transport: BiDiTransport | undefined;
  try {
    chrome = await launchChrome({
      binary,
      headless: input.headless,
      args: input.args,
      prefs: input.prefs,
    });

    const { major, initialTab } = await inspectChrome(chrome);
    if (major !== undefined) knownMajors.set(binary, major);
    checkChromeVersion(major, input);

    const caps = { unhandledPromptBehavior: input.unhandledPromptBehavior };
    transport = await startInProcessMapper(chrome.wsUrl, { capabilities: caps });

    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port: 0 };
    const placeholder = `pending-attach-${crypto.randomUUID()}`;
    const launched = chrome;
    const ready = (async () => {
      await serviceStart;
      const attached = await attachChromedriver(
        input.service,
        {
          browserName: 'chrome',
          unhandledPromptBehavior: input.unhandledPromptBehavior,
          'goog:chromeOptions': { debuggerAddress: launched.debuggerAddress },
        },
        launched,
        initialTab
      );
      Object.assign(endpoint, attached.endpoint);
      return attached.sessionId;
    })();
    // Nobody may be awaiting yet; the first Classic command (or quit) observes it.
    ready.catch(() => {});
    endpoint.pendingSession = { placeholder, ready };

    return { driver: new Driver(endpoint, placeholder), transport, chrome };
  } catch (err) {
    if (!input.forced && !(err instanceof HybridUnavailableError)) failedBinaries.add(binary);
    await transport?.close().catch(() => {});
    await serviceStart.catch(() => {});
    await input.service.stop().catch(() => {});
    await chrome?.close().catch(() => {});
    throw err;
  }
}
