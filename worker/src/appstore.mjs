// Mullo Pro bought in the iPhone app (S22c): Apple's in-app purchase lands in the SAME accounts
// rows as Stripe, so plans, minutes, /api/me and the plan ring work unchanged.
//   accounts.subscription_id = 'apple:' + originalTransactionId, customer_id = 'apple'.
//
// Nothing the phone says is trusted: it sends only a transaction id, and the Worker asks Apple's
// App Store Server API about it (over TLS, with Mullo's In-App Purchase key) and checks the
// answer: this app, this product, and bought FOR this Mullo account (appAccountToken = the
// Supabase user id the app passed to StoreKit). App Store Server Notifications V2 (renewals,
// expiry, refunds) are only a nudge, like the Stripe webhook: the subscription's current state is
// read back from Apple, so a forged notification changes nothing.
//
// Vars: APPLE_CLIENT_ID (bundle id), APPLE_PRODUCT_ID, APPSTORE_KEY_ID, APPSTORE_ISSUER_ID.
// Secret: APPSTORE_KEY (the In-App Purchase key's .p8 text).

import { ready } from './usage.mjs';

const PROD = 'https://api.storekit.itunes.apple.com';
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64json = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

// The payload of a JWS Apple signed. Read only from Apple's own API answers (or to find which
// subscription a notification is about, then read back from Apple).
export function jwsPayload(jws) {
  const part = String(jws ?? '').split('.')[1];
  if (!part) throw fail(400, 'Not a signed Apple payload.');
  return JSON.parse(new TextDecoder().decode(unb64(part)));
}

export const appStoreOn = (env) => Boolean(env.APPSTORE_KEY && env.APPSTORE_KEY_ID && env.APPSTORE_ISSUER_ID && env.APPLE_CLIENT_ID && env.APPLE_PRODUCT_ID);

async function apiToken(env, now = Math.floor(Date.now() / 1000)) {
  const pem = env.APPSTORE_KEY;
  const der = unb64(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64json({ alg: 'ES256', kid: env.APPSTORE_KEY_ID, typ: 'JWT' });
  const body = b64json({ iss: env.APPSTORE_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1', bid: env.APPLE_CLIENT_ID });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// Production first; a 404 there means a sandbox (TestFlight / review) purchase (Apple's advice).
async function apple(env, fetch, path) {
  const auth = { Authorization: `Bearer ${await apiToken(env)}` };
  for (const base of [PROD, SANDBOX]) {
    const res = await fetch(`${base}${path}`, { headers: auth });
    // Before the app is on sale, production answers 401 to every request (checked 2026-10-16):
    // TestFlight and App Review purchases are the sandbox's, so look there.
    if (res.status === 404 || (res.status === 401 && base === PROD)) continue;
    if (!res.ok) throw fail(502, `The App Store answered ${res.status}. Try again in a minute.`);
    return res.json();
  }
  throw fail(404, 'The App Store doesn\'t know this purchase.');
}

// Apple's subscription status → the Stripe-style status the accounts table keeps.
// 1 active, 4 billing grace period (still has access), 3 billing retry, 2 expired, 5 revoked.
const STATUS = { 1: 'active', 4: 'active', 3: 'past_due', 2: 'canceled', 5: 'canceled' };

// The subscription's state now, from Apple. → { id, status, periodEnd, info } (info = its newest transaction).
export async function subscriptionState(env, fetch, originalTransactionId) {
  const answer = await apple(env, fetch, `/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`);
  for (const group of answer.data ?? []) {
    for (const last of group.lastTransactions ?? []) {
      if (String(last.originalTransactionId) !== String(originalTransactionId)) continue;
      const info = jwsPayload(last.signedTransactionInfo);
      if (info.bundleId !== env.APPLE_CLIENT_ID || info.productId !== env.APPLE_PRODUCT_ID) throw fail(403, 'That purchase isn\'t Mullo Pro.');
      return {
        id: `apple:${originalTransactionId}`,
        status: STATUS[last.status] ?? 'canceled',
        periodEnd: info.expiresDate ? Math.floor(info.expiresDate / 1000) : null,
        info,
      };
    }
  }
  throw fail(404, 'The App Store doesn\'t know this subscription.');
}

async function store(env, state) {
  await env.DB.prepare(`insert into accounts (subscription_id, customer_id, email, status, period_end, updated_at)
      values (?, 'apple', null, ?, ?, ?)
    on conflict(subscription_id) do update set status = excluded.status, period_end = excluded.period_end, updated_at = excluded.updated_at`)
    .bind(state.id, state.status, state.periodEnd, Math.floor(Date.now() / 1000)).run();
}

// "I bought Mullo Pro in the iPhone app": the transaction id from StoreKit, for the signed-in
// account. Checked with Apple, stored, linked. → { status, periodEnd }.
// link(userId, subId) = index.mjs linkBuyer (one account per subscription).
export async function claimApple(env, fetch, userId, transactionId, link) {
  if (!appStoreOn(env)) throw fail(503, 'Buying in the iPhone app isn\'t switched on yet.');
  if (!/^\d{1,20}$/.test(String(transactionId ?? ''))) throw fail(400, 'That isn\'t an App Store purchase.');
  const tx = jwsPayload((await apple(env, fetch, `/inApps/v1/transactions/${transactionId}`)).signedTransactionInfo);
  if (tx.bundleId !== env.APPLE_CLIENT_ID || tx.productId !== env.APPLE_PRODUCT_ID) throw fail(403, 'That purchase isn\'t Mullo Pro.');
  const subId = `apple:${tx.originalTransactionId}`;
  // Bought for another account: refused, unless that account was deleted (the person keeps paying
  // Apple until they cancel, so a new account of theirs may use it).
  const released = async () => {
    await ready(env);
    return Boolean(await env.DB.prepare('select 1 from released_subscriptions where subscription_id = ?').bind(subId).first());
  };
  if (String(tx.appAccountToken ?? '').toLowerCase() !== String(userId).toLowerCase() && !(await released())) {
    throw fail(403, 'This purchase belongs to another Mullo account. Sign in with that account, or buy on this one.', 'apple_other_account');
  }
  const state = await subscriptionState(env, fetch, tx.originalTransactionId);
  await store(env, state);
  if (!(await link(userId, state.id))) throw fail(409, 'This App Store subscription is already on another Mullo account.', 'apple_other_account');
  await env.DB.prepare('delete from released_subscriptions where subscription_id = ?').bind(state.id).run();
  return { status: state.status, periodEnd: state.periodEnd };
}

// App Store Server Notifications V2. Only WHICH subscription is read from the body; its state
// comes from Apple. A purchase made before the app could claim it is linked by its
// appAccountToken (the account it was bought for). Anything else is ignored.
export async function appleNotification(env, fetch, body, link) {
  if (!appStoreOn(env)) return { ignored: true };
  const note = jwsPayload(body?.signedPayload);
  const signed = note?.data?.signedTransactionInfo;
  if (!signed || note.data.bundleId !== env.APPLE_CLIENT_ID) return { ignored: true };
  const tx = jwsPayload(signed);
  const state = await subscriptionState(env, fetch, tx.originalTransactionId);
  await store(env, state);
  const user = String(state.info.appAccountToken ?? '');
  // Not back onto a deleted account: a released subscription waits for its next Restore.
  await ready(env);
  const released = await env.DB.prepare('select 1 from released_subscriptions where subscription_id = ?').bind(state.id).first();
  if (/^[0-9a-f-]{36}$/i.test(user) && !released) await link(user.toLowerCase(), state.id);
  return { type: note.notificationType, status: state.status };
}
