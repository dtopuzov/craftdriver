/**
 * Hybrid Chrome launch: craftdriver starts Chrome itself, runs the BiDi mapper
 * in-process, and attaches chromedriver to the running browser for Classic
 * commands.
 *
 * `Browser.launch` resolves as soon as BiDi is ready. chromedriver keeps
 * attaching in the background; the first Classic command waits for it (see
 * `WebDriverEndpoint.pendingSession`). Only local, chrome-family, BiDi
 * launches can take this path; everything else uses chromedriver to launch
 * Chrome as before.
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

export type ChromeLaunchMode = 'auto' | 'chromedriver' | 'hybrid';

/** Env default for {@link ChromeLaunchMode}; the `chromeLaunchMode` option wins. */
export const CHROME_LAUNCH_MODE_ENV = 'CRAFTDRIVER_CHROME_LAUNCH_MODE';

const MODES: readonly ChromeLaunchMode[] = ['auto', 'chromedriver', 'hybrid'];

/** Oldest Chrome major the vendored mapper is verified against. */
export const MAPPER_MIN_CHROME_MAJOR: number = manifest.chromeSupport.minMajor;

export interface ChromeLaunchRouteInput {
  kind: 'browser' | 'electron' | 'remote';
  browserName: string;
  bidiRequested: boolean;
  /** `LaunchOptions.chromeLaunchMode`, unvalidated. */
  option?: unknown;
  /** `process.env[CHROME_LAUNCH_MODE_ENV]`. */
  env?: string;
  mobileEmulation: boolean;
  args?: readonly string[];
}

export type ChromeLaunchRoute =
  { path: 'hybrid'; strict: boolean } | { path: 'chromedriver'; reason: string };

function parseMode(value: unknown, source: string): ChromeLaunchMode | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && (MODES as readonly string[]).includes(value)) {
    return value as ChromeLaunchMode;
  }
  throw new CraftdriverError(
    ErrorCode.INVALID_ARGUMENT,
    `${source} must be one of ${MODES.map((m) => `'${m}'`).join(', ')} (got ${JSON.stringify(value)}).`
  );
}

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
 * An explicit `chromeLaunchMode: 'hybrid'` is strict: an unroutable launch
 * throws `UNSUPPORTED` with the reason. The env var is a default for a whole
 * run, so launches it can't apply to (Firefox, mobile emulation, ...) quietly
 * keep the chromedriver path. `'auto'` currently means `'chromedriver'`.
 */
export function chooseChromeLaunchPath(input: ChromeLaunchRouteInput): ChromeLaunchRoute {
  const option = parseMode(input.option, 'chromeLaunchMode');
  const env = parseMode(input.env, CHROME_LAUNCH_MODE_ENV);
  const mode = option ?? env ?? 'auto';
  if (mode !== 'hybrid') {
    return { path: 'chromedriver', reason: `chromeLaunchMode is '${mode}'` };
  }
  const strict = option === 'hybrid';
  const blocker = hybridBlocker(input);
  if (!blocker) return { path: 'hybrid', strict };
  if (strict) {
    throw new CraftdriverError(
      ErrorCode.UNSUPPORTED,
      `chromeLaunchMode 'hybrid' is not available for this launch: ${blocker}.`,
      { hint: "Omit chromeLaunchMode or set it to 'chromedriver'." }
    );
  }
  return { path: 'chromedriver', reason: blocker };
}

/** Raised when an env-requested hybrid launch can't proceed and should fall back. */
export class HybridUnavailableError extends Error {}

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
  strict: boolean;
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

function unavailable(strict: boolean, message: string): Error {
  return strict
    ? new CraftdriverError(ErrorCode.UNSUPPORTED, message, {
        hint: "Omit chromeLaunchMode or set it to 'chromedriver'.",
      })
    : new HybridUnavailableError(message);
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
    throw unavailable(input.strict, 'Could not find a Chrome/Chromium installation to launch.');
  }

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
    if (major !== undefined && major < MAPPER_MIN_CHROME_MAJOR) {
      throw unavailable(
        input.strict,
        `chromeLaunchMode 'hybrid' needs Chrome ${MAPPER_MIN_CHROME_MAJOR} or newer (found ${major}).`
      );
    }

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
    await transport?.close().catch(() => {});
    await serviceStart.catch(() => {});
    await input.service.stop().catch(() => {});
    await chrome?.close().catch(() => {});
    throw err;
  }
}
