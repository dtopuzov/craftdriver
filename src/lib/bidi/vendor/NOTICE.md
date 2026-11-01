# Vendored: chromium-bidi BiDi-CDP mapper

`chromium-bidi-mapper.js` is an esbuild bundle of the BiDi-CDP mapper from
[chromium-bidi](https://www.npmjs.com/package/chromium-bidi) (Apache-2.0,
Google LLC and contributors; source now lives in Chromium under
`third_party/chromium-bidi`) and its one runtime dependency,
[mitt](https://www.npmjs.com/package/mitt) (MIT). Their licences ship next to
it as `LICENSE.chromium-bidi` and `LICENSE.mitt`.

craftdriver runs this mapper inside the Node process to speak WebDriver BiDi
to Chrome over CDP, instead of relying on the copy chromedriver injects into
a hidden tab.

## What is in it

Only `BidiServer` and `MapperCdpConnection` and the code they reach. The
validating command parser (and with it `zod`) is left out; the mapper uses its
built-in no-op parser. `devtools-protocol` is types-only and never bundled.
`chromium-bidi-mapper.manifest.json` records the exact versions, their npm
integrity hashes, the esbuild version and the output hash.

## Rules

- `chromium-bidi-mapper.js`, `chromium-bidi-mapper.api.txt`, the manifest and
  the `LICENSE.*` files are generated. Never edit them by hand: CI rebuilds
  them from the manifest with `npm run mapper:check` and fails on any
  difference.
- `chromium-bidi-mapper.d.ts` and this file are hand-written.
- The directory is excluded from prettier (`.prettierignore`); eslint only
  lints `.ts`, and the hand-written `.d.ts` is typechecked by `tsc`.
- None of these packages are npm dependencies of craftdriver, so `npm audit`
  and Dependabot can't see them. Updates go through `npm run mapper:status` and
  `npm run mapper:update` (see the `mapper-update` skill).

## Rebuild

```sh
npm run mapper:build   # regenerate from the manifest
npm run mapper:check   # prove the committed files match
```
