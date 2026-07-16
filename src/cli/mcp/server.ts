/**
 * MCP server — JSON-RPC 2.0 over stdio.
 *
 * Hand-rolled because the spec we use (initialize / tools/list /
 * tools/call) is ~6 methods, and pulling `@modelcontextprotocol/sdk`
 * would multiply our runtime-dep footprint. If the spec grows we can
 * swap in the SDK without changing tool definitions in `tools.ts`.
 *
 * Protocol version we advertise: 2024-11-05. If the client offers a
 * newer one we just echo theirs back — the methods we implement are
 * stable across versions to date.
 *
 * Lifecycle:
 *   client → initialize         → server returns capabilities + info
 *   client → notifications/initialized   (no response)
 *   client ⇆ tools/list, tools/call, ...
 *   stdin EOF (or SIGINT/SIGTERM)        → close browser, exit 0
 */
import { Browser, type LaunchOptions } from '../../lib/browser.js';
import { assertLocalOnlyLaunch } from '../../lib/launchTarget.js';
import { CraftdriverError, ErrorCode } from '../../lib/errors.js';
import { createBrowserHandle, type DispatchContext } from '../dispatcher.js';
import { TOOLS, getTool, runTool, type ToolDef } from './tools.js';
import { renderDelta, renderFull, takeSnapshot, type SnapshotShape } from '../snapshot.js';
import {
  ArtifactStore,
  resolveSpillBytes,
  spillPreview,
} from './artifacts.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'craftdriver';
const SERVER_VERSION = '0.1.0';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolCallResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpServerOptions {
  launch: LaunchOptions;
  /** Stream for incoming messages; defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Stream for outgoing messages; defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Disable snapshots for tests that want a deterministic payload. */
  snapshot?: 'auto' | 'none';
  /** Override the artifact directory root (defaults to $CRAFTDRIVER_MCP_ARTIFACTS_DIR or os.tmpdir()). */
  artifactsDir?: string;
  /** Override the spill threshold in bytes (default 2048; env: $CRAFTDRIVER_MCP_SPILL_BYTES). */
  spillBytes?: number;
}

export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  // The MCP server is a local dev tool only — never reachable against a
  // Grid/cloud. Fail fast at startup, not on first browser use.
  assertLocalOnlyLaunch(opts.launch as unknown as Record<string, unknown>);

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const handle = createBrowserHandle(() => Browser.launch(opts.launch));
  const ctx: DispatchContext = { handle, launchOptions: opts.launch };

  // Snapshot state: one most-recent snapshot per session for diffing.
  let lastSnapshot: Awaited<ReturnType<typeof takeSnapshot>> = null;
  const snapshotsOn = opts.snapshot !== 'none';

  // Artifact store: large content blocks spill here so they don't burn
  // context tokens on every turn.
  const artifacts = new ArtifactStore(opts.artifactsDir);
  const spillBytes = opts.spillBytes ?? resolveSpillBytes();

  function send(msg: JsonRpcResponse): void {
    output.write(JSON.stringify(msg) + '\n');
  }

  async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'initialize':
          return ok(id, {
            protocolVersion:
              (req.params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              'craftdriver browser automation. Probe selectors with browser_exists ' +
              'before acting; errors carry a stable `code` field; the post-action ' +
              'a11y snapshot diff tells you what changed.',
          });

        case 'notifications/initialized':
          return null; // notification — no response

        case 'ping':
          return ok(id, {});

        case 'tools/list':
          return ok(id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });

        case 'tools/call': {
          const name = req.params?.name as string | undefined;
          const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
          if (!name) return rpcError(id, -32602, 'tools/call: missing "name"');
          const tool = getTool(name);
          if (!tool) {
            return ok(id, toolError(`unknown tool: ${name}`, ErrorCode.INVALID_ARGUMENT));
          }
          const result = await callTool(ctx, tool, args, {
            snapshotsOn,
            getPrev: () => lastSnapshot,
            setLast: (s) => {
              lastSnapshot = s;
            },
            artifacts,
            spillBytes,
          });
          return ok(id, result);
        }

        case 'resources/list':
          // Resources land with Item 7 (trace summaries). Empty list now
          // keeps clients that probe for resource capability happy.
          return ok(id, { resources: [] });

        default:
          return rpcError(id, -32601, `method not found: ${req.method}`);
      }
    } catch (e) {
      return rpcError(id, -32000, (e as Error).message ?? String(e));
    }
  }

  // Line-delimited JSON over stdin. Tolerate \r\n and trailing whitespace.
  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(line) as JsonRpcRequest;
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      // Run async; responses may interleave but each carries its own id.
      void handleRequest(parsed).then((resp) => {
        if (resp) send(resp);
      });
    }
  });

  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    input.once('end', done);
    input.once('close', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });

  await handle.close();
}

