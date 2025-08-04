import { HttpClient } from './http.js';
import type { CommandResponse, WebDriverEndpoint } from './types.js';

export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
export const LEGACY_ELEMENT_KEY = 'ELEMENT';

export class WebElement {
  constructor(
    private endpoint: WebDriverEndpoint,
    private sessionId: string,
    private elementId: string
  ) {}

  getId(): string {
    return this.elementId;
  }

  async click(): Promise<void> {
    const client = new HttpClient(this.endpoint);
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/element/${this.elementId}/click`,
      body: {},
    });
  }

  async sendKeys(text: string): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const payload: { text: string; value: string[] } = { text, value: text.split('') };
    await client.send({
      method: 'POST',
      path: `/session/${this.sessionId}/element/${this.elementId}/value`,
      body: payload,
    });
  }

  async getText(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/text`,
    });
    const value = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(value ?? '');
  }

  toJSON() {
    return { [W3C_ELEMENT_KEY]: this.elementId, [LEGACY_ELEMENT_KEY]: this.elementId };
  }

  async isDisplayed(): Promise<boolean> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<boolean>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/displayed`,
    });
    const value = (res as CommandResponse<boolean>)?.value ?? (res as unknown as boolean);
    return Boolean(value);
  }

  async screenshotBase64(): Promise<string> {
    const client = new HttpClient(this.endpoint);
    const res = await client.send<string>({
      method: 'GET',
      path: `/session/${this.sessionId}/element/${this.elementId}/screenshot`,
    });
    const value = (res as CommandResponse<string>)?.value ?? (res as unknown as string);
    return String(value ?? '');
  }
}
