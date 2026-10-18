// Bring your own AI key (spec docs/specs/2026-10-08-connections-design.md §4).
//
// The person's Gemini, OpenAI or Claude key is SEALED here (AES-GCM, with the Worker secret
// OWN_KEY_SECRET) and the sealed text goes back to the phone, which keeps it (Android: the
// Keystore again). The Worker stores nothing: each AI call carries the sealed key
// (X-Mullo-Own-Key), it's opened for that call only, and never logged. A database leak shows
// no keys; a copy taken from the phone works only through this Worker, rate-limited like everyone,
// and only for the Mullo account that added it: the sealed text carries that account's id (`u`),
// so a stolen copy is refused under anyone else's sign-in (checkOwner in index.mjs). Keys sealed
// before 2026-10-17 carry no id: the first account to use one claims it (own_key_claims).
//
// With your own key no minutes are counted and no plan is needed: the AI company bills you.
// What each provider can do is in bridge/providers.mjs (`CAN`; Claude takes no audio).

const PREFIX = 'mk1';
const AAD = new TextEncoder().encode('mullo-own-ai-key-v1');
export const PROVIDERS = ['gemini', 'openai', 'anthropic'];
export const OWN_KEY_HEADER = 'X-Mullo-Own-Key';
const SEALED_SHAPE = /^mk1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,2000}$/;
// Google AI Studio keys: the older `AIza...` and the newer `AQ.` ones (with a dot). The
// provider's own check (keyWorks) decides; these only stop what can't be a key.
const GEMINI_SHAPE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{29,199}$/;
const OPENAI_SHAPE = /^sk-[A-Za-z0-9_-]{20,300}$/;
const ANTHROPIC_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const SHAPE = { gemini: GEMINI_SHAPE, openai: OPENAI_SHAPE, anthropic: ANTHROPIC_SHAPE };
const NAME = { gemini: 'Google', openai: 'OpenAI', anthropic: 'Anthropic' };
const WHERE = { gemini: 'Google AI Studio', openai: 'the OpenAI dashboard', anthropic: 'the Claude Console' };

// Which company's key this is, from its shape: Claude keys start sk-ant-, OpenAI keys sk-.
export function providerOf(key) {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  return 'gemini';
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

const keys = new Map(); // secret → CryptoKey, per isolate
async function aes(env) {
  const secret = env.OWN_KEY_SECRET;
  if (!secret) throw fail(503, 'Your own AI key isn\'t switched on on this server yet.');
  if (!keys.has(secret)) {
    let raw;
    try { raw = unb64url(secret.trim()); } catch { raw = new Uint8Array(0); }
    if (raw.length !== 32) throw fail(503, 'This server\'s key-sealing secret is not set up right.');
    keys.set(secret, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keys.get(secret);
}

// Sealing, shared with apikeys.mjs (API keys' Supabase tokens). `purpose` is bound into the
// seal, so text sealed for one use can't be passed off as another.
export async function sealText(env, text, purpose = AAD) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = typeof purpose === 'string' ? new TextEncoder().encode(`mullo-${purpose}`) : purpose;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aes(env), new TextEncoder().encode(text)));
  return `${PREFIX}.${b64url(iv)}.${b64url(ct)}`;
}

// → the text, or null (not ours, changed, another purpose, or sealed with a secret since replaced).
export async function openText(env, sealed, purpose = AAD) {
  if (!/^mk1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{20,20000}$/.test(sealed ?? '')) return null;
  const [, iv, ct] = sealed.split('.');
  const aad = typeof purpose === 'string' ? new TextEncoder().encode(`mullo-${purpose}`) : purpose;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv), additionalData: aad }, await aes(env), unb64url(ct)));
  } catch (err) {
    if (err.status === 503) throw err;
    return null;
  }
}

export const sealKey = (env, provider, key, userId = null) => sealText(env, JSON.stringify({ p: provider, k: key, ...(userId ? { u: userId } : {}) }));

// → { provider, key, user } or null. user = the Mullo account that added it (null: sealed before
// keys carried one).
export async function openKey(env, sealed) {
  if (!SEALED_SHAPE.test(sealed ?? '')) return null;
  const text = await openText(env, sealed);
  try {
    const { p, k, u } = JSON.parse(text ?? 'null') ?? {};
    return PROVIDERS.includes(p) && typeof k === 'string' ? { provider: p, key: k, user: typeof u === 'string' ? u : null } : null;
  } catch { return null; }
}

// Does the provider take this key? One cheap call (list models); the key goes in a header, never a URL.
const CHECK = {
  gemini: (key) => ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } }],
  openai: (key) => ['https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }],
  anthropic: (key) => ['https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }],
};
export async function keyWorks(provider, key, doFetch) {
  let res;
  try {
    res = await doFetch(...CHECK[provider](key));
  } catch { throw fail(502, `Couldn't reach ${NAME[provider]} to check the key. Try again.`); }
  if (res.ok) return true;
  if ([400, 401, 403].includes(res.status)) return false;
  throw fail(502, `${NAME[provider]} answered ${res.status} while checking the key. Try again.`);
}

// POST /api/own-key { key } → { sealed, provider, hint }. The provider is read from the key
// itself (an older app also sends provider: 'gemini'; the key's shape wins).
export async function sealRoute(body, env, doFetch, userId = null) {
  const key = String(body?.key ?? '').trim();
  const provider = providerOf(key);
  if (!SHAPE[provider].test(key)) {
    throw fail(400, 'That doesn\'t look like an AI key. Gemini keys start with AIza or AQ., OpenAI keys with sk-, Claude keys with sk-ant-.');
  }
  await aes(env); // switched on? Say so before sending the key anywhere
  if (!(await keyWorks(provider, key, doFetch))) throw fail(400, `${NAME[provider]} didn't accept that key. Check it in ${WHERE[provider]}.`);
  return { sealed: await sealKey(env, provider, key, userId), provider, hint: key.slice(-4) };
}

export const OWN_KEY_ELSEWHERE = 'This AI key was added on another Mullo account. Add it again in Settings, Developers.';
export const OWN_KEY_GONE = 'Your own AI key can\'t be used any more. Add it again in Settings, Developers.';
