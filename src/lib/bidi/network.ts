/**
 * BiDi Network Interceptor
 * Provides request interception, mocking, and modification capabilities
 */

import type { BiDiConnection } from './connection.js';
import type {
  BrowsingContext,
  InterceptPhase,
  NetworkBeforeRequestSentEvent,
  NetworkResponseEvent,
  NetworkIntercept,
  NetworkHeader,
  UrlPattern,
} from './types.js';

export interface MockResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | object;
}

export interface RequestHandler {
  (request: InterceptedRequest): MockResponse | void | Promise<MockResponse | void>;
}

export interface InterceptedRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType?: string;
  isBlocked: boolean;
  context: BrowsingContext | null;
}

export interface InterceptRule {
  id: NetworkIntercept;
  patterns: UrlPattern[];
  phases: InterceptPhase[];
  handler?: RequestHandler;
}

export class NetworkInterceptor {
  private connection: BiDiConnection;
  private intercepts = new Map<string, InterceptRule>();
  private handlers = new Map<string, RequestHandler>();
  private subscribed = false;
  private context?: BrowsingContext;

  constructor(connection: BiDiConnection, context?: BrowsingContext) {
    this.connection = connection;
    this.context = context;
  }

  /**
   * Initialize network event subscriptions
   */
  async initialize(): Promise<void> {
    if (this.subscribed) return;

    // Subscribe to network events
    await this.connection.subscribe([
      'network.beforeRequestSent',
      'network.responseStarted',
      'network.responseCompleted',
      'network.fetchError',
      'network.authRequired',
    ]);

    // Handle intercepted requests
    this.connection.on('network.beforeRequestSent', async (params) => {
      await this.handleBeforeRequestSent(params as unknown as NetworkBeforeRequestSentEvent);
    });

    this.subscribed = true;
  }

  /**
   * Add a network intercept for specific URL patterns
   */
  async intercept(
    patterns: string | string[] | UrlPattern | UrlPattern[],
    handler: RequestHandler,
    phases: InterceptPhase[] = ['beforeRequestSent']
  ): Promise<string> {
    await this.initialize();

    const urlPatterns = this.normalizePatterns(patterns);

    const result = await this.connection.send<{ intercept: string }>('network.addIntercept', {
      phases,
      urlPatterns,
      ...(this.context ? { contexts: [this.context] } : {}),
    });

    const interceptId = result.intercept;

    this.intercepts.set(interceptId, {
      id: interceptId,
      patterns: urlPatterns,
      phases,
      handler,
    });

    this.handlers.set(interceptId, handler);

    return interceptId;
  }

  /**
   * Mock all requests matching pattern with a fixed response
   */
  async mock(
    pattern: string | string[] | UrlPattern | UrlPattern[],
    response: MockResponse | ((req: InterceptedRequest) => MockResponse)
  ): Promise<string> {
    const handler: RequestHandler = (req) => {
      if (typeof response === 'function') {
        return response(req);
      }
      return response;
    };

    return this.intercept(pattern, handler);
  }

  /**
   * Block all requests matching pattern
   */
  async block(pattern: string | string[]): Promise<string> {
    return this.intercept(pattern, () => ({
      status: 0,
      body: '',
    }));
  }

  /**
   * Modify request headers for matching patterns
   */
  async setExtraHeaders(
    headers: Record<string, string>,
    contexts?: BrowsingContext[]
  ): Promise<void> {
    const headerList: NetworkHeader[] = Object.entries(headers).map(([name, value]) => ({
      name,
      value: { type: 'string', value },
    }));

    await this.connection.send('network.setExtraHeaders', {
      headers: headerList,
      ...(contexts ? { contexts } : {}),
    });
  }

