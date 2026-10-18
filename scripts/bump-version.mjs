// Raises APP_VERSION in app/core/version.js and app/version.txt together.
// `npm run deploy` runs this first: a check can prove the two numbers agree,
// never that you remembered to raise them (spec §10).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP } from './lib.mjs';

const jsPath = join(APP, 'core', 'version.js');
const txtPath = join(APP, 'version.txt');
const src = readFileSync(jsPath, 'utf8');
const m = /export const APP_VERSION = (\d+);/.exec(src);
if (!m) {
  console.error('APP_VERSION not found in app/core/version.js');
  process.exit(1);
}
const next = Number(m[1]) + 1;
writeFileSync(jsPath, src.replace(m[0], `export const APP_VERSION = ${next};`), 'utf8');
writeFileSync(txtPath, `${next}\n`, 'utf8');
console.log(`version ${m[1]} → ${next}`);
