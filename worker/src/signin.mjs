// A Mullo sign-in token (Supabase Auth), checked without any shared secret:
// Supabase signs with a private key (ES256) and publishes the public half
// (JWKS) at <project>/auth/v1/.well-known/jwks.json. Only tokens from OUR
// project (env.SUPABASE_URL) count: Mullo Pro's AI is for Mullo accounts, and a
// family on its own Supabase brings its own AI key instead.
//
// → { userId, email, clientId } or null. Never throws on a bad token: a forged, expired
// or foreign token is simply nobody.

const JWKS_TTL_MS = 10 * 60_000;
const MISS_REFETCH_MS = 60_000; // an unknown key id refetches at most once a minute
const keys = { base: null, at: 0, missAt: 0, byKid: new Map() };

function bytes(b64url) {
  const s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const json = (part) => JSON.parse(new TextDecoder().decode(bytes(part)));

async function loadKeys(base, doFetch, now) {
  const res = await doFetch(`${base}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const { keys: list = [] } = await res.json();
  const byKid = new Map();
  for (const k of list) {
    if (k.kty !== 'EC' || k.crv !== 'P-256' || !k.kid) continue;
    byKid.set(k.kid, await crypto.subtle.importKey('jwk', { kty: k.kty, crv: k.crv, x: k.x, y: k.y },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  }
  Object.assign(keys, { base, at: now, byKid });
}

async function keyFor(kid, base, doFetch, now) {
  if (keys.base !== base || now - keys.at > JWKS_TTL_MS) await loadKeys(base, doFetch, now);
  if (!keys.byKid.has(kid) && now - keys.missAt > MISS_REFETCH_MS) {
    keys.missAt = now; // Supabase rotated its key, or a made-up kid: look once, not on every call
    await loadKeys(base, doFetch, now);
  }
  return keys.byKid.get(kid) ?? null;
}

export const looksLikeToken = (t) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(t ?? '');

export async function verifySignIn(token, env, doFetch = globalThis.fetch, now = Date.now()) {
  const base = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base || !looksLikeToken(token)) return null;
  const [h, p, s] = token.split('.');
  let header;
  let claims;
  try { header = json(h); claims = json(p); } catch { return null; }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') return null; // never "none", never HS256
  let key;
  try { key = await keyFor(header.kid, base, doFetch, now); } catch { return null; }
  if (!key) return null;
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const sec = now / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `${base}/auth/v1`) return null;
  if (!aud.includes('authenticated') || claims.role !== 'authenticated') return null;
  if (!(Number(claims.exp) > sec)) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub ?? '')) return null;
  // clientId: set when a connected app (Supabase OAuth) holds this token, null for the app's own sign-in.
  return { userId: claims.sub.toLowerCase(), email: claims.email ?? null, clientId: typeof claims.client_id === 'string' && claims.client_id ? claims.client_id : null };
}

// Tests: forget the cached keys.
export function forgetKeys() { Object.assign(keys, { base: null, at: 0, missAt: 0, byKid: new Map() }); }
