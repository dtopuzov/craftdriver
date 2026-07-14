import { DriverService, type DriverServiceOptions } from './service.js';
import { resolveSafariDriver } from './driverManager.js';
import { CraftdriverError, ErrorCode } from './errors.js';

export type SafariServiceOptions = Omit<DriverServiceOptions, 'command'> & {
  /**
   * Absolute path to a `safaridriver` binary.
   * When omitted, craftdriver resolves the driver automatically — but, unlike
   * Chrome/Firefox, **never by downloading**: Safari's WebDriver support ships
   * with macOS/Safari itself. Resolution order (first match wins):
   *   1. this `binaryPath`
   *   2. CRAFTDRIVER_SAFARIDRIVER_PATH env var
   *   3. CRAFTDRIVER_DRIVER_PATH env var
   *   4. /usr/bin/safaridriver (the fixed system location on macOS)
   *   5. safaridriver on PATH
   *   6. a clear, actionable error if nothing resolves (no download fallback)
   *
   * Use this to select Safari Technology Preview's own `safaridriver`, e.g.
   * `/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver`.
   */
  binaryPath?: string;

  /**
   * Extra `safaridriver` CLI arguments, passed through verbatim after the
   * `--port <port>` flag. For example, `args: ['--diagnose']` turns on
   * safaridriver's diagnostic logging (Apple writes the logs under
   * `~/Library/Logs/com.apple.WebDriver/`), which is useful when a Safari
   * session fails to start and the standard stdout/stderr tail isn't enough
   * to tell why.
   */
  args?: string[];
};

export class SafariService extends DriverService {
  private readonly binaryPath: string | undefined;

  constructor(options: SafariServiceOptions = {}) {
    // Platform guard first, before any option handling or filesystem access:
    // safaridriver exists only on macOS (Apple ships no Windows/Linux build),
    // so there is nothing to resolve off-darwin. Fail immediately with a stable
    // machine-readable code rather than letting resolution find nothing and
    // throw a vaguer "not found" later. (There is no path to running real
    // Safari on Linux, ever — Apple ships no Windows/Linux build.)
    if (process.platform !== 'darwin') {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        `browserName: 'safari' is only supported on macOS (this platform is '${process.platform}'). ` +
          'Safari and safaridriver ship only on Apple platforms; there is no Windows or Linux build.',
        { detail: { browserName: 'safari', platform: process.platform } }
      );
    }

    const { binaryPath, ...rest } = options;

    // Pass a placeholder command; the real path is resolved asynchronously in
    // start() (safaridriver serves the standard Classic /status readiness
    // endpoint, same as chromedriver/geckodriver).
    super({
      command: binaryPath ?? 'safaridriver',
      pathBase: '',
      readinessPath: '/status',
      ...rest,
    });
    this.binaryPath = binaryPath;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.opts.command = await resolveSafariDriver({ binaryPath: this.binaryPath });
    await super.start();
  }

  // `DriverService.buildCommandArgs()`'s default is chromedriver/geckodriver's
  // `--port=<port>` (equals-separated). Apple documents safaridriver's flag as
  // space-separated (`safaridriver --port <port>`; see Apple's "Testing with
  // WebDriver in Safari"). An equals-separated
  // `--port=N` is not the documented syntax and risks safaridriver treating the
  // whole thing as an unrecognized single argument. Override to emit the two
  // tokens safaridriver expects, still passing through any extra `args` (e.g.
  // `--diagnose`) untouched.
  protected override buildCommandArgs(port: number): string[] {
    return ['--port', String(port), ...this.opts.args];
  }
}

/**
 * Returns true if `message` looks like the error `safaridriver` produces when
 * a client attempts `POST /session` while "Allow Remote Automation" has not
 * been enabled (Safari's Develop menu, or `safaridriver --enable`).
 *
 * There is no single documented exact string for this — Apple's guidance and
 * community reports describe the wording rather than pin one byte-for-byte
 * wire format, and we don't have a live Safari box to capture the literal
 * response from right now. So this matches defensively on a few likely, distinctive substrings
 * rather than one exact string, case-insensitively, while staying narrow
 * enough not to false-positive on unrelated failures (connection refused,
 * invalid session id, etc.).
 */
