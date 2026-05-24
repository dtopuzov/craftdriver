/**
 * Wire protocol for the craftdriver daemon.
 *
 * Line-delimited JSON over a Unix domain socket. Each line is a
 * single JSON object terminated by `\n`. Requests carry an `id`;
 * the daemon mirrors it back on the matching response.
 *
 * v1 deliberately uses a hand-rolled framing rather than JSON-RPC
 * to keep the surface tiny. If the MCP server later wants to reuse
 * the dispatcher we can upgrade to JSON-RPC behind the same
 * `Request`/`Response` shape — agents don't see the wire format.
 */
export interface Request {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
}

export interface OkResponse {
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrResponse {
  id: number;
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    detail?: Record<string, unknown>;
  };
}

export type Response = OkResponse | ErrResponse;