interface SnapshotState {
  snapshotsOn: boolean;
  getPrev: () => Awaited<ReturnType<typeof takeSnapshot>>;
  setLast: (s: Awaited<ReturnType<typeof takeSnapshot>>) => void;
  artifacts: ArtifactStore;
  spillBytes: number;
}

async function callTool(
  ctx: DispatchContext,
  tool: ToolDef,
  args: Record<string, unknown>,
  snap: SnapshotState,
): Promise<ToolCallResult> {
  // Screenshot path allocation: if the caller didn't supply a path,
  // give them one inside the artifact directory so the PNG bytes are
  // actually persisted somewhere they can read.
  if (tool.name === 'browser_screenshot' && !args.path) {
    args = { ...args, path: await snap.artifacts.allocate('screenshot.png') };
  }

  let value: unknown;
  try {
    value = await runTool(ctx, tool, args);
  } catch (e) {
    if (e instanceof CraftdriverError) {
      return toolError(e.message, e.code, e.hint, compactErrorDetail(e.detail));
    }
    return toolError((e as Error).message ?? String(e), ErrorCode.DRIVER_ERROR);
  }

  const content: ContentBlock[] = [];

  // Render result. The snapshot tool returns a structured shape we
  // know how to print compactly; everything else falls through to
  // the generic summariser. Both paths run through `maybeSpill` so
  // large payloads land on disk instead of in the context window.
  let primaryText: string;
  if (tool.name === 'browser_snapshot' && value && typeof value === 'object' && 'lines' in value) {
    primaryText = await maybeSpill(
      renderFull(value as SnapshotShape),
      'snapshot.txt',
      snap.artifacts,
      snap.spillBytes,
    );
  } else {
    primaryText = await summariseValue(tool.name, value, snap.artifacts, snap.spillBytes);
  }
  content.push({ type: 'text', text: primaryText });

  // Post-action a11y diff, when this tool changed page state.
  if (tool.mutating && snap.snapshotsOn) {
    const next = await takeSnapshot(await ctx.handle.get()).catch(() => null);
    const delta = renderDelta(snap.getPrev(), next);
    if (delta) {
      const block = await maybeSpill(
        delta,
        'snapshot.txt',
        snap.artifacts,
        snap.spillBytes,
      );
      content.push({ type: 'text', text: block });
    }
    snap.setLast(next);
  }

  return { content, structuredContent: { result: value } };
}

async function summariseValue(
  toolName: string,
  value: unknown,
  artifacts: ArtifactStore,
  spillBytes: number,
): Promise<string> {
  if (value === null || value === undefined) return `${toolName}: ok`;
  const text = typeof value === 'string' ? value : safeJson(value);
  return maybeSpill(text, `${toolName}.txt`, artifacts, spillBytes);
}

async function maybeSpill(
  text: string,
  nameHint: string,
  artifacts: ArtifactStore,
  spillBytes: number,
): Promise<string> {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= spillBytes) return text;
  const written = await artifacts.write(nameHint, text);
  return spillPreview(text, written);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactErrorDetail(detail?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const compact = { ...detail };
  delete compact.stacktrace;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function toolError(
  message: string,
  code: string,
  hint?: string,
  detail?: Record<string, unknown>
): ToolCallResult {
  const lines = [`error: ${message}`, `code:  ${code}`];
  if (hint) lines.push(`hint:  ${hint}`);
  const error = {
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(detail ? { detail } : {}),
  };
  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { error },
  };
}

function ok(id: number | string | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
