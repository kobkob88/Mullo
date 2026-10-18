// Shared by the build, the dev server and the architecture tests.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APP = join(ROOT, 'app');

// Files that live in app/ but are never shipped from the repo.
export const NOT_SHIPPED = new Set(['config.json']);

export function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, 'deploy-manifest.json'), 'utf8')).files;
}

export function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

export function appFiles() {
  return walk(APP).filter((f) => !NOT_SHIPPED.has(f));
}

export function read(rel) {
  return readFileSync(join(APP, rel), 'utf8');
}

// Relative static imports of an app module, resolved to app-relative paths.
export function importsOf(rel) {
  const src = read(rel);
  const found = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) found.push(posix.normalize(posix.join(posix.dirname(rel), m[1])));
  return found;
}

// ECHO_OWN_SERVERS: the web build only (build-web.mjs), so a person can point the browser at
// their own Supabase-hosted project (core/own-server.js). Only *.supabase.co, never a wider source.
const OWN_SERVERS = ['https://*.supabase.co', 'wss://*.supabase.co'];
export function connectSrc(env = process.env) {
  return [
    ...[env.ECHO_BRIDGE_URL, env.ECHO_SUPABASE_URL, env.ECHO_SUPABASE_URL?.replace(/^https:/, 'wss:')]
      .filter(Boolean)
      .map((u) => new URL(u).origin),
    ...(env.ECHO_OWN_SERVERS === 'supabase' ? OWN_SERVERS : []),
  ].join(' ');
}
