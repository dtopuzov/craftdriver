/**
 * Bounded reader for the newline-delimited JSON both agent transports speak.
 *
 * Shared deliberately: MCP over stdio and the daemon over its Unix socket
 * frame messages identically, and an unbounded accumulator is a
 * resource-exhaustion hazard on either. A peer that writes bytes without a
 * newline would otherwise grow the buffer until the process dies — worse in
 * the daemon, which is long-lived and never exits to reclaim it.
 *
 * Over-long frames are dropped rather than truncated: half a JSON object is
 * not a message, and parsing one would be worse than reporting the overrun.
 */

/** Maximum UTF-8 payload for one JSON line: 1 MiB, excluding `\n`. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export interface LineValue {
  kind: 'line';
  line: string;
}

export interface OversizedLine {
  kind: 'oversized';
}

export type LineReaderEvent = LineValue | OversizedLine;

/** Incremental line reader that discards a frame as soon as it exceeds its cap. */
export class BoundedLineReader {
  private buffer = '';
  private bufferedBytes = 0;
  private discarding = false;

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: string | Buffer): LineReaderEvent[] {
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const events: LineReaderEvent[] = [];
    let offset = 0;

    while (offset <= value.length) {
      const newline = value.indexOf('\n', offset);
      const terminated = newline !== -1;
      const end = terminated ? newline : value.length;
      const segment = value.slice(offset, end);
      this.pushSegment(segment, terminated, events);
      if (!terminated) break;
      offset = newline + 1;
      if (offset === value.length) break;
    }

    return events;
  }

  private pushSegment(
    segment: string,
    terminated: boolean,
    events: LineReaderEvent[],
  ): void {
    if (this.discarding) {
      // Still swallowing the tail of an over-long frame; resume at its newline.
      if (terminated) this.discarding = false;
      return;
    }

    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (this.bufferedBytes + segmentBytes > this.maxFrameBytes) {
      this.buffer = '';
      this.bufferedBytes = 0;
      this.discarding = !terminated;
      events.push({ kind: 'oversized' });
      return;
    }

    this.buffer += segment;
    this.bufferedBytes += segmentBytes;
    if (!terminated) return;

    events.push({ kind: 'line', line: this.buffer });
    this.buffer = '';
    this.bufferedBytes = 0;
  }
}
