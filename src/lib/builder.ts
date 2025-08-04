import { ChromeService } from './chrome.js';
import { Driver } from './driver.js';
import { Capabilities } from './types.js';

export class Builder {
  private browserName: string | undefined;
  private chromeService: ChromeService | undefined;
  private caps: Capabilities = {};

  forBrowser(name: 'chrome' | 'chromium' | 'firefox' | string): this {
    this.browserName = name;
    return this;
  }

  setChromeService(service: ChromeService): this {
    this.chromeService = service;
    return this;
  }

  withCapabilities(caps: Capabilities): this {
    this.caps = { ...this.caps, ...caps };
    return this;
  }

  async build(): Promise<Driver> {
    const name = this.browserName ?? 'chrome';
    if (name !== 'chrome' && name !== 'chromium') {
      throw new Error(`Only chrome/chromium supported in this initial setup. Requested: ${name}`);
    }
    const service = this.chromeService ?? new ChromeService();
    await service.start();
    const endpoint = service.getEndpoint();
    const caps = { browserName: name, ...this.caps };
    return await Driver.create(endpoint, caps);
  }
}
