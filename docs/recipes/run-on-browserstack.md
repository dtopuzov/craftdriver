# Run On BrowserStack

A provider-specific walkthrough of [Remote WebDriver](../remote-webdriver.md)
against [BrowserStack](https://www.browserstack.com). craftdriver's core has
no BrowserStack-specific code — everything here is the generic `remote`
launch option plus BrowserStack's own `bstack:options` vendor capabilities,
which pass straight through untouched. If you're targeting a different
provider or a self-hosted Grid, start with the
[Remote WebDriver](../remote-webdriver.md) page instead; this recipe assumes
you've read it.

The desktop and real-device examples use the hosted
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html).
The BrowserStack Local example uses a URL reachable through your own tunnel.

## Credentials

```bash
export BROWSERSTACK_USERNAME=your_username
export BROWSERSTACK_ACCESS_KEY=your_access_key
```

Get these from BrowserStack's Automate dashboard. Never commit them — read
them from the environment, as shown throughout this page.

## Desktop Chrome (primary example)

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
  remote: {
    url: 'https://hub.browserstack.com/wd/hub',
    auth: {
      username: process.env.BROWSERSTACK_USERNAME!,
      password: process.env.BROWSERSTACK_ACCESS_KEY!,
    },
    // Allow time for BrowserStack to provision the session.
    sessionTimeoutMs: 120_000,
    commandTimeoutMs: 120_000,
    capabilities: {
      browserVersion: 'latest',
      'bstack:options': {
        os: 'Windows',
        osVersion: '11',
        projectName: 'CraftDriver',
        buildName: 'Remote smoke',
        sessionName: 'Chrome login flow',
        seleniumBidi: true,
        seleniumVersion: '4.20.0',
      },
    },
  },
});

try {
  await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
  await browser.getByLabel('Username').fill('alice');
  await browser.getByLabel('Password').fill('secret');
  await browser.getByRole('button', { name: 'Sign in' }).click();
  await browser.expect('#welcome').toContainText('Welcome back, alice!');
} finally {
  await browser.quit();
}
```

BiDi requires both craftdriver's `enableBiDi: true` and BrowserStack's
`seleniumBidi: true`. The Selenium version above follows BrowserStack's BiDi
setup example; use the version in BrowserStack's current
[BiDi guide](https://www.browserstack.com/docs/automate/selenium/bidi-event-driven-testing) or
Capability Generator when they differ. After launch,
`browser.isBiDiEnabled()` tells you whether the provider returned a usable
BiDi endpoint.

**Timeouts matter more remotely.** `sessionTimeoutMs` bounds only the initial
`POST /session` request (30 seconds when omitted). `commandTimeoutMs` sets the
default for subsequent Classic WebDriver HTTP commands. BiDi commands use
their own WebSocket timeouts and are not bounded by `commandTimeoutMs`.

## Concise variants

### Desktop Safari (Classic only)

```ts
const browser = await Browser.launch({
  browserName: 'safari',
  // Remote Safari defaults to Classic.
  remote: {
    url: 'https://hub.browserstack.com/wd/hub',
    auth: { username: process.env.BROWSERSTACK_USERNAME!, password: process.env.BROWSERSTACK_ACCESS_KEY! },
    capabilities: {
      'bstack:options': { os: 'OS X', osVersion: 'Sonoma', projectName: 'CraftDriver' },
    },
  },
});
```

### Android Chrome (real device)

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  remote: {
    url: 'https://hub.browserstack.com/wd/hub',
    auth: { username: process.env.BROWSERSTACK_USERNAME!, password: process.env.BROWSERSTACK_ACCESS_KEY! },
    capabilities: {
      'bstack:options': { deviceName: 'Samsung Galaxy S23', osVersion: '13.0', realMobile: true },
    },
  },
});
```

### iPhone Safari (real device)

```ts
const browser = await Browser.launch({
  browserName: 'safari',
  remote: {
    url: 'https://hub.browserstack.com/wd/hub',
    auth: { username: process.env.BROWSERSTACK_USERNAME!, password: process.env.BROWSERSTACK_ACCESS_KEY! },
    capabilities: {
      'bstack:options': { deviceName: 'iPhone 15', osVersion: '17', realMobile: true },
    },
  },
});
```

craftdriver doesn't model devices at all — **BrowserStack owns the real-device
catalog, and you pick from it.** Set `deviceName`/`osVersion`/`realMobile` in
`bstack:options` and craftdriver forwards them untouched; there is no
craftdriver device list to keep in sync. Pick valid values from BrowserStack's
own sources, not from memory:

- [Devices & platform grid](https://www.browserstack.com/list-of-browsers-and-platforms/automate)
  — the live catalog of every real device, OS version, and browser available
  for Automate.
- [Capabilities reference](https://www.browserstack.com/docs/automate/capabilities)
  — every `bstack:options` key, plus an interactive Capability Generator that
  emits the exact capability object for a device you choose.

A fleet's exact devices and OS versions change over time, so verify current
names against those pages before pinning them in CI.

`gesture.swipe()` and `gesture.pinch()` send W3C touch-pointer actions.
Whether those actions are supported is determined by the selected real
device, browser, and BrowserStack. Derive gesture coordinates from
`window.innerWidth` and `window.innerHeight`; a remote driver can reject
coordinates outside the device viewport with `move target out of bounds`.
Assert the page behavior caused by each gesture instead of treating a
no-error command as proof that the page received it.

## Running a platform list sequentially and in parallel

The three variants above are just different `capabilities`; running a list of
them is a loop over that list plus [Remote WebDriver](../remote-webdriver.md#parallel-remote-sessions)'s
same concurrency guarantee — each session gets its own connection pool, so
quitting one never disrupts another running against the same hub.

```ts
const platforms = [
  { browserName: 'chrome', 'bstack:options': { os: 'Windows', osVersion: '11' } },
  { browserName: 'safari', 'bstack:options': { os: 'OS X', osVersion: 'Sonoma' } },
  { browserName: 'chrome', 'bstack:options': { deviceName: 'Samsung Galaxy S23', realMobile: true } },
];

// Sequentially — one BrowserStack session (and its metered minute) at a time.
for (const { browserName, ...capabilities } of platforms) {
  const browser = await Browser.launch({
    browserName,
    remote: { url: hubUrl, auth, capabilities },
  });
  try {
    await runSmokeFlow(browser);
  } finally {
    await browser.quit();
  }
}

// In parallel — respect your BrowserStack plan's concurrent-session limit.
await Promise.all(
  platforms.map(async ({ browserName, ...capabilities }) => {
    const browser = await Browser.launch({
      browserName,
      remote: { url: hubUrl, auth, capabilities },
    });
    try {
      await runSmokeFlow(browser);
    } finally {
      await browser.quit();
    }
  })
);
```

Running in parallel is useful only up to your plan's concurrent-session
limit. BrowserStack may queue additional requests within your plan's queue
allowance and reject requests beyond that allowance, so bound application
concurrency instead of relying on an unlimited provider queue.

## BrowserStack Local for internal/private sites

craftdriver does not manage the BrowserStack Local process — provider
infrastructure stays outside the generic library API, the same way
craftdriver doesn't manage BrowserStack's Grid itself. You run the tunnel;
craftdriver just launches a session that's told to use it.

1. Run `BrowserStackLocal` yourself, on a machine/CI runner that can reach
   your internal site, with a unique identifier:

   ```bash
   ./BrowserStackLocal --key $BROWSERSTACK_ACCESS_KEY --local-identifier ci-run-42
   ```

2. Wait for it to report ready (its own stdout, or the
   [`browserstack-local` npm package](https://www.npmjs.com/package/browserstack-local)'s
   callback if you're launching it programmatically) before starting the
   session below — a session that requests `local: true` before the tunnel is
   up simply can't reach the internal site.

3. Set `local: true` in `bstack:options`, matching `localIdentifier` if you
   have multiple tunnels running (e.g. parallel CI jobs):

   ```ts
   const browser = await Browser.launch({
     browserName: 'chrome',
     remote: {
       url: 'https://hub.browserstack.com/wd/hub',
       auth: { username: process.env.BROWSERSTACK_USERNAME!, password: process.env.BROWSERSTACK_ACCESS_KEY! },
       capabilities: {
         acceptInsecureCerts: true, // only if the internal site requires it
         'bstack:options': { local: true, localIdentifier: 'ci-run-42' },
       },
     },
   });

   try {
     await browser.navigateTo('http://localhost:3000/internal-dashboard');
     // ...
   } finally {
     await browser.quit();
   }
   ```

4. Configure tunnel behavior such as `--force-local` and proxy settings on
   the `BrowserStackLocal` binary. `acceptInsecureCerts` is a standard
   top-level WebDriver capability, as shown above. Follow BrowserStack's
   [Local testing docs](https://www.browserstack.com/docs/automate/selenium/local-testing-introduction)
   for the current tunnel flags.

**Honest caveat:** the remote browser does not automatically inherit your
test runner's VPN connection just because the tunnel is running somewhere —
BrowserStack Local specifically proxies traffic through the machine running
`BrowserStackLocal`, so that machine (not the machine running your test
script) is what needs network access to the internal site.

## See also

- [Remote WebDriver](../remote-webdriver.md) — the generic, provider-neutral
  page this recipe builds on.
- [File Uploads And Downloads](./file-upload-download.md) — desktop remote
  sessions can upload through Selenium's `se/file` extension; see
  [Remote WebDriver → Remote file uploads](../remote-webdriver.md#remote-file-uploads)
  for what's different under the hood.