  /**
   * Continue a blocked request (optionally with modifications)
   */
  async continueRequest(
    requestId: string,
    options?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<void> {
    const params: Record<string, unknown> = { request: requestId };

    if (options?.url) params.url = options.url;
    if (options?.method) params.method = options.method;
    if (options?.headers) {
      params.headers = Object.entries(options.headers).map(([name, value]) => ({
        name,
        value: { type: 'string', value },
      }));
    }
    if (options?.body) {
      params.body = { type: 'string', value: options.body };
    }

    await this.connection.send('network.continueRequest', params);
  }

  /**
   * Provide a custom response for a blocked request
   */
  async provideResponse(requestId: string, response: MockResponse): Promise<void> {
    const params: Record<string, unknown> = { request: requestId };

    if (response.status !== undefined) params.statusCode = response.status;
    if (response.statusText) params.reasonPhrase = response.statusText;
    if (response.headers) {
      params.headers = Object.entries(response.headers).map(([name, value]) => ({
        name,
        value: { type: 'string', value },
      }));
    }
    if (response.body !== undefined) {
      let bodyStr: string;
      let bodyType: 'string' | 'base64' = 'string';

      if (typeof response.body === 'string') {
        bodyStr = response.body;
      } else if (Buffer.isBuffer(response.body)) {
        bodyStr = response.body.toString('base64');
        bodyType = 'base64';
      } else {
        // Object - serialize as JSON
        bodyStr = JSON.stringify(response.body);
      }
      params.body = { type: bodyType, value: bodyStr };
    }

    await this.connection.send('network.provideResponse', params);
  }

  /**
   * Fail a blocked request
   */
  async failRequest(requestId: string): Promise<void> {
    await this.connection.send('network.failRequest', { request: requestId });
  }

  /**
   * Remove an intercept
   */
  async removeIntercept(interceptId: string): Promise<void> {
    await this.connection.send('network.removeIntercept', { intercept: interceptId });
    this.intercepts.delete(interceptId);
    this.handlers.delete(interceptId);
  }

  /**
   * Remove all intercepts
   */
  async removeAllIntercepts(): Promise<void> {
    const ids = [...this.intercepts.keys()];
    for (const id of ids) {
      await this.removeIntercept(id);
    }
  }

  /**
   * Set cache behavior
   */
  async setCacheBehavior(
    behavior: 'default' | 'bypass',
    contexts?: BrowsingContext[]
  ): Promise<void> {
    await this.connection.send('network.setCacheBehavior', {
      cacheBehavior: behavior,
      ...(contexts ? { contexts } : {}),
    });
  }

  private async handleBeforeRequestSent(event: NetworkBeforeRequestSentEvent): Promise<void> {
    if (!event.isBlocked || !event.intercepts?.length) return;

    const requestId = event.request.request;

    // Find matching handler
    for (const interceptId of event.intercepts) {
      const handler = this.handlers.get(interceptId);
      if (!handler) continue;

      const interceptedRequest: InterceptedRequest = {
        id: requestId,
        url: event.request.url,
        method: event.request.method,
        headers: this.headersToObject(event.request.headers),
        isBlocked: event.isBlocked,
        context: event.context,
      };

      try {
        const result = await handler(interceptedRequest);

        if (result) {
          // Provide mock response
          await this.provideResponse(requestId, result);
        } else {
          // Continue with original request
          await this.continueRequest(requestId);
        }
        return;
      } catch (err) {
        console.error('Error in network intercept handler:', err);
        await this.continueRequest(requestId);
        return;
      }
    }

    // No handler found, continue request
    await this.continueRequest(requestId);
  }

  private normalizePatterns(patterns: string | string[] | UrlPattern | UrlPattern[]): UrlPattern[] {
    // Handle single UrlPattern object
    if (typeof patterns === 'object' && !Array.isArray(patterns) && 'type' in patterns) {
      return [patterns];
    }
    const arr = Array.isArray(patterns) ? patterns : [patterns];
    return arr.map((p) => {
      if (typeof p === 'string') {
        // BiDi URL patterns don't support wildcards - they use exact component matching
        // Extract pathname from glob-style patterns for simple prefix matching
        if (p.includes('**') || p.includes('*')) {
          // Extract pathname from glob pattern
          // e.g., "**/api/users" -> pathname: "/api/users"
          // Note: BiDi will only match exact pathnames, not prefixes
          let pathname = p;
          // Remove leading **
          pathname = pathname.replace(/^\*\*/, '');
          // Remove trailing wildcards (can't do prefix matching in BiDi)
          pathname = pathname.replace(/\/?\*\*$/, '');
          pathname = pathname.replace(/\/?\*$/, '');
          // Remove any remaining wildcards
          pathname = pathname.replace(/\*/g, '');
          if (!pathname.startsWith('/')) {
            pathname = '/' + pathname;
          }
          // Clean up double slashes
          pathname = pathname.replace(/\/+/g, '/');
          return {
            type: 'pattern' as const,
            pathname,
          };
        }
        // For full URLs, use UrlPatternString
        return { type: 'string' as const, pattern: p };
      }
      return p;
    });
  }

  private headersToObject(headers: NetworkHeader[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const h of headers) {
      result[h.name] = h.value.value;
    }
    return result;
  }
}
