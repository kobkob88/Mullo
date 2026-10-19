// Mullo Pro Worker (worker/src): run in Node against a real SQLite (D1 is
// SQLite) with fake Stripe and fake Gemini. No network.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { handle, hashKey, newKey, usable, tokensIn, TranscribeJob, addressKey, TOO_MANY } from '../worker/src/index.mjs';
import { KEEP_MS } from '../worker/src/jobs.mjs';
import { verifyWebhook, formEncode, periodEnd } from '../worker/src/stripe.mjs';
import { forgetKeys } from '../worker/src/signin.mjs';
import { LEGAL_UPDATED } from '../worker/src/legal.mjs';

const SCHEMA = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');

// Mullo sign-ins (signin.mjs): a stand-in for our Supabase project, with a real
// ES256 key pair. `jwks` is what the project publishes.
const SUPABASE = 'https://project.supabase.test';
const signer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const stranger = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
let jwks = [];
const pub = async (k, kid) => ({ ...(await crypto.subtle.exportKey('jwk', k.publicKey)), kid, alg: 'ES256', use: 'sig' });
const b64 = (s) => Buffer.from(s).toString('base64url');
async function signInToken({ sub = 'aaaaaaaa-1111-2222-3333-444444444444', iss = `${SUPABASE}/auth/v1`, exp = now() + 3600,
  role = 'authenticated', aud = 'authenticated', kid = 'k1', keys = signer, alg = 'ES256', email = 'me@example.com', extra = {} } = {}) {
  const head = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub, iss, exp, role, aud, email, ...extra }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const ADMIN_ID = 'ad000000-1111-2222-3333-444444444444';
const BASE = 'https://echo-api.example.workers.dev';
const APP = 'https://app.mullo.lizai.io';
const now = () => Math.floor(Date.now() / 1000);

// The slice of the D1 API the Worker uses: prepare().bind().first()/run()/all().
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) {
          if (a.some((v) => v === undefined)) throw new Error('D1 rejects undefined binds');
          args = a; return st;
        },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return st;
    },
  };
}

let env;
let sub;        // what Stripe says the subscription is right now
let calls;      // every outgoing fetch
let geminiTokens;
let geminiText;  // what Gemini answers (null = an Ask answer)
let geminiDown;  // true = Gemini answers 503
let geminiRefuse; // a model id Gemini answers 400 for (the summary-model fallback)
let geminiNoBudget; // a model id that refuses thinkingBudget (wants a thinkingLevel)
let appleStore;  // what the App Store Server API says: { env, status, tx }
let geminiAudio; // audio tokens Gemini reports hearing (32 per second)
let checkoutRef; // the Mullo account a Checkout was opened for (client_reference_id), or null
let otherText;   // what OpenAI or Claude answers (null = an Ask answer)

// Durable Objects: one TranscribeJob per name, with its SQL storage in memory and its
// alarm recorded (a test runs it by calling alarm()).
function fakeJobs() {
  const objects = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) {
        const db = new DatabaseSync(':memory:');
        const ctx = {
          alarmAt: null,
          storage: {
            sql: {
              exec(q, ...b) {
                const st = db.prepare(q);
                const rows = /^\s*select/i.test(q) ? st.all(...b) : (st.run(...b), []);
                return { toArray: () => rows };
              },
            },
            async setAlarm(t) { ctx.alarmAt = t; },
          },
        };
        const job = new TranscribeJob(ctx, env);
        job.doFetch = fakeFetch;
        objects.set(id, job);
      }
      return objects.get(id);
    },
  };
}

function fakeFetch(url, init = {}) {
  calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, headers: init.headers });
  const u = new URL(url);
  if (`${u.origin}` === SUPABASE && u.pathname === '/auth/v1/.well-known/jwks.json') {
    return Promise.resolve(new Response(JSON.stringify({ keys: jwks }), { status: 200 }));
  }
  const ok = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  if (u.host === 'api.stripe.com') {
    if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') return ok({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    if (u.pathname === '/v1/checkout/sessions/cs_test_ok') {
      return ok({ mode: 'subscription', status: 'complete', customer_details: { email: 'a@example.com' }, subscription: sub, client_reference_id: checkoutRef });
    }
    if (u.pathname === '/v1/checkout/sessions/cs_test_open') return ok({ mode: 'subscription', status: 'open', subscription: null });
    if (u.pathname === `/v1/subscriptions/${sub.id}`) {
      if (init.method === 'DELETE') sub = { ...sub, status: 'canceled' };
      return ok(sub);
    }
    if (u.pathname === '/v1/billing_portal/sessions') return ok({ url: 'https://billing.stripe.com/p/session/x' });
  }
  if (u.host === 'generativelanguage.googleapis.com' && u.pathname === '/v1beta/models') {
    // Bring your own key: Google's answer to "does this key work?"
    const key = init.headers?.['x-goog-api-key'] ?? '';
    return Promise.resolve(new Response('{}', { status: key.includes('BAD') ? 400 : 200 }));
  }
  if (u.host === 'generativelanguage.googleapis.com') {
    if (geminiRefuse && u.pathname.includes(`/${geminiRefuse}:`)) {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Unsupported thinking config' } }), { status: 400 }));
    }
    if (geminiNoBudget && u.pathname.includes(`/${geminiNoBudget}:`) && 'thinkingBudget' in (JSON.parse(init.body).generationConfig?.thinkingConfig ?? {})) {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Request contains an invalid argument.' } }), { status: 400 }));
    }
    if (geminiDown) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 }));
    return ok({
      candidates: [{ content: { parts: [{ text: geminiText ?? JSON.stringify({ answer: 'On Friday.', found: false, sources: [] }) }] } }],
      usageMetadata: {
        totalTokenCount: geminiTokens,
        ...(geminiAudio ? { promptTokensDetails: [{ modality: 'TEXT', tokenCount: 50 }, { modality: 'AUDIO', tokenCount: geminiAudio }] } : {}),
      },
    });
  }
  // App Store Server API (appstore.mjs): answers from `appleStore` (null = this environment doesn't know it).
  if (u.host === 'api.storekit.itunes.apple.com' || u.host === 'api.storekit-sandbox.itunes.apple.com') {
    const env_ = u.host.includes('sandbox') ? 'Sandbox' : 'Production';
    if (appleStore.prod401 && env_ === 'Production') return Promise.resolve(new Response('', { status: 401 }));
    if (appleStore.env !== env_) return Promise.resolve(new Response('{}', { status: 404 }));
    const fakeJws = (o) => `h.${Buffer.from(JSON.stringify(o)).toString('base64url')}.s`;
    const tx = appleStore.tx;
    if (u.pathname === `/inApps/v1/transactions/${tx.transactionId}`) return ok({ signedTransactionInfo: fakeJws(tx) });
    if (u.pathname === `/inApps/v1/subscriptions/${tx.originalTransactionId}`) {
      return ok({ data: [{ lastTransactions: [{ originalTransactionId: tx.originalTransactionId, status: appleStore.status, signedTransactionInfo: fakeJws(tx) }] }] });
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }
  // Sign in with Apple (apple.mjs): the code 'good-code' trades for a refresh token; revoke says yes.
  if (u.host === 'appleid.apple.com') {
    const form = new URLSearchParams(String(init.body ?? ''));
    if (u.pathname === '/auth/token') {
      return form.get('code') === 'good-code' ? ok({ refresh_token: 'apple-refresh-1', access_token: 'a' })
        : Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    }
    if (u.pathname === '/auth/revoke') return Promise.resolve(new Response('', { status: 200 }));
  }
  // People's own OpenAI and Claude keys: a key with BAD in it is refused.
  if (u.host === 'api.openai.com' || u.host === 'api.anthropic.com') {
    const key = init.headers?.Authorization ?? init.headers?.['x-api-key'] ?? '';
    if (key.includes('BAD')) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }));
    if (u.pathname === '/v1/models') return ok({ data: [] });
    if (u.pathname === '/v1/responses') {
      return ok({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: otherText ?? JSON.stringify({ answer: 'From OpenAI.', found: false, sources: [] }) }] }] });
    }
    if (u.pathname === '/v1/messages') {
      return ok({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: otherText ?? JSON.stringify({ answer: 'From Claude.', found: false, sources: [] }) }] });
    }
    if (u.pathname === '/v1/audio/transcriptions') {
      return ok({ task: 'transcribe', duration: 5, segments: [{ type: 'transcript.text.segment', id: 's1', speaker: 'A', start: 0.5, end: 2, text: 'Hello' }, { speaker: 'B', start: 2.1, end: 4, text: 'Hi there' }] });
    }
  }
  return Promise.resolve(new Response('unexpected', { status: 599 }));
}

const call = (path, init = {}) => handle(new Request(`${BASE}${path}`, init), env, { fetch: fakeFetch });
const ask = (key, extra = {}) => call('/api/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
  body: JSON.stringify({ question: 'When is the delivery?', today: '2026-10-05', recordings: [] }),
});

async function subscribe() {
  const res = await call('/welcome?session_id=cs_test_ok');
  assert.equal(res.status, 200);
  const key = /value="(echo_[^"]+)"/.exec(await res.text())?.[1];
  assert.ok(key, 'the welcome page shows a key');
  return key;
}

function signed(body, secret = env.STRIPE_WEBHOOK_SECRET, t = now()) {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { 'Stripe-Signature': `t=${t},v1=${v1}` };
}

beforeEach(async () => {
  env = {
    DB: fakeD1(), GEMINI_API_KEY: 'test-gemini', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_ID: 'price_123', MONTHLY_TOKENS: '10000', AI_PER_MINUTE: '20', APP_ORIGINS: APP, SUPABASE_URL: SUPABASE,
    ADMIN_USER_IDS: ADMIN_ID, TRIAL_TOKENS_PER_MINUTE: '6000',
    OWN_KEY_SECRET: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString('base64url'),
  };
  forgetKeys();
  jwks = [await pub(signer, 'k1')];
  sub = { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [{ current_period_end: now() + 30 * 86400, price: { id: 'price_123', product: 'prod_mullo' } }] } };
  calls = [];
  geminiTokens = 1200;
  geminiText = null;
  appleStore = { env: 'Production', status: 1, tx: { transactionId: '2000000111', originalTransactionId: '2000000100', bundleId: 'app.mullo', productId: 'app.mullo.pro.monthly', appAccountToken: 'aaaaaaaa-1111-2222-3333-444444444444', expiresDate: (now() + 30 * 86400) * 1000 } };
  geminiDown = false;
  geminiRefuse = null;
  geminiNoBudget = null;
  geminiAudio = 0;
  checkoutRef = null;
  otherText = null;
  env.TRANSCRIBE_JOBS = fakeJobs();
});

test('keys: random, prefixed, stored only as a hash', async () => {
  const a = newKey();
  assert.match(a, /^echo_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, newKey());
  assert.match(await hashKey(a), /^[0-9a-f]{64}$/);
  const key = await subscribe();
  const rows = env.DB.raw.prepare('select * from accounts').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key_hash, await hashKey(key));
  assert.ok(!JSON.stringify(rows).includes(key), 'the key itself is never stored');
});

