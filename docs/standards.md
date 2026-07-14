# WebDriver Standards

CraftDriver is built on W3C WebDriver protocols:

- **WebDriver Classic** for broadly supported browser automation commands
- **WebDriver BiDi** for modern bidirectional browser capabilities

That protocol choice is the center of the project. CraftDriver tries to provide a modern developer experience without making browser-private protocols the foundation of user code.

## Classic And BiDi Together

| Protocol          | Used for                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebDriver Classic | Stable navigation, element actions, browser sessions, window operations, and widely supported commands.                                               |
| WebDriver BiDi    | Network interception, console and page errors, screenshots, storage, contexts, init scripts, downloads, tracing, and other event-driven capabilities. |

CraftDriver picks the practical protocol path behind a single public API. You call `browser.click()`, `browser.navigateTo()`, `browser.network.mock()`, or `browser.startTrace()`; the library handles the transport details.

### Safari is Classic-only

`browserName: 'safari'` always uses WebDriver Classic and never negotiates
`webSocketUrl`. This isn't a temporary gap CraftDriver plans to close — Apple
does not currently document a supported WebDriver BiDi endpoint for Safari or
Safari Technology Preview, so there's no BiDi transport to opt into. CraftDriver
rejects `enableBiDi: true` for Safari with a clear `UNSUPPORTED` error before
launch rather than silently downgrading, and every BiDi-only method (network,
logs, tracing, contexts, permissions/geolocation/emulation, full-page
screenshots, event-driven dialogs) fails the same way when called on a Safari
session. See the [Safari guide](./safari.md) for what remains available on
Classic.

## Why It Matters

Standards-based automation gives projects a few useful properties:

- browser behavior can converge across engines instead of depending on a single vendor protocol
- Firefox support is a first-class target, not an afterthought
- protocol errors can be mapped into stable CraftDriver error codes
- browser control can be exposed safely to CLIs and MCP tools

## Honest Limits

WebDriver BiDi is still evolving. Some capabilities are browser-specific today, especially around emulation and mobile behavior. CraftDriver documents those limits instead of silently pretending every browser supports every feature.

Use these pages when you need exact capability details:

- [Network Mocking And Request Waiting](./network.md)
- [Console Logs And JavaScript Errors](./browser-logs.md)
- [Session Management](./session-management.md)
- [Browser Contexts](./browser-context.md)
- [Emulation](./emulation.md)
- [Mobile Emulation](./mobile-emulation.md)
- [Error Codes](./error-codes.md)
