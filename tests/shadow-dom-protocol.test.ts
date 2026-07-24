import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { By } from '../src/lib/by.js';
import { Driver } from '../src/lib/driver.js';
import { CraftdriverError, ErrorCode } from '../src/lib/errors.js';
import { HttpClient } from '../src/lib/http.js';
import { Locator } from '../src/lib/locator.js';
import { ClassicShadowRoot, W3C_SHADOW_ROOT_KEY } from '../src/lib/shadowRoot.js';
import type { WebDriverEndpoint } from '../src/lib/types.js';
import { W3C_ELEMENT_KEY } from '../src/lib/webelement.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

const unusedEndpoint: WebDriverEndpoint = {
  protocol: 'http',
  hostname: '127.0.0.1',
  port: 9,
};

describe('Shadow DOM wire references', () => {
  it('preserves a null Execute Script result for the public shadowRoot getter', async () => {
    const server = http.createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: null }));
    });
    const port = await listen(server);
    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port };
    const driver = new Driver(endpoint, 'session');

    try {
      await expect(driver.executeScript('return arguments[0].shadowRoot;', []))
        .resolves.toBeNull();
    } finally {
      new HttpClient(endpoint).close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('recursively deserializes element and shadow-root references', () => {
    const driver = new Driver(unusedEndpoint, 'session');
    const value = driver.deserializeWireValue<{
      list: unknown[];
      nested: { root: ClassicShadowRoot };
    }>({
      list: [{ [W3C_ELEMENT_KEY]: 'element-1' }],
      nested: { root: { [W3C_SHADOW_ROOT_KEY]: 'root-1' } },
    });

    expect((value.list[0] as { getId(): string }).getId()).toBe('element-1');
    expect(value.nested.root).toBeInstanceOf(ClassicShadowRoot);
    expect(value.nested.root.getId()).toBe('root-1');
  });

  it('uses the exact W3C get-root and find-from-root routes', async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          ...(text ? { body: JSON.parse(text) } : {}),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url?.endsWith('/shadow')) {
          res.end(JSON.stringify({ value: { [W3C_SHADOW_ROOT_KEY]: 'root-7' } }));
        } else if (req.url?.endsWith('/element')) {
          res.end(JSON.stringify({ value: { [W3C_ELEMENT_KEY]: 'child-1' } }));
        } else {
          res.end(JSON.stringify({ value: [{ [W3C_ELEMENT_KEY]: 'child-2' }] }));
        }
      });
    });
    const port = await listen(server);
    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port };
    const driver = new Driver(endpoint, 'session-1');

    try {
      const root = await driver.getElementShadowRoot(driver.webElementFromId('host-4'));
      const first = await root.findElement(By.css('.first'));
      const elements = await root.findElements(By.css('.save'));

      expect(first.getId()).toBe('child-1');
      expect(elements.map((element) => element.getId())).toEqual(['child-2']);
      expect(requests).toEqual([
        {
          method: 'GET',
          url: '/session/session-1/element/host-4/shadow',
        },
        {
          method: 'POST',
          url: '/session/session-1/shadow/root-7/element',
          body: { using: 'css selector', value: '.first' },
        },
        {
          method: 'POST',
          url: '/session/session-1/shadow/root-7/elements',
          body: { using: 'css selector', value: '.save' },
        },
      ]);
    } finally {
      new HttpClient(endpoint).close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Shadow DOM transport selection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the public getter root as a BiDi locateNodes start node', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    vi.spyOn(driver, 'findElement').mockResolvedValue(driver.webElementFromId('host'));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const connection = {
      send: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'script.callFunction') {
          return {
            type: 'success',
            realm: 'realm',
            result: {
              type: 'node',
              sharedId: 'open-root',
              value: { nodeType: 11, childNodeCount: 1 },
            },
          };
        }
        return {
          nodes: [{
            type: 'node',
            sharedId: 'button-1',
            value: { nodeType: 1, childNodeCount: 0 },
          }],
        };
      },
    };

    const count = await new Locator(driver, By.css('#host'))
      .withBiDi(() => ({ connection: connection as never, contextId: 'context-3' }))
      .shadowRoot()
      .locator('.save')
      .count();

    expect(count).toBe(1);
    expect(calls[0]).toMatchObject({
      method: 'script.callFunction',
      params: {
        target: { context: 'context-3' },
        arguments: [{ sharedId: 'host' }],
      },
    });
    expect(calls[1]).toEqual({
      method: 'browsingContext.locateNodes',
      params: {
        context: 'context-3',
        locator: { type: 'css', value: '.save' },
        startNodes: [{ sharedId: 'open-root' }],
      },
    });
  });

  it('passes semantic locator values as BiDi data instead of executable code', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    vi.spyOn(driver, 'findElement').mockResolvedValue(driver.webElementFromId('host'));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let scriptCalls = 0;
    const connection = {
      send: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        scriptCalls += 1;
        if (scriptCalls === 1) {
          return {
            type: 'success',
            realm: 'realm',
            result: {
              type: 'node',
              sharedId: 'open-root',
              value: { nodeType: 11, childNodeCount: 1 },
            },
          };
        }
        return {
          type: 'success',
          realm: 'realm',
          result: { type: 'array', value: [] },
        };
      },
    };
    const text = '</script>"; globalThis.compromised = true; //\u2028';
    const by = By.text(text);

    const count = await new Locator(driver, By.css('#host'))
      .withBiDi(() => ({ connection: connection as never, contextId: 'context-3' }))
      .shadowRoot()
      .locator(by)
      .count();

    expect(count).toBe(0);
    expect(calls[1]).toMatchObject({
      method: 'script.callFunction',
      params: {
        arguments: [
          { sharedId: 'open-root' },
          { type: 'string', value: JSON.stringify(by.descriptor) },
        ],
      },
    });
    expect(calls[1].params.functionDeclaration).not.toContain(text);
    expect(calls[1].params.functionDeclaration).toContain('JSON.parse(queryJson)');
  });

  it('restarts the complete plan through Classic and caches unsupported BiDi', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = driver.webElementFromId('host');
    const child = driver.webElementFromId('classic-child');
    const findHost = vi.spyOn(driver, 'findElement').mockResolvedValue(host);
    vi.spyOn(driver, 'executeScript').mockResolvedValue(driver.shadowRootFromId('classic-root'));
    const findClassic = vi.spyOn(driver, 'findElementsFromShadowRoot').mockResolvedValue([child]);
    let bidiCalls = 0;
    const connection = {
      send: async (method: string) => {
        bidiCalls += 1;
        if (method === 'script.callFunction') {
          return {
            type: 'success',
            realm: 'realm',
            result: {
              type: 'node',
              sharedId: 'bidi-root',
              value: { nodeType: 11, childNodeCount: 1 },
            },
          };
        }
        throw new Error('BiDi error [unknown command]: locateNodes unsupported');
      },
    };
    const locator = new Locator(driver, By.css('#host'))
      .withBiDi(() => ({ connection: connection as never, contextId: 'context' }))
      .shadowRoot()
      .locator('.save');

    expect(await locator.count()).toBe(1);
    expect(findHost).toHaveBeenCalledTimes(2);
    expect(findClassic).toHaveBeenCalledWith('classic-root', expect.objectContaining({ value: '.save' }));
    const callsAfterFallback = bidiCalls;

    expect(await locator.count()).toBe(1);
    expect(bidiCalls).toBe(callsAfterFallback);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('using WebDriver Classic shadow-root commands')
    );
  });

  it('never calls a protocol root endpoint when the public getter is null', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    vi.spyOn(driver, 'findElement').mockResolvedValue(driver.webElementFromId('closed-host'));
    vi.spyOn(driver, 'executeScript').mockResolvedValue(null);
    const getRoot = vi.spyOn(driver, 'getElementShadowRoot');

    const error = await new Locator(driver, By.css('#closed'))
      .shadowRoot()
      .locator('button')
      .count()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CraftdriverError);
    expect((error as CraftdriverError).code).toBe(ErrorCode.NO_OPEN_SHADOW_ROOT);
    expect(getRoot).not.toHaveBeenCalled();
  });

  it('uses the guarded get-root fallback when script cannot deserialize a root', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    const host = driver.webElementFromId('host');
    vi.spyOn(driver, 'findElement').mockResolvedValue(host);
    vi.spyOn(driver, 'executeScript').mockResolvedValue({ mode: 'open' } as never);
    const getRoot = vi
      .spyOn(driver, 'getElementShadowRoot')
      .mockResolvedValue(driver.shadowRootFromId('fallback-root'));
    vi.spyOn(driver, 'findElementsFromShadowRoot').mockResolvedValue([
      driver.webElementFromId('child'),
    ]);

    const count = await new Locator(driver, By.css('#host'))
      .shadowRoot()
      .locator('.child')
      .count();

    expect(count).toBe(1);
    expect(getRoot).toHaveBeenCalledWith(host);
  });

  it('keeps DETACHED_SHADOW_ROOT after retries and reports the attempt count', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    vi.spyOn(driver, 'findElement').mockResolvedValue(driver.webElementFromId('host'));
    vi.spyOn(driver, 'executeScript').mockResolvedValue(driver.shadowRootFromId('root'));
    vi.spyOn(driver, 'findElementsFromShadowRoot').mockRejectedValue(
      new CraftdriverError(ErrorCode.DRIVER_ERROR, 'detached', {
        detail: { webDriverError: 'detached shadow root' },
      })
    );

    const error = await new Locator(driver, By.css('#host'), () => 0)
      .shadowRoot()
      .locator('button')
      .text({ timeout: 0 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CraftdriverError);
    expect((error as CraftdriverError).code).toBe(ErrorCode.DETACHED_SHADOW_ROOT);
    expect((error as CraftdriverError).detail?.attempts).toBe(1);
  });

  it('restarts an action after a transient detached-root lookup', async () => {
    const driver = new Driver(unusedEndpoint, 'session');
    const host = driver.webElementFromId('host');
    const child = driver.webElementFromId('child');
    vi.spyOn(driver, 'findElement').mockResolvedValue(host);
    vi.spyOn(driver, 'executeScript').mockResolvedValue(driver.shadowRootFromId('root'));
    const findInRoot = vi.spyOn(driver, 'findElementsFromShadowRoot')
      .mockRejectedValueOnce(
        new CraftdriverError(ErrorCode.DRIVER_ERROR, 'detached', {
          detail: { webDriverError: 'detached shadow root' },
        })
      )
      .mockResolvedValue([child]);
    vi.spyOn(child, 'isDisplayed').mockResolvedValue(true);
    const click = vi.spyOn(child, 'click').mockResolvedValue();

    await new Locator(driver, By.css('#host'), () => 100)
      .shadowRoot()
      .locator('button')
      .click();

    expect(findInRoot).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledOnce();
  });
});
