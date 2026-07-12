/**
 * Electron main-process e2e — the product truth for `browser.electron` (main-process
 * access, opt-in via `mainProcess: true`). Runs against the packaged example app
 * downloaded by the global setup; skips when no app is available.
 *
 * Note: main-process access needs the app's `EnableNodeCliInspectArguments` fuse
 * enabled (the default for the example fixture). Hardened production builds disable
 * it — see docs/electron.md; renderer automation is unaffected either way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, By, CraftdriverError, ErrorCode } from '../../src';
import { resolveElectronAppPath, launchExampleApp } from './fixture';

const APP_PATH = resolveElectronAppPath();

describe.runIf(!!APP_PATH)('Electron main process (browser.electron)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchExampleApp(APP_PATH!, { mainProcess: true });
  });
  afterAll(async () => {
    await browser?.quit();
  });

  it('runs code in the main process — return values, args, async, and errors', async () => {
    // Sync return: the electron module is injected as the first argument.
    const name = await browser.electron.executeMain((electron) =>
      (electron as { app: { getName(): string } }).app.getName()
    );
    expect(name).toBe('CraftdriverExample');

    // JSON args in, async callback awaited, value returned by value.
    const result = await browser.electron.executeMain(
      async (electron, a: number, b: number) => ({
        sum: a + b,
        windows: (
          electron as { BrowserWindow: { getAllWindows(): unknown[] } }
        ).BrowserWindow.getAllWindows().length,
      }),
      2,
      40
    );
    expect(result).toMatchObject({ sum: 42 });
    expect((result as { windows: number }).windows).toBeGreaterThanOrEqual(1);

    // Works alongside renderer automation on the same session.
    await browser.find(By.testId('app-title')).expect().toBeVisible();

    // A throw in the main process surfaces as ELECTRON_MAIN_THREW.
    await expect(
      browser.electron.executeMain(() => {
        throw new Error('boom-in-main');
      })
    ).rejects.toSatisfy(
      (e) =>
        CraftdriverError.is(e, ErrorCode.ELECTRON_MAIN_THREW) &&
        /boom-in-main/.test((e as Error).message)
    );

    // Non-serializable return values should fail loudly instead of becoming
    // undefined through CDP's by-value transport.
    await expect(browser.electron.executeMain(() => () => 1)).rejects.toSatisfy(
      (e) =>
        CraftdriverError.is(e, ErrorCode.EVAL_BAD_ARG) &&
        /not JSON-serializable/.test((e as Error).message)
    );
  });

  it('captures main-process console logs and errors', async () => {
    browser.electron.mainLogs.clearLogs();

    const logMarker = `main-log-${Date.now()}`;
    const captured = browser.electron.mainLogs.waitForLog((l) => l.text.includes(logMarker), 5_000);
    await browser.electron.executeMain(
      (electron, m) => console.log(m, (electron as { app: { getName(): string } }).app.getName()),
      logMarker
    );
    const entry = await captured;
    expect(entry.level).toBe('log');
    expect(entry.text).toContain('CraftdriverExample'); // ran in the main process

    const errMarker = `main-err-${Date.now()}`;
    const errored = browser.electron.mainLogs.waitForError(
      (l) => l.text.includes(errMarker),
      5_000
    );
    await browser.electron.executeMain((_e, m) => console.error(m, { code: 7 }), errMarker);
    expect((await errored).level).toBe('error');
    expect(browser.electron.mainLogs.getErrors().some((l) => l.text.includes(errMarker))).toBe(
      true
    );
  });

  it('mocks native dialogs, records calls, clears history, and restores', async () => {
    const openDialog = await browser.electron.mockDialog('showOpenDialog', {
      canceled: false,
      filePaths: ['/fixtures/report.txt'],
    });

    await expect(
      browser.electron.mockDialog('showOpenDialog', { canceled: true, filePaths: [] })
    ).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });

    const selected = await browser.electron.executeMain((electron) =>
      (electron as any).dialog.showOpenDialog({
        title: 'Choose a report',
        properties: ['openFile'],
        filters: [{ name: 'Text', extensions: ['txt'] }],
      })
    );
    expect(selected).toEqual({ canceled: false, filePaths: ['/fixtures/report.txt'] });
    expect(await openDialog.getCallCount()).toBe(1);
    expect(await openDialog.getCalls()).toEqual([
      {
        options: {
          title: 'Choose a report',
          properties: ['openFile'],
          filters: [{ name: 'Text', extensions: ['txt'] }],
        },
      },
    ]);

    await openDialog.clearCalls();
    expect(await openDialog.getCalls()).toEqual([]);
    await openDialog.restore();
    await expect(openDialog.getCalls()).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });

    const messageBox = await browser.electron.mockDialog('showMessageBox', {
      response: 1,
      checkboxChecked: true,
    });
    expect(
      await browser.electron.executeMain((electron) =>
        (electron as any).dialog.showMessageBox({ message: 'Delete file?', buttons: ['No', 'Yes'] })
      )
    ).toEqual({ response: 1, checkboxChecked: true });
    await messageBox.restore();

    const saveDialog = await browser.electron.mockDialog('showSaveDialog', {
      canceled: false,
      filePath: '/fixtures/saved.txt',
    });
    expect(
      await browser.electron.executeMain((electron) =>
        (electron as any).dialog.showSaveDialog({ defaultPath: 'saved.txt' })
      )
    ).toEqual({ canceled: false, filePath: '/fixtures/saved.txt' });
    await saveDialog.restore();
  });

  it('drives the real renderer → preload → IPC → native file dialog flow', async () => {
    // The product truth for native-dialog testing: a user clicks a button, the
    // sandboxed renderer calls a preload API, the preload sends IPC, and the main
    // process opens the OS file picker. We replace only the final showOpenDialog,
    // then drive the *real* UI — no dialog is invoked directly.
    const selectFile = await browser.electron.mockDialog('showOpenDialog', {
      canceled: false,
      filePaths: ['/fixtures/invoice.txt'],
    });
    try {
      await browser.click(By.testId('nav-dialog'));
      await browser.click(By.testId('open-native-file-btn'));
      await browser
        .find(By.testId('native-dialog-result'))
        .expect()
        .toHaveText('/fixtures/invoice.txt');

      // The click really reached the main process: the mock recorded the exact
      // options the app's ipcMain handler passes to dialog.showOpenDialog.
      expect(await selectFile.getCalls()).toEqual([
        {
          options: {
            title: 'Choose a text file',
            properties: ['openFile'],
            filters: [{ name: 'Text files', extensions: ['txt', 'md'] }],
          },
        },
      ]);
    } finally {
      await selectFile.restore();
    }

    // Re-script to the cancel path and drive the same real flow again.
    const cancel = await browser.electron.mockDialog('showOpenDialog', {
      canceled: true,
      filePaths: [],
    });
    try {
      await browser.click(By.testId('open-native-file-btn'));
      await browser.find(By.testId('native-dialog-result')).expect().toHaveText('cancelled');
    } finally {
      await cancel.restore();
    }
  });

  it('mocks any electron API method — records args, re-scripts, and restores', async () => {
    // The general primitive behind mockDialog: replace an arbitrary electron.<api>.<fn>
    // main-process method with a scripted return and a call recorder.
    const getName = await browser.electron.mock('app', 'getName', 'MockedName');
    try {
      // The replacement returns the scripted value in-process (sync methods work).
      const name = await browser.electron.executeMain((electron) =>
        (electron as { app: { getName(): string } }).app.getName()
      );
      expect(name).toBe('MockedName');

      // Args of every call are recorded (JSON-safe).
      await browser.electron.executeMain((electron) =>
        (electron as { app: { getName(...a: unknown[]): string } }).app.getName('ignored-arg')
      );
      expect(await getName.getCallCount()).toBe(2);
      expect(await getName.getCalls()).toEqual([{ args: [] }, { args: ['ignored-arg'] }]);

      // Re-scripting the return value takes effect for later calls.
      await getName.mockReturnValue('SecondName');
      expect(
        await browser.electron.executeMain((electron) =>
          (electron as { app: { getName(): string } }).app.getName()
        )
      ).toBe('SecondName');

      await getName.clearCalls();
      expect(await getName.getCalls()).toEqual([]);
    } finally {
      await getName.restore();
    }

    // After restore the real method is back and the handle rejects further use.
    const realName = await browser.electron.executeMain((electron) =>
      (electron as { app: { getName(): string } }).app.getName()
    );
    expect(realName).toBe('CraftdriverExample');
    await expect(getName.getCalls()).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });

    // The docs/recipes/electron-mock-apis.md headline: mock shell.openExternal so a
    // "share" action records the URL without launching a browser.
    const openExternal = await browser.electron.mock('shell', 'openExternal', true);
    try {
      const opened = await browser.electron.executeMain((electron) =>
        (electron as { shell: { openExternal(u: string): unknown } }).shell.openExternal(
          'https://example.com/report/42'
        )
      );
      expect(opened).toBe(true); // scripted return
      expect(await openExternal.getCalls()).toEqual([
        { args: ['https://example.com/report/42'] },
      ]);
    } finally {
      await openExternal.restore();
    }

    // An omitted return value is valid (the method returns undefined) — the value
    // must not be forced through executeMain's JSON-arg validation as undefined.
    const beep = await browser.electron.mock('shell', 'beep');
    try {
      const result = await browser.electron.executeMain((electron) =>
        (electron as { shell: { beep(): unknown } }).shell.beep()
      );
      expect(result).toBeUndefined();
      expect(await beep.getCallCount()).toBe(1);

      // Double-mocking the same target is rejected; a bad target fails fast.
      await expect(browser.electron.mock('shell', 'beep')).rejects.toMatchObject({
        code: ErrorCode.STATE_INVALID,
      });
      await expect(browser.electron.mock('app', '')).rejects.toMatchObject({
        code: ErrorCode.INVALID_ARGUMENT,
      });
    } finally {
      await beep.restore();
    }
  });
});
