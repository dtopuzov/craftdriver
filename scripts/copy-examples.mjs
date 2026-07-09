// Copies the runnable example pages into the VitePress public directory so they
// deploy alongside the docs site at https://dtopuzov.github.io/craftdriver/examples/.
//
// `examples/` stays the single source of truth — the local test server
// (`npm run serve`) serves it directly, and this copy is regenerated at
// docs-build time (it is gitignored). Recipe snippets link to the deployed
// copies so readers can open the exact page a recipe drives.

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'examples';
const DEST = join('docs', 'public', 'examples');

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

const htmlFiles = readdirSync(SRC).filter((name) => name.endsWith('.html'));
for (const name of htmlFiles) {
  cpSync(join(SRC, name), join(DEST, name));
}

console.log(`Copied ${htmlFiles.length} example pages to ${DEST}`);
