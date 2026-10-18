// Stripe over plain fetch (no SDK: Mullo has no dependencies).

const API = 'https://api.stripe.com/v1';

// Stripe takes form encoding with bracket keys: line_items[0][price]=...
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, doFetch, method, path, body) {
  const res = await doFetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? formEncode(body).toString() : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `Stripe ${res.status}`), { status: 502 });
  return json;
}

// Newer Stripe API versions moved the period end onto the subscription item.
export function periodEnd(sub) {
  return sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">[,v1=...]
// Returns the parsed event, or throws 400. Tolerance: 5 minutes (replays).
export async function verifyWebhook(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!header || !secret) throw bad('missing signature');
  const parts = header.split(',').map((p) => p.split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw bad('bad signature header');
  if (Math.abs(nowSec - t) > 300) throw bad('signature too old');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  if (!sigs.some((s) => safeEqual(s, expected))) throw bad('signature mismatch');
  return JSON.parse(rawBody);
}

export { hex };
