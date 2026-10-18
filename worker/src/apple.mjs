// Sign in with Apple: revoking Mullo's access when an account is deleted (App Store rule
// 5.1.1(v), Apple TN3194). Supabase doesn't keep Apple's tokens, so the iPhone app asks Apple for
// a fresh one-time code at "Delete account" (ios/Mullo/SignIn.swift appleCode) and sends it with
// the delete; here it's traded for Apple's refresh token, which is revoked at once. Nothing is kept.
//
// Apple wants a client secret: an ES256 JWT signed with Mullo's Sign in with Apple key, made per
// call (5 minutes). Vars: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID (the app's bundle id: the
// code came from the app). Secret: APPLE_SIGNIN_KEY, the key's .p8 text (`wrangler secret put`).
//
// → 'revoked' | 'failed' | 'not_set'. Never throws: a delete the person asked for goes ahead even
// when Apple can't be reached (they can still remove Mullo in their Apple ID settings).

const APPLE = 'https://appleid.apple.com';
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64json = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function signingKey(pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function appleClientSecret(env, now = Math.floor(Date.now() / 1000)) {
  const head = b64json({ alg: 'ES256', kid: env.APPLE_KEY_ID });
  const body = b64json({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: APPLE, sub: env.APPLE_CLIENT_ID });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(env.APPLE_SIGNIN_KEY), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const form = (fields) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

export async function revokeApple(env, fetch, code) {
  if (!env.APPLE_SIGNIN_KEY || !env.APPLE_KEY_ID || !env.APPLE_TEAM_ID || !env.APPLE_CLIENT_ID) return 'not_set';
  try {
    const client = { client_id: env.APPLE_CLIENT_ID, client_secret: await appleClientSecret(env) };
    const res = await fetch(`${APPLE}/auth/token`, form({ ...client, code: String(code), grant_type: 'authorization_code' }));
    const tokens = res.ok ? await res.json() : null;
    const [token, hint] = tokens?.refresh_token ? [tokens.refresh_token, 'refresh_token'] : [tokens?.access_token, 'access_token'];
    if (!token) return 'failed';
    const gone = await fetch(`${APPLE}/auth/revoke`, form({ ...client, token, token_type_hint: hint }));
    return gone.ok ? 'revoked' : 'failed';
  } catch {
    return 'failed';
  }
}