test('landing page: Pro is bought in the app (no form here); /checkout still redirects to Stripe with the price', async () => {
  const page = await (await call('/')).text();
  assert.doesNotMatch(page, /<form/, 'no Subscribe form: a POST to mullo.app was redirected and lost');
  assert.match(page, /Get it in Mullo: Settings, Subscription/);
  assert.doesNotMatch(page, /<script/i, 'no scripts on the pages');
  const res = await call('/checkout', { method: 'POST' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://checkout.stripe.com/c/pay/cs_test_1');
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('line_items[0][price]'), 'price_123');
  assert.equal(body.get('mode'), 'subscription');
  assert.equal(body.get('success_url'), `${BASE}/welcome?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(body.get('automatic_tax[enabled]'), null, 'no tax until STRIPE_TAX is on');
});

test('STRIPE_TAX on: both checkouts ask Stripe to add the sales tax (GST/HST)', async () => {
  env.STRIPE_TAX = 'on';
  await call('/checkout', { method: 'POST' });
  await billing('checkout', await signInToken({ sub: 'bbbbbbbb-1111-2222-3333-444444444444' }));
  const sessions = calls.filter((c) => c.url.endsWith('/v1/checkout/sessions'));
  assert.equal(sessions.length, 2);
  for (const c of sessions) assert.equal(new URLSearchParams(c.body).get('automatic_tax[enabled]'), 'true');
});

test('checkout currency: CA$ by default (Israel too), US$ from the US, never Adaptive Pricing', async () => {
  await call('/checkout', { method: 'POST', headers: { 'CF-IPCountry': 'IL' } });
  await call('/checkout', { method: 'POST', headers: { 'CF-IPCountry': 'US' } });
  await billing('checkout', await signInToken({ sub: 'bbbbbbbb-1111-2222-3333-444444444444' }));
  const sessions = calls.filter((c) => c.url.endsWith('/v1/checkout/sessions')).map((c) => new URLSearchParams(c.body));
  assert.deepEqual(sessions.map((b) => b.get('currency')), ['cad', 'usd', 'cad']);
  for (const b of sessions) assert.equal(b.get('adaptive_pricing[enabled]'), 'false');
});

test('before Stripe is set up: landing says Coming soon and /checkout refuses', async () => {
  env.STRIPE_PRICE_ID = 'REPLACE_WITH_price_ID';
  const page = await (await call('/')).text();
  assert.match(page, /Coming soon/);
  assert.equal((await call('/checkout', { method: 'POST' })).status, 503);
  assert.equal(calls.length, 0, 'Stripe was never called');
});

test('landing: the trial card shows the size new accounts get, hidden when off or paused', async () => {
  assert.doesNotMatch(await (await call('/')).text(), /Free trial/, 'no trial set = no card');
  env.DB.raw.prepare("insert into settings (name, value, updated_at) values ('trial_minutes', '300', 0)").run();
  const page = await (await call('/')).text();
  assert.match(page, /Free trial/);
  assert.match(page, /first 300 minutes/);
  assert.match(page, /Once per account, not every month/);
  env.DB.raw.prepare("insert into settings (name, value, updated_at) values ('trials_paused', '1', 0)").run();
  assert.doesNotMatch(await (await call('/')).text(), /Free trial/, 'paused = no card');
});

test('pages send a CSP with no scripts and allow forms only to Stripe', async () => {
  const csp = (await call('/')).headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.match(csp, /form-action 'self' https:\/\/checkout\.stripe\.com https:\/\/billing\.stripe\.com/);
});

test('welcome: refuses unfinished or made-up sessions; reopening issues a new key and kills the old', async () => {
  assert.equal((await call('/welcome?session_id=cs_test_open')).status, 402);
  assert.equal((await call('/welcome?session_id=../../x')).status, 400);
  const first = await subscribe();
  const second = await subscribe();
  assert.notEqual(first, second);
  assert.equal((await ask(first)).status, 401);
  assert.equal((await ask(second)).status, 200);
});

test('AI calls need a valid key, an active subscription, and allowance left', async () => {
  assert.equal((await ask(null)).status, 401);
  assert.equal((await ask('echo_made_up')).status, 401);
  const key = await subscribe();
  const res = await ask(key);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answer, 'On Friday.');
  const gemini = calls.find((c) => c.url.includes('generativelanguage'));
  assert.equal(gemini.headers['x-goog-api-key'], 'test-gemini', 'the server key is used, never one from the app');

  // Metered from Gemini's own count: 1200 + 1200 + ... until 10000.
  for (let i = 0; i < 8; i += 1) await ask(key);
  const used = env.DB.raw.prepare('select tokens, calls from usage').get();
  assert.equal(used.tokens, 9 * 1200);
  assert.equal(used.calls, 9);
  await ask(key); // 10800: over, but this one was let in (it was under before the call)
  const over = await ask(key);
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /this month's minutes/);
});

test('Ask as a chat (S10): same gate as Ask, metered, drafts checked; /api/draft is gone', async () => {
  const chat = (key, body) => call('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const recordings = [{ id: 'rec-1', title: 'Call with Daniel', date: '2026-10-02', summary: 'Price list', actions: [], transcript: 'We can do it.' }];
  const messages = [{ role: 'user', text: 'Write Daniel an email about the price list' }];
  assert.equal((await chat(null, { messages, recordings })).status, 401);
  const key = await subscribe();
  geminiText = JSON.stringify({ answer: 'Here is an email to Daniel.', found: true, sources: ['r1'], draft_kind: 'email', draft_subject: 'Price list', draft_body: 'Hi Daniel — here it is' });
  const res = await chat(key, { messages, recordings, today: '2026-10-11' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.sources, ['rec-1']);
  assert.deepEqual(out.draft, { kind: 'email', subject: 'Price list', body: 'Hi Daniel - here it is' });
  assert.equal(env.DB.raw.prepare('select calls from usage').get().calls, 1);
  assert.equal((await chat(key, { messages: [], recordings })).status, 400);
  assert.equal((await call('/api/draft', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: '{}' })).status, 404);
});

test('Pro is minutes a month: Gemini\'s audio counts them, and the month stops at the limit', async () => {
  env.MONTHLY_MINUTES = '30';
  env.MONTHLY_TOKENS = '1000000';
  const key = await subscribe();
  geminiAudio = 32 * 60 * 20; // a 20-minute meeting
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Hello' }] });
  const send = () => call('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: audioForm() });
  assert.equal((await send()).status, 200);
  let m = await (await call('/api/me', { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.deepEqual([m.minutesUsed, m.minutesAllowed, m.active, m.capped], [20, 30, true, undefined]);
  assert.equal((await send()).status, 200, '10 minutes left: the next one may start');
  m = await (await call('/api/me', { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.deepEqual([m.minutesUsed, m.active, m.capped], [40, false, true]);
  assert.equal((await send()).status, 429);
});

test('per-minute cap stops a leaked key from burning the month in an hour', async () => {
  env.AI_PER_MINUTE = '3';
  env.MONTHLY_TOKENS = '1000000';
  const key = await subscribe();
  for (let i = 0; i < 3; i += 1) assert.equal((await ask(key)).status, 200);
  assert.equal((await ask(key)).status, 429);
});

test('webhook: bad or old signatures are refused; a valid one re-reads the subscription from Stripe', async () => {
  const key = await subscribe();
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active' } } });
  assert.equal((await call('/stripe/webhook', { method: 'POST', body, headers: { 'Stripe-Signature': 't=1,v1=00' } })).status, 400);
  assert.equal((await call('/stripe/webhook', { method: 'POST', body, headers: signed(body, 'whsec_wrong') })).status, 400);
  assert.equal((await call('/stripe/webhook', { method: 'POST', body, headers: signed(body, undefined, now() - 3600) })).status, 400);

  // The event body says "active" but Stripe now says canceled: Stripe wins.
  sub = { ...sub, status: 'canceled' };
  const res = await call('/stripe/webhook', { method: 'POST', body, headers: signed(body) });
  assert.equal(res.status, 200);
  assert.equal(env.DB.raw.prepare('select status from accounts').get().status, 'canceled');
  const blocked = await ask(key);
  assert.equal(blocked.status, 402);
  assert.match((await blocked.json()).error, /not active/);
});

test('webhook: another product sold on the same Stripe account (the budget app) never becomes Mullo Pro', async () => {
  sub = { ...sub, id: 'sub_budget', items: { data: [{ current_period_end: now() + 30 * 86400, price: { id: 'price_budget', product: 'prod_budget' } }] } };
  for (const [id, type, object] of [
    ['evt_b1', 'customer.subscription.created', { id: 'sub_budget' }],
    ['evt_b2', 'checkout.session.completed', { mode: 'subscription', subscription: 'sub_budget', client_reference_id: 'aaaaaaaa-1111-2222-3333-444444444444' }],
  ]) {
    const body = JSON.stringify({ id, type, data: { object } });
    assert.equal((await call('/stripe/webhook', { method: 'POST', body, headers: signed(body) })).status, 200);
  }
  assert.equal(env.DB.raw.prepare('select count(*) n from accounts').get().n, 0);
  assert.equal((await me(await signInToken())).plan, 'none');

  // A later Mullo price (a price change) still counts, by its product.
  env.STRIPE_PRODUCT_ID = 'prod_mullo';
  sub = { ...sub, id: 'sub_new', items: { data: [{ current_period_end: now() + 30 * 86400, price: { id: 'price_2027', product: 'prod_mullo' } }] } };
  const body = JSON.stringify({ id: 'evt_b3', type: 'customer.subscription.created', data: { object: { id: 'sub_new' } } });
  assert.equal((await call('/stripe/webhook', { method: 'POST', body, headers: signed(body) })).status, 200);
  assert.equal(env.DB.raw.prepare('select count(*) n from accounts').get().n, 1);
});

test('CORS: the Android app is allowed, any other site is refused before any AI call', async () => {
  const key = await subscribe();
  const ok = await ask(key, { Origin: APP });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), APP);
  const before = calls.length;
  const evil = await ask(key, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(calls.length, before, 'no Gemini call was made');
  const pre = await call('/api/ask', { method: 'OPTIONS', headers: { Origin: APP } });
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('every response carries the baseline security headers; pages are locked down further', async () => {
  const key = await subscribe();
  const responses = {
    page: await call('/'),
    docs: await call('/docs'),
    missing: await call('/no-such-page'),
    api: await ask(key),
    css: await call('/style.css'),
    redirect: await call('/connect'),
    mcp: await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  };
  for (const [name, res] of Object.entries(responses)) {
    const hd = res.headers;
    assert.match(hd.get('Strict-Transport-Security') ?? '', /max-age=\d{8,}; includeSubDomains/, `${name}: HSTS`);
    assert.equal(hd.get('X-Content-Type-Options'), 'nosniff', `${name}: nosniff`);
    assert.equal(hd.get('X-Frame-Options'), 'DENY', `${name}: no framing`);
    assert.ok(hd.get('Referrer-Policy'), `${name}: referrer policy`);
  }
  for (const name of ['page', 'docs', 'missing']) {
    const hd = responses[name].headers;
    assert.equal(hd.get('Cross-Origin-Opener-Policy'), 'same-origin', `${name}: COOP`);
    assert.match(hd.get('Permissions-Policy') ?? '', /camera=\(\)/, `${name}: permissions`);
    const csp = hd.get('Content-Security-Policy') ?? '';
    assert.match(csp, /default-src 'none'/, `${name}: CSP`);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, `${name}: no inline`);
    assert.match(csp, /require-trusted-types-for 'script'/, `${name}: Trusted Types`);
  }
  assert.match(responses.page.headers.get('Cache-Control'), /no-store, no-transform/, 'no analytics injection into pages');
  assert.doesNotMatch(responses.css.headers.get('Cache-Control'), /no-transform/, 'other files stay compressible');
  assert.equal(responses.redirect.status, 302);
  assert.equal(responses.css.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(responses.mcp.headers.get('Access-Control-Allow-Origin'), '*', 'MCP stays open to any origin');
  assert.equal(responses.mcp.headers.get('Cross-Origin-Resource-Policy'), null);
});

test('the consent page keeps its opener (an app may watch it as a popup) but is otherwise locked down', async () => {
  const res = await handle(new Request(`${BASE}/oauth/consent`), { ...env, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }, { fetch: fakeFetch });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'unsafe-none');
  assert.match(res.headers.get('Content-Security-Policy') ?? '', /require-trusted-types-for 'script'; trusted-types 'none'/);
  assert.match(res.headers.get('Strict-Transport-Security') ?? '', /max-age/);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
});

test('privacy and terms: served as locked-down pages, linked from every page footer', async () => {
  const privacy = await call('/privacy');
  const terms = await call('/terms');
  assert.equal(privacy.status, 200);
  assert.equal(terms.status, 200);
  assert.ok(privacy.headers.get('Content-Security-Policy'));
  assert.match(await privacy.text(), /Privacy Policy/);
  const termsText = await terms.text();
  assert.match(termsText, /Free trial minutes/);
  assert.doesNotMatch(termsText, /—/);
  const landing = await (await call('/')).text();
  assert.match(landing, /href="\/privacy"/);
  assert.match(landing, /href="\/terms"/);
  // S60 A8: the source code, from the site and the docs (not from the Privacy Policy text or Terms text).
  assert.match(landing, /<footer>.*href="https:\/\/github\.com\/[^/"]+\/Mullo">Source code<\/a>/);
  assert.match(await (await call('/docs')).text(), /<footer>.*>Source code<\/a><\/footer>/);
});

test('security.txt names a contact and expires', async () => {
  const res = await call('/.well-known/security.txt');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^Contact: mailto:/m);
  assert.ok(Date.parse(/^Expires: (.+)$/m.exec(text)[1]) > Date.now());
});

test('the web app on this same site (/app/) may call /api', async () => {
  const key = await subscribe();
  const res = await ask(key, { Origin: new URL(BASE).origin });
  assert.equal(res.status, 200);
});

test('manage: a valid key goes to the Stripe billing portal, a bad one does not', async () => {
  const key = await subscribe();
  const form = (k) => ({ method: 'POST', body: new URLSearchParams({ key: k }) });
  const res = await call('/manage', form(key));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), 'https://billing.stripe.com/p/session/x');
  assert.equal((await call('/manage', form('echo_wrong'))).status, 401);
});

test('/api/me reports status and this month\'s use', async () => {
  const key = await subscribe();
  await ask(key);
  const me = await (await call('/api/me', { headers: { Authorization: `Bearer ${key}` } })).json();
  assert.equal(me.active, true);
  assert.equal(me.tokensUsed, 1200);
  assert.deepEqual([me.minutesUsed, me.minutesAllowed], [0, 1800]);
});

test('helpers: form encoding, period end on old and new Stripe shapes, usable()', async () => {
  assert.equal(formEncode({ a: 1, line_items: [{ price: 'p', quantity: 1 }] }).toString(), 'a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1');
  assert.equal(periodEnd({ current_period_end: 5 }), 5);
  assert.equal(periodEnd({ items: { data: [{ current_period_end: 7 }] } }), 7);
  assert.match(usable({ status: 'past_due' }), /not active/);
  assert.match(usable({ status: 'active', period_end: now() - 10 * 86400 }), /ended/);
  assert.equal(usable({ status: 'active', period_end: now() + 86400 }), null);
  await assert.rejects(verifyWebhook('{}', 't=1,v1=ab', 'whsec_x', 1000), /too old/);
});

test('transcribe: names travel in the form body, never in the URL; an older app\'s query form still works', async () => {
  const key = await subscribe();
  const options = { lang: 'he', out: null, vocabulary: ['נועה (Noa)', 'Charmander'], duration_ms: 4000, mime: 'audio/mp4' };
  const form = new FormData();
  form.append('options', JSON.stringify(options));
  form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), 'audio');
  await call('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const sent = calls.filter((c) => c.url.includes('generativelanguage'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /נועה \(Noa\)/, 'the names reach Gemini');
  assert.match(sent[0].body, /"mime_type":"audio\/mp4"/);

  await call('/api/transcribe?lang=he&vocab=Charmander', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'audio/mp4' }, body: new Uint8Array([1, 2, 3]),
  });
  assert.match(calls.filter((c) => c.url.includes('generativelanguage'))[1].body, /Charmander/);
});

test('transcribe: a form without audio is refused before any AI call', async () => {
  const key = await subscribe();
  const form = new FormData();
  form.append('options', '{}');
  const res = await call('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  assert.equal(res.status, 400);
  assert.equal(calls.filter((c) => c.url.includes('generativelanguage')).length, 0);
});

test('usage: a streamed answer counts its last running total, a JSON one its total', () => {
  const stream = [{ usageMetadata: { totalTokenCount: 900 } }, { usageMetadata: { totalTokenCount: 1500 } }]
    .map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
  assert.equal(tokensIn(stream), 1500);
  assert.equal(tokensIn(JSON.stringify({ usageMetadata: { totalTokenCount: 42 } })), 42);
  assert.equal(tokensIn('<html>524</html>'), 0);
});

test('transcribe: a speech map with no sound never reaches Gemini, and costs nothing', async () => {
  const key = await subscribe();
  const form = new FormData();
  form.append('options', JSON.stringify({ lang: 'he', mime: 'audio/mp4', speech: { ranges: [], duration_ms: 5000 } }));
  form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), 'audio');
  const res = await call('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).segments, []);
  assert.equal(calls.filter((c) => c.url.includes('generativelanguage')).length, 0);
  assert.equal(env.DB.raw.prepare('select count(*) n from usage').get().n, 0);
});

// ── Send now, collect later (worker/src/jobs.mjs) ───────────────────────
const audioForm = (options = { lang: 'en', mime: 'audio/mp4', duration_ms: 5000 }, bytes = [1, 2, 3]) => {
  const form = new FormData();
  form.append('options', JSON.stringify(options));
  form.append('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }), 'audio');
  return form;
};
const startJob = (key, form = audioForm()) => call('/api/transcribe/jobs', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
const jobStatus = (key, id) => call(`/api/transcribe/jobs/${id}`, { headers: { Authorization: `Bearer ${key}` } });
const audioRows = (id) => env.TRANSCRIBE_JOBS.objects.get(id).sql.exec('select count(*) n from audio').toArray()[0].n;

test('jobs: the phone gets a ticket at once; the work runs with nobody connected; the result waits to be collected', async () => {
  const key = await subscribe();
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Hello all' }] });
  const res = await startJob(key);
  assert.equal(res.status, 202);
  const { job } = await res.json();
  assert.match(job, /^[0-9a-f-]{36}$/);
  assert.equal(calls.filter((c) => c.url.includes('generativelanguage')).length, 0, 'nothing sent to Gemini yet');
  assert.deepEqual(await (await jobStatus(key, job)).json(), { state: 'queued' });
  assert.ok(audioRows(job) > 0, 'the audio waits in the job');

  await env.TRANSCRIBE_JOBS.objects.get(job).alarm();
  const done = await (await jobStatus(key, job)).json();
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result.segments.map((s) => s.text), ['Hello all']);
  assert.equal(audioRows(job), 0, 'the audio is gone once the transcript is written');
  assert.equal(env.DB.raw.prepare('select tokens from usage').get().tokens, 1200, 'the background work is counted');
  assert.deepEqual(await (await jobStatus(key, job)).json(), done, 'asking again is harmless');
});

test('jobs: only the sender can read it; an unknown or expired job says send it again', async () => {
  const key = await subscribe();
  const { job } = await (await startJob(key)).json();
  assert.equal(await env.TRANSCRIBE_JOBS.objects.get(job).status('sub_someone_else'), null);
  assert.equal((await jobStatus('echo_not_a_real_key_000000000000', job)).status, 401);
  const missing = await jobStatus(key, '00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /send it again/);
});

test('jobs: a Gemini failure is kept as the answer, and the audio is still deleted', async () => {
  const key = await subscribe();
  geminiDown = true;
  const { job } = await (await startJob(key)).json();
  await env.TRANSCRIBE_JOBS.objects.get(job).alarm();
  const failed = await (await jobStatus(key, job)).json();
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /overloaded/);
  assert.equal(audioRows(job), 0);
});

test('jobs: bad audio and a spent allowance are refused before anything is stored', async () => {
  const key = await subscribe();
  const bad = await startJob(key, audioForm({ mime: 'text/plain' }));
  assert.equal(bad.status, 415);
  assert.equal(env.TRANSCRIBE_JOBS.objects.size, 0);
  env.DB.raw.prepare("insert into usage (subscription_id, month, tokens, calls) values ('sub_1', ?, 999999, 1)").run(new Date().toISOString().slice(0, 7));
  assert.equal((await startJob(key)).status, 429);
  assert.equal(env.TRANSCRIBE_JOBS.objects.size, 0);
});

test('jobs: kept for a day after it finishes, then forgotten; an interrupted job stops after 3 tries', async () => {
  const key = await subscribe();
  geminiText = JSON.stringify({ segments: [] });
  const { job } = await (await startJob(key)).json();
  const obj = env.TRANSCRIBE_JOBS.objects.get(job);
  await obj.alarm();
  assert.ok(obj.ctx.alarmAt >= Date.now() + KEEP_MS - 1000, 'cleanup is booked a day out');
  await obj.alarm(); // too early: nothing happens
  assert.equal((await jobStatus(key, job)).status, 200);
  const meta = obj.meta();
  obj.save({ ...meta, finished: Date.now() - KEEP_MS - 1 });
  await obj.alarm();
  assert.equal((await jobStatus(key, job)).status, 404);

  const second = (await (await startJob(key)).json()).job;
  const stuck = env.TRANSCRIBE_JOBS.objects.get(second);
  stuck.save({ ...stuck.meta(), state: 'working', tries: 3 });
  await stuck.alarm();
  assert.match((await (await jobStatus(key, second)).json()).error, /kept being interrupted/);
});

// S45: how long the server keeps a result. Only a fixed list, only ever shorter than a day.
const releaseJob = (key, id) => call(`/api/transcribe/jobs/${id}`, { method: 'DELETE', ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) });

test('jobs keep: the choice shortens the wait (1 h, 6 h); none = a day; off the list = 400, nothing stored', async () => {
  const key = await subscribe();
  geminiText = JSON.stringify({ segments: [] });
  for (const [keep, ms] of [['1h', 3_600_000], ['6h', 6 * 3_600_000], ['24h', KEEP_MS], [undefined, KEEP_MS], ['collected', 3_600_000]]) {
    const { job } = await (await startJob(key, audioForm({ lang: 'en', mime: 'audio/mp4', ...(keep ? { keep } : {}) }))).json();
    const obj = env.TRANSCRIBE_JOBS.objects.get(job);
    await obj.alarm();
    assert.ok(Math.abs(obj.ctx.alarmAt - (Date.now() + ms)) < 2000, `${keep}: cleanup booked ${ms} ms out`);
    assert.equal(obj.meta().options.keep, undefined, 'the choice is not handed to the AI');
    obj.save({ ...obj.meta(), finished: Date.now() - ms - 1 });
    await obj.alarm();
    assert.equal((await jobStatus(key, job)).status, 404, `${keep}: gone after ${ms} ms`);
  }
  const before = env.TRANSCRIBE_JOBS.objects.size;
  for (const keep of ['48h', '7d', 'forever', 999999999, '']) {
    const res = await startJob(key, audioForm({ lang: 'en', mime: 'audio/mp4', keep }));
    assert.equal(res.status, 400, `${JSON.stringify(keep)} is refused`);
  }
  assert.equal(env.TRANSCRIBE_JOBS.objects.size, before, 'a refused choice stores nothing');
});

test('jobs keep: "got it" forgets a finished job at once; only its sender, only once it is done', async () => {
  const key = await subscribe();
  const other = await signInToken({ sub: 'bbbbbbbb-1111-2222-3333-444444444444' }); // a real sign-in, not the payer
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Hello' }] });
  const { job } = await (await startJob(key, audioForm({ lang: 'en', mime: 'audio/mp4', keep: 'collected' }))).json();
  assert.equal((await releaseJob(key, job)).status, 409, 'still working: not forgotten');
  await env.TRANSCRIBE_JOBS.objects.get(job).alarm();
  assert.equal((await releaseJob(null, job)).status, 401, 'no sign-in');
  assert.equal((await releaseJob(other, job)).status, 404, 'someone else\'s job');
  assert.equal((await jobStatus(key, job)).status, 200, 'still there for its sender');
  assert.equal((await releaseJob(key, job)).status, 204);
  assert.equal((await jobStatus(key, job)).status, 404, 'forgotten');
  assert.equal(env.TRANSCRIBE_JOBS.objects.get(job).sql.exec('select count(*) n from job').toArray()[0].n, 0);
  assert.equal((await releaseJob(key, job)).status, 404, 'saying it twice is harmless');
});

// ── Mullo sign-ins (signin.mjs) ─────────────────────────────────────────
const link = (token, key) => call('/api/link', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ key }),
});

test('sign-in tokens: only a real one from our project counts; forged, foreign, expired or unsigned ones are nobody', async () => {
  const geminiCalls = () => calls.filter((c) => c.url.includes('generativelanguage')).length;
  const bad = {
    'signed with someone else\'s key': await signInToken({ keys: stranger }),
    'from another Supabase project': await signInToken({ iss: 'https://other.supabase.co/auth/v1' }),
    expired: await signInToken({ exp: now() - 10 }),
    'signed out (anon role)': await signInToken({ role: 'anon' }),
    'not a user id': await signInToken({ sub: 'admin' }),
    'alg none': `${b64(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64(JSON.stringify({ sub: 'aaaaaaaa-1111-2222-3333-444444444444', iss: `${SUPABASE}/auth/v1`, exp: now() + 60, role: 'authenticated', aud: 'authenticated' }))}.`,
    'HS256': await signInToken({ alg: 'HS256' }),
    'unknown key id': await signInToken({ kid: 'nope' }),
  };
  for (const [why, token] of Object.entries(bad)) {
    const res = await ask(token);
    assert.equal(res.status, 401, why);
  }
  // Tampered: a real token with someone else's user id swapped in.
  const real = await signInToken();
  const [h, , s] = real.split('.');
  const swapped = `${h}.${b64(JSON.stringify({ sub: 'bbbbbbbb-1111-2222-3333-444444444444', iss: `${SUPABASE}/auth/v1`, exp: now() + 3600, role: 'authenticated', aud: 'authenticated' }))}.${s}`;
  assert.equal((await ask(swapped)).status, 401, 'tampered');
  assert.equal(geminiCalls(), 0, 'none of them reached Gemini');

  const res = await ask(real);
  assert.equal(res.status, 402, 'a real sign-in without Mullo Pro');
  assert.match((await res.json()).error, /isn't on this Mullo account/);
  // No project configured: no sign-in counts at all.
  delete env.SUPABASE_URL;
  assert.equal((await ask(real)).status, 401);
});

const deleteAccount = (token) => call('/api/account/delete', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('delete account: cancels a linked Pro at once, lets go of the key and email, keeps the trial fingerprint', async () => {
  const key = await subscribe();
  const token = await signInToken();
  assert.equal((await link(token, key)).status, 200);
  await ask(token);
  assert.equal((await deleteAccount()).status, 401, 'signed out');
  assert.equal((await deleteAccount(key)).status, 401, 'a Pro key is not the person');

  const res = await deleteAccount(token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true, cancelled: true });
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/v1/subscriptions/${sub.id}`)), 'Stripe was told to cancel');
  const row = env.DB.raw.prepare('select status, email, key_hash from accounts').get();
  assert.deepEqual({ ...row }, { status: 'canceled', email: null, key_hash: null });
  assert.equal(env.DB.raw.prepare('select count(*) n from account_users').get().n, 0);
  assert.equal((await ask(key)).status, 401, 'the old key no longer works');

  // Again (a retry after the app lost signal): nothing to cancel, still fine.
  const again = await deleteAccount(token);
  assert.deepEqual(await again.json(), { deleted: true, cancelled: false });
});

