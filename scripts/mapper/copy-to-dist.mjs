#!/usr/bin/env node
/**
 * Copy the vendored mapper bundle into dist/. tsc compiles only .ts (no
 * allowJs), so the generated JavaScript, its hand-written types and the
 * licences have to be copied next to the compiled loader.
 */

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, vendorDir } from './lib.mjs';

const SHIPPED = /^(chromium-bidi-mapper\.(js|d\.ts)|LICENSE\..+|NOTICE\.md)$/;

const out = path.join(repoRoot, 'dist', 'lib', 'bidi', 'vendor');
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(vendorDir)) {
  if (SHIPPED.test(name)) fs.copyFileSync(path.join(vendorDir, name), path.join(out, name));
}
