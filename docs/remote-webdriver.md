# Remote WebDriver

`Browser.launch({ remote })` connects to a W3C-compatible remote WebDriver
endpoint — a self-hosted Selenium Grid, BrowserStack, or another cloud
provider — instead of starting a local browser/driver process. You use the
same `Browser` API after launch. Feature availability still depends on the
browser, protocol, Grid configuration, and provider; BiDi-only features such
as network interception require the endpoint to return a working
`webSocketUrl`.

craftdriver's core has **zero provider-specific code**. `remote` speaks plain
W3C `POST /session` + Basic auth + opaque capability passthrough; a provider's
own vendor capabilities (BrowserStack's `bstack:options`, or another
provider's equivalent) pass straight through `remote.capabilities` untouched.
See the [BrowserStack recipe](./recipes/run-on-browserstack.md) for a
provider-specific walkthrough — this page stays generic.

> **Not available from the CLI or MCP server.** Both are local dev tools —
> they help you write and debug tests against a browser on your own machine,
> not execute against a Grid or cloud. Passing `remote` to either fails fast
> with a clear error at startup. Use the `Browser.launch({ remote })` library
> API directly from your own script/test runner instead.

## Local vs. remote session lifecycle

A local launch starts a driver process (`chromedriver`/`geckodriver`/
`safaridriver`) on your machine, then creates a WebDriver session against it.
A remote launch skips that local process entirely — no driver download, no
downloads directory, no browser-binary resolution — and creates the session
directly against the endpoint you give it:

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({
  browserName: 'chrome',
  remote: {
    url: 'http://localhost:4444', // Selenium Grid 4 default
  },
});

await browser.navigateTo('https://example.com');
// ...
await browser.quit(); // DELETEs the remote session
```

`browser.quit()` closes an active BiDi connection and deletes the WebDriver
session. There is no local driver process for craftdriver to stop remotely.

## A plain Selenium Grid, no provider-specific capabilities

```ts
const browser = await Browser.launch({
  browserName: 'firefox',
  remote: {
    url: 'http://grid.internal:4444',
  },
});
```

Nothing above is BrowserStack-specific. Selenium Grid 4 uses the root URL by
default. If your Grid is configured with a non-root base path, include that
path in `remote.url`; craftdriver preserves it.

## Authentication

Pass credentials via `remote.auth`, or embed them in `remote.url` for
Selenium-migration compatibility (`https://user:pass@host/...`) — not both;
craftdriver rejects the combination rather than silently picking one.

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  remote: {
    url: 'https://hub.browserstack.com/wd/hub',
    auth: {
      username: process.env.BROWSERSTACK_USERNAME!,
      password: process.env.BROWSERSTACK_ACCESS_KEY!,
    },
  },
});
```

Credentials are sent as a standard `Authorization: Basic ...` header on every
request to the remote endpoint. craftdriver never logs `remote.auth`, never
includes it in a thrown error's message or `detail`, and never forwards it to
a BiDi WebSocket connection (some providers proxy `webSocketUrl` through a
different host than the REST endpoint — Basic auth is tied to the REST
origin and is never reused there).

**Secret-handling guidance:** treat `remote.auth`/URL-embedded credentials
like any other secret — read them from environment variables, never commit
them, and never log the `remote` object itself (its `auth` field and any
credential embedded in `url` are exactly what you don't want in a CI log).

## Capabilities: standard and vendor-namespaced

`remote.capabilities` is opaque W3C JSON. craftdriver validates that it is an
object and merges it under `alwaysMatch`; vendor namespaces such as
`bstack:options` pass through without schema conversion. craftdriver fills in
`browserName` and its BiDi request defaults only when those values are absent.

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  remote: {
    url: 'https://hub.browserstack.com/wd/hub',
    auth: { username: '...', password: '...' },
    capabilities: {
      browserVersion: 'latest',
      'bstack:options': {
        os: 'Windows',
        osVersion: '11',
        projectName: 'CraftDriver',
        buildName: 'Remote smoke',
      },
    },
  },
});
```