test('delete account with Apple: the iPhone\'s fresh code is traded and revoked at Apple; a failure never stops the delete', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  Object.assign(env, { APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_CLIENT_ID: 'app.mullo',
    APPLE_SIGNIN_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n` });
  const token = await signInToken();
  const del = (body) => call('/api/account/delete', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const res = await del({ apple_code: 'good-code' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true, cancelled: false, apple: 'revoked' });
  const apple = calls.filter((c) => c.url.startsWith('https://appleid.apple.com/'));
  assert.deepEqual(apple.map((c) => new URL(c.url).pathname), ['/auth/token', '/auth/revoke']);
  const traded = new URLSearchParams(apple[0].body);
  assert.equal(traded.get('client_id'), 'app.mullo');
  assert.equal(traded.get('grant_type'), 'authorization_code');
  const revoked = new URLSearchParams(apple[1].body);
  assert.equal(revoked.get('token'), 'apple-refresh-1');
  assert.equal(revoked.get('token_type_hint'), 'refresh_token');
  // The client secret: an ES256 JWT for Apple, signed with the key, short-lived.
  const [h, b, s] = traded.get('client_secret').split('.');
  const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${b}`));
  assert.ok(verified, 'signed with the Sign in with Apple key');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.sub, 'app.mullo');
  assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.ok(claims.exp - claims.iat <= 300);

  assert.equal((await (await del({ apple_code: 'stale-code' })).json()).apple, 'failed', 'Apple refused: still deleted');
  delete env.APPLE_SIGNIN_KEY;
  assert.deepEqual(await (await del({ apple_code: 'good-code' })).json(), { deleted: true, cancelled: false, apple: 'not_set' });
  assert.deepEqual(await (await del({})).json(), { deleted: true, cancelled: false }, 'no code: no Apple step');
});

