/**
 * Per-session artifact store for the MCP server.
 *
 * Why this exists: MCP content blocks count against the model's
 * context window. A 100 KB screenshot or a 4 KB full a11y snapshot
 * costs the agent real tokens on every turn. We'd rather spill the
 * payload to disk and hand back a short preview + absolute path.
 * Hosts that can read files (Claude Code, Cursor, Windsurf, Zed,
 * Goose, Gemini CLI, …) just open it; hosts that can't can still
 * fetch via MCP resources once we expose them.
 *
 * Directory layout:
 *   <root>/craftdriver-mcp-<pid>-<ts>/
 *     0001-screenshot.png
 *     0002-snapshot.txt
 *     0003-eval.json
 *
 * Root resolution order:
 *   1. $CRAFTDRIVER_MCP_ARTIFACTS_DIR if set
 *   2. os.tmpdir()
 *
 * Lifetime: the directory is **not** deleted on shutdown. Agents may
 * still be holding paths to past artifacts; OS-level temp cleanup
 * reclaims them eventually. Override the root if you need a custom
 * cleanup policy.
 */
import { chmod, mkdir, rm, stat, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { CraftdriverError, ErrorCode } from '../../lib/errors.js';

export interface ArtifactWriteResult {
  path: string;
  bytes: number;
}

/**
 * Quota for one session's spill directory.
 *
 * The store is written to automatically, on every oversized result, for the
 * whole life of a long-running session — and nothing deletes it. Without a
 * quota a loop that snapshots a large page fills the disk silently, which is
 * a worse failure than a refused spill: the caller falls back to an inline
 * preview and the session keeps working.
 */
export const MAX_ARTIFACTS = 500;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Raised when a write would exceed the session's artifact quota. */
export class ArtifactQuotaError extends CraftdriverError {
  constructor(message: string) {
    super(ErrorCode.STATE_INVALID, message, {
      hint: 'start a fresh MCP session, or clean the configured artifact root',
    });
    this.name = 'ArtifactQuotaError';
  }
}

export interface ArtifactStoreLimits {
  /** Test/embedding override; production uses {@link MAX_ARTIFACTS}. */
  maxArtifacts?: number;
  /** Test/embedding override; production uses {@link MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number;
}

export class ArtifactStore {
  private dir: string;
  private ready: Promise<void> | null = null;
  private counter = 0;
  private artifactCount = 0;
  private totalBytes = 0;
  private reservations = new Set<string>();
  private readonly maxArtifacts: number;
  private readonly maxTotalBytes: number;

  constructor(rootOverride?: string, limits: ArtifactStoreLimits = {}) {
    const root = rootOverride
      ?? process.env.CRAFTDRIVER_MCP_ARTIFACTS_DIR
      ?? tmpdir();
    const stamp = `${process.pid}-${Date.now().toString(36)}`;
    this.dir = resolve(root, `craftdriver-mcp-${stamp}`);
    this.maxArtifacts = limits.maxArtifacts ?? MAX_ARTIFACTS;
    this.maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  }

  /** Absolute path to the artifact directory (may not exist yet). */
  get directory(): string {
    return this.dir;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    }
    await this.ready;
  }

  /**
   * Write a payload to a numbered file. `nameHint` is used to build a
   * human-readable filename (`0001-<hint>`); pass something like
   * `screenshot.png` or `eval.json`.
   */
  async write(nameHint: string, data: Buffer | string): Promise<ArtifactWriteResult> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.assertWithinQuota(buf.length);
    this.counter += 1;
    this.artifactCount += 1;
    this.totalBytes += buf.length;
    const seq = this.counter.toString().padStart(4, '0');
    const path = join(this.dir, `${seq}-${nameHint}`);
    try {
      await this.ensure();
      await writeFile(path, buf, { mode: 0o600 });
      return { path, bytes: buf.length };
    } catch (error) {
      this.artifactCount -= 1;
      this.totalBytes -= buf.length;
      await rm(path, { force: true }).catch(() => {});
      throw error;
    }
  }

  private assertWithinQuota(incoming: number): void {
    if (this.artifactCount >= this.maxArtifacts) {
      throw new ArtifactQuotaError(
        `artifact store is full (${this.maxArtifacts} files in ${this.dir})`,
      );
    }
    if (this.totalBytes + incoming > this.maxTotalBytes) {
      throw new ArtifactQuotaError(
        `artifact store would exceed ${this.maxTotalBytes} bytes (${this.dir})`,
      );
    }
  }

  /**
   * Allocate a path for an artifact the caller will write itself (e.g.
   * pass to `browser.screenshot({ path })`). Doesn't touch the disk
   * beyond `mkdir -p` of the directory.
   */
  async allocate(nameHint: string): Promise<string> {
    // Reserve the count synchronously, before awaiting mkdir, so concurrent
    // allocations cannot all observe the same free slot.
    this.assertWithinQuota(0);
    this.counter += 1;
    this.artifactCount += 1;
    const seq = this.counter.toString().padStart(4, '0');
    const path = join(this.dir, `${seq}-${nameHint}`);
    this.reservations.add(path);
    try {
      await this.ensure();
      return path;
    } catch (error) {
      this.reservations.delete(path);
      this.artifactCount -= 1;
      throw error;
    }
  }

  /**
   * Account for a file written to a path returned by {@link allocate}.
   *
   * Screenshots are written by the browser, so their size is known only after
   * capture. If the actual file would cross the quota, remove that one file and
   * fail the tool call rather than letting the supposedly bounded store grow.
   */
  async commitAllocated(path: string): Promise<ArtifactWriteResult> {
    if (!this.reservations.has(path)) {
      throw new Error(`artifact path was not allocated by this store: ${path}`);
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`allocated artifact is not a regular file: ${path}`);
      if (this.totalBytes + info.size > this.maxTotalBytes) {
        throw new ArtifactQuotaError(
          `artifact store would exceed ${this.maxTotalBytes} bytes (${this.dir})`,
        );
      }
      await chmod(path, 0o600);
      this.totalBytes += info.size;
      this.reservations.delete(path);
      return { path, bytes: info.size };
    } catch (error) {
      await this.releaseAllocated(path);
      throw error;
    }
  }

  /** Release a failed allocation and remove any partial file. Idempotent. */
  async releaseAllocated(path: string): Promise<void> {
    if (!this.reservations.delete(path)) return;
    this.artifactCount -= 1;
    await rm(path, { force: true }).catch(() => {});
  }
}

/**
 * Spill threshold in bytes. Content blocks longer than this are
 * written to an artifact and replaced inline with a short preview.
 *
 * Default 2 KB ≈ 500 tokens — enough room for a typical short
 * snapshot diff or a small JSON result, but well below the cost of a
 * full 80-node snapshot or a verbose eval payload.
 */
export const DEFAULT_SPILL_BYTES = 2048;

export function resolveSpillBytes(): number {
  const env = process.env.CRAFTDRIVER_MCP_SPILL_BYTES;
  if (!env) return DEFAULT_SPILL_BYTES;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPILL_BYTES;
}

/**
 * Build the short inline replacement shown in place of a spilled
 * payload. Keeps the first ~5 lines (or 240 chars, whichever is
 * shorter) so the agent still sees the head of the data without
 * having to read the file for a quick glance.
 */
export function spillPreview(text: string, written: ArtifactWriteResult): string {
  const head = text.split('\n').slice(0, 5).join('\n');
  const trimmed = head.length > 240 ? head.slice(0, 237) + '…' : head;
  return `${trimmed}\n…\n(full output: ${written.path}, ${written.bytes} bytes)`;
}
