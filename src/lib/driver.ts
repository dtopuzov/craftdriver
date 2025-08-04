import { HttpClient } from './http.js';
import type { Capabilities, SessionResponse, WebDriverEndpoint, CommandResponse } from './types.js';
import { By } from './by.js';
import { WebElement, W3C_ELEMENT_KEY, LEGACY_ELEMENT_KEY } from './webelement.js';
import { WebDriverWait, type Condition, type WaitOptions } from './wait.js';

export class Driver {
  constructor(
    private endpoint: WebDriverEndpoint,
    private sessionId: string
  ) {}

  static async create(endpoint: WebDriverEndpoint, caps: Capabilities): Promise<Driver> {
    const client = new HttpClient(endpoint);
    const res = await client.send<SessionResponse>({
      method: 'POST',
      path: '/session',
      body: { capabilities: { alwaysMatch: caps } },
    });
    const value =
      (res as CommandResponse<SessionResponse>)?.value ?? (res as unknown as SessionResponse);
    const sessionId = (value as SessionResponse)?.sessionId || (res as any)?.sessionId;
    if (!sessionId) {
      const v: any = value as any;
      const err = v?.error;
      const msg = v?.message || v?.data || JSON.stringify(res);
      throw new Error(`Failed to create session${err ? ` [${err}]` : ''}: ${msg}`);
    }
    return new Driver(endpoint, sessionId);
  }

