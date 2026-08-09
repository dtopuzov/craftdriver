import { afterEach, describe, expect, it, vi } from 'vitest';
import { Builder } from '../src/lib/builder.js';
import { ChromeService } from '../src/lib/chrome.js';
import { Driver } from '../src/lib/driver.js';
import { CraftdriverError, ErrorCode } from '../src/lib/errors.js';

class StubChromeService extends ChromeService {
  startCalls = 0;
  stopCalls = 0;

  constructor(
    private readonly outputTails: string[] = [],
    private readonly replacementStartError?: Error
  ) {
    super({ binaryPath: '/tmp/craftdriver-test-chromedriver' });
  }

  override async start(): Promise<void> {
    this.startCalls++;
    if (this.startCalls === 2 && this.replacementStartError) {
      throw this.replacementStartError;
    }
    this.endpoint = {
      protocol: 'http',
      hostname: '127.0.0.1',
      port: 9500 + this.startCalls,
      path: '',
    };
  }

  override async stop(): Promise<void> {
    this.stopCalls++;
  }

  override getOutputTail(): string {
    return this.outputTails[this.startCalls - 1] ?? '';
  }
}

class StubElectronLikeService extends StubChromeService {
  override allowsFreshSessionRetry(): boolean {
    return false;
  }
}

function sessionTimeout(): CraftdriverError {
  return new CraftdriverError(
    ErrorCode.DRIVER_ERROR,
    'WebDriver command POST /session timed out after 30000ms waiting for a response',
    { detail: { method: 'POST', path: '/session', timeoutMs: 30_000 } }
  );
}

function sessionFailure(): CraftdriverError {
  return new CraftdriverError(
    ErrorCode.DRIVER_ERROR,
    'WebDriver command POST /session failed — session not created',
    { detail: { method: 'POST', path: '/session', status: 500 } }
  );
}

describe('Builder local Chrome session recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces the local driver process once after a structured session timeout', async () => {
    const service = new StubChromeService();
    const driver = { quit: vi.fn() } as unknown as Driver;
    vi.spyOn(Driver, 'create')
      .mockRejectedValueOnce(sessionTimeout())
      .mockResolvedValueOnce(driver);

    await expect(
      new Builder().forBrowser('chrome').setChromeService(service).build()
    ).resolves.toBe(driver);
    expect(Driver.create).toHaveBeenCalledTimes(2);
    expect(service.startCalls).toBe(2);
    expect(service.stopCalls).toBe(1);
  });

  it('retains both attempts and bounded driver output when the retry fails', async () => {
    const service = new StubChromeService(['first driver tail', 'second driver tail']);
    vi.spyOn(Driver, 'create').mockRejectedValue(sessionTimeout());

    let caught: unknown;
    try {
      await new Builder().forBrowser('chrome').setChromeService(service).build();
    } catch (err) {
      caught = err;
    }

    expect(CraftdriverError.is(caught, ErrorCode.DRIVER_ERROR)).toBe(true);
    const error = caught as CraftdriverError;
    expect(Driver.create).toHaveBeenCalledTimes(2);
    expect(service.startCalls).toBe(2);
    expect(service.stopCalls).toBe(2);
    expect(error.message).toContain('Local Chrome session diagnostics (2 attempts)');
    expect(error.message).toContain('first driver tail');
    expect(error.message).toContain('second driver tail');
    expect(error.detail?.sessionAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        phase: 'session-create',
        driverPath: '/tmp/craftdriver-test-chromedriver',
        endpoint: 'http://127.0.0.1:9501',
        driverOutputTail: 'first driver tail',
      }),
      expect.objectContaining({
        attempt: 2,
        phase: 'session-create',
        driverPath: '/tmp/craftdriver-test-chromedriver',
        endpoint: 'http://127.0.0.1:9502',
        driverOutputTail: 'second driver tail',
      }),
    ]);
  });

  it('does not retry an ordinary session-creation failure', async () => {
    const service = new StubChromeService();
    vi.spyOn(Driver, 'create').mockRejectedValueOnce(sessionFailure());

    await expect(
      new Builder().forBrowser('chrome').setChromeService(service).build()
    ).rejects.toThrow('session not created');
    expect(Driver.create).toHaveBeenCalledTimes(1);
    expect(service.startCalls).toBe(1);
    expect(service.stopCalls).toBe(1);
  });

  it('retains the timed-out attempt when the replacement driver cannot start', async () => {
    const service = new StubChromeService(
      ['first driver tail', 'replacement startup tail'],
      new Error('replacement driver exited before ready')
    );
    vi.spyOn(Driver, 'create').mockRejectedValueOnce(sessionTimeout());

    let caught: unknown;
    try {
      await new Builder().forBrowser('chrome').setChromeService(service).build();
    } catch (err) {
      caught = err;
    }

    expect(CraftdriverError.is(caught, ErrorCode.DRIVER_ERROR)).toBe(true);
    const error = caught as CraftdriverError;
    expect(Driver.create).toHaveBeenCalledTimes(1);
    expect(service.startCalls).toBe(2);
    expect(error.message).toContain('replacement driver exited before ready');
    expect(error.detail?.sessionAttempts).toEqual([
      expect.objectContaining({ attempt: 1, phase: 'session-create' }),
      expect.objectContaining({
        attempt: 2,
        phase: 'driver-start',
        driverOutputTail: 'replacement startup tail',
      }),
    ]);
  });

  it('does not apply the Chrome retry policy to an Electron-like service', async () => {
    const service = new StubElectronLikeService();
    vi.spyOn(Driver, 'create').mockRejectedValueOnce(sessionTimeout());

    await expect(
      new Builder().forBrowser('chrome').setChromeService(service).build()
    ).rejects.toThrow('timed out after 30000ms');
    expect(Driver.create).toHaveBeenCalledTimes(1);
    expect(service.startCalls).toBe(1);
    expect(service.stopCalls).toBe(1);
  });
});
