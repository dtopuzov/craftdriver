/**
 * Loader for the vendored chromium-bidi BiDi-CDP mapper.
 *
 * The bundle is ~420 KB of JavaScript, so it is imported lazily: sessions that
 * never run the mapper in-process never parse it. One import per Node process.
 */

import type { BidiServer, MapperCdpConnection } from './vendor/chromium-bidi-mapper.js';

export type { BidiServer, MapperCdpConnection } from './vendor/chromium-bidi-mapper.js';
export type {
  BidiTransport,
  MapperBidiCommand,
  MapperCdpClient,
  MapperTransport,
} from './vendor/chromium-bidi-mapper.js';

export interface MapperModule {
  BidiServer: typeof BidiServer;
  MapperCdpConnection: typeof MapperCdpConnection;
}

let loading: Promise<MapperModule> | undefined;

export function loadMapper(): Promise<MapperModule> {
  loading ??= import('./vendor/chromium-bidi-mapper.js').catch((err) => {
    loading = undefined;
    throw err;
  });
  return loading;
}