export function isRemoteAutomationDisabledError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('remote automation') ||
    (text.includes('automation') && text.includes('develop menu')) ||
    text.includes('safaridriver --enable')
  );
}

/**
 * Returns true if `message` looks like the error `safaridriver` produces when
 * a client attempts `POST /session` while another Safari WebDriver session is
 * already active. Per Apple's documented constraint: only one Safari browser
 * instance can be under automation at a
 * time, and only one WebDriver session can attach to it — a second `POST
 * /session` is refused by `safaridriver` itself, not something craftdriver
 * controls.
 *
 * As with {@link isRemoteAutomationDisabledError}, there is no live Safari box
 * to capture the literal wire text from right now, so this matches
 * defensively on a few likely, distinctive substrings rather than one exact
 * string, case-insensitively. `safaridriver` reports this as a W3C `session
 * not created` error whose message body indicates an existing/active
 * session — so this checks for "session" together with "already"/"active"/"in
 * progress" wording, which is narrow enough not to false-positive on an
 * unrelated `session not created` failure such as a genuine crash-at-launch
 * (those don't mention an existing session at all).
 */
export function isSecondSessionRefusedError(message: string): boolean {
  const text = message.toLowerCase();
  if (!text.includes('session')) return false;
  return (
    (text.includes('already') && (text.includes('active') || text.includes('session'))) ||
    text.includes('session already') ||
    (text.includes('in progress') && text.includes('session')) ||
    text.includes('only one') ||
    (text.includes('another') && text.includes('session'))
  );
}

/**
 * Augments a session-creation failure with Safari's remedy when it matches
 * {@link isRemoteAutomationDisabledError} (checked first, since it is the more
 * specific/common failure) or {@link isSecondSessionRefusedError}; otherwise
 * returns the error unchanged.
 *
 * Wired into `Builder.build()`'s session-creation failure path:
 * when constructing a Safari session fails, this is called on the thrown
 * error before it propagates to the caller.
 *
 * Deliberately does **not** run `safaridriver --enable` itself: that flips a
 * security setting and may prompt for administrator authentication, which
 * library code must never do on the user's behalf. Likewise, the second-
 * session case is deliberately message augmentation only — no in-process
 * queue, retry loop, or wait-for-other-session-to-close logic. An in-process
 * queue cannot coordinate across separate test-runner processes (the common
 * case — parallel CI workers, separate `vitest`/`playwright` processes) and
 * risks `launch()` hanging indefinitely waiting for another process's Safari
 * session to close.
 */
export function augmentSafariSessionError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err));

  if (isRemoteAutomationDisabledError(original.message)) {
    return new Error(
      `${original.message}\n` +
        'Remedy: Safari WebDriver automation is not enabled. Run `safaridriver --enable`, ' +
        'or open Safari and enable Develop → Allow Remote Automation, then retry. ' +
        'craftdriver does not run this for you — it changes a security setting and may ' +
        'require administrator authentication.',
      { cause: original }
    );
  }

  if (isSecondSessionRefusedError(original.message)) {
    return new Error(
      `${original.message}\n` +
        'Remedy: only one Safari WebDriver session can be active at a time — this is ' +
        "Safari's automation model, not a craftdriver limitation. Run Safari tests " +
        'serially on this Mac (e.g. `npm run test:safari`, which already forces ' +
        '--maxWorkers=1); do not launch a second Safari session while one is still open. ' +
        'For concurrent Safari coverage, use separate macOS hosts, or run one additional ' +
        'session in Safari Technology Preview alongside stable Safari (each has its own ' +
        'safaridriver, so the two can run one session each at the same time).',
      { cause: original }
    );
  }

  return original;
}
