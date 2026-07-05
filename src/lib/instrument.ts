/**
 * Round-trip counters for perf investigation.
 *
 * Every hot-path hypothesis in this repo ultimately reduces to "how many
 * protocol round trips does this command make?" — so we count them directly
 * rather than inferring from wall clock. A single integer increment per Classic
 * HTTP request / BiDi frame is negligible next to the I/O it measures, so these
 * are always on; read/reset them around a scenario to get its round-trip
 * profile.
 *
 * This is diagnostic instrumentation, not part of the public API. Import it by
 * deep path from measurement scripts (`craftdriver/dist/lib/instrument.js`).
 *
 * @see docs/wdio-perf-parity-plan.md §1 (the round-trip counter)
 */
export interface RoundTripCounts {
  /** Classic WebDriver HTTP requests (`HttpClient.send`). */
  classicRT: number;
  /** BiDi commands sent (each awaits a response) — the round-trip driver. */
  bidiSent: number;
  /** BiDi messages received over the socket (command responses + pushed events). */
  bidiRecv: number;
}

export const roundTrips: RoundTripCounts = {
  classicRT: 0,
  bidiSent: 0,
  bidiRecv: 0,
};

/** Reset all counters to zero (call before the block you want to profile). */
export function resetRoundTrips(): void {
  roundTrips.classicRT = 0;
  roundTrips.bidiSent = 0;
  roundTrips.bidiRecv = 0;
}

/** Snapshot the current counts (call after the profiled block). */
export function snapshotRoundTrips(): RoundTripCounts {
  return { ...roundTrips };
}
