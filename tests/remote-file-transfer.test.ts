/**
 * Remote file upload: `setInputFiles()` can't send a local path directly to a
 * remote session (the path doesn't exist on the grid node), so it zips the
 * file and uploads it through Selenium's `se/file` extension, then
 * `sendKeys()`s the remote path(s) returned. Exercised against a small
 * in-process fake grid implementing just the element/file-input surface
 * `setInputFiles()` touches. The local branch (`driver.isRemote() === false`)
 * is asserted unchanged via a stub driver, no real browser needed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Driver } from '../src/lib/driver.js';
import { ElementHandle } from '../src/lib/elementHandle.js';
import { By } from '../src/lib/by.js';
import { W3C_ELEMENT_KEY } from '../src/lib/webelement.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

interface FileInputGridOptions {
  /** value returned by GET .../attribute/type — defaults to 'file' */
  inputType?: string;
}

class FakeFileInputGrid {
  server: http.Server;
  sendKeysPayloads: string[] = [];
  uploadedZips: string[] = [];
  private elementId = 'elem-1';

  constructor(private opts: FileInputGridOptions = {}) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<number> {
    return listen(this.server);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : undefined;
      const method = req.method!;
      const url = req.url!;
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value }));
      };

      if (method === 'POST' && url === '/session') {
        return json(200, { sessionId: 'sess-1', capabilities: {} });
      }
      if (method === 'POST' && url === '/session/sess-1/element') {
        return json(200, { [W3C_ELEMENT_KEY]: this.elementId });
      }
      if (method === 'GET' && url === `/session/sess-1/element/${this.elementId}/name`) {
        return json(200, 'input');
      }
      if (method === 'GET' && url === `/session/sess-1/element/${this.elementId}/attribute/type`) {
        return json(200, this.opts.inputType ?? 'file');
      }
      if (method === 'POST' && url === `/session/sess-1/element/${this.elementId}/value`) {
        this.sendKeysPayloads.push(body.text);
        return json(200, null);
      }
      if (method === 'POST' && url === '/session/sess-1/se/file') {
        this.uploadedZips.push(body.file);
        const uploadedIndex = this.uploadedZips.length;
        return json(200, `/remote/tmp/upload-${uploadedIndex}`);
      }
      return json(200, 'ok');
    });
  }
}

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-remote-upload-'));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

/**
 * Assert an uploaded `se/file` payload is a real zip carrying exactly the
 * expected filename at its root — not merely "some non-empty base64 string".
 * A zip local-file-header starts with the `PK\x03\x04` magic, and the entry's
 * filename is stored uncompressed in that header, so it's directly findable in
 * the decoded bytes.
 */
function expectZipWithFile(base64: string, filename: string): void {
  const buf = Buffer.from(base64, 'base64');
  expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(buf.includes(Buffer.from(filename, 'utf8'))).toBe(true);
}

describe('setInputFiles() — remote upload', () => {
  let grid: FakeFileInputGrid | undefined;

  afterEach(async () => {
    if (grid) await grid.close();
    grid = undefined;
  });

  it('zips and uploads a single file via se/file, then sendKeys() the remote path', async () => {
    grid = new FakeFileInputGrid();
    const port = await grid.listen();
    // poolKey stamped so driver.isRemote() reports true, matching how
    // parseRemoteEndpoint() marks a real remote endpoint.
    const driver = await Driver.create(
      { protocol: 'http', hostname: '127.0.0.1', port, poolKey: 'test-pool-key' },
      { browserName: 'chrome' }
    );
    const filePath = await writeTempFile('hello.txt', 'hello world');

    const handle = new ElementHandle(driver, By.css('input[type=file]'));
    await handle.setInputFiles(filePath);

    expect(grid.uploadedZips).toHaveLength(1);
    expectZipWithFile(grid.uploadedZips[0], 'hello.txt');
    expect(grid.sendKeysPayloads).toEqual(['/remote/tmp/upload-1']);
  });

  it('joins multiple uploaded remote paths with \\n', async () => {
    grid = new FakeFileInputGrid();
    const port = await grid.listen();
    const driver = await Driver.create(
      { protocol: 'http', hostname: '127.0.0.1', port, poolKey: 'test-pool-key' },
      { browserName: 'chrome' }
    );
    const fileA = await writeTempFile('a.txt', 'aaa');
    const fileB = await writeTempFile('b.txt', 'bbb');

    const handle = new ElementHandle(driver, By.css('input[type=file]'));
    await handle.setInputFiles([fileA, fileB]);

    expect(grid.uploadedZips).toHaveLength(2);
    expect(grid.sendKeysPayloads).toEqual(['/remote/tmp/upload-1\n/remote/tmp/upload-2']);
  });

  it('local sessions (driver.isRemote() === false) are unaffected — no zip/upload, raw path sent directly', async () => {
    grid = new FakeFileInputGrid();
    const port = await grid.listen();
    // No poolKey → driver.isRemote() === false, exactly like a local endpoint.
    const driver = await Driver.create(
      { protocol: 'http', hostname: '127.0.0.1', port },
      { browserName: 'chrome' }
    );
    const filePath = await writeTempFile('local.txt', 'local');

    const handle = new ElementHandle(driver, By.css('input[type=file]'));
    await handle.setInputFiles(filePath);

    expect(grid.uploadedZips).toHaveLength(0);
    expect(grid.sendKeysPayloads).toEqual([filePath]);
  });

  it('still rejects a non-file input on a remote session before attempting any upload', async () => {
    grid = new FakeFileInputGrid({ inputType: 'text' });
    const port = await grid.listen();
    const driver = await Driver.create(
      { protocol: 'http', hostname: '127.0.0.1', port, poolKey: 'test-pool-key' },
      { browserName: 'chrome' }
    );
    const filePath = await writeTempFile('hello.txt', 'hello');

    const handle = new ElementHandle(driver, By.css('input'));
    await expect(handle.setInputFiles(filePath)).rejects.toThrow(/type="file"/);
    expect(grid.uploadedZips).toHaveLength(0);
  });
});
