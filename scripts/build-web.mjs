// Builds the web app for computers (roadmap S3b) into the Worker's static files:
// worker/public/app/ → https://mullo.lizai.io/app/. Same site as Mullo's server, so
// /api needs no CORS and the CSP's 'self' covers it; sign-in goes to Supabase.
//
// The Supabase address and publishable key are the Worker's own public [vars]
// (worker/wrangler.toml), so this needs no environment. Then:
//   cd worker && npx wrangler deploy      (uploads the files with the Worker)
// `npm run deploy:web` does both. worker/public/ is built, never committed.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

const PREFIX = '/app';
const toml = readFileSync(join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
const varOf = (name) => {
  const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(toml);
  if (!m?.[1]) throw new Error(`${name} missing from worker/wrangler.toml`);
  return m[1];
};
const supabaseUrl = varOf('SUPABASE_URL');
const supabaseAnonKey = varOf('SUPABASE_PUBLISHABLE_KEY');

// The normal build (manifest checks, CSP connect-src from these values). ECHO_OWN_SERVERS lets
// the browser reach a person's own Supabase-hosted project (core/own-server.js).
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, ECHO_SUPABASE_URL: supabaseUrl, ECHO_SUPABASE_ANON_KEY: supabaseAnonKey, ECHO_BRIDGE_URL: '', ECHO_OWN_SERVERS: 'supabase' },
});

// Emptied, not removed: a running `wrangler dev` holds the folder open on Windows.
const out = join(ROOT, 'worker', 'public');
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
cpSync(join(ROOT, 'dist'), join(out, PREFIX.slice(1)), { recursive: true });

// Static-asset headers are read from the root of the assets folder, with full paths.
const headers = readFileSync(join(out, 'app', '_headers'), 'utf8')
  .replace(/^\/(\*|index\.html|version\.txt|config\.json|)$/gm, `${PREFIX}/$1`);
writeFileSync(join(out, '_headers'), headers);
rmSync(join(out, 'app', '_headers'));

// bridgeUrl '' = this same site is Mullo's server; aiPlan 'account' = AI follows the
// signed-in account's plan (no Pro key in a browser).
writeFileSync(join(out, 'app', 'config.json'), JSON.stringify({
  backend: 'local', supabaseUrl, supabaseAnonKey, bridgeUrl: '', aiPlan: 'account',
}, null, 2));

console.log(`worker/public${PREFIX}/ built for ${new URL(supabaseUrl).host}`);