test('delete account: a trial account goes, its trial claim stays so a new sign-up gets no second trial', async () => {
  env.DB.raw.prepare("insert into settings (name, value, updated_at) values ('trial_minutes', '30', 0)").run();
  const token = await signInToken({ sub: 'cccccccc-1111-2222-3333-444444444444', email: 'trial@example.com' });
  assert.equal((await (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json()).plan, 'trial');
  // A Google connection (google.mjs) goes with the account.
  env.DB.raw.prepare("insert into google_links (user_id, refresh_sealed, scopes, created_at) values ('cccccccc-1111-2222-3333-444444444444', 'x', '', 0)").run();
  env.DB.raw.prepare("insert into google_tasks (user_id, action_id, task_id) values ('cccccccc-1111-2222-3333-444444444444', 'a1', 't1')").run();
  assert.equal((await deleteAccount(token)).status, 200);
  assert.equal(env.DB.raw.prepare('select count(*) n from google_links').get().n, 0);
  assert.equal(env.DB.raw.prepare('select count(*) n from google_tasks').get().n, 0);
  assert.equal(env.DB.raw.prepare('select count(*) n from plans').get().n, 0);
  assert.equal(env.DB.raw.prepare('select count(*) n from trial_claims').get().n, 1);
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'no subscription, no Stripe call');
});

