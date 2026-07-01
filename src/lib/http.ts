import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { CommandResponse, RequestOptions, WebDriverEndpoint } from './types.js';

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
          const text = Buffer.concat(chunks).toString('utf8');
          if (!text) return resolve({ value: undefined as unknown as T });
          try {
            const json = JSON.parse(text) as CommandResponse<T>;
            resolve(json);
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${text}`));
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
