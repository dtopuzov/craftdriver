/** Create a real Craftdriver trace zip for manual Vibium Player verification. */
import { resolve } from 'node:path';
import { Browser } from '../dist/index.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(`traces/vibium-sample-${stamp}-raw`);
const zipPath = resolve(`traces/vibium-sample-${stamp}.zip`);
const browser = await Browser.launch({ browserName: 'chrome' });
let tracing = false;

try {
  await browser.startTrace({
    outDir,
    title: 'Craftdriver documentation sample',
  });
  tracing = true;
  await browser.navigateTo('https://dtopuzov.github.io/craftdriver/');
  await browser.navigateTo('https://dtopuzov.github.io/craftdriver/getting-started');
  await browser.navigateTo('https://dtopuzov.github.io/craftdriver/api-reference');
} finally {
  if (tracing) {
    await browser.stopTrace({ path: zipPath });
  }
  await browser.quit();
}

console.log(zipPath);