test('linking: the key and the sign-in together, once; then the sign-in reaches the same allowance and usage', async () => {
  const key = await subscribe();
  const token = await signInToken();
  assert.equal((await link(token, 'echo_made_up')).status, 401, 'a made-up key');
  assert.equal((await link(key, key)).status, 401, 'the key alone is not a sign-in');
  const linked = await link(token, key);
  assert.equal(linked.status, 200);
  assert.deepEqual(await linked.json(), { linked: true, active: true });
  assert.equal((await link(token, key)).status, 200, 'linking again is harmless');

  assert.equal((await ask(token)).status, 200);
  await ask(key);
  const used = env.DB.raw.prepare('select tokens, calls from usage').all().map((r) => ({ ...r }));
  assert.deepEqual(used, [{ tokens: 2400, calls: 2 }], 'one subscription, counted once, whichever was used');
  const me = await (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(me.tokensUsed, 2400);

  // A second account can't take the same key.
  const other = await signInToken({ sub: 'bbbbbbbb-1111-2222-3333-444444444444' });
  const taken = await link(other, key);
  assert.equal(taken.status, 409);
  assert.equal((await ask(other)).status, 402);

  // A transcription sent with the key is collected with the sign-in: same owner.
  geminiText = JSON.stringify({ segments: [] });
  const { job } = await (await startJob(key)).json();
  await env.TRANSCRIBE_JOBS.objects.get(job).alarm();
  assert.equal((await jobStatus(token, job)).status, 200);
  assert.equal((await jobStatus(other, job)).status, 404, 'someone else\'s sign-in can\'t read it');
});

test('a lapsed subscription: the sign-in is real, but AI is refused with the subscription\'s reason', async () => {
  const key = await subscribe();
  const token = await signInToken();
  await link(token, key);
  env.DB.raw.prepare("update accounts set status = 'canceled'").run();
  const res = await ask(token);
  assert.equal(res.status, 402);
  assert.match((await res.json()).error, /not active/);
});

test('Supabase\'s public keys are fetched once and kept, and a rotated key is picked up', async () => {
  const key = await subscribe();
  const token = await signInToken();
  await link(token, key);
  await ask(token);
  await ask(token);
  const fetched = () => calls.filter((c) => c.url.endsWith('/jwks.json')).length;
  assert.equal(fetched(), 1);
  // Supabase rotates to a new signing key: the unknown id triggers one fresh look.
  jwks = [await pub(signer, 'k1'), await pub(stranger, 'k2')];
  assert.equal((await ask(await signInToken({ keys: stranger, kid: 'k2' }))).status, 200);
  assert.equal(fetched(), 2);
});

// ── Plans (plans.mjs): trial, free, none, and the admin who sets them ───
const me = async (token) => (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();
const admin = (path, body, token) => call(`/api/admin/${path}`, body === undefined
  ? { headers: { Authorization: `Bearer ${token}` } }
  : { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const adminToken = () => signInToken({ sub: ADMIN_ID, email: 'owner@example.com' });
const person = (n, email) => signInToken({ sub: `0000000${n}-1111-2222-3333-444444444444`, email });
const transcribe = (token) => {
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Hello' }] });
  return call('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: audioForm() });
};

test('plans: trials are off until an admin sets a size; a signed-in account then gets it once', async () => {
  const first = await person(1, 'first@example.com');
  const { legal, ...plan } = await me(first);
  assert.deepEqual(plan, { plan: 'none', active: false, month: new Date().toISOString().slice(0, 7) });
  assert.equal(legal.accepted, null);
  assert.match((await (await ask(first)).json()).error, /isn't on this Mullo account/);

  assert.equal((await admin('settings', { trialMinutes: 5 }, await adminToken())).status, 200);
  const later = await me(first);
  assert.equal(later.plan, 'trial', 'someone who joined while trials were off gets one once they open');
  assert.deepEqual([later.minutesUsed, later.minutesAllowed, later.active], [0, 5, true]);
  assert.equal((await ask(first)).status, 200);
});

test('plans: a trial counts minutes of audio Gemini heard, and stops when they are used', async () => {
  await admin('settings', { trialMinutes: 5 }, await adminToken());
  const t = await person(1, 'a@example.com');
  geminiAudio = 32 * 180; // 3 minutes
  assert.equal((await transcribe(t)).status, 200);
  assert.equal((await me(t)).minutesUsed, 3);
  assert.equal((await transcribe(t)).status, 200, 'some minutes left: the next one may start');
  const after = await me(t);
  assert.deepEqual([after.minutesUsed, after.active], [6, false]);
  const res = await ask(t);
  assert.equal(res.status, 402);
  assert.match((await res.json()).error, /free minutes are used up/);
});

test('plans: the hidden token cap stops a trial that only asks questions', async () => {
  await admin('settings', { trialMinutes: 1 }, await adminToken()); // 6000 tokens
  const t = await person(1, 'b@example.com');
  geminiTokens = 3000;
  assert.equal((await ask(t)).status, 200);
  assert.equal((await ask(t)).status, 200);
  assert.equal((await ask(t)).status, 402);
});

test('plans: a new size applies to new accounts only; one trial per mailbox, however it is written', async () => {
  const boss = await adminToken();
  await admin('settings', { trialMinutes: 300 }, boss);
  const early = await person(1, 'sam.test@gmail.com');
  assert.equal((await me(early)).minutesAllowed, 300);
  await admin('settings', { trialMinutes: 100 }, boss);
  assert.equal((await me(early)).minutesAllowed, 300, 'someone already on a trial keeps what they were given');
  assert.equal((await me(await person(2, 'other@example.com'))).minutesAllowed, 100);
  const again = await me(await person(3, 'Sam.Test+2@googlemail.com'));
  assert.equal(again.plan, 'none', 'the same Gmail inbox gets no second trial');

  await admin('settings', { trialMinutes: 0 }, boss);
  assert.equal((await me(await person(4, 'late@example.com'))).plan, 'none', 'trials pulled: new accounts get none');
  assert.equal((await me(early)).plan, 'trial', 'existing trials carry on');
});

test('plans: pause stops every trial at once, and lifts again', async () => {
  const boss = await adminToken();
  await admin('settings', { trialMinutes: 50 }, boss);
  const t = await person(1, 'c@example.com');
  assert.equal((await ask(t)).status, 200);
  assert.deepEqual(await (await admin('settings', { trialsPaused: true }, boss)).json(), { trialMinutes: 50, trialsPaused: true });
  const res = await ask(t);
  assert.equal(res.status, 402);
  assert.match((await res.json()).error, /paused/);
  await admin('settings', { trialsPaused: false }, boss);
  assert.equal((await ask(t)).status, 200);
});

test('plans: free by email, given before or after the first sign-in; its own monthly allowance; taken back without a new trial', async () => {
  const boss = await adminToken();
  await admin('settings', { trialMinutes: 50 }, boss);
  const given = await (await admin('grant', { email: 'Partner@Example.com', plan: 'free' }, boss)).json();
  assert.deepEqual(given, { plan: 'free', signedUp: false });
  const partner = await person(5, 'partner@example.com');
  const p = await me(partner);
  assert.deepEqual([p.plan, p.active, p.minutesAllowed], ['free', true, 1800]);
  await ask(partner);
  assert.equal((await me(partner)).tokensUsed, 1200);
  // Not someone else's allowance: the owner's subscription is untouched.
  assert.deepEqual(env.DB.raw.prepare('select subscription_id from usage').all().map((r) => r.subscription_id), ['user:00000005-1111-2222-3333-444444444444']);

  // Someone already signed in (on a trial) is moved over at once.
  const known = await person(6, 'known@example.com');
  assert.equal((await me(known)).plan, 'trial');
  assert.deepEqual(await (await admin('grant', { email: 'known@example.com', plan: 'free' }, boss)).json(), { plan: 'free', signedUp: true });
  assert.equal((await me(known)).plan, 'free');

  await admin('grant', { email: 'partner@example.com', plan: 'none' }, boss);
  assert.equal((await me(partner)).plan, 'none', 'taken back, and no fresh trial');
  assert.equal((await ask(partner)).status, 402);
  const log = env.DB.raw.prepare('select action, admin_id from admin_log').all().map((r) => r.action);
  assert.deepEqual(log, ['setting', 'grant_free', 'grant_free', 'grant_removed']);
  assert.equal(env.DB.raw.prepare("select count(*) n from admin_log where detail like '%@%'").get().n, 0, 'no email addresses kept');
});

test('admin: only listed accounts, only signed in, never with a key', async () => {
  const key = await subscribe();
  assert.equal((await admin('settings', undefined, key)).status, 401);
  assert.equal((await admin('settings', { trialMinutes: 999 }, await person(1, 'x@example.com'))).status, 403);
  assert.equal((await admin('settings', undefined, await signInToken({ sub: ADMIN_ID, keys: stranger }))).status, 401, 'a forged admin');
  assert.deepEqual(await (await admin('settings', undefined, await adminToken())).json(), { trialMinutes: 0, trialsPaused: false });
  assert.equal((await me(await adminToken())).admin, true);
  assert.equal((await me(await person(1, 'x@example.com'))).admin, undefined);
  assert.equal((await admin('grant', { email: 'nope', plan: 'free' }, await adminToken())).status, 400);
  assert.equal((await admin('grant', { email: 'a@example.com', plan: 'pro' }, await adminToken())).status, 400, 'Pro comes from Stripe only');
});

// S59 reports (admin-reports.mjs; the engines are in admin-reports.test.mjs).
test('admin reports: admins only; the dashboard has no emails; Pro equals the accounts table', async () => {
  const boss = await adminToken();
  await admin('settings', { trialMinutes: 5 }, boss);
  const t = await person(1, 'trial@example.com');
  geminiAudio = 32 * 180;
  assert.equal((await transcribe(t)).status, 200);
  await link(await signInToken(), await subscribe());

  assert.equal((await admin('dashboard', undefined, t)).status, 403);
  assert.equal((await admin('stats/people', undefined, await subscribe())).status, 401, 'never a key');
  const dash = await (await admin('dashboard', undefined, boss)).json();
  assert.equal(dash.windows.length, 9);
  assert.ok(!JSON.stringify(dash).includes('@'), 'no email on the dashboard');

  const people = await (await admin('stats/people', undefined, boss)).json();
  assert.equal(people.tiles[0].value, env.DB.raw.prepare('select count(*) n from (select user_id from plans union select user_id from account_users)').get().n);
  assert.deepEqual(people.tables.find((x) => x.id === 'trials').rows.slice(1), [['Used some minutes', '1 of 1'], ['Went Pro', '0 of 1']]);
  const subs = await (await admin('stats/subscriptions', undefined, boss)).json();
  assert.equal(subs.tiles[0].value, env.DB.raw.prepare("select count(*) n from accounts where status in ('active', 'trialing')").get().n);
  const cost = await (await admin('stats/cost', undefined, boss)).json();
  assert.equal(cost.tiles[0].value, 3);
  for (const name of ['heavy', 'features', 'legal', 'problems', 'log', 'groups']) {
    assert.equal((await admin(`stats/${name}`, undefined, boss)).status, 200, name);
  }
  assert.equal((await admin('stats/nope', undefined, boss)).status, 404);
});

test('a linked subscription wins over the account\'s own plan; Pro also counts minutes', async () => {
  await admin('settings', { trialMinutes: 5 }, await adminToken());
  const key = await subscribe();
  const token = await signInToken();
  assert.equal((await me(token)).plan, 'trial');
  await link(token, key);
  geminiAudio = 32 * 600;
  await transcribe(token);
  const m = await me(token);
  assert.deepEqual([m.plan, m.minutesUsed, m.active], ['pro', 10, true]);
});

test('usage: the audio minutes are the longest round, never the sum of rounds', async () => {
  const { meteredFetch } = await import('../worker/src/usage.mjs');
  const replies = [3000, 3000, 1000].map((audio) => JSON.stringify({ usageMetadata: { totalTokenCount: audio + 100, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: audio }] } }));
  const meter = { tokens: 0 };
  const f = meteredFetch(async () => new Response(replies.shift()), meter);
  await f('x'); await f('x'); await f('x');
  assert.equal(meter.tokens, 7300);
  assert.equal(meter.seconds, 3000 / 32);
});

// ── Billing from inside the app ─────────────────────────────────────────
const billing = (what, token) => call(`/api/billing/${what}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

test('Get Mullo Pro from the app: Checkout carries the account; paying puts Pro on it with no key to paste', async () => {
  const token = await signInToken();
  const res = await billing('checkout', token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const sent = new URLSearchParams(calls.find((c) => c.url.endsWith('/v1/checkout/sessions')).body);
  assert.equal(sent.get('client_reference_id'), 'aaaaaaaa-1111-2222-3333-444444444444');
  assert.equal(sent.get('customer_email'), 'me@example.com');

  checkoutRef = 'aaaaaaaa-1111-2222-3333-444444444444';
  const page = await (await call('/welcome?session_id=cs_test_ok')).text();
  assert.match(page, /nothing to paste/);
  const m = await me(token);
  assert.deepEqual([m.plan, m.active], ['pro', true]);
  assert.equal((await billing('checkout', token)).status, 409, 'already on Pro');

  // Someone else's Checkout can't take this subscription.
  checkoutRef = 'bbbbbbbb-1111-2222-3333-444444444444';
  await call('/welcome?session_id=cs_test_ok');
  assert.equal((await me(await signInToken({ sub: checkoutRef }))).plan, 'none');
});

test('Get Mullo Pro: a key is not a sign-in, and before Stripe is set up it says so', async () => {
  const key = await subscribe();
  assert.equal((await billing('checkout', key)).status, 401);
  env.STRIPE_PRICE_ID = 'REPLACE_WITH_price_ID';
  const res = await billing('checkout', await signInToken({ sub: 'bbbbbbbb-1111-2222-3333-444444444444' }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /open soon/);
});

test('a paid Checkout lands on the account by the webhook too, even if the welcome page never opens', async () => {
  const body = JSON.stringify({ id: 'evt_2', type: 'checkout.session.completed', data: { object: {
    mode: 'subscription', subscription: 'sub_1', client_reference_id: 'aaaaaaaa-1111-2222-3333-444444444444', customer_details: { email: 'me@example.com' },
  } } });
  assert.equal((await call('/stripe/webhook', { method: 'POST', body, headers: signed(body) })).status, 200);
  assert.equal((await me(await signInToken())).plan, 'pro');
});

test('Manage payments: the Stripe portal for the account\'s own subscription; nothing for a trial', async () => {
  const key = await subscribe();
  const token = await signInToken();
  assert.equal((await billing('portal', token)).status, 404, 'no subscription on this account yet');
  await link(token, key);
  const res = await billing('portal', token);
  assert.deepEqual(await res.json(), { url: 'https://billing.stripe.com/p/session/x' });
  const sent = new URLSearchParams(calls.findLast((c) => c.url.endsWith('/v1/billing_portal/sessions')).body);
  assert.equal(sent.get('customer'), 'cus_1');
  assert.equal((await billing('portal', key)).status, 200, 'the key works too');
  assert.equal((await billing('portal', 'echo_made_up')).status, 401);
});

// ── Bring your own AI key (ownkey.mjs) ──
const MY_GEMINI = 'AIzaSyOwnKey_1234567890abcdefghijklmnop';
const seal = (key, ip = '1.2.3.4') => call('/api/own-key', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ provider: 'gemini', key }),
});
const sealedFor = async (key = MY_GEMINI) => (await (await seal(key)).json()).sealed;

test('own key: checked with Google, sealed, handed back; the Worker keeps nothing', async () => {
  const res = await seal(MY_GEMINI);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.sealed, /^mk1\.[\w-]+\.[\w-]+$/);
  assert.equal(body.hint, 'mnop');
  assert.ok(!body.sealed.includes(MY_GEMINI) && !body.sealed.includes('OwnKey'), 'the key can\'t be read from the sealed text');
  const check = calls.find((c) => c.url.includes('/v1beta/models'));
  assert.equal(check.headers['x-goog-api-key'], MY_GEMINI, 'checked with Google');
  assert.doesNotMatch(check.url, /AIza/, 'the key goes in a header, never a URL');
  const tables = env.DB.raw.prepare("select name from sqlite_master where type = 'table'").all().map((t) => t.name);
  for (const t of tables) assert.doesNotMatch(JSON.stringify(env.DB.raw.prepare(`select * from "${t}"`).all()), /AIza|mk1\./, `nothing kept in ${t}`);
  assert.notEqual(await sealedFor(), await sealedFor(), 'sealed fresh each time');
});

test('own key: Google\'s newer AQ. keys (with a dot) are taken too', async () => {
  const res = await seal('AQ.Ab8RN6Kq_newStyleKey-1234567890abcdefghijklmnopqrstuv');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).hint, 'stuv');
});

test('own key: a key Google refuses, or not a key at all, is refused; off without the secret', async () => {
  assert.equal((await seal('AIzaSyBAD_key_1234567890abcdefghijklmnop')).status, 400);
  assert.match((await (await seal('hello')).json()).error, /doesn't look like an AI key/);
  delete env.OWN_KEY_SECRET;
  assert.equal((await seal(MY_GEMINI, '9.9.9.9')).status, 503);
});

test('own key: sealing is limited per address, so it can\'t test stolen keys in bulk', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await seal(MY_GEMINI, '5.5.5.5')).status, 200);
  assert.equal((await seal(MY_GEMINI, '5.5.5.5')).status, 429);
  assert.equal((await seal(MY_GEMINI, '6.6.6.6')).status, 200, 'another address is not slowed');
});

test('own key: AI runs on their key with no sign-in or plan, and nothing is counted', async () => {
  const sealed = await sealedFor();
  calls = [];
  const res = await ask(null, { 'X-Mullo-Own-Key': sealed });
  assert.equal(res.status, 200);
  const gem = calls.find((c) => c.url.includes('generateContent'));
  assert.equal(gem.headers['x-goog-api-key'], MY_GEMINI, 'Gemini is called with THEIR key');
  assert.equal(env.DB.raw.prepare('select count(*) n from usage').get().n, 0, 'no minutes or tokens counted');
});

test('own key: a changed or foreign sealed key is refused, never falls back to Mullo\'s key', async () => {
  const sealed = await sealedFor();
  const tampered = sealed.slice(0, -3) + (sealed.endsWith('A') ? 'BBB' : 'AAA');
  calls = [];
  const res = await ask(null, { 'X-Mullo-Own-Key': tampered });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /Add it again/);
  assert.equal(calls.filter((c) => /generateContent/i.test(c.url)).length, 0);
  const other = { ...env, OWN_KEY_SECRET: Buffer.alloc(32, 9).toString('base64url') };
  const res2 = await handle(new Request(`${BASE}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mullo-Own-Key': sealed }, body: '{"question":"q","recordings":[]}' }), other, { fetch: fakeFetch });
  assert.equal(res2.status, 401, 'sealed by another server\'s secret');
});

test('own key: a long recording\'s job runs on their key, and the key leaves with the job', async () => {
  const sealed = await sealedFor();
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Mine' }] });
  const res = await call('/api/transcribe/jobs', { method: 'POST', headers: { 'X-Mullo-Own-Key': sealed }, body: audioForm() });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const obj = env.TRANSCRIBE_JOBS.objects.get(job);
  assert.equal(obj.meta().ownKey, sealed, 'kept sealed while it waits');
  assert.doesNotMatch(JSON.stringify(obj.meta()), /AIza/);
  calls = [];
  await obj.alarm();
  assert.equal(calls.find((c) => /generateContent/i.test(c.url)).headers['x-goog-api-key'], MY_GEMINI, 'transcribed (streamed) on their key');
  assert.equal(obj.meta().ownKey, undefined, 'gone once the job is done');
  const done = await (await call(`/api/transcribe/jobs/${job}`, { headers: { 'X-Mullo-Own-Key': sealed } })).json();
  assert.deepEqual(done.result.segments.map((s) => s.text), ['Mine']);
  assert.equal(env.DB.raw.prepare('select count(*) n from usage').get().n, 0);
  assert.equal((await call(`/api/transcribe/jobs/${job}`, { headers: { 'X-Mullo-Own-Key': await sealedFor() } })).status, 404,
    'another sealing (another person) can\'t collect it');
});

// ── Own OpenAI and Claude keys (bridge/providers.mjs) ──
const MY_OPENAI = 'sk-proj-OwnOpenAI_1234567890abcdefWXYZ';
const MY_CLAUDE = 'sk-ant-api03-OwnClaude_1234567890abcdefQRST';
const processBody = () => JSON.stringify({ segments: [{ speaker: 'Speaker 1', text: 'Buy milk tomorrow', start_ms: 0, end_ms: 2000 }], template: 'general', today: '2026-10-09' });
const notesAnswer = JSON.stringify({
  title: 'Milk', sections: [{ title: 'Shopping', summary: 'Milk', start: null }],
  blocks: [{ heading: 'Summary', items: ['Buy milk'] }], actions: [{ label: 'Buy milk', type: 'create_reminder', priority: null, due_date: '2026-10-10', context: null }],
});

test('own key: OpenAI and Claude keys are told apart by shape, checked with their own company, sealed', async () => {
  for (const [key, provider, host] of [[MY_OPENAI, 'openai', 'api.openai.com'], [MY_CLAUDE, 'anthropic', 'api.anthropic.com']]) {
    calls = [];
    const res = await call('/api/own-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `7.7.7.${provider.length}` }, body: JSON.stringify({ provider: 'gemini', key }) });
    assert.equal(res.status, 200, provider);
    const body = await res.json();
    assert.equal(body.provider, provider, 'the key\'s shape wins over what an older app says');
    assert.equal(body.hint, key.slice(-4));
    const check = calls.find((c) => new URL(c.url).host === host);
    assert.ok(check, `checked with ${host}`);
    assert.doesNotMatch(check.url, /sk-/, 'the key goes in a header, never a URL');
  }
  const bad = await call('/api/own-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '7.7.7.9' }, body: JSON.stringify({ key: 'sk-ant-api03-BAD_1234567890abcdefghijk' }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Anthropic didn't accept/);
});

test('own key: Ask and summaries run on OpenAI (store off, strict schema) and Claude (structured output)', async () => {
  const openai = await sealedFor(MY_OPENAI);
  calls = [];
  const res = await ask(null, { 'X-Mullo-Own-Key': openai });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answer, 'From OpenAI.');
  const sent = calls.find((c) => c.url === 'https://api.openai.com/v1/responses');
  assert.equal(sent.headers.Authorization, `Bearer ${MY_OPENAI}`);
  const req = JSON.parse(sent.body);
  assert.equal(req.store, false, 'OpenAI keeps no stored response');
  assert.equal(req.text.format.strict, true);
  assert.match(req.instructions, /recorded conversations/, 'Mullo\'s own Ask prompt');
  assert.equal(calls.filter((c) => c.url.includes('googleapis')).length, 0, 'Gemini isn\'t called');

  const claude = await sealedFor(MY_CLAUDE);
  calls = [];
  otherText = notesAnswer;
  const res2 = await call('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mullo-Own-Key': claude }, body: processBody() });
  assert.equal(res2.status, 200);
  const notes = await res2.json();
  assert.equal(notes.title, 'Milk');
  assert.deepEqual(notes.actions.map((a) => [a.label, a.priority, a.due_date]), [['Buy milk', 'medium', '2026-10-10']], 'the same checks as Gemini\'s answers');
  const msg = calls.find((c) => c.url === 'https://api.anthropic.com/v1/messages');
  assert.equal(msg.headers['x-api-key'], MY_CLAUDE);
  const body = JSON.parse(msg.body);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(env.DB.raw.prepare('select count(*) n from usage').get().n, 0, 'nothing counted on their own keys');
});

test('own key: OpenAI transcribes with speaker labels, in order, times in ms', async () => {
  const sealed = await sealedFor(MY_OPENAI);
  calls = [];
  const res = await call('/api/transcribe', { method: 'POST', headers: { 'X-Mullo-Own-Key': sealed }, body: audioForm() });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.segments.map((s) => [s.speaker, s.text, s.start_ms]), [['Speaker 1', 'Hello', 500], ['Speaker 2', 'Hi there', 2100]]);
  const sent = calls.find((c) => c.url === 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(sent.body.get('response_format'), 'diarized_json');
  assert.equal(sent.body.get('language'), 'en');
  assert.match(sent.body.get('file').name, /\.m4a$/, 'the file name tells OpenAI the format');
  const translate = await call('/api/transcribe', { method: 'POST', headers: { 'X-Mullo-Own-Key': sealed }, body: audioForm({ lang: 'he', out: 'en', mime: 'audio/mp4', duration_ms: 5000 }) });
  assert.equal(translate.status, 400, 'OpenAI doesn\'t translate while transcribing');
});

test('own key: a Claude key can\'t transcribe; without a plan that\'s said plainly, with one the plan does it', async () => {
  const sealed = await sealedFor(MY_CLAUDE);
  calls = [];
  const res = await call('/api/transcribe', { method: 'POST', headers: { 'X-Mullo-Own-Key': sealed }, body: audioForm() });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Claude can't turn audio into text/);
  assert.equal(calls.filter((c) => /anthropic|googleapis/.test(c.url)).length, 0);

  const pro = await subscribe();
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'On the plan' }] });
  calls = [];
  const res2 = await call('/api/transcribe/jobs', { method: 'POST', headers: { Authorization: `Bearer ${pro}`, 'X-Mullo-Own-Key': sealed }, body: audioForm() });
  assert.equal(res2.status, 202);
  const { job } = await res2.json();
  const obj = env.TRANSCRIBE_JOBS.objects.get(job);
  assert.equal(obj.meta().ownKey, undefined, 'the Claude key doesn\'t ride along');
  await obj.alarm();
  assert.equal(calls.find((c) => /generateContent/i.test(c.url)).headers['x-goog-api-key'], 'test-gemini', 'Mullo\'s Gemini, on the plan');
  const done = await (await call(`/api/transcribe/jobs/${job}`, { headers: { Authorization: `Bearer ${pro}`, 'X-Mullo-Own-Key': sealed } })).json();
  assert.deepEqual(done.result.segments.map((s) => s.text), ['On the plan'], 'collected with the sign-in it was sent with');
});

