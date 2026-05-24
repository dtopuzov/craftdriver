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
import { mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

export interface ArtifactWriteResult {
  path: string;
  bytes: number;
}

export class ArtifactStore {
  private dir: string;
  private ready: Promise<void> | null = null;
  private counter = 0;

  constructor(rootOverride?: string) {
    const root = rootOverride
      ?? process.env.CRAFTDRIVER_MCP_ARTIFACTS_DIR
      ?? tmpdir();
    const stamp = `${process.pid}-${Date.now().toString(36)}`;
    this.dir = resolve(root, `craftdriver-mcp-${stamp}`);
  }

  /** Absolute path to the artifact directory (may not exist yet). */
  get directory(): string {
    return this.dir;
  }

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = mkdir(this.dir, { recursive: true }).then(() => undefined);
    }
    await this.ready;
  }

  /**
   * Write a payload to a numbered file. `nameHint` is used to build a
   * human-readable filename (`0001-<hint>`); pass something like
   * `screenshot.png` or `eval.json`.
   */
  async write(nameHint: string, data: Buffer | string): Promise<ArtifactWriteResult> {
    await this.ensure();
    this.counter += 1;
    const seq = this.counter.toString().padStart(4, '0');
    const path = join(this.dir, `${seq}-${nameHint}`);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await writeFile(path, buf);
    return { path, bytes: buf.length };
  }

  /**
   * Allocate a path for an artifact the caller will write itself (e.g.
   * pass to `browser.screenshot({ path })`). Doesn't touch the disk
   * beyond `mkdir -p` of the directory.
   */
  async allocate(nameHint: string): Promise<string> {
    await this.ensure();
    this.counter += 1;
    const seq = this.counter.toString().padStart(4, '0');
    return join(this.dir, `${seq}-${nameHint}`);
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
