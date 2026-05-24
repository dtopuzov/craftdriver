#!/usr/bin/env node
/**
 * craftdriver — CLI entry shim.
 *
 * Resolves the compiled CLI in `dist/cli/index.js` and invokes its
 * `main()`. If the dist tree is missing, fail with a clear message
 * pointing at `npm run build` rather than a stack trace.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, '..', 'dist', 'cli', 'index.js');

if (!existsSync(distEntry)) {
  process.stderr.write(
    'craftdriver: compiled CLI not found at ' + distEntry + '\n' +
    'hint:  run `npm run build` first (the bin shim loads `dist/cli/index.js`).\n'
  );
  process.exit(2);
}

const mod = await import(pathToFileURL(distEntry).href);
const rc = await mod.main(process.argv.slice(2));
process.exit(typeof rc === 'number' ? rc : 0);