// ── One cap per address (PER_IP) ──
// Like Workers' rate limiting binding: { success } per key, here `limit` per key in total.
function fakeLimiter(limit) {
  const seen = new Map();
  return { seen, async limit({ key }) { seen.set(key, (seen.get(key) ?? 0) + 1); return { success: seen.get(key) <= limit }; } };
}
const from = (ip, init = {}) => ({ ...init, headers: { ...init.headers, 'CF-Connecting-IP': ip } });

test('per address: IPv4 as is, IPv6 by its /64', () => {
  assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(addressKey('2001:DB8:AA:BB::99'), '2001:db8:aa:bb::/64', 'same /64, other address, other case');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey(null), null);
});

test('per address: past the cap a 429 with Retry-After, before any work; other addresses carry on', async () => {
  env.PER_IP = fakeLimiter(2);
  assert.equal((await call('/api/health', from('198.51.100.1'))).status, 200);
  assert.equal((await call('/api/health', from('198.51.100.1'))).status, 200);
  calls = [];
  const res = await call('/api/me', from('198.51.100.1', { headers: { Authorization: `Bearer ${await signInToken()}` } }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal((await res.json()).error, TOO_MANY);
  assert.equal(calls.length, 0, 'no sign-in check or other call once over');
  const page = await call('/privacy', from('198.51.100.1'));
  assert.equal(page.status, 429, 'pages too');
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.equal((await call('/api/health', from('198.51.100.2'))).status, 200, 'another address');
  assert.equal((await call('/api/health', from('2001:db8:1:2::5'))).status, 200);
  assert.equal((await call('/api/health', from('2001:db8:1:2::6'))).status, 200);
  assert.equal((await call('/api/health', from('2001:db8:1:2::7'))).status, 429, 'a new address in the same /64 is the same sender');
});

test('per address: connected apps and Stripe are not counted; a limiter fault never locks people out', async () => {
  env.PER_IP = fakeLimiter(0);
  for (const path of ['/mcp', '/v1/recordings', '/.well-known/oauth-protected-resource', '/oauth/consent', '/stripe/webhook']) {
    await call(path, from('192.0.2.7', { method: path === '/mcp' || path === '/stripe/webhook' ? 'POST' : 'GET', body: path === '/mcp' ? '{}' : path === '/stripe/webhook' ? '{}' : undefined }));
  }
  assert.equal(env.PER_IP.seen.size, 0, 'none of them counted');
  assert.equal((await call('/api/health', from('192.0.2.7'))).status, 429, 'the app\'s own routes are');
  env.PER_IP = { async limit() { throw new Error('limiter down'); } };
  assert.equal((await call('/api/health', from('192.0.2.7'))).status, 200);
  delete env.PER_IP;
  assert.equal((await call('/api/health', from('192.0.2.7'))).status, 200, 'no binding (the PC bridge, tests): no cap');
});

// ── Privacy Policy and Terms accepted (acceptance.mjs, S23) ─────────────
const acceptLegalCall = (token, body = {}) => call('/api/legal/accept', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});

test('legal: /api/me says the current version and the one accepted; accepting records it once', async () => {
  const token = await signInToken();
  const before = (await me(token)).legal;
  assert.equal(before.current, LEGAL_UPDATED);
  assert.equal(before.accepted, null, 'never accepted');
  assert.ok(before.changes.length > 10, 'a short "what changed" line');

  assert.equal((await acceptLegalCall()).status, 401, 'signed out');
  assert.equal((await acceptLegalCall(await subscribe())).status, 401, 'a Pro key is not the person');
  assert.equal((await acceptLegalCall(token, { version: 'January 1, 2020' })).status, 409, 'an older version shown: ask again');
  assert.equal(env.DB.raw.prepare('select count(*) n from legal_acceptances').get().n, 0);

  const res = await acceptLegalCall(token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).legal.accepted, LEGAL_UPDATED);
  assert.equal((await acceptLegalCall(token, { version: LEGAL_UPDATED })).status, 200, 'again: harmless');
  assert.equal(env.DB.raw.prepare('select count(*) n from legal_acceptances').get().n, 1, 'one row per account and version');
  assert.equal((await me(token)).legal.accepted, LEGAL_UPDATED);

  // A Pro key alone has no person behind it: no legal in its answer.
  assert.equal((await (await call('/api/me', { headers: { Authorization: `Bearer ${await subscribe()}` } })).json()).legal, undefined);
});

test('legal: with the gate on, AI waits until the current version is accepted; off, nothing changes', async () => {
  const key = await subscribe();
  const token = await signInToken();
  await link(token, key);
  assert.equal((await ask(token)).status, 200, 'gate off (apps from before S23): AI as before');

  env.LEGAL_GATE = 'on';
  const refused = await ask(token);
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.code, 'legal');
  assert.match(body.error, /accept/);
  assert.equal((await startJob(token)).status, 403, 'transcriptions wait too');
  assert.equal((await ask(key)).status, 200, 'a Pro key alone is S25\'s to close');

  await acceptLegalCall(token);
  assert.equal((await ask(token)).status, 200);
  // A change to the pages: an older acceptance no longer counts.
  env.DB.raw.prepare("update legal_acceptances set version = 'January 1, 2020'").run();
  assert.equal((await ask(token)).status, 403);
});

test('legal: deleting the account deletes its acceptance record', async () => {
  const token = await signInToken();
  await acceptLegalCall(token);
  assert.equal((await deleteAccount(token)).status, 200);
  assert.equal(env.DB.raw.prepare('select count(*) n from legal_acceptances').get().n, 0);
});

