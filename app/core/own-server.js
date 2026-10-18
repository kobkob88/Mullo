// Your own server in a browser (Settings → Developers → Your own server; spec
// docs/specs/2026-10-08-connections-design.md §3).
//
// Android keeps the choice natively (Cloud in WebFiles.kt) and asks in a native dialog,
// because its activity can be started from outside. In a browser only this page can change
// it: the person confirms on the page, the choice is kept in this site's storage, and boot
// applies it over config.json (withBrowserServer). Changing it signs out (a session belongs
// to one server); cloud-sync's noteServer then starts that server's copying afresh.
//
// The web build's CSP allows Supabase-hosted projects only (https://*.supabase.co, see
// scripts/lib.mjs connectSrc), so a self-hosted server stays an Android-app feature.

import { disk } from './disk.js';
import { inAndroidApp } from './native.js';

const KEY = 'echo:own-server'; // { url, key }
const SUPABASE_HOST = /^[a-z0-9-]{3,63}\.supabase\.co$/;

// The JWT's role, for the older anon/service keys (three dot-separated parts). → role or null.
function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (parts[1].length % 4)) % 4));
    return JSON.parse(json)?.role ?? null;
  } catch { return null; }
}

// The same checks as Android's Cloud.check: https, never a secret or service key, only a
// publishable (or anon) key; in a browser also a supabase.co project.
// → { url, key } cleaned, or { problem }.
export function checkServer(rawUrl, rawKey, { browser = !inAndroidApp() } = {}) {
  let u;
  try { u = new URL(String(rawUrl ?? '').trim()); } catch { return { problem: 'The project address starts with https://' }; }
  if (u.protocol !== 'https:' || !u.hostname) return { problem: 'The project address starts with https://' };
  const key = String(rawKey ?? '').trim();
  if (key.startsWith('sb_secret_')) return { problem: 'That\'s a secret key. Use the publishable key: a secret key must never be in a browser.' };
  const role = jwtRole(key);
  if (role === 'service_role') return { problem: 'That\'s the service key. Use the anon or publishable key: the service key must never be in a browser.' };
  if (!/^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(key) && role !== 'anon') return { problem: 'That doesn\'t look like a publishable key (sb_publishable_...).' };
  if (browser && !SUPABASE_HOST.test(u.hostname)) {
    return { problem: 'In a browser, Mullo can use a project hosted on supabase.co (https://<project>.supabase.co). A self-hosted server works in the Android app.' };
  }
  return { url: u.origin, key };
}

// The server this browser was told to use, still passing the checks. → { url, key } or null.
export function browserServer() {
  if (inAndroidApp()) return null;
  const saved = disk.get(KEY, null);
  if (!saved) return null;
  const clean = checkServer(saved.url, saved.key, { browser: true });
  return clean.problem ? null : clean;
}

export function keepBrowserServer({ url, key }) {
  disk.set(KEY, { url, key });
}

export function dropBrowserServer() {
  disk.remove(KEY);
}

// config.json, with the person's own server over it when this browser has one. Mullo's own
// account server stays known: the AI still needs a Mullo sign-in (S25).
export function withBrowserServer(config) {
  const own = browserServer();
  return own ? {
    ...config, supabaseUrl: own.url, supabaseAnonKey: own.key, ownServer: true,
    mulloSupabaseUrl: config.supabaseUrl, mulloSupabaseAnonKey: config.supabaseAnonKey,
  } : config;
}