If `remote.capabilities` also sets `browserName`, it must agree
(case-insensitively) with the top-level `browserName` — craftdriver rejects a
genuine conflict rather than silently picking one.

### Headless and other browser flags on a remote session

A local launch honors the `HEADLESS` env var and injects `--headless=new` for
you. A **remote** launch deliberately does not — the remote path is opaque
passthrough and never adds browser flags itself (it can't assume which browser
or vendor-option shape the endpoint runs). Pass headless (and any other flag)
through the browser's own vendor capability:

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  remote: {
    url: 'http://grid.internal:4444',
    capabilities: {
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] },
    },
  },
});
```

Use `moz:firefoxOptions.args` (`-headless`) for Firefox and `ms:edgeOptions`
for Edge. This is how a Grid runs browsers headless on a CI runner with no
display — no Xvfb required.

## Browser names: not limited to craftdriver's local whitelist

Locally, craftdriver only knows how to launch `chrome`, `chromium`,
`firefox`, and `safari` — those are the only browsers craftdriver itself
knows how to spawn a driver process for. Remotely, a Grid or provider may
offer Edge, older browser versions, or anything else it supports, so
`browserName` accepts any non-empty string for a remote launch and defaults
to `'chrome'` when omitted.

## Classic/BiDi negotiation for remote

The default mirrors local policy: `chrome`, `chromium`, `firefox`, and
`edge`/`microsoftedge` default to BiDi on (`enableBiDi !== false`); `safari`
and any browser name craftdriver doesn't recognize default to Classic,
requiring an explicit `enableBiDi: true` to opt in. Unlike local Safari
(where `enableBiDi: true` is rejected outright), an unrecognized remote
browser name is allowed to opt in — craftdriver just won't assume BiDi works
for a name it doesn't know, but it also won't refuse the attempt.

```ts
const browser = await Browser.launch({
  browserName: 'MicrosoftEdge',
  remote: { url: 'https://hub.example.com/wd/hub' },
});
```

If the remote endpoint doesn't actually return a `webSocketUrl` in its
session-create response, craftdriver simply never attempts a BiDi connection
— no error, no retry, the session runs Classic. If a BiDi connection is
attempted and fails after retries, craftdriver falls back to Classic and logs
a warning with the WebSocket URL's query string, fragment, and any embedded
credentials stripped before logging.

Whether a remote endpoint returns a `webSocketUrl` is up to that endpoint.
Selenium Grid can proxy WebDriver BiDi when Grid BiDi proxying is enabled and
the selected node/browser supports it. This project verifies that path with
Selenium Grid 4.46.0 and Chrome. Administrators can disable the proxy, and a
provider may require additional capabilities, so check
`browser.isBiDiEnabled()` before depending on BiDi-only APIs.

## Session and command timeouts

Real remote sessions run over a network, not a loopback socket to a process
craftdriver just spawned — set generous timeouts:

```ts
const browser = await Browser.launch({
  remote: {
    url: 'https://hub.example.com/wd/hub',
    sessionTimeoutMs: 120_000, // POST /session — session creation only
    commandTimeoutMs: 120_000, // applied as the default for every command after
  },
});
```

`sessionTimeoutMs` bounds only the initial session-creation request.
`commandTimeoutMs` becomes the default for every WebDriver command sent over
that session afterward (navigate, find, click, evaluate, ...), unless a
specific call already passes its own timeout.

A timed-out `POST /session` is **not retried** — a client-side timeout on
session creation doesn't mean the remote end failed; it may have already
created the session. Blind retry risks creating a second, paid, orphaned
session on a metered provider, so craftdriver creates a remote session
exactly once and surfaces the failure if it doesn't succeed. (Local sessions
still retry — that logic exists for local driver-process readiness lag, which
doesn't apply here.)

## Parallel remote sessions

Many concurrent sessions against one hub/host is the normal case for a
Grid or cloud provider — unlike a local launch, where every `DriverService`
picks its own port. craftdriver gives each remote session its own
keep-alive connection pool, so quitting one session never disrupts another
session's in-flight requests, even when they share the same host:port.

```ts
const [a, b] = await Promise.all([
  Browser.launch({ browserName: 'chrome', remote: { url: hubUrl } }),
  Browser.launch({ browserName: 'firefox', remote: { url: hubUrl } }),
]);
try {
  await Promise.all([a.navigateTo(url1), b.navigateTo(url2)]);
} finally {
  await a.quit();
  await b.quit(); // unaffected by a.quit() completing first
}
```

## Supported / unsupported feature matrix

The Classic/BiDi split still applies — see
[WebDriver Standards](./standards.md). Remote endpoints add these constraints:

| Feature | Remote behavior |
|---|---|
| File upload (`setInputFiles()`) | Supported when the endpoint implements Selenium's `se/file` extension; see below. Mobile/cloud sessions may require a provider-specific upload mechanism. |
| Downloads (`waitForDownload()`) | **Unsupported.** Throws `UNSUPPORTED` immediately (not a timeout) — a remote session has no client-visible downloads directory. Use your provider's own download/artifact API if it has one. |
| Desktop browsers, Edge, unrecognized names | Can be requested; the endpoint decides whether the browser/version is available. See [Browser names](#browser-names-not-limited-to-craftdrivers-local-whitelist). |
| Real mobile browsers (Android Chrome, iOS Safari) | Device selection is provider-controlled. Pass documented device capabilities through `remote.capabilities`. `gesture.swipe()` and `gesture.pinch()` use W3C touch-pointer actions, but support is determined by the selected device/browser/provider; verify the gestures your suite relies on. |

## Remote file uploads

`setInputFiles()` works transparently on a remote session — you still pass a
local file path:

```ts
await browser.find('input[type=file]').setInputFiles('/local/path/report.csv');
```

Under the hood, a local path cannot be used directly by a remote node.
craftdriver zips the file, calls Selenium's
`POST /session/{id}/se/file` extension, and sends the returned remote path to
the input. This works for desktop Grid/provider sessions that implement that
extension. Check your provider's documentation for mobile sessions or
endpoints that do not implement `se/file`.

## Provider tunnels for private/internal sites

craftdriver doesn't manage a provider's tunnel process (e.g. BrowserStack
Local) — that stays outside the generic library API, the same way craftdriver
doesn't manage the Grid/hub itself. Start the tunnel yourself (or in CI)
before launching, then pass whatever capability the provider documents for
routing through it (e.g. `local: true` in BrowserStack's `bstack:options`).
See the [BrowserStack recipe](./recipes/run-on-browserstack.md#browserstack-local-for-internalprivate-sites)
for a worked example.

## Troubleshooting

**Authentication failures** — double check `remote.auth` isn't also set
alongside URL-embedded credentials (craftdriver rejects that combination at
launch, before any network call); confirm the credential env vars are
actually set in the process running your tests, not just your shell.

**Hub base paths** — Selenium Grid 4 uses its root URL by default, for example
`http://grid.internal:4444`. If your deployment configures a base path (or
uses a legacy `/wd/hub` path), include it in `remote.url`; craftdriver
preserves the path you pass.

**Capability mismatch** — for a `session not created` response, inspect the
provider's error and validate the browser, OS, version, and vendor capability
names against its current capability generator or platform catalog.

**BiDi connectivity** — if you expect BiDi but `browser.isBiDiEnabled()` is
`false`, confirm the provider returned a `webSocketUrl` for the session. Some
providers require their own opt-in capability in addition to craftdriver's
`enableBiDi`; BrowserStack currently documents `seleniumBidi: true`. Also
confirm that your network permits outbound WebSocket connections to the
returned host.

## See also

- [BrowserStack recipe](./recipes/run-on-browserstack.md) — a full,
  provider-specific walkthrough with desktop, mobile, and BrowserStack Local
  examples.
- [Driver Configuration](./driver-configuration.md) — local-only; this page
  is the remote counterpart.
- [WebDriver Standards](./standards.md) — the Classic/BiDi split this page
  builds on.