// ── A Mullo sign-in for anything through Mullo's server (S25) ───────────
const sealSignedIn = async (token, key = MY_GEMINI) => (await (await call('/api/own-key', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ key }),
})).json()).sealed;

test('sign-in gate: off, a key alone works as before (apps from before S25)', async () => {
  assert.equal((await ask(null, { 'X-Mullo-Own-Key': await sealedFor() })).status, 200);
  assert.equal((await ask(await subscribe())).status, 200);
});

test('sign-in gate: your own AI key needs a Mullo sign-in beside it, to add it and to use it', async () => {
  env.SIGNIN_GATE = 'on';
  const sealedRes = await seal(MY_GEMINI);
  assert.equal(sealedRes.status, 401);
  const sealedBody = await sealedRes.json();
  assert.equal(sealedBody.code, 'signin');
  assert.match(sealedBody.error, /Sign in to Mullo first/);
  assert.equal(calls.filter((c) => c.url.includes('/v1beta/models')).length, 0, 'not even checked with Google');

  const token = await signInToken();
  const sealed = await sealSignedIn(token);
  assert.match(sealed, /^mk1\./);

  calls = [];
  const alone = await ask(null, { 'X-Mullo-Own-Key': sealed });
  assert.equal(alone.status, 401);
  assert.equal((await alone.json()).code, 'signin');
  assert.equal((await ask(await subscribe(), { 'X-Mullo-Own-Key': sealed })).status, 401, 'a Pro key is not a sign-in');
  assert.equal(calls.filter((c) => /generateContent/i.test(c.url)).length, 0);

  const res = await ask(token, { 'X-Mullo-Own-Key': sealed });
  assert.equal(res.status, 200);
  assert.equal(calls.find((c) => /generateContent/i.test(c.url)).headers['x-goog-api-key'], MY_GEMINI, 'their key still pays');
  assert.equal(env.DB.raw.prepare('select count(*) n from usage').get().n, 0, 'nothing counted');
});

test('sign-in gate: with your own key, the sign-in must have accepted the current Privacy Policy and Terms', async () => {
  env.SIGNIN_GATE = 'on';
  const token = await signInToken();
  const sealed = await sealSignedIn(token);
  env.LEGAL_GATE = 'on';
  const refused = await ask(token, { 'X-Mullo-Own-Key': sealed });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'legal');
  assert.equal((await seal(MY_GEMINI)).status, 401, 'adding a key waits too');
  await acceptLegalCall(token);
  assert.equal((await ask(token, { 'X-Mullo-Own-Key': sealed })).status, 200);
});

test('sign-in gate: a long recording on your own key is sent and collected with the sign-in', async () => {
  env.SIGNIN_GATE = 'on';
  const token = await signInToken();
  const sealed = await sealSignedIn(token);
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Mine' }] });
  assert.equal((await call('/api/transcribe/jobs', { method: 'POST', headers: { 'X-Mullo-Own-Key': sealed }, body: audioForm() })).status, 401);
  const res = await call('/api/transcribe/jobs', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Mullo-Own-Key': sealed }, body: audioForm() });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  await env.TRANSCRIBE_JOBS.objects.get(job).alarm();
  assert.equal((await call(`/api/transcribe/jobs/${job}`, { headers: { 'X-Mullo-Own-Key': sealed } })).status, 401, 'the key alone can\'t collect it');
  const done = await (await call(`/api/transcribe/jobs/${job}`, { headers: { Authorization: `Bearer ${token}`, 'X-Mullo-Own-Key': sealed } })).json();
  assert.deepEqual(done.result.segments.map((s) => s.text), ['Mine']);
});

test('own AI key: works only for the Mullo account that added it (a stolen copy is refused)', async () => {
  env.SIGNIN_GATE = 'on';
  const mine = await signInToken();
  const thief = await signInToken({ sub: 'cccccccc-1111-2222-3333-444444444444' });
  const sealed = await sealSignedIn(mine);
  calls = [];
  const refused = await ask(thief, { 'X-Mullo-Own-Key': sealed });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /another Mullo account/);
  assert.equal(calls.filter((c) => /generateContent/i.test(c.url)).length, 0, 'the key never reached Google');
  assert.equal((await call('/api/transcribe/jobs', { method: 'POST', headers: { Authorization: `Bearer ${thief}`, 'X-Mullo-Own-Key': sealed }, body: audioForm() })).status, 403);
  assert.equal((await ask(mine, { 'X-Mullo-Own-Key': sealed })).status, 200, 'still works for its owner, on any device');
});

test('own AI key sealed before keys carried their account: the first account to use it claims it', async () => {
  const old = await sealedFor(); // sealed with no sign-in, like a key added before 2026-10-17
  env.SIGNIN_GATE = 'on';
  const mine = await signInToken();
  const thief = await signInToken({ sub: 'cccccccc-1111-2222-3333-444444444444' });
  assert.equal((await ask(mine, { 'X-Mullo-Own-Key': old })).status, 200, 'no need to add it again');
  assert.equal((await ask(mine, { 'X-Mullo-Own-Key': old })).status, 200);
  assert.equal((await ask(thief, { 'X-Mullo-Own-Key': old })).status, 403);
  const rows = env.DB.raw.prepare('select * from own_key_claims').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(MY_GEMINI), 'only a fingerprint, never the key');
  assert.equal((await deleteAccount(mine)).status, 200);
  assert.equal(env.DB.raw.prepare('select count(*) n from own_key_claims').get().n, 0, 'deleted with the account');
});

test('sign-in gate: a Mullo Pro key alone is refused everywhere; the sign-in it is linked to works', async () => {
  const key = await subscribe();
  env.SIGNIN_GATE = 'on';
  const alone = await ask(key);
  assert.equal(alone.status, 401);
  const body = await alone.json();
  assert.equal(body.code, 'signin');
  assert.match(body.error, /Mullo Pro key/);
  assert.equal((await startJob(key)).status, 401);
  assert.equal((await call('/api/me', { headers: { Authorization: `Bearer ${key}` } })).status, 401);
  assert.equal((await call('/api/ask', { method: 'POST', headers: { Authorization: 'Bearer echo_made_up' }, body: '{}' })).status, 401);

  const token = await signInToken();
  assert.equal((await link(token, key)).status, 200, 'linking still takes the key, with the sign-in');
  assert.equal((await ask(token)).status, 200, 'the sign-in reaches the subscription');
  assert.equal((await me(token)).plan, 'pro');
});

// ── Mullo Pro bought in the iPhone app (S22c, appstore.mjs) ──────────────
async function appleOn() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  Object.assign(env, { APPLE_CLIENT_ID: 'app.mullo', APPLE_PRODUCT_ID: 'app.mullo.pro.monthly', APPSTORE_KEY_ID: 'IAPKEY1234', APPSTORE_ISSUER_ID: 'issuer-uuid',
    APPSTORE_KEY: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n` });
  return pair;
}
const claim = (token, body) => call('/api/billing/apple', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const meOf = async (token) => (await call('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();

test('Apple purchase: checked with Apple, stored like a Stripe one, linked; /api/me says Pro from the App Store', async () => {
  const pair = await appleOn();
  const token = await signInToken();
  const res = await claim(token, { transaction_id: '2000000111' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'active');
  const row = env.DB.raw.prepare("select * from accounts where subscription_id = 'apple:2000000100'").get();
  assert.equal(row.customer_id, 'apple');
  assert.equal(row.status, 'active');
  assert.equal(env.DB.raw.prepare('select subscription_id from account_users where user_id = ?').get('aaaaaaaa-1111-2222-3333-444444444444').subscription_id, 'apple:2000000100');
  const me = await meOf(token);
  assert.deepEqual([me.plan, me.store, me.active], ['pro', 'apple', true]);
  // Apple's API was called with a JWT signed by the In-App Purchase key, for this app.
  const asked = calls.find((c) => c.url.includes('api.storekit.itunes.apple.com'));
  const [h, b, sig] = asked.headers.Authorization.replace('Bearer ', '').split('.');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${h}.${b}`)));
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.deepEqual([claims.iss, claims.aud, claims.bid], ['issuer-uuid', 'appstoreconnect-v1', 'app.mullo']);
  // Stripe's billing page doesn't open for it.
  const portal = await call('/api/billing/portal', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(portal.status, 409);
  assert.equal((await portal.json()).code, 'apple');
});

test('Apple purchase: bought for another account, another product, or a made-up id is refused; off until set up', async () => {
  const token = await signInToken();
  assert.equal((await claim(token, { transaction_id: '2000000111' })).status, 503, 'not set up yet');
  await appleOn();
  appleStore.tx.appAccountToken = 'bbbbbbbb-1111-2222-3333-444444444444';
  const other = await claim(token, { transaction_id: '2000000111' });
  assert.equal(other.status, 403);
  assert.equal((await other.json()).code, 'apple_other_account');
  appleStore.tx.appAccountToken = 'aaaaaaaa-1111-2222-3333-444444444444';
  appleStore.tx.productId = 'com.someone.else';
  assert.equal((await claim(token, { transaction_id: '2000000111' })).status, 403);
  assert.equal((await claim(token, { transaction_id: '../../etc' })).status, 400);
  assert.equal(env.DB.raw.prepare("select count(*) n from accounts where customer_id = 'apple'").get().n, 0);
});

test('Apple purchase: a TestFlight (sandbox) purchase is found in the sandbox', async () => {
  await appleOn();
  appleStore.env = 'Sandbox';
  assert.equal((await claim(await signInToken(), { transaction_id: '2000000111' })).status, 200);
  // Before the app is on sale, production answers 401: still found in the sandbox.
  appleStore.prod401 = true;
  assert.equal((await claim(await signInToken(), { transaction_id: '2000000111' })).status, 200);
});

test('Apple notifications: only a nudge, the state comes from Apple; a purchase before the app claimed it is linked', async () => {
  await appleOn();
  const fakeJws = (o) => `h.${Buffer.from(JSON.stringify(o)).toString('base64url')}.s`;
  const notify = (type) => call('/apple/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedPayload: fakeJws({ notificationType: type, data: { bundleId: 'app.mullo', signedTransactionInfo: fakeJws(appleStore.tx) } }) }) });
  assert.equal((await notify('SUBSCRIBED')).status, 200);
  const token = await signInToken();
  assert.deepEqual([(await meOf(token)).plan, (await meOf(token)).active], ['pro', true], 'linked by the appAccountToken it was bought for');
  appleStore.status = 2; // Apple now says expired, whatever the notification claims
  await notify('DID_RENEW');
  assert.equal(env.DB.raw.prepare("select status from accounts where subscription_id = 'apple:2000000100'").get().status, 'canceled');
  assert.equal((await meOf(token)).active, false);
  // Something that isn't Mullo's: ignored with a 200 so Apple doesn't retry it.
  const odd = await call('/apple/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedPayload: 'nope' }) });
  assert.equal(odd.status, 200);
});

test('Apple purchase whose account was deleted (still billed by Apple): a new account can restore it; renewals don\'t link it back', async () => {
  await appleOn();
  const old = await signInToken();
  assert.equal((await claim(old, { transaction_id: '2000000111' })).status, 200);
  assert.equal((await deleteAccount(old)).status, 200);
  const fresh = await signInToken({ sub: 'dddddddd-1111-2222-3333-444444444444' });
  const fakeJws = (o) => `h.${Buffer.from(JSON.stringify(o)).toString('base64url')}.s`;
  // Apple renews it before the person restores: it must not go back onto the deleted account.
  await call('/apple/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedPayload: fakeJws({ notificationType: 'DID_RENEW', data: { bundleId: 'app.mullo', signedTransactionInfo: fakeJws(appleStore.tx) } }) }) });
  assert.equal(env.DB.raw.prepare("select count(*) n from account_users where subscription_id = 'apple:2000000100'").get().n, 0);
  const res = await claim(fresh, { transaction_id: '2000000111' }); // bought for the old account's id
  assert.equal(res.status, 200, 'Restore Purchases on the new account takes it over');
  assert.deepEqual([(await meOf(fresh)).plan, (await meOf(fresh)).active], ['pro', true]);
  assert.equal(env.DB.raw.prepare('select count(*) n from released_subscriptions').get().n, 0, 'taken: no longer up for grabs');
  const third = await signInToken({ sub: 'eeeeeeee-1111-2222-3333-444444444444' });
  assert.equal((await claim(third, { transaction_id: '2000000111' })).status, 403, 'a live account\'s purchase stays refused');
});

test('delete account with an App Store subscription: nothing is sent to Stripe (Apple can only be cancelled by the person)', async () => {
  await appleOn();
  const token = await signInToken();
  await claim(token, { transaction_id: '2000000111' });
  const res = await call('/api/account/delete', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await res.json(), { deleted: true, cancelled: false });
  assert.ok(!calls.some((c) => c.url.includes('api.stripe.com')), 'no Stripe call');
});

// ── Summary models (S54, models.mjs) ────────────────────────────────────
const geminiModelOf = (c) => /\/models\/([^:]+):generateContent/.exec(c.url)?.[1];
const processAs = (token, extra = {}) => call('/api/process', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ ...JSON.parse(processBody()), ...extra }) });
async function proToken() {
  const token = await signInToken();
  assert.equal((await link(token, await subscribe())).status, 200);
  return token;
}

