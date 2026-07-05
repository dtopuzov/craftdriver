import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { CommandResponse, RequestOptions, WebDriverEndpoint } from './types.js';
import { CraftdriverError, ErrorCode } from './errors.js';

/**
 * One keep-alive `Agent` per endpoint, shared across every `HttpClient`
 * instance for that endpoint (every Classic WebDriver command constructs a
 * fresh `HttpClient`, but they all resolve to the same pooled agent here) —
 * avoids a fresh TCP/TLS handshake on every single command.
 */
const agents = new Map<string, http.Agent | https.Agent>();

function agentKey(endpoint: WebDriverEndpoint): string {
  return `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}`;
}

function getAgent(endpoint: WebDriverEndpoint): http.Agent | https.Agent {
  const key = agentKey(endpoint);
  let agent = agents.get(key);
  if (!agent) {
    agent =
      endpoint.protocol === 'https'
        ? new https.Agent({ keepAlive: true, maxSockets: 6 })
        : new http.Agent({ keepAlive: true, maxSockets: 6 });
    agents.set(key, agent);
  }
  return agent;
}

/**
 * Build a `CraftdriverError` from a non-200 WebDriver response.
 *
 * Per the W3C WebDriver spec a *successful* command always replies HTTP 200;
 * any other status is an error whose body is
 * `{ value: { error, message, stacktrace } }`, where `error` is the spec's
 * machine-readable JSON error code (e.g. `"stale element reference"`,
 * `"element click intercepted"`). We surface `error`/`message` as
 * `detail.webDriverError` / `detail.webDriverMessage` so recovery loops can
 * classify the failure without string-scraping the human message.
 *
 * The status code is the sole gate for *whether* this is an error — never the
 * body shape. A successful `executeScript`/`evaluate()` can legitimately return
 * user data shaped like `{ error, message, stacktrace }` (e.g. serializing a
 * caught `Error`), and that must not be misread as a protocol failure. When the
 * body doesn't parse or doesn't carry the spec shape (proxy text, HTML error
 * page, empty body) we fall back to the raw text.
 */
function buildDriverError(
  status: number,
  text: string,
  method: string,
  path: string
): CraftdriverError {
  let webDriverError: string | undefined;
  let webDriverMessage: string | undefined;
  let stacktrace: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      value?: { error?: string; message?: string; stacktrace?: string };
    };
    const v = parsed?.value;
    if (v && typeof v === 'object') {
      if (typeof v.error === 'string') webDriverError = v.error;
      if (typeof v.message === 'string') webDriverMessage = v.message;
      if (typeof v.stacktrace === 'string') stacktrace = v.stacktrace;
    }
  } catch {
    // Non-JSON error body — keep the raw text in detail below.
  }

  const summary = webDriverError
    ? `${webDriverError}${webDriverMessage ? `: ${webDriverMessage}` : ''}`
    : `HTTP ${status}${text ? `: ${text}` : ''}`;

  return new CraftdriverError(
    ErrorCode.DRIVER_ERROR,
    `WebDriver command ${method} ${path} failed — ${summary}`,
    {
      detail: {
        method,
        path,
        status,
        ...(webDriverError !== undefined ? { webDriverError } : {}),
        ...(webDriverMessage !== undefined ? { webDriverMessage } : {}),
        ...(stacktrace !== undefined ? { stacktrace } : {}),
        ...(webDriverError === undefined ? { body: text } : {}),
      },
    }
  );
}

export class HttpClient {
  constructor(private endpoint: WebDriverEndpoint) {}

  async send<T = unknown>({ method, path, body }: RequestOptions): Promise<CommandResponse<T>> {
    const base = `${this.endpoint.protocol}://${this.endpoint.hostname}:${this.endpoint.port}${this.endpoint.path ?? ''}`;
    const url = new URL(path, base);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      method,
      agent: getAgent(this.endpoint),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const transport = isHttps ? (https as unknown as typeof http) : http;

    return await new Promise<CommandResponse<T>>((resolve, reject) => {
      const req = transport.request(url, options, (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');

          // W3C WebDriver: success is always HTTP 200; any other status is an
          // error response. Gate on status alone (see buildDriverError) so a
          // successful command returning error-shaped data is never misread.
          if (status !== 200) {
            return reject(buildDriverError(status, text, method, path));
          }

          if (!text) return resolve({ value: undefined as unknown as T });
          try {
            const json = JSON.parse(text) as CommandResponse<T>;
            resolve(json);
          } catch {
            reject(
              new CraftdriverError(
                ErrorCode.DRIVER_ERROR,
                `Invalid JSON in WebDriver response for ${method} ${path}: ${text}`,
                { detail: { method, path, status, body: text } }
              )
            );
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Destroy the keep-alive agent (and its pooled sockets) for this client's
   * endpoint. Call once the WebDriver session owning that endpoint is done
   * (`Driver.quit()`) so idle keep-alive sockets don't keep the Node process
   * alive after the browser session ends.
   */
  close(): void {
    const key = agentKey(this.endpoint);
    const agent = agents.get(key);
    if (agent) {
      agent.destroy();
      agents.delete(key);
    }
  }
}
