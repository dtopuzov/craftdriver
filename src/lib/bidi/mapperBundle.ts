/**
 * Location of the vendored chromium-bidi BiDi-CDP mapper bundle
 * (`vendor/chromium-bidi-mapper.js`, ~420 KB). It is loaded only by the mapper
 * worker (inProcessMapper.ts), so sessions that never run the mapper
 * in-process never parse it. Its API is described by
 * `vendor/chromium-bidi-mapper.d.ts`.
 */
export function mapperBundleUrl(): string {
  return new URL('./vendor/chromium-bidi-mapper.js', import.meta.url).href;
}
