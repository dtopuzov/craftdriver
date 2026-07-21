---
layout: home
title: CraftDriver
titleTemplate: false
hero:
  name: CraftDriver
  text: Crafted browser automation for Node.js.
  tagline: Playwright-style ergonomics. WebDriver standards. AI friendly.
  image:
    src: /craftdriver-mark.svg
    alt: CraftDriver
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Recipes
      link: /recipes
    - theme: alt
      text: API Reference
      link: /api-reference
    - theme: alt
      text: AI Agent Guide
      link: /agents
features:
  - title: Control network traffic
    details: Mock APIs, block noisy requests, intercept calls, and wait for real requests or responses.
  - title: Reuse browser state
    details: Save cookies and localStorage, launch already signed in, and isolate users with browser contexts.
  - title: Test time and quality
    details: Use virtual time, axe-core accessibility checks, traces, screenshots, console logs, and JS error capture.
  - title: Agent-friendly
    details: CLI, a safe project-local skill, and optional MCP are there when you want coding agents to drive the browser too.
---

## Quick Start

```bash
npm install craftdriver --save-dev
```

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

await browser.navigateTo('https://example.com/login');
await browser.getByLabel('Username').fill('alice');
await browser.getByLabel('Password').fill('hunter2');
await browser.getByRole('button', { name: 'Sign in' }).click();
await browser.expect('#result').toHaveText('Welcome alice');

await browser.quit();
```

## Choose Your Path

| You want to...                    | Start                                   |
| --------------------------------- | --------------------------------------- |
| Write browser automation          | [Getting Started](./getting-started.md) |
| Solve a common testing workflow   | [Recipes](./recipes.md)                 |
| Give an AI coding agent a browser | [AI Agent Guide](./agents.md)           |
| Run on a Grid or cloud provider   | [Remote WebDriver](./remote-webdriver.md) |

## Good Stuff To Read Next

- [Zero-Config Drivers](./zero-config-drivers.md) explains driver resolution and caching.
- [WebDriver Standards](./standards.md) explains how Classic and BiDi work together.
- [Recipes](./recipes.md) collects KB-style patterns for common real-world workflows.
