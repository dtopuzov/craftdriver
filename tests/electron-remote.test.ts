/**
 * Unit tests for the browser.electron main-process namespace guards and the
 * bridge's connect-failure path. The happy path (real main-process execution) is
 * proven end-to-end in tests/electron/electron-main-process.test.ts against a
 * live app, since it needs a real Node inspector.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import { ElectronRemote } from '../src/lib/electronRemote';
import { ElectronMainBridge } from '../src/lib/electronMainBridge';
import { findFreePort } from '../src/lib/service';

describe('ElectronRemote guards', () => {
  it('throws ELECTRON_MAIN_UNAVAILABLE when main-process access was not enabled', async () => {
    const remote = new ElectronRemote(undefined); // non-Electron / no mainProcess
    try {
      await remote.executeMain(() => 1);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.ELECTRON_MAIN_UNAVAILABLE)).toBe(true);
      expect((err as CraftdriverError).hint).toMatch(/mainProcess: true/);
    }
  });

  it('rejects a non-function callback before connecting', async () => {
    const remote = new ElectronRemote({ host: '127.0.0.1', port: 1 });
    await expect(remote.executeMain('nope' as unknown as () => void)).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
  });

  it('rejects a non-JSON-serializable arg (EVAL_BAD_ARG) before connecting', async () => {
    const remote = new ElectronRemote({ host: '127.0.0.1', port: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(remote.executeMain((_electron, _x) => undefined, circular)).rejects.toMatchObject({
      code: ErrorCode.EVAL_BAD_ARG,
    });
  });

  it.each([
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['class instance', new Date()],
    ['nested function', { ok: true, nope: () => 1 }],
  ])('rejects %s args before connecting', async (_label, value) => {
    const remote = new ElectronRemote({ host: '127.0.0.1', port: 1 });
    await expect(remote.executeMain((_electron, _x) => undefined, value)).rejects.toMatchObject({
      code: ErrorCode.EVAL_BAD_ARG,
    });
  });

  it('validates native-dialog methods and results before connecting', async () => {
    const remote = new ElectronRemote({ host: '127.0.0.1', port: 1 });

    await expect(
      remote.mockDialog('showOpenDialog', { canceled: false, filePaths: 'not-an-array' } as any)
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    await expect(
      remote.mockDialog('showMessageBox', { response: 1.5, checkboxChecked: false })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    await expect(
      remote.mockDialog('showSaveDialog', { canceled: true } as any)
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    await expect(
      remote.mockDialog('showErrorBox' as any, { canceled: true, filePaths: [] })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
  });

  it('validates the general mock() api/fn target before connecting', async () => {
    const remote = new ElectronRemote({ host: '127.0.0.1', port: 1 });

    await expect(remote.mock('', 'getName')).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
    await expect(remote.mock('app', '')).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
    await expect(remote.mock('app', 123 as any)).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
  });
});

describe('ElectronMainBridge connect failure', () => {
  it('fails with ELECTRON_MAIN_UNAVAILABLE when nothing is listening', async () => {
    // A just-freed port has no inspector — the /json/list fetch fails.
    const port = await findFreePort();
    const bridge = new ElectronMainBridge('127.0.0.1', port);
    try {
      await bridge.connect(1_000);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.ELECTRON_MAIN_UNAVAILABLE)).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it('waits for a slow-starting inspector instead of failing the first refused connection', async () => {
    const port = await findFreePort();
    const wsPort = await findFreePort();
    let server: http.Server | undefined;
    let wss: WebSocketServer | undefined;
    const startTimer = setTimeout(() => {
      wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
      server = http
        .createServer((_req, res) => {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify([
              { webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/main` },
            ])
          );
        })
        .listen(port, '127.0.0.1');
    }, 100);

    const bridge = new ElectronMainBridge('127.0.0.1', port);
    try {
      await expect(bridge.connect(2_000)).resolves.toBeUndefined();
    } finally {
      clearTimeout(startTimer);
      await bridge.close();
      await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  });
});
