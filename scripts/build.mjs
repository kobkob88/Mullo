// Builds dist/ for a static host (Cloudflare Pages / Netlify).
// Copies ONLY the files in deploy-manifest.json, and fails when:
//   - a listed file is missing,
//   - a file in app/ is not listed (it would 404 in production while working
//     on your machine),
//   - a module imports a file that is not listed.
// Writes config.json and the CSP connect-src from the environment, so no
// live URL or key sits in the repo:
//   ECHO_BRIDGE_URL, ECHO_SUPABASE_URL, ECHO_SUPABASE_ANON_KEY

import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, APP, readManifest, appFiles, importsOf, connectSrc } from './lib.mjs';

const listed = readManifest();
const listedSet = new Set(listed);
const problems = [];

for (const f of listed) if (!existsSync(join(APP, f))) problems.push(`listed but missing: ${f}`);
for (const f of appFiles()) if (!listedSet.has(f)) problems.push(`in app/ but not in deploy-manifest.json: ${f}`);
for (const f of listed.filter((x) => x.endsWith('.js'))) {
  for (const dep of importsOf(f)) if (!listedSet.has(dep)) problems.push(`${f} imports ${dep}, which is not shipped`);
}
if (problems.length) {
  console.error(`Build refused:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

const DIST = join(ROOT, 'dist');
rmSync(DIST, { recursive: true, force: true });
for (const f of listed) {
  mkdirSync(dirname(join(DIST, f)), { recursive: true });
  copyFileSync(join(APP, f), join(DIST, f));
}

// The CSP line itself (the file's comment names the placeholder first).
const headers = readFileSync(join(DIST, '_headers'), 'utf8')
  .replace(/(connect-src 'self') __CONNECT_SRC__/, (_, head) => [head, connectSrc()].filter(Boolean).join(' '));
if (headers.includes("connect-src 'self' __CONNECT_SRC__")) throw new Error('CSP connect-src was not filled in');
writeFileSync(join(DIST, '_headers'), headers);

// The service worker's offline copy: this build's files, under this build's version (sw.js).
// A new version = a new sw.js, so every deploy refills the cache whole.
const version = readFileSync(join(APP, 'version.txt'), 'utf8').trim();
const offline = [...listed.filter((f) => !['sw.js', '_headers', 'version.txt'].includes(f)), 'config.json'];
const swPath = join(DIST, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const BUILD_LINE = /^const BUILD = \{ version: 'dev', files: \[\] \};.*$/m;
if (!BUILD_LINE.test(sw)) throw new Error('sw.js: the BUILD line was not found');
writeFileSync(swPath, sw.replace(BUILD_LINE, `const BUILD = ${JSON.stringify({ version, files: offline })};`));

// Always written, so the app never logs a 404 for it.
const env = process.env;
writeFileSync(join(DIST, 'config.json'), JSON.stringify({
  // The device store is always the first stop; with a Supabase address the
  // account signs in and sync copies it up (core/account.js).
  backend: 'local',
  supabaseUrl: env.ECHO_SUPABASE_URL ?? null,
  supabaseAnonKey: env.ECHO_SUPABASE_ANON_KEY ?? null,
  bridgeUrl: env.ECHO_BRIDGE_URL ?? null,
}, null, 2));

console.log(`dist/ built: ${listed.length} files, version ${readFileSync(join(APP, 'version.txt'), 'utf8').trim()}`);
