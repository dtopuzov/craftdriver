/**
 * Shared helpers for `tests/perf/*.perf.ts` benchmark harnesses (issue #20).
 * Non-test file — underscore prefix per `tests/` file-naming convention.
 */

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

export function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

export async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const start = performance.now();
  const result = await fn();
  return [performance.now() - start, result];
}

/** Run `warmup + measured` samples of `fn`, discarding the warmup. */
export async function sample(
  fn: () => Promise<number>,
  warmup: number,
  measured: number
): Promise<number[]> {
  const values: number[] = [];
  for (let i = 0; i < warmup + measured; i++) {
    const elapsed = await fn();
    if (i >= warmup) values.push(elapsed);
  }
  return values;
}

export function printTable(title: string, rows: Array<{ label: string; values: number[] }>): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const { label, values } of rows) {
    console.log(
      `  ${label.padEnd(28)} median=${fmt(median(values)).padStart(9)}  p95=${fmt(p95(values)).padStart(9)}  n=${values.length}`
    );
  }
}
