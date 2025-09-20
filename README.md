# Craftdriver 🍺🍺🍺

Crafted Node.js browser automation built directly on the WebDriver protocol.

Think of it as a modern take on Selenium with automatic waits and ergonomic API, while staying true to the W3C standards so your tests stay stable across real browsers.

## Getting started

Install from npm (package coming soon):

```bash
npm install craftdriver
```

Quick example:

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
await browser.navigateTo('http://127.0.0.1:8080/login.html');
await browser.type('#username', 'testuser');
await browser.type('#password', 'secret');
await browser.click('#submit');
await browser.expect('#result').toHaveText('Welcome testuser');
await browser.quit();
```

See [DOCUMENTATION.md](DOCUMENTATION.md) for more details.

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