test('summary model: Pro gets its pick from the Pro list; a Max model or a made-up id falls back to the default', async () => {
  const token = await proToken();
  geminiText = JSON.stringify({ title: 'T', sections: [], blocks: [], actions: [] });
  assert.equal((await processAs(token)).status, 200);
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-3.1-flash-lite', 'no pick: the default');
  await processAs(token, { model: 'gemini-3.5-flash-lite' });
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-3.5-flash-lite');
  await processAs(token, { model: 'gemini-3.8-flash' });
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-3.1-flash-lite', 'Max model on Pro');
  await processAs(token, { model: 'gemini-4-argon' });
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-3.1-flash-lite', 'a model no longer listed (dropped 2026-10-17)');
  env.DB.raw.prepare("insert into model_picks values ('aaaaaaaa-1111-2222-3333-444444444444', 'gemini-3.5-flash-lite', 0)").run();
  await processAs(token);
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-3.5-flash-lite', 'the stored pick, also for watch notes made with Mullo closed');
  geminiText = null;
  await ask(token);
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-3.5-flash-lite', 'Ask too');
});

test('summary model: transcription never follows the pick', async () => {
  const token = await proToken();
  env.DB.raw.prepare("insert into model_picks values ('aaaaaaaa-1111-2222-3333-444444444444', 'gemini-3.5-flash-lite', 0)").run();
  geminiText = JSON.stringify({ segments: [{ speaker: 'Speaker 1', start: '0:01', text: 'Hello' }] });
  calls = [];
  assert.equal((await call('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: audioForm() })).status, 200);
  const google = calls.filter((c) => c.url.includes('generativelanguage'));
  assert.ok(google.length);
  assert.ok(google.every((c) => !c.url.includes('3.5-flash-lite')));
});

test('summary model: a pick that fails at Google (400) is tried once more on the default', async () => {
  const token = await proToken();
  geminiText = JSON.stringify({ title: 'T', sections: [], blocks: [], actions: [] });
  geminiRefuse = 'gemini-3.5-flash-lite';
  calls = [];
  const res = await processAs(token, { model: 'gemini-3.5-flash-lite' });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.filter((c) => geminiModelOf(c)).map(geminiModelOf), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
});

test('summary model: thinking follows the model; delete account drops the pick', async () => {
  const token = await proToken();
  assert.equal((await admin('models', { models: [
    { id: 'gemini-3.1-flash-lite', tier: 'standard', isDefault: true },
    { id: 'gemini-x-think', tier: 'standard', thinking: 'low' },
  ] }, await adminToken())).status, 200);
  geminiText = JSON.stringify({ title: 'T', sections: [], blocks: [], actions: [] });
  await processAs(token, { model: 'gemini-x-think' });
  assert.deepEqual(JSON.parse(calls.at(-1).body).generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  env.DB.raw.prepare("insert into model_picks values ('aaaaaaaa-1111-2222-3333-444444444444', 'gemini-x-think', 0)").run();
  assert.equal((await deleteAccount(token)).status, 200);
  assert.equal(env.DB.raw.prepare('select count(*) n from model_picks').get().n, 0);
});

test('models route: a signed-in person sees the list for their plan and saves a pick', async () => {
  const token = await proToken();
  const get = async () => (await call('/api/models', { headers: { Authorization: `Bearer ${token}` } })).json();
  const first = await get();
  assert.deepEqual(first.models.map((m) => [m.id, m.allowed]),
    [['gemini-3.1-flash-lite', true], ['gemini-3.5-flash-lite', true], ['gemini-3.8-flash', false]]);
  assert.deepEqual([first.pick, first.using], [null, 'gemini-3.1-flash-lite']);
  const saved = await (await call('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pick: 'gemini-3.5-flash-lite' }) })).json();
  assert.deepEqual([saved.pick, saved.using], ['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite']);
  const off = await call('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ pick: 'gemini-4-argon' }) });
  assert.equal(off.status, 400);
  assert.equal((await call('/api/models')).status, 401, 'signed out');
});

test('admin models: only admins; the list is checked, saved and logged; Test runs a tiny summary', async () => {
  const t = await signInToken();
  assert.equal((await admin('models', undefined, t)).status, 403);
  const a = await adminToken();
  assert.equal((await (await admin('models', undefined, a)).json()).models.length, 3);
  assert.equal((await admin('models', { models: [{ id: 'nope' }] }, a)).status, 400);
  const list = [
    { id: 'gemini-3.1-flash-lite', label: 'Lite', tier: 'standard', isDefault: true },
    { id: 'gemini-3.8-flash', label: 'Flash', tier: 'standard', badge: 'new' },
  ];
  const saved = await (await admin('models', { models: list }, a)).json();
  assert.deepEqual(saved.models.map((m) => [m.id, m.tier, m.badge]), [['gemini-3.1-flash-lite', 'standard', 'none'], ['gemini-3.8-flash', 'standard', 'new']]);
  assert.match(env.DB.raw.prepare("select detail from admin_log where action = 'models'").get().detail, /gemini-3.8-flash=standard/);
  geminiText = JSON.stringify({ title: 'Milk', sections: [], blocks: [], actions: [{ label: 'Buy milk', type: 'create_reminder' }] });
  const ok = await (await admin('models/test', { id: 'gemini-4-argon', thinking: 'low' }, a)).json();
  assert.deepEqual([ok.ok, ok.title, ok.actions], [true, 'Milk', 1]);
  assert.equal(geminiModelOf(calls.at(-1)), 'gemini-4-argon');
  geminiRefuse = 'gemini-4-argon';
  const no = await (await admin('models/test', { id: 'gemini-4-argon', thinking: 'none' }, a)).json();
  assert.equal(no.ok, false);
  assert.match(no.error, /Gemini 400/);
  assert.deepEqual(no.tried.map((t) => [t.thinking, t.ok]), [['none', false], ['minimal', false], ['low', false]], 'every setting tried');
});

test('admin models Test: a model that refuses thinking off says which setting works; saved, summaries use it', async () => {
  const a = await adminToken();
  geminiNoBudget = 'gemini-3.5-flash-lite';
  geminiText = JSON.stringify({ title: 'Milk', sections: [], blocks: [], actions: [] });
  const r = await (await admin('models/test', { id: 'gemini-3.5-flash-lite', thinking: 'none' }, a)).json();
  assert.equal(r.ok, true, 'it works with another setting');
  assert.equal(r.thinking, 'minimal', 'the first setting that worked');
  assert.deepEqual(r.tried.map((t) => [t.thinking, t.ok]), [['none', false], ['minimal', true]], 'stops at the first that works');
  assert.match(r.tried[0].error, /invalid argument/);
  const minimalOnly = await (await admin('models/test', { id: 'gemini-3.5-flash-lite', thinking: 'minimal' }, a)).json();
  assert.deepEqual(minimalOnly.tried.map((t) => [t.thinking, t.ok]), [['minimal', true]], 'a working setting is tried alone');

  const list = (await (await admin('models', undefined, a)).json()).models.map((m) => (m.id === 'gemini-3.5-flash-lite' ? { ...m, thinking: 'minimal' } : m));
  assert.equal((await admin('models', { models: list }, a)).status, 200);
  const token = await proToken();
  calls = [];
  assert.equal((await processAs(token, { model: 'gemini-3.5-flash-lite' })).status, 200);
  const sent = calls.filter((c) => geminiModelOf(c));
  assert.deepEqual(sent.map(geminiModelOf), ['gemini-3.5-flash-lite'], 'no fallback needed');
  assert.deepEqual(JSON.parse(sent[0].body).generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
});

// ── Report a problem (S56, reports.mjs) ─────────────────────────────────
const report = (token, body) => call('/api/reports', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

test('reports: signed in only, never a connected app; sizes checked; five an hour', async () => {
  assert.equal((await report(null, { text: 'x' })).status, 401);
  const app = await signInToken({ extra: { client_id: 'claude' } });
  assert.equal((await report(app, { text: 'x' })).status, 403, 'a connected app can\'t send one');
  const me = await signInToken();
  assert.equal((await report(me, { text: '   ' })).status, 400);
  assert.equal((await report(me, { text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await report(me, { text: 'x', details: { blob: 'y'.repeat(9000) } })).status, 400);
  assert.equal((await report(me, { text: 'x', screenshot: Buffer.from('PNG...').toString('base64') })).status, 400, 'not a JPEG');
  assert.equal((await report(me, { text: 'x', screenshot: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(400 * 1024)]).toString('base64') })).status, 400, 'too big');
  for (let i = 0; i < 5; i++) assert.equal((await report(me, { text: `Problem ${i}`, details: { version: '94' }, screenshot: i === 0 ? JPEG : undefined })).status, 200);
  assert.equal((await report(me, { text: 'sixth' })).status, 429);
  assert.equal((await report(await person(2, 'two@example.com'), { text: 'someone else' })).status, 200, 'the limit is per account');
});

test('reports: admins list, see the screenshot, close and reopen (logged); others get 403', async () => {
  const me = await signInToken();
  await report(me, { text: 'The record button froze', details: { version: '94', screen: 'record' }, screenshot: JPEG });
  assert.equal((await admin('reports', undefined, me)).status, 403);
  const token = await adminToken();
  const list = await (await admin('reports', undefined, token)).json();
  assert.equal(list.open, 1);
  const [r] = list.reports;
  assert.equal(r.text, 'The record button froze');
  assert.equal(r.email, 'me@example.com');
  assert.deepEqual(r.details, { version: '94', screen: 'record' });
  assert.equal(r.has_screenshot, true);
  assert.equal(r.screenshot, undefined, 'the list never carries the image');
  assert.equal((await (await admin(`reports/${r.id}/screenshot`, undefined, token)).json()).screenshot, `data:image/jpeg;base64,${JPEG}`);
  assert.equal((await admin(`reports/${r.id}`, { status: 'closed' }, me)).status, 403);
  assert.equal((await admin(`reports/${r.id}`, { status: 'closed' }, token)).status, 200);
  assert.equal((await (await admin('reports', undefined, token)).json()).open, 0);
  assert.equal((await (await admin('reports?status=closed', undefined, token)).json()).reports.length, 1);
  assert.equal((await admin(`reports/${r.id}`, { status: 'gone' }, token)).status, 400);
  assert.equal((await admin('reports/nosuchid1/screenshot', undefined, token)).status, 404);
  const log = env.DB.raw.prepare("select action, detail from admin_log where action like 'report-%'").all();
  assert.deepEqual(log.map((l) => [l.action, l.detail]), [['report-closed', r.id]]);
});

test('reports: closed 91 days ago is swept on the next send; open ones stay; Delete account removes them', async () => {
  const me = await signInToken();
  await report(me, { text: 'old one' });
  await report(me, { text: 'still open' });
  const day = 86400;
  const t = Math.floor(Date.now() / 1000);
  env.DB.raw.prepare("update reports set status = 'closed', closed_at = ?, created_at = ? where text = 'old one'").run(t - 91 * day, t - 100 * day);
  env.DB.raw.prepare("update reports set created_at = ? where text = 'still open'").run(t - 200 * day);
  await report(await person(3, 'three@example.com'), { text: 'trigger' });
  assert.deepEqual(env.DB.raw.prepare('select text from reports order by text').all().map((r) => r.text), ['still open', 'trigger']);
  assert.equal((await deleteAccount(me)).status, 200);
  assert.deepEqual(env.DB.raw.prepare('select text from reports').all().map((r) => r.text), ['trigger']);
});
