import { describe, it, expect } from 'vitest';
import { WebDriverWait } from '../src/lib/wait.js';
import type { Driver } from '../src/lib/driver.js';

// Pure unit tests for WebDriverWait.until — no browser. The condition ignores
// the driver, so a stub is sufficient.
const stubDriver = {} as Driver;

describe('WebDriverWait.until (check-first)', () => {
  it('evaluates the condition at least once even at timeout 0', async () => {
    let calls = 0;
    const wait = new WebDriverWait(stubDriver, 0);
    const result = await wait.until(() => {
      calls++;
      return 'ready';
    });
    expect(result).toBe('ready');
    expect(calls).toBe(1);
  });

  it('still times out at 0 ms when the condition is never satisfied', async () => {
    let calls = 0;
    const wait = new WebDriverWait(stubDriver, 0);
    await expect(
      wait.until(() => {
        calls++;
        return undefined as unknown as string;
      })
    ).rejects.toThrow(/timed out/i);
    // Exactly one evaluation: checked once, then the deadline is already reached.
    expect(calls).toBe(1);
  });
});
