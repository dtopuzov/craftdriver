/**
 * Unit tests for ElectronMainLogMonitor — the pure buffering/conversion logic
 * behind `browser.electron.mainLogs`. No app or inspector: CDP event params are
 * synthesized, so level mapping, arg deserialization, filtering, subscriptions,
 * and waiters localize here. End-to-end capture against the real app lives in
 * tests/electron/electron-main-process.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ElectronMainLogMonitor,
  type ConsoleApiCalledParams,
  type ExceptionThrownParams,
} from '../src/lib/electronMainLogs';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';

function consoleEvent(type: string, args: ConsoleApiCalledParams['args'] = [], ts = 1_000): ConsoleApiCalledParams {
  return { type, args, timestamp: ts };
}

describe('ElectronMainLogMonitor — console ingestion', () => {
  it('maps CDP console types to normalized levels', () => {
    const m = new ElectronMainLogMonitor();
    for (const [type, level] of [
      ['log', 'log'], ['info', 'info'], ['warning', 'warn'],
      ['error', 'error'], ['assert', 'error'], ['debug', 'debug'],
      ['trace', 'debug'], ['dir', 'log'], ['table', 'log'],
    ] as const) {
      m.ingestConsoleEvent(consoleEvent(type));
    }
    expect(m.getLogs().map((l) => l.level)).toEqual([
      'log', 'info', 'warn', 'error', 'error', 'debug', 'debug', 'log', 'log',
    ]);
    // Raw CDP method is preserved for console entries.
    expect(m.getLogs()[2].method).toBe('warning');
    expect(m.getLogs().every((l) => l.type === 'console')).toBe(true);
  });

  it('joins text and deserializes primitive args, describing complex ones', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent(consoleEvent('log', [
      { type: 'string', value: 'ready' },
      { type: 'number', value: 42 },
      { type: 'boolean', value: true },
      { type: 'undefined' },
      { type: 'object', subtype: 'null' },
      { type: 'object', description: 'Object { a: 1 }' },
    ]));
    const [entry] = m.getLogs();
    expect(entry.text).toBe('ready 42 true undefined null Object { a: 1 }');
    expect(entry.args).toEqual(['ready', 42, true, undefined, null, 'Object { a: 1 }']);
  });

  it('formats a stack trace when present', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent({
      type: 'error',
      args: [{ type: 'string', value: 'boom' }],
      stackTrace: { callFrames: [{ functionName: 'main', url: 'app.js', lineNumber: 9, columnNumber: 3 }] },
    });
    expect(m.getLogs()[0].stackTrace).toBe('  at main (app.js:9:3)');
  });

  it('uses the event timestamp, falling back to now when absent', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent({ type: 'log', args: [], timestamp: 5_000 });
    expect(m.getLogs()[0].timestamp).toEqual(new Date(5_000));
    m.ingestConsoleEvent({ type: 'log', args: [] });
    expect(m.getLogs()[1].timestamp).toBeInstanceOf(Date);
  });
});

describe('ElectronMainLogMonitor — exceptions and errors', () => {
  it('ingests an exception as an error-level entry', () => {
    const m = new ElectronMainLogMonitor();
    const params: ExceptionThrownParams = {
      timestamp: 2_000,
      exceptionDetails: { exception: { description: 'Error: kaboom\n  at x' }, text: 'Uncaught' },
    };
    m.ingestExceptionEvent(params);
    const [entry] = m.getLogs();
    expect(entry).toMatchObject({ type: 'exception', level: 'error', text: 'Error: kaboom\n  at x' });
  });

  it('falls back to text, then a default, for an exception without a description', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestExceptionEvent({ exceptionDetails: { text: 'Uncaught thing' } });
    m.ingestExceptionEvent({});
    expect(m.getLogs().map((l) => l.text)).toEqual(['Uncaught thing', 'uncaught exception']);
  });

  it('getErrors returns console.error/assert and every exception, not others', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent(consoleEvent('log', [{ type: 'string', value: 'info-line' }]));
    m.ingestConsoleEvent(consoleEvent('error', [{ type: 'string', value: 'err-line' }]));
    m.ingestConsoleEvent(consoleEvent('assert', [{ type: 'string', value: 'assert-line' }]));
    m.ingestExceptionEvent({ exceptionDetails: { text: 'exc-line' } });
    expect(m.getErrors().map((l) => l.text)).toEqual(['err-line', 'assert-line', 'exc-line']);
  });

  it('assertNoErrors throws ELECTRON_MAIN_THREW listing the errors, else is a no-op', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent(consoleEvent('log', [{ type: 'string', value: 'fine' }]));
    expect(() => m.assertNoErrors()).not.toThrow();
    m.ingestConsoleEvent(consoleEvent('error', [{ type: 'string', value: 'nope' }]));
    try {
      m.assertNoErrors();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.ELECTRON_MAIN_THREW)).toBe(true);
      expect((err as CraftdriverError).message).toContain('nope');
    }
  });
});

describe('ElectronMainLogMonitor — buffering and subscriptions', () => {
  it('getLogs returns a copy; clearLogs empties the buffer', () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent(consoleEvent('log'));
    const snapshot = m.getLogs();
    snapshot.push({} as never);
    expect(m.getLogs()).toHaveLength(1);
    m.clearLogs();
    expect(m.getLogs()).toHaveLength(0);
  });

  it('caps the buffer at 1000, dropping oldest', () => {
    const m = new ElectronMainLogMonitor();
    for (let i = 0; i < 1005; i++) {
      m.ingestConsoleEvent(consoleEvent('log', [{ type: 'number', value: i }]));
    }
    const logs = m.getLogs();
    expect(logs).toHaveLength(1000);
    expect(logs[0].args[0]).toBe(5); // 0..4 dropped
    expect(logs[999].args[0]).toBe(1004);
  });

  it('onLog fires for every entry; onError only for errors; both unsubscribe', () => {
    const m = new ElectronMainLogMonitor();
    const all = vi.fn();
    const errs = vi.fn();
    const offAll = m.onLog(all);
    const offErr = m.onError(errs);
    m.ingestConsoleEvent(consoleEvent('log'));
    m.ingestConsoleEvent(consoleEvent('error'));
    expect(all).toHaveBeenCalledTimes(2);
    expect(errs).toHaveBeenCalledTimes(1);
    offAll();
    offErr();
    m.ingestConsoleEvent(consoleEvent('error'));
    expect(all).toHaveBeenCalledTimes(2);
    expect(errs).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break capture or other subscribers', () => {
    const m = new ElectronMainLogMonitor();
    const good = vi.fn();
    m.onLog(() => { throw new Error('subscriber blew up'); });
    m.onLog(good);
    expect(() => m.ingestConsoleEvent(consoleEvent('log'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(m.getLogs()).toHaveLength(1);
  });
});

describe('ElectronMainLogMonitor — waiters', () => {
  it('waitForLog resolves from an already-buffered entry', async () => {
    const m = new ElectronMainLogMonitor();
    m.ingestConsoleEvent(consoleEvent('log', [{ type: 'string', value: 'already-here' }]));
    await expect(m.waitForLog((l) => l.text.includes('already-here'))).resolves.toMatchObject({
      text: 'already-here',
    });
  });

  it('waitForLog resolves from a future entry', async () => {
    const m = new ElectronMainLogMonitor();
    const pending = m.waitForLog((l) => l.text === 'soon', 1_000);
    m.ingestConsoleEvent(consoleEvent('log', [{ type: 'string', value: 'soon' }]));
    await expect(pending).resolves.toMatchObject({ text: 'soon' });
  });

  it('waitForError defaults to matching any error', async () => {
    const m = new ElectronMainLogMonitor();
    const pending = m.waitForError(undefined, 1_000);
    m.ingestExceptionEvent({ exceptionDetails: { text: 'anything' } });
    await expect(pending).resolves.toMatchObject({ type: 'exception' });
  });

  it('waitForLog rejects with TIMEOUT when nothing matches', async () => {
    const m = new ElectronMainLogMonitor();
    try {
      await m.waitForLog(() => false, 20);
      expect.unreachable('should have timed out');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.TIMEOUT)).toBe(true);
    }
  });
});
