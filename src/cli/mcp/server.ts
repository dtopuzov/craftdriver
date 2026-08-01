/**
 * MCP server — JSON-RPC 2.0 over newline-delimited stdio.
 *
 * The protocol functions in this module only decode, classify, route, and
 * render messages. Browser commands always execute through AgentSession.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchOptions } from '../../lib/browser.js';
import { assertLocalOnlyLaunch } from '../../lib/launchTarget.js';
import { CraftdriverError, ErrorCode } from '../../lib/errors.js';
import { AgentSession, type AgentSessionRunner } from '../agentSession.js';
import {
  TOOLS,
  getTool,
  inputSchemaFor,
  validateToolArgs,
  runToolDetailed,
  type ToolDef,
} from './tools.js';
import { renderFull, type SnapshotShape } from '../snapshot.js';
import { BoundedLineReader, MAX_FRAME_BYTES } from '../lineReader.js';
import { boundToolResult, resolveMaxResponseBytes, truncateUtf8 } from './bounds.js';
import { ArtifactStore, ArtifactQuotaError, resolveSpillBytes, spillPreview } from './artifacts.js';

/**
 * Protocol versions this server has actually been tested against, newest
 * first. Negotiation picks from this list and never echoes an unknown
 * requested version: claiming to speak a revision nobody verified is how a
 * client ends up relying on behaviour that was never implemented.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];
const SERVER_NAME = 'craftdriver';

/**
 * Read from the installed package rather than a hand-maintained constant,
 * which had drifted to 0.1.0 against a 1.7.0 package — so every client was
 * told the wrong server version.
 */
function readServerVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli/mcp/server.js and src/cli/mcp/server.ts are both three levels
    // below the package root.
    const pkg = JSON.parse(
      readFileSync(resolvePath(here, '..', '..', '..', 'package.json'), 'utf8')
    ) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readServerVersion();

/**
 * Choose the protocol version to answer with.
 *
 * A client asking for a version we support gets it. Anything else — unknown,
 * malformed, or missing — gets our default, which the spec allows and which
 * is honest about what this server actually implements.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

/** Maximum UTF-8 payload for one MCP JSON line. Shared with the daemon. */
export const MCP_MAX_FRAME_BYTES = MAX_FRAME_BYTES;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
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
  /** Override the envelope cap (default 32 KiB; env: $CRAFTDRIVER_MCP_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Internal injection point for protocol and lifecycle tests. */
  sessionFactory?: () => AgentSessionRunner;
  /** Internal injection point for SIGINT/SIGTERM lifecycle tests. */
  signalSource?: McpSignalSource;
}

export interface ClassifiedJsonRpcMessage {
  kind: 'request' | 'notification';
  message: JsonRpcRequest;
}

/** Decode exactly one JSON value after newline framing has completed. */
export function decodeJsonLine(line: string): unknown {
  return JSON.parse(line) as unknown;
}

/** Classify by presence of an `id`; validation remains a separate concern. */
export function classifyJsonRpcMessage(value: unknown): ClassifiedJsonRpcMessage {
  const message = value as JsonRpcRequest;
  return {
    kind: Object.prototype.hasOwnProperty.call(message, 'id') ? 'request' : 'notification',
    message,
  };
}

export function serializeJsonRpcResponse(response: JsonRpcResponse): string {
  return JSON.stringify(response) + '\n';
}

export function sendJsonRpcResponse(
  output: NodeJS.WritableStream,
  response: JsonRpcResponse
): void {
  output.write(serializeJsonRpcResponse(response));
}

interface SnapshotState {
  snapshotsOn: boolean;
  artifacts: ArtifactStore;
  spillBytes: number;
  /** Envelope cap, applied to failures as well as successes. */
  maxResponseBytes: number;
}

interface RouterContext {
  session: AgentSessionRunner;
  snapshotState: SnapshotState;
}

interface ToolInvocation {
  value: unknown;
  delta?: string;
}

