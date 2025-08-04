import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { CommandResponse, RequestOptions, WebDriverEndpoint } from './types.js';

export class HttpClient {
  constructor(private endpoint: WebDriverEndpoint) {}

  async send<T = unknown>({ method, path, body }: RequestOptions): Promise<CommandResponse<T>> {
    const base = `${this.endpoint.protocol}://${this.endpoint.hostname}:${this.endpoint.port}${this.endpoint.path ?? ''}`;
    const url = new URL(path, base);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      method,
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
}
