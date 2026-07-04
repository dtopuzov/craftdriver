import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Driver } from '../src/lib/driver.js';
import { Builder } from '../src/lib/builder.js';
import { ChromeService } from '../src/lib/chrome.js';

function cftPlatformForTest(): string {
  const p = os.platform();
  const a = os.arch();
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (p === 'win32') return a === 'x64' ? 'win64' : 'win32';
  return a === 'arm64' ? 'linux-aarch64' : 'linux64';
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

class FakeChromeService extends ChromeService {
  startCalls = 0;
  stopCalls = 0;
  private server?: http.Server;

  constructor(
    private readonly staleDriverPath: string,
    private readonly freshDriverPath: string,
  ) {
    super();
  }

  override async start(): Promise<void> {
    if (this.server) return;
    this.startCalls++;
    const generation = this.startCalls;
    this.opts.command = generation === 1 ? this.staleDriverPath : this.freshDriverPath;

    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/session') {
        if (generation === 1) {
          writeJson(res, 500, {
            value: {
              error: 'session not created',
              message:
                'session not created: This version of ChromeDriver only supports Chrome version 139',
            },
          });
          return;
        }

        writeJson(res, 200, {
          value: {
            sessionId: 'fresh-session',
            capabilities: { browserName: 'chrome' },
          },
        });
        return;
      }

      if (req.method === 'DELETE' && req.url === '/session/fresh-session') {
        writeJson(res, 200, { value: null });
        return;
      }

      writeJson(res, 404, { value: { error: 'unknown command', message: req.url } });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (typeof address !== 'object' || !address) throw new Error('No fake service port');
        this.endpoint = {
          protocol: 'http',
          hostname: '127.0.0.1',
          port: address.port,
          path: '',
        };
        resolve();
      });
    });
  }

  override async stop(): Promise<void> {
    if (!this.server) return;
    this.stopCalls++;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('chromedriver auto-resolution cache recovery', () => {
  const envCacheDir = process.env.CRAFTDRIVER_CACHE_DIR;
  let cacheDir: string | undefined;

  afterEach(() => {
    if (envCacheDir === undefined) {
      delete process.env.CRAFTDRIVER_CACHE_DIR;
    } else {
      process.env.CRAFTDRIVER_CACHE_DIR = envCacheDir;
    }
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = undefined;
  });

  it('invalidates a stale cached chromedriver path and retries launch once', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-cache-retry-'));
    process.env.CRAFTDRIVER_CACHE_DIR = cacheDir;

    const staleDriverPath = path.join(cacheDir, 'chromedriver-139');
    const freshDriverPath = path.join(cacheDir, 'chromedriver-140');
    fs.writeFileSync(staleDriverPath, '');
    fs.writeFileSync(freshDriverPath, '');

    const cacheKey = `chromedriver/${cftPlatformForTest()}`;
    fs.writeFileSync(
      path.join(cacheDir, 'metadata.json'),
      JSON.stringify({
        [cacheKey]: {
          version: '139.0.0.0',
          driverPath: staleDriverPath,
          timestamp: Date.now(),
        },
      }),
    );

    const service = new FakeChromeService(staleDriverPath, freshDriverPath);
    let driver: Driver | undefined;
    try {
      driver = await new Builder()
        .forBrowser('chrome')
        .setChromeService(service)
        .build();

      expect(service.startCalls).toBe(2);
      expect(service.stopCalls).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(cacheDir, 'metadata.json'), 'utf-8'))[cacheKey])
        .toBeUndefined();
    } finally {
      await driver?.quit();
      await service.stop();
    }
  });
});
