// Personal API keys (spec docs/specs/2026-10-08-connections-design.md §2): `mullo_...` for
// scripts, n8n, Zapier, Make, and MCP clients that take a header.
//
// A key is a grant from Supabase's OAuth server, held here: the app approves it with its own
// sign-in, the Worker exchanges the code (PKCE) and keeps that grant's refresh token SEALED
// (ownkey.mjs) in D1. The person sees the key once; D1 keeps only its SHA-256. Every use reads
// Supabase with that grant's own token, so row-level security applies, and sql/003 keeps it
// read-only (its tokens carry a client_id). No secret Supabase key anywhere.
//
// Revoking signs that one grant session out at Supabase and deletes the row.

import { sealText, openText } from './ownkey.mjs';
import { ready } from './usage.mjs';
import { hex } from './stripe.mjs';

export const KEY_PREFIX = 'mullo_';
const PURPOSE = 'api-key-tokens-v1';
const START_TTL_S = 600;
const MAX_KEYS = 10;
export const KEYS_OFF = 'API keys aren\'t switched on on Mullo\'s server yet.';

const fail = (status, message) => Object.assign(new Error(message), { status });
const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
export const keyHash = async (key) => hex(await sha256(key));
const base = (env) => String(env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const claimsOf = (jwt) => {
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { return {}; }
};

// Supabase's OAuth server, as it describes itself. Cached per isolate for an hour.
let discovery = null;
async function oauthMeta(env, doFetch) {
  if (discovery?.base === base(env) && Date.now() - discovery.at < 3_600_000) return discovery.meta;
  const res = await doFetch(`${base(env)}/.well-known/oauth-authorization-server/auth/v1`);
  if (res.status === 404) throw fail(503, KEYS_OFF);
  if (!res.ok) throw fail(502, 'Mullo\'s account server didn\'t answer. Try again.');
  const meta = await res.json();
  discovery = { base: base(env), at: Date.now(), meta };
  return meta;
}
export function forgetDiscovery() { discovery = null; }

const supabaseHeaders = (env, extra = {}) => ({ apikey: env.SUPABASE_PUBLISHABLE_KEY, ...extra });

// Mullo's own OAuth client for API keys, registered once per callback address.
async function clientId(env, doFetch, redirectUri) {
  await ready(env);
  const row = await env.DB.prepare('select client_id from api_clients where redirect_uri = ?').bind(redirectUri).first();
  if (row) return row.client_id;
  const meta = await oauthMeta(env, doFetch);
  if (!meta.registration_endpoint) throw fail(503, KEYS_OFF);
  const res = await doFetch(meta.registration_endpoint, {
    method: 'POST',
    headers: supabaseHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      client_name: 'Mullo API keys', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw fail(502, 'Mullo\'s account server didn\'t register API keys. Try again.');
  await env.DB.prepare('insert into api_clients (redirect_uri, client_id, created_at) values (?, ?, ?) on conflict(redirect_uri) do nothing')
    .bind(redirectUri, body.client_id, nowSec()).run();
  return (await env.DB.prepare('select client_id from api_clients where redirect_uri = ?').bind(redirectUri).first()).client_id;
}

async function tokenCall(env, doFetch, form) {
  const meta = await oauthMeta(env, doFetch);
  return doFetch(meta.token_endpoint, {
    method: 'POST',
    headers: supabaseHeaders(env, { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: new URLSearchParams(form).toString(),
  });
}

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'API key';

// Step 1 (signed in): open an authorization for this person. → { authorizationId, state }.
// The app then approves it with its own sign-in (Supabase's consent API) and brings back
// where Supabase would send it (step 2).
export async function startKey(env, doFetch, user, { name, origin }) {
  await ready(env);
  const live = await env.DB.prepare('select count(*) n from api_keys where user_id = ? and dead = 0').bind(user.userId).first();
  if (live.n >= MAX_KEYS) throw fail(409, `You have ${MAX_KEYS} keys already. Revoke one first.`);
  const redirectUri = `${origin}/api/keys/callback`;
  const client = await clientId(env, doFetch, redirectUri);
  const meta = await oauthMeta(env, doFetch);
  const verifier = random(32);
  const state = random(24);
  await env.DB.prepare('delete from api_key_starts where expires_at < ?').bind(nowSec()).run();
  await env.DB.prepare('insert into api_key_starts (state, user_id, name, verifier, expires_at) values (?, ?, ?, ?, ?)')
    .bind(state, user.userId, cleanName(name), verifier, nowSec() + START_TTL_S).run();
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: client, redirect_uri: redirectUri, state,
    code_challenge: b64url(await sha256(verifier)), code_challenge_method: 'S256', scope: 'email',
  }).toString();
  const res = await doFetch(url.toString(), { redirect: 'manual', headers: supabaseHeaders(env) });
  const location = res.headers.get('Location');
  const id = location ? new URL(location, url).searchParams.get('authorization_id') : null;
  if (!id) throw fail(502, 'Mullo\'s account server didn\'t start the key. Try again.');
  return { authorizationId: id, state };
}

// Step 2 (signed in, the same person): the approved redirect → a new key, shown once.
export async function finishKey(env, doFetch, user, { redirectUrl, origin }) {
  let u;
  try { u = new URL(String(redirectUrl)); } catch { throw fail(400, 'That isn\'t where the approval should come back to.'); }
  if (`${u.origin}${u.pathname}` !== `${origin}/api/keys/callback`) throw fail(400, 'That isn\'t where the approval should come back to.');
  if (u.searchParams.get('error')) throw fail(400, 'The key wasn\'t approved.');
  const state = u.searchParams.get('state') ?? '';
  const code = u.searchParams.get('code') ?? '';
  await ready(env);
  const start = await env.DB.prepare('select * from api_key_starts where state = ?').bind(state).first();
  await env.DB.prepare('delete from api_key_starts where state = ?').bind(state).run(); // one use, whatever happens
  if (!start || start.user_id !== user.userId || start.expires_at < nowSec() || !code) throw fail(400, 'This key request ran out. Start again.');
  const redirectUri = `${origin}/api/keys/callback`;
  const client = await clientId(env, doFetch, redirectUri);
  const res = await tokenCall(env, doFetch, {
    grant_type: 'authorization_code', code, client_id: client, redirect_uri: redirectUri, code_verifier: start.verifier,
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token || !t.refresh_token) throw fail(502, 'Mullo\'s account server didn\'t give the key. Start again.');
  if (claimsOf(t.access_token).sub !== user.userId) throw fail(400, 'That approval was for another account.');
  const key = `${KEY_PREFIX}${random(32)}`;
  const id = crypto.randomUUID();
  await env.DB.prepare(`insert into api_keys (id, user_id, client_id, name, key_hash, refresh_sealed, access_sealed, access_exp, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, user.userId, client, start.name, await keyHash(key), await sealText(env, t.refresh_token, PURPOSE),
      await sealText(env, t.access_token, PURPOSE), nowSec() + Number(t.expires_in ?? 3600), nowSec()).run();
  return { key, id, name: start.name };
}

export async function listKeys(env, user) {
  await ready(env);
  const { results } = await env.DB.prepare('select id, name, created_at, last_used_at, dead from api_keys where user_id = ? order by created_at desc')
    .bind(user.userId).all();
  return results.map((k) => ({ id: k.id, name: k.name, createdAt: k.created_at, lastUsedAt: k.last_used_at, working: !k.dead }));
}

// A presented key → a token for its person ({ token, userId, keyId }), or null (unknown,
// revoked, or its grant was disconnected). Refreshes the token when it's about to run out.
export async function tokenForKey(env, doFetch, presented) {
  if (!presented?.startsWith(KEY_PREFIX)) return null;
  await ready(env);
  const row = await env.DB.prepare('select * from api_keys where key_hash = ?').bind(await keyHash(presented)).first();
  if (!row || row.dead) return null;
  if ((row.last_used_at ?? 0) < nowSec() - 3600) await env.DB.prepare('update api_keys set last_used_at = ? where id = ?').bind(nowSec(), row.id).run();
  const token = await freshToken(env, doFetch, row);
  return token ? { token, userId: row.user_id, keyId: row.id } : null;
}

// The row's access token, refreshed when it's about to run out. null = the grant is gone.
async function freshToken(env, doFetch, row) {
  if (row.dead) return null;
  if (row.access_exp > nowSec() + 60) {
    const token = await openText(env, row.access_sealed, PURPOSE);
    if (token) return token;
  }
  const refresh = await openText(env, row.refresh_sealed, PURPOSE);
  const dead = async () => { await env.DB.prepare('update api_keys set dead = 1 where id = ?').bind(row.id).run(); return null; };
  if (!refresh) return dead();
  const res = await tokenCall(env, doFetch, { grant_type: 'refresh_token', refresh_token: refresh, client_id: row.client_id });
  if ([400, 401, 403].includes(res.status)) return dead(); // disconnected in Settings, or signed out everywhere
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) throw fail(502, 'Mullo\'s account server didn\'t answer. Try again.');
  // Refresh tokens rotate: keep the new one (a second refresh racing this one gets the same
  // child from Supabase within its reuse window).
  await env.DB.prepare('update api_keys set refresh_sealed = ?, access_sealed = ?, access_exp = ? where id = ?')
    .bind(await sealText(env, t.refresh_token ?? refresh, PURPOSE), await sealText(env, t.access_token, PURPOSE),
      nowSec() + Number(t.expires_in ?? 3600), row.id).run();
  return t.access_token;
}

export async function revokeKey(env, doFetch, user, id) {
  await ready(env);
  const row = await env.DB.prepare('select * from api_keys where id = ? and user_id = ?').bind(String(id ?? ''), user.userId).first();
  if (!row) throw fail(404, 'No such key.');
  // Sign that grant's session out at Supabase: its refresh token stops at once.
  try {
    const live = await freshToken(env, doFetch, row);
    if (live) await doFetch(`${base(env)}/auth/v1/logout?scope=local`, { method: 'POST', headers: supabaseHeaders(env, { Authorization: `Bearer ${live}` }) });
  } catch { /* the row goes anyway: the key is dead to Mullo either way */ }
  await env.DB.prepare('delete from api_keys where id = ?').bind(row.id).run();
  return { revoked: true };
}