export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  // The MCP server is a local dev tool only — never reachable against a
  // Grid/cloud. Fail fast at startup, not on first browser use.
  assertLocalOnlyLaunch(opts.launch as unknown as Record<string, unknown>);

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const signalSource = opts.signalSource ?? process;
  const session =
    opts.sessionFactory?.() ??
    new AgentSession({
      launchOptions: opts.launch,
      autoSnapshot: opts.snapshot !== 'none',
    });
  const router: RouterContext = {
    session,
    snapshotState: {
      snapshotsOn: opts.snapshot !== 'none',
      artifacts: new ArtifactStore(opts.artifactsDir),
      spillBytes: opts.spillBytes ?? resolveSpillBytes(),
      maxResponseBytes: opts.maxResponseBytes ?? resolveMaxResponseBytes(),
    },
  };
  const reader = new BoundedLineReader();
  const pending = new Set<Promise<void>>();
  let routeTail: Promise<void> = Promise.resolve();
  let accepting = true;

  const trackMessage = (classified: ClassifiedJsonRpcMessage): void => {
    const route = async (): Promise<void> => {
      const response = await routeJsonRpcMethod(classified, router);
      if (response) sendJsonRpcResponse(output, response);
    };
    const isToolCall = classified.message.method === 'tools/call';
    const task = isToolCall ? routeTail.then(route) : route();
    if (isToolCall) routeTail = task.catch(() => undefined);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task)
    );
  };

  const onData = (chunk: string | Buffer): void => {
    if (!accepting) return;
    for (const event of reader.push(chunk)) {
      if (event.kind === 'oversized') {
        sendJsonRpcResponse(
          output,
          rpcError(null, -32700, `input frame exceeds ${MCP_MAX_FRAME_BYTES}-byte limit`)
        );
        continue;
      }

      const line = event.line.trim();
      if (!line) continue;
      try {
        trackMessage(classifyJsonRpcMessage(decodeJsonLine(line)));
      } catch {
        sendJsonRpcResponse(output, rpcError(null, -32700, 'parse error'));
      }
    }
  };

  input.setEncoding?.('utf8');
  input.on('data', onData);

  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    accepting = false;
    finish();
  };

  input.once('end', stop);
  input.once('close', stop);
  signalSource.once('SIGINT', stop);
  signalSource.once('SIGTERM', stop);

  try {
    await stopped;
    await Promise.allSettled([...pending]);
  } finally {
    input.removeListener('data', onData);
    input.removeListener('end', stop);
    input.removeListener('close', stop);
    signalSource.off('SIGINT', stop);
    signalSource.off('SIGTERM', stop);
    await session.close();
  }
}

export async function routeJsonRpcMethod(
  classified: ClassifiedJsonRpcMessage,
  ctx: RouterContext
): Promise<JsonRpcResponse | null> {
  const req = classified.message;
  const id = req.id ?? null;
  // JSON-RPC forbids replying to a notification. Only `notifications/
  // initialized` was handled explicitly, so every other notification fell
  // through to the method-not-found default and got an unsolicited
  // `id: null` error frame — which strict MCP clients treat as a protocol
  // violation. Silence is the correct response to all of them.
  if (classified.kind === 'notification') return null;
  try {
    switch (req.method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: negotiateProtocolVersion(req.params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'craftdriver browser automation. Probe selectors with browser_exists ' +
            'before acting; errors carry a stable `code` field; the post-action ' +
            'a11y snapshot diff tells you what changed.',
        });

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchemaFor(tool),
            annotations: tool.annotations,
          })),
        });

      case 'tools/call': {
        const name = req.params?.name as string | undefined;
        const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
        if (!name) return rpcError(id, -32602, 'tools/call: missing "name"');
        const tool = getTool(name);
        // A tool that does not exist is a caller mistake about the protocol,
        // not a browser failure, so it is a JSON-RPC error rather than a
        // successful result carrying isError. Normal action failures — a
        // missing element, a timeout — stay successful results.
        if (!tool) return rpcError(id, -32602, `tools/call: unknown tool "${name}"`);

        let validated: Record<string, unknown>;
        try {
          // Validate before the session queue: a malformed call should not
          // wait behind a slow browser action to be told it was malformed,
          // and nothing invalid should reach the dispatcher at all.
          validated = validateToolArgs(tool, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return rpcError(id, -32602, message, {
            ...(error instanceof CraftdriverError && error.detail ? { detail: error.detail } : {}),
          });
        }

        try {
          const invocation = await invokeTool(ctx.session, tool, validated, ctx.snapshotState);
          return ok(
            id,
            await serializeToolSuccess(tool, invocation.value, {
              artifacts: ctx.snapshotState.artifacts,
              spillBytes: ctx.snapshotState.spillBytes,
              delta: invocation.delta,
              maxResponseBytes: ctx.snapshotState.maxResponseBytes,
            })
          );
        } catch (error) {
          return ok(id, serializeToolFailure(error, ctx.snapshotState.maxResponseBytes));
        }
      }

      case 'resources/list':
        return ok(id, { resources: [] });

      default:
        return rpcError(id, -32601, `method not found: ${req.method}`);
    }
  } catch (error) {
    return rpcError(id, -32000, (error as Error).message ?? String(error));
  }
}

async function invokeTool(
  session: AgentSessionRunner,
  tool: ToolDef,
  inputArgs: Record<string, unknown>,
  snapshotState: SnapshotState
): Promise<ToolInvocation> {
  let args = inputArgs;
  let screenshotPath: string | undefined;
  if (tool.name === 'browser_screenshot') {
    // Always server-allocated. The tool takes no destination, so this is the
    // only path a screenshot can land on, which is what its description says.
    screenshotPath = await snapshotState.artifacts.allocate('screenshot.png');
    args = {
      ...args,
      path: screenshotPath,
    };
  }

  // The session captures the post-action snapshot in the same operation
  // as the action, against the one baseline explicit snapshots also
  // advance. The adapter renders that result; it never owns a second one.
  let detailed: Awaited<ReturnType<typeof runToolDetailed>>;
  try {
    detailed = await runToolDetailed(session, tool, args);
    if (screenshotPath) await snapshotState.artifacts.commitAllocated(screenshotPath);
  } catch (error) {
    if (screenshotPath) await snapshotState.artifacts.releaseAllocated(screenshotPath);
    throw error;
  }
  if (!snapshotState.snapshotsOn) return { value: detailed.value };
  return { value: detailed.value, ...(detailed.delta ? { delta: detailed.delta } : {}) };
}