  async navigateTo(url: string): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({ method: 'POST', path: `/session/${this.sessionId}/url`, body: { url } });
  }

  async quit(): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({ method: 'DELETE', path: `/session/${this.sessionId}` });
  }

  async getCurrentUrl(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/url`,
    });
    const v = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(v ?? '');
  }

  async getTitle(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/title`,
    });
    const v = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(v ?? '');
  }

  async findElement(locator: By): Promise<WebElement> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<Record<string, string>>({
      method: 'POST',
      path: `/session/${this.sessionId}/element`,
      body: { using: locator.using, value: locator.value },
    });
    const value =
      (res as CommandResponse<Record<string, string>>)?.value ??
      (res as unknown as Record<string, string>);
    const elId = (value as any)?.[W3C_ELEMENT_KEY] || (value as any)?.[LEGACY_ELEMENT_KEY];
    if (!elId) throw new Error(`findElement failed: ${JSON.stringify(res)}`);
    return new WebElement(this.endpoint, this.sessionId, elId);
  }

  async findElements(locator: By): Promise<WebElement[]> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<Array<Record<string, string>> | Record<string, string>>({
      method: 'POST',
      path: `/session/${this.sessionId}/elements`,
      body: { using: locator.using, value: locator.value },
    });
    const arr = ((res as CommandResponse<Array<Record<string, string>>>)?.value ??
      (res as unknown as Array<Record<string, string>>)) as Array<Record<string, string>>;
    return (arr || [])
      .map((v) => {
        const elId = (v as any)?.[W3C_ELEMENT_KEY] || (v as any)?.[LEGACY_ELEMENT_KEY];
        if (!elId) return undefined;
        return new WebElement(this.endpoint, this.sessionId, elId);
      })
      .filter(Boolean) as WebElement[];
  }

  async executeScript<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<T>({
      method: 'POST',
      path: `/session/${this.sessionId}/execute/sync`,
      body: { script, args },
    });
    return ((res as CommandResponse<T>)?.value ?? (res as unknown as T)) as T;
  }

  wait<T>(condition: Condition<T>, options?: WaitOptions & { message?: string }): Promise<T>;
  wait<T>(
    condition: Condition<T>,
    timeoutMs?: number,
    intervalMs?: number,
    message?: string
  ): Promise<T>;
  wait<T>(condition: Condition<T>, a?: any, b?: any, c?: any): Promise<T> {
    // Overload: prefer options object, but accept legacy positional args
    if (typeof a === 'object') {
      const { timeout, interval, timeoutMsg, message } = a as WaitOptions & { message?: string };
      return new WebDriverWait(this, { timeout, interval, timeoutMsg }).until(condition, message);
    }
    return new WebDriverWait(this, a as number | undefined, b as number | undefined).until(
      condition,
      c as string | undefined
    );
  }

  // New helpers for simplified API
  // Note: string-based keyPress removed; use Key via keyboard controller.

  async keyPressCode(code: string, repeat: number = 1): Promise<void> {
    const client = new HttpClient(this.endpoint);
    for (let i = 0; i < repeat; i++) {
      await client.send({
        method: 'POST',
        path: `/session/${this.sessionId}/actions`,
        body: {
          actions: [
            {
              type: 'key',
              id: 'keyboard',
              actions: [
                { type: 'keyDown', value: code },
                { type: 'keyUp', value: code },
              ],
            },
          ],
        },
      });
    }
  }

  async keyDownCode(code: string): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: code }] }],
      },
    });
  }

  async keyUpCode(code: string): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: code }] }],
      },
    });
  }

  async typeText(text: string): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const actions = Array.from(text).flatMap((ch) => [
      { type: 'keyDown', value: ch },
      { type: 'keyUp', value: ch },
    ]);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: { actions: [{ type: 'key', id: 'keyboard', actions }] },
    });
  }

  // Pointer/mouse helpers
  async pointerMoveTo(
    originElement?: WebElement,
    x?: number,
    y?: number,
    duration: number = 0
  ): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const pointerMove: Record<string, unknown> = { type: 'pointerMove', duration };
    if (originElement) {
      pointerMove.origin = originElement.toJSON();
      // Always include x/y; default to 0,0 which for element origin is the element's center
      pointerMove.x = typeof x === 'number' ? x : 0;
      pointerMove.y = typeof y === 'number' ? y : 0;
    } else {
      pointerMove.origin = 'viewport';
      pointerMove.x = x ?? 0;
      pointerMove.y = y ?? 0;
    }
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [pointerMove],
          },
        ],
      },
    });
  }

  async mouseDown(button: number = 0): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [{ type: 'pointerDown', button }],
          },
        ],
      },
    });
  }

  async mouseUp(button: number = 0): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [{ type: 'pointerUp', button }],
          },
        ],
      },
    });
  }

  async pointerClick(
    originElement?: WebElement,
    x?: number,
    y?: number,
    button: number = 0,
    count: number = 1,
    moveDuration: number = 50
  ): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const pointerMove: Record<string, unknown> = { type: 'pointerMove', duration: moveDuration };
    if (originElement) {
      pointerMove.origin = originElement.toJSON();
      pointerMove.x = typeof x === 'number' ? x : 0;
      pointerMove.y = typeof y === 'number' ? y : 0;
    } else {
      pointerMove.origin = 'viewport';
      pointerMove.x = x ?? 0;
      pointerMove.y = y ?? 0;
    }
    const singleClick = [
      pointerMove,
      { type: 'pointerDown', button },
      { type: 'pointerUp', button },
    ];
    const actions = Array.from({ length: Math.max(1, count) }, () => singleClick).flat();
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }],
      },
    });
  }

  async wheelScroll(
    deltaX: number,
    deltaY: number,
    x: number = 0,
    y: number = 0,
    duration: number = 0
  ): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [
          {
            type: 'wheel',
            id: 'wheel',
            actions: [{ type: 'scroll', x, y, deltaX, deltaY, duration }],
          },
        ],
      },
    });
  }

  async performTouchSwipe(
    from: [number, number],
    to: [number, number],
    durationMs = 300
  ): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const [x1, y1] = from;
    const [x2, y2] = to;
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', x: x1, y: y1, duration: 0 },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerMove', x: x2, y: y2, duration: durationMs },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
    });
  }

  async performTouchPinch(
    center: [number, number],
    scale = 0.5,
    distance = 100,
    durationMs = 250
  ): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const [cx, cy] = center;
    const dx = distance / 2;
    const dy = 0;
    const start1 = [cx - dx, cy - dy] as const;
    const start2 = [cx + dx, cy + dy] as const;
    const end1 = [cx - dx * scale, cy - dy * scale] as const;
    const end2 = [cx + dx * scale, cy + dy * scale] as const;
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', x: start1[0], y: start1[1], duration: 0 },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerMove', x: end1[0], y: end1[1], duration: durationMs },
              { type: 'pointerUp', button: 0 },
            ],
          },
          {
            type: 'pointer',
            id: 'finger2',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', x: start2[0], y: start2[1], duration: 0 },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerMove', x: end2[0], y: end2[1], duration: durationMs },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
    });
  }

  async screenshotBase64(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<any>({
      method: 'GET',
      path: `/session/${this.sessionId}/screenshot`,
    });
    return String((res as any)?.value ?? res ?? '');
  }

  // Internal helper for ActionsBuilder to send combined payloads
  async __sendActions(actions: any[]): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/actions`,
      body: { actions },
    });
  }
}
