/**
 * Deep-link (custom protocol) triggering for Electron — the pure, testable logic
 * behind `browser.electron.triggerDeeplink(url)`. It opens a `myapp://…` URL the
 * way an external app would (macOS `open`, Linux `gio open`, Windows `rundll32`),
 * so the running app's real `open-url` / `second-instance` handler fires.
 *
 * The OS launcher and platform routing are separated from the transport so they
 * can be unit-tested without a live app (see tests/electron-deeplink.test.ts).
 */
import { spawn } from 'node:child_process';
import { CraftdriverError, ErrorCode } from './errors.js';

/** Protocols that are *not* custom deep links — routing these would hit a browser/FS, not the app. */
const DISALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/**
 * Validate a deep-link URL: it must parse and use a custom scheme (not
 * http/https/file). Returns the URL unchanged on success.
 */
export function validateDeeplinkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `triggerDeeplink(url): "${url}" is not a valid URL.`,
      { hint: 'Pass a custom-protocol URL such as myapp://open?file=test.txt.' }
    );
  }
  if (DISALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `triggerDeeplink(url): "${parsed.protocol.slice(0, -1)}" is not a deep-link protocol.`,
      {
        hint: 'Use your app’s registered custom protocol (e.g. myapp://), not http/https/file.',
        detail: { protocol: parsed.protocol.slice(0, -1) },
      }
    );
  }
  return url;
}

/**
 * Append (or overwrite) a `userData` query parameter carrying the running app's
 * user-data dir. On Windows and Linux a fresh `open` would spawn a *second*
 * instance; the app reads this parameter to point the second instance at the same
 * user-data dir so the single-instance lock routes the URL to the test instance.
 */
export function appendUserDataDir(url: string, userDataDir: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('userData', userDataDir);
  return parsed.toString();
}

/** OS launcher command + args for a deep-link URL, per platform. */
export function getPlatformCommand(
  url: string,
  platform: NodeJS.Platform,
  appBinaryPath?: string
): { command: string; args: string[] } {
  switch (platform) {
    case 'darwin':
      // `open` re-encodes the query when handing off to the protocol handler, so
      // decode our appended query once to avoid double-encoding.
      return { command: 'open', args: [decodeQueryOnce(url)] };
    case 'linux':
      return { command: 'gio', args: ['open', url] };
    case 'win32':
      if (!appBinaryPath) {
        throw new CraftdriverError(
          ErrorCode.ELECTRON_DEEPLINK_FAILED,
          'triggerDeeplink requires the app binary path on Windows to route the deep link.',
          {
            hint: 'Launch via Browser.launch({ electron: { appBinaryPath } }) so the running instance is targeted.',
          }
        );
      }
      // rundll32's FileProtocolHandler avoids cmd.exe metacharacter interpretation (e.g. &).
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
    default:
      throw new CraftdriverError(
        ErrorCode.ELECTRON_DEEPLINK_FAILED,
        `triggerDeeplink does not support platform "${platform}".`,
        { hint: 'Supported platforms are macOS (darwin), Linux, and Windows (win32).' }
      );
  }
}

/** Decode the query component once so `open` re-encodes it exactly once on hand-off. */
function decodeQueryOnce(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const base = url.slice(0, q);
  try {
    return `${base}?${decodeURIComponent(url.slice(q + 1))}`;
  } catch {
    return url;
  }
}

/** Spawn the OS launcher detached (fire-and-forget); rejects only if the spawn itself fails. */
export function executeDeeplinkCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(
          new CraftdriverError(
            ErrorCode.ELECTRON_DEEPLINK_FAILED,
            `Failed to run the deep-link launcher "${command}": ${error.message}`,
            { cause: error, detail: { command } }
          )
        );
      });
      // The launcher exits quickly; resolve on next tick once no synchronous error fired.
      process.nextTick(() => {
        if (settled) return;
        settled = true;
        resolve();
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      reject(
        new CraftdriverError(
          ErrorCode.ELECTRON_DEEPLINK_FAILED,
          `Failed to run the deep-link launcher "${command}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error, detail: { command } }
        )
      );
    }
  });
}

/** Resolve the final URL to hand to the OS launcher for the given platform. */
export function resolveDeeplinkUrl(
  url: string,
  platform: NodeJS.Platform,
  userDataDir?: string
): string {
  const validated = validateDeeplinkUrl(url);
  // Only Windows/Linux need the second-instance routing hint; macOS `open-url`
  // reaches the running instance directly.
  if ((platform === 'win32' || platform === 'linux') && userDataDir) {
    return appendUserDataDir(validated, userDataDir);
  }
  return validated;
}