interface ToolResultContext {
  artifacts: ArtifactStore;
  spillBytes: number;
  delta?: string;
  /** Cap on the complete serialized result; defaults from the environment. */
  maxResponseBytes?: number;
}

/** Render an already-computed tool value without invoking browser work. */
export async function serializeToolSuccess(
  tool: ToolDef,
  value: unknown,
  ctx: ToolResultContext
): Promise<ToolCallResult> {
  const content: ContentBlock[] = [];
  let primaryText: string;
  if (tool.name === 'browser_snapshot' && value && typeof value === 'object' && 'lines' in value) {
    primaryText = await maybeSpill(
      renderFull(value as SnapshotShape),
      'snapshot.txt',
      ctx.artifacts,
      ctx.spillBytes
    );
  } else {
    primaryText = await summariseValue(tool.name, value, ctx.artifacts, ctx.spillBytes);
  }
  content.push({ type: 'text', text: primaryText });

  if (ctx.delta) {
    content.push({
      type: 'text',
      text: await maybeSpill(ctx.delta, 'snapshot.txt', ctx.artifacts, ctx.spillBytes),
    });
  }

  // Bound the complete response, not just the content blocks. Spilling a
  // large value to an artifact while attaching the same value in full as
  // structuredContent left a 50 KB eval on the wire behind a 514-byte preview.
  return boundToolResult(
    { content, structuredContent: { result: value } },
    ctx.maxResponseBytes ?? resolveMaxResponseBytes()
  );
}

/**
 * Render a tool failure without requiring a session or transport.
 *
 * Bounded like a success. An error carries page-derived text — an assertion
 * message quoting a whole element, a driver error echoing a selector — so
 * leaving the failure path unbounded left the envelope cap trivially
 * bypassable by whatever the page put in the message.
 */
export function serializeToolFailure(
  error: unknown,
  maxResponseBytes: number = resolveMaxResponseBytes()
): ToolCallResult {
  const result =
    error instanceof CraftdriverError
      ? toolError(
          error.message,
          error.code,
          error.hint,
          compactErrorDetail(error.detail),
          error.recoverySnapshot
        )
      : toolError((error as Error)?.message ?? String(error), ErrorCode.DRIVER_ERROR);
  return boundToolResult(result, maxResponseBytes);
}

async function summariseValue(
  toolName: string,
  value: unknown,
  artifacts: ArtifactStore,
  spillBytes: number
): Promise<string> {
  if (value === null || value === undefined) return `${toolName}: ok`;
  const text = typeof value === 'string' ? value : safeJson(value);
  return maybeSpill(text, `${toolName}.txt`, artifacts, spillBytes);
}

async function maybeSpill(
  text: string,
  nameHint: string,
  artifacts: ArtifactStore,
  spillBytes: number
): Promise<string> {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= spillBytes) return text;
  try {
    const written = await artifacts.write(nameHint, text);
    return spillPreview(text, written);
  } catch (error) {
    if (!(error instanceof ArtifactQuotaError)) throw error;
    // A full artifact store must not fail the command the agent asked for.
    // Fall back to an inline value; the envelope bound trims it either way.
    return truncateUtf8(text, spillBytes) + `\n… (truncated — ${error.message})`;
  }
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
  const seen = new WeakSet<object>();
  const strip = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(strip);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.toLowerCase() === 'stacktrace' || key.toLowerCase() === 'stack') continue;
      result[key] = strip(child);
    }
    return result;
  };
  const compact = strip(detail) as Record<string, unknown>;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function toolError(
  message: string,
  code: string,
  hint?: string,
  detail?: Record<string, unknown>,
  recoverySnapshot?: string
): ToolCallResult {
  const lines = [`error: ${message}`, `code:  ${code}`];
  if (hint) lines.push(`hint:  ${hint}`);
  if (recoverySnapshot) lines.push(`recovery snapshot:\n${recoverySnapshot}`);
  const error = {
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(detail ? { detail } : {}),
    ...(recoverySnapshot ? { recoverySnapshot } : {}),
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
  extra?: { detail?: unknown }
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      // `data` carries the machine-readable part (which field, what was
      // allowed) so a client need not parse the message to correct itself.
      ...(extra?.detail !== undefined ? { data: extra.detail } : {}),
    },
  };
}
