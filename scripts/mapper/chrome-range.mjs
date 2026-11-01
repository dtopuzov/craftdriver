#!/usr/bin/env node
/**
 * Show or change the Chrome range the vendored mapper is verified against
 * (`chromeSupport` in the manifest). Hybrid launch uses it: Chrome outside the
 * range falls back to chromedriver unless hybrid was requested explicitly.
 *
 * Usage:
 *   node scripts/mapper/chrome-range.mjs
 *   node scripts/mapper/chrome-range.mjs [--min <major>] [--max <major>] --source "<what passed>"
 *
 * Only record majors the hybrid gates passed on (the chrome-compat workflow
 * or a local run with CRAFTDRIVER_CHROME_PATH). Raising --min drops support
 * for older Chrome: that is an owner decision.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { formatManifest, manifestPath, readManifest } from './lib.mjs';

const { values } = parseArgs({
  options: { min: { type: 'string' }, max: { type: 'string' }, source: { type: 'string' } },
});

const manifest = readManifest();
const current = manifest.chromeSupport;

if (values.min === undefined && values.max === undefined) {
  console.log(`Chrome ${current.minMajor}–${current.maxMajor}: ${current.source}`);
  process.exit(0);
}

function major(flag) {
  const value = values[flag];
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    console.error(`--${flag} must be a Chrome major version (got "${value}")`);
    process.exit(1);
  }
  return Number(value);
}

const minMajor = major('min') ?? current.minMajor;
const maxMajor = major('max') ?? current.maxMajor;
if (minMajor > maxMajor) {
  console.error(`--min ${minMajor} is above --max ${maxMajor}`);
  process.exit(1);
}
if (!values.source) {
  console.error('--source is required: say which Chrome builds the hybrid gates passed on');
  process.exit(1);
}

manifest.chromeSupport = { minMajor, maxMajor, source: values.source };
fs.writeFileSync(manifestPath, formatManifest(manifest));
console.log(
  `Chrome ${current.minMajor}–${current.maxMajor} → ${minMajor}–${maxMajor}. ` +
    'Run `npm run mapper:check` and commit the manifest.'
);
