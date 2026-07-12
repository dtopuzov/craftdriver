import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverService } from '../src/lib/service';

class NodeScriptService extends DriverService {
  constructor(private readonly scriptPath: string) {
    super({ command: process.execPath, readinessTimeoutMs: 5_000 });
  }

  protected buildCommandArgs(): string[] {
    return [this.scriptPath];
  }
}

describe('DriverService startup diagnostics', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drains driver output, keeps a bounded tail, and reports an early exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-service-'));
    tempDirs.push(dir);
    const script = path.join(dir, 'noisy-driver.cjs');
    fs.writeFileSync(script, [
      "process.stdout.write('discard-me-' + 'x'.repeat(128 * 1024));",
      "process.stdout.write('STDOUT-TAIL\\n');",
      "process.stderr.write('STDERR-TAIL\\n');",
      'setTimeout(() => process.exit(17), 20);',
    ].join('\n'));

    const service = new NodeScriptService(script);
    const startedAt = Date.now();

    await expect(service.start()).rejects.toThrow(/exited before it was ready \(code 17\)/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const output = service.getOutputTail();
    expect(output).toContain('STDOUT-TAIL');
    expect(output).toContain('STDERR-TAIL');
    expect(output).not.toContain('discard-me-');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });
});
