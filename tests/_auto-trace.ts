/**
 * Vitest helper that wires automatic per-test tracing for a Browser
 * instance. Copy this into your own project's test folder — it is not
 * part of the craftdriver public API.
 *
 * Usage:
 *   describe('my feature', () => {
 *     let browser: Browser;
 *     beforeAll(async () => { browser = await Browser.launch(); });
 *     afterAll(async () => { await browser.quit(); });
 *     autoTrace(() => browser);   // ← one line
 *     // ... tests
 *   });
 *
 * Environment variables:
 *   CRAFTDRIVER_TRACE=off|on-failure|always   (default: on-failure)
 *   CRAFTDRIVER_TRACE_DIR=./traces            (default: ./traces)
 *   CRAFTDRIVER_TRACE_SCREENSHOTS=auto|off    (default: auto)
 */
import { beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, TraceScreenshotMode } from '../src';

const ROOT = process.env.CRAFTDRIVER_TRACE_DIR ?? './traces';
const MODE = (process.env.CRAFTDRIVER_TRACE ?? 'on-failure') as
  'always' | 'on-failure' | 'off';
const SHOTS = (process.env.CRAFTDRIVER_TRACE_SCREENSHOTS ?? 'auto') as
  TraceScreenshotMode;

export interface AutoTraceOptions {
  /** Override the env-var default. */
  mode?: 'always' | 'on-failure' | 'off';
  /** Override the env-var default for screenshot capture. */
  screenshots?: TraceScreenshotMode;
}

export function autoTrace(getBrowser: () => Browser, opts: AutoTraceOptions = {}): void {
  const mode = opts.mode ?? MODE;
  if (mode === 'off') return;
  const screenshots = opts.screenshots ?? SHOTS;
  let currentDir = '';

  beforeEach(async ({ task }) => {
    currentDir = join(ROOT, safeName(task));
    await getBrowser().startTrace({ outDir: currentDir, screenshots });
  });

  afterEach(async ({ task }) => {
    const failed = task.result?.state === 'fail';
    const keep = mode === 'always' || failed;
    const zipPath = `${currentDir}.zip`;
    // Capture the final page state BEFORE stopping the trace so a viewer
    // can see what the page looked like at the moment of failure (not
    // just the snapshot taken before the last click).
    try {
      await getBrowser().stopTrace(keep ? { path: zipPath } : undefined);
    } catch {
      return; // never started — nothing to clean up
    }
    if (mode === 'on-failure' && !failed) {
      rmSync(currentDir, { recursive: true, force: true });
    } else if (failed) {
      // Surface the path so CI logs point at the artefact.
      // eslint-disable-next-line no-console
      console.error(`  📦 Vibium trace: ${zipPath}`);
    }
  });
}

function safeName(task: { name: string; suite?: { name: string } | null }): string {
  const parts: string[] = [];
  let s: { name: string; suite?: { name: string } | null } | null | undefined = task;
  while (s && s.name) { parts.unshift(s.name); s = s.suite; }
  return parts.join('/').replace(/[^a-z0-9/]+/gi, '-').toLowerCase();
}
