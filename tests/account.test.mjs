import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccount } from '../app/core/account.js';

const URL_ = 'https://project.example';
const KEY = 'public-key';

function memoryStore(initial = null) {
  let value = initial;
  return { load: () => value, save: (v) => { value = v; }, clear: () => { value = null; }, peek: () => value };
}

// A fake Supabase Auth: records every call, answers from `routes`.
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.slice(`${URL_}/auth/v1/`.length);
    const body = JSON.parse(init.body);
    calls.push({ path, body, headers: init.headers });
    const route = routes[path.split('?')[0]] ?? routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    const [status, data] = await route(body, init);
    return { ok: status < 300, status, json: async () => data };
  };
  return { fetch, calls };
}

const tokens = (n, { expiresIn = 3600, now = 1_000_000 } = {}) => ({
  access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresIn,
  expires_at: Math.floor(now / 1000) + expiresIn, user: { id: 'user-1', email: 'me@example.com' },
});

test('signed out when the server is not configured: nothing is sent anywhere', async () => {
  const acct = createAccount({ url: null, key: null, store: memoryStore(), fetch: () => assert.fail('no network') });
  assert.equal(acct.on, false);
  assert.equal(acct.user(), null);
  assert.equal(await acct.accessToken(), null);
});

test('email code: send, verify, then the session is kept and the token used', async () => {
  const store = memoryStore();
  const server = fakeServer({
    otp: async () => [200, {}],
    verify: async (b) => (b.token === '123456' ? [200, tokens(1)] : [403, { msg: 'Token has expired or is invalid' }]),
  });
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => 1_000_000 });

  const email = await acct.sendCode('  Me@Example.com ');
  assert.equal(email, 'me@example.com');
  assert.deepEqual(server.calls[0].body, { email: 'me@example.com', create_user: true });
  assert.equal(server.calls[0].headers.apikey, KEY);
  assert.equal(server.calls[0].headers.Authorization, undefined, 'no token before sign-in');

  await assert.rejects(acct.verifyCode(email, '000000'), /wrong or has expired/);
  assert.equal(acct.user(), null);

  const user = await acct.verifyCode(email, '123 456');
  assert.deepEqual(user, { id: 'user-1', email: 'me@example.com' });
  assert.deepEqual(server.calls.at(-1).body, { type: 'email', email: 'me@example.com', token: '123456' });
  assert.equal(store.peek().refresh_token, 'refresh-1');
  assert.equal(await acct.accessToken(), 'access-1');
});

test('bad input never reaches the server', async () => {
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: () => assert.fail('no network') });
  await assert.rejects(acct.sendCode('not an email'), /email address/);
  await assert.rejects(acct.verifyCode('me@example.com', '12ab'), /digits in the email/);
});

test('rate limits and offline come back as plain words', async () => {
  const limited = fakeServer({ otp: async () => [429, { msg: 'For security purposes, you can only request this after 42 seconds.' }] });
  const a = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: limited.fetch });
  await assert.rejects(a.sendCode('me@example.com'), /Wait 42 seconds/);

  const b = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(b.sendCode('me@example.com'), (err) => err.offline && /No connection/.test(err.message));
});

test('an expiring token is refreshed once, even when asked for twice at the same time', async () => {
  let now = 1_000_000;
  const store = memoryStore(tokens(1, { expiresIn: 30, now }));
  let refreshes = 0;
  const server = fakeServer({
    token: async (b) => { refreshes += 1; assert.equal(b.refresh_token, 'refresh-1'); return [200, tokens(2, { now })]; },
  });
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => now });
  const [x, y] = await Promise.all([acct.accessToken(), acct.accessToken()]);
  assert.equal(x, 'access-2');
  assert.equal(y, 'access-2');
  assert.equal(refreshes, 1, 'refresh tokens rotate: a second refresh would sign the person out');
  assert.equal(store.peek().refresh_token, 'refresh-2');
});

test('a session the phone\'s background side refreshed meanwhile is taken, not refreshed again', async () => {
  // Watch notes with Mullo closed (S12): the Android side refreshes the session itself and
  // saves it in the same sealed store. The app still holds the old one in memory.
  let now = 1_000_000;
  const store = memoryStore(tokens(1, { expiresIn: 30, now }));
  let refreshes = 0;
  const server = fakeServer({ token: async () => { refreshes += 1; return [400, { msg: 'Invalid Refresh Token: Already Used' }]; } });
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => now });
  store.save(tokens(2, { now })); // the background job's refresh
  assert.equal(await acct.accessToken(), 'access-2');
  assert.equal(refreshes, 0, 'the used refresh token is never sent again');
  assert.ok(acct.user());
});

test('a refresh refused because the phone\'s background side already used it: the newer session wins, still signed in', async () => {
  const now = 1_000_000;
  const store = memoryStore(tokens(1, { expiresIn: 30, now }));
  const server = fakeServer({
    token: async () => { store.save(tokens(2, { now })); return [400, { msg: 'Invalid Refresh Token: Already Used' }]; },
  });
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => now });
  assert.equal(await acct.accessToken(), 'access-2');
  assert.ok(acct.user(), 'still signed in');
  assert.equal(store.peek().refresh_token, 'refresh-2');
});

test('offline is not signed out; a rejected session is', async () => {
  const now = 1_000_000;
  // Still valid for 30 s: offline keeps using it.
  const store = memoryStore(tokens(1, { expiresIn: 30, now }));
  const offline = createAccount({ url: URL_, key: KEY, store, fetch: async () => { throw new TypeError('offline'); }, now: () => now });
  assert.equal(await offline.accessToken(), 'access-1');
  assert.ok(offline.user(), 'still signed in');

  // Expired and offline: no token right now, but still signed in.
  const late = createAccount({ url: URL_, key: KEY, store, fetch: async () => { throw new TypeError('offline'); }, now: () => now + 60_000 });
  assert.equal(await late.accessToken(), null);
  assert.ok(late.user());

  // The server says the session is gone: signed out, and the device forgets it.
  const server = fakeServer({ token: async () => [400, { msg: 'Invalid Refresh Token: Refresh Token Not Found' }] });
  const revoked = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => now + 60_000 });
  assert.equal(await revoked.accessToken(), null);
  assert.equal(revoked.user(), null);
  assert.equal(store.peek(), null);
});

test('Continue with Google: the ID token and the raw nonce go to the server; the provider got its SHA-256', async () => {
  const { signInNonce } = await import('../app/core/account.js');
  const nonce = await signInNonce();
  assert.match(nonce.raw, /^[0-9a-f]{64}$/);
  assert.match(nonce.hashed, /^[0-9a-f]{64}$/);
  const { createHash } = await import('node:crypto');
  assert.equal(nonce.hashed, createHash('sha256').update(nonce.raw).digest('hex'));
  assert.notEqual((await signInNonce()).raw, nonce.raw, 'never the same twice');

  const store = memoryStore();
  const server = fakeServer({ token: async (b) => [200, { ...tokens(7), user: { id: 'user-1', email: 'me@example.com' } }] });
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => 1_000_000 });
  const user = await acct.signInWithIdToken('google', 'google-id-token', nonce.raw);
  assert.equal(user.email, 'me@example.com');
  assert.equal(server.calls[0].path, 'token?grant_type=id_token');
  assert.deepEqual(server.calls[0].body, { provider: 'google', id_token: 'google-id-token', nonce: nonce.raw });
  assert.equal(store.peek().refresh_token, 'refresh-7');
});

test('the native Google sheet: an answer resolves the one waiting request; a cancel is quiet', async () => {
  const { googleIdToken, googleAnswer, googleSignInAvailable } = await import('../app/core/native.js');
  const asked = [];
  globalThis.MulloGoogle = { available: () => true, signIn: (n) => asked.push(n) };
  try {
    assert.equal(googleSignInAvailable(), true);
    const first = googleIdToken('a'.repeat(64));
    googleAnswer(JSON.stringify({ idToken: 'tok' }));
    assert.equal(await first, 'tok');
    assert.deepEqual(asked, ['a'.repeat(64)]);

    const second = googleIdToken('b'.repeat(64));
    googleAnswer(JSON.stringify({ error: 'Cancelled', cancelled: true }));
    await assert.rejects(second, (err) => err.cancelled === true);

    googleAnswer(JSON.stringify({ idToken: 'stray' })); // nobody waiting: ignored
  } finally {
    delete globalThis.MulloGoogle;
  }
  assert.equal(googleSignInAvailable(), false, 'not in the Android app: no Google button');
});

test('Mullo Pro link: the sign-in and the key go together once; remembered for this account only', async () => {
  const { disk } = await import('../app/core/disk.js');
  disk.remove('echo:pro-link');
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ linked: true, active: true }) };
  };
  const store = memoryStore(tokens(1));
  const acct = createAccount({ url: URL_, key: KEY, store, fetch, now: () => 1_000_000 });
  assert.equal(acct.proLinked(), false);
  assert.equal(await acct.linkPro('https://pro.example', 'echo_abc'), true);
  assert.deepEqual(sent, [{ url: 'https://pro.example/api/link', auth: 'Bearer access-1', body: { key: 'echo_abc' } }]);
  assert.equal(acct.proLinked(), true);

  // Someone else signs in on this phone: not linked for them.
  const other = createAccount({ url: URL_, key: KEY, store: memoryStore({ ...tokens(2), user: { id: 'user-2', email: 'b@x' } }), fetch, now: () => 1_000_000 });
  assert.equal(other.proLinked(), false);
  disk.remove('echo:pro-link');
});

test('the AI engine asks for the credential before every call (a sign-in refreshes hourly)', async () => {
  const { createRemoteEngine } = await import('../app/domain/engines/remote.js');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(init.headers.Authorization ?? null); return { ok: true, status: 200, json: async () => ({ answer: 'x', found: false, sources: [] }) }; };
  try {
    let n = 0;
    const engine = createRemoteEngine({ bridgeUrl: 'https://pro.example', authKey: async () => `token-${n += 1}` });
    await engine.chat({ messages: [{ role: 'user', text: 'q' }] });
    await engine.chat({ messages: [{ role: 'user', text: 'q' }] });
    assert.deepEqual(seen, ['Bearer token-1', 'Bearer token-2']);
    const keyed = createRemoteEngine({ bridgeUrl: 'https://pro.example', authKey: 'echo_fixed' });
    await keyed.chat({ messages: [{ role: 'user', text: 'q' }] });
    assert.equal(seen.at(-1), 'Bearer echo_fixed');
    const none = createRemoteEngine({ bridgeUrl: '', authKey: null });
    await none.chat({ messages: [{ role: 'user', text: 'q' }] });
    assert.equal(seen.at(-1), null, 'no key: no Authorization at all');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('own AI key: every call carries the SEALED key, next to the sign-in or alone', async () => {
  const { createRemoteEngine } = await import('../app/domain/engines/remote.js');
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(init.headers); return { ok: true, status: 200, json: async () => ({ answer: 'x', found: false, sources: [] }) }; };
  try {
    await createRemoteEngine({ bridgeUrl: 'https://pro.example', authKey: async () => 'tok', ownKey: 'mk1.sealed.text' }).chat({ messages: [{ role: 'user', text: 'q' }] });
    assert.equal(seen.at(-1).Authorization, 'Bearer tok');
    assert.equal(seen.at(-1)['X-Mullo-Own-Key'], 'mk1.sealed.text');
    await createRemoteEngine({ bridgeUrl: 'https://pro.example', authKey: null, ownKey: 'mk1.sealed.text' }).chat({ messages: [{ role: 'user', text: 'q' }] });
    assert.equal(seen.at(-1).Authorization, undefined, 'no sign-in needed with your own key');
    await createRemoteEngine({ bridgeUrl: 'https://pro.example', authKey: 'k' }).chat({ messages: [{ role: 'user', text: 'q' }] });
    assert.equal(seen.at(-1)['X-Mullo-Own-Key'], undefined, 'nothing when there is no own key');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('own AI key: a browser keeps the sealed text; the Android app hands it to the Keystore', async () => {
  const { ownAi, keepOwnAi, dropOwnAi } = await import('../app/core/own-ai.js');
  dropOwnAi();
  assert.equal(ownAi({}), null);
  assert.match(keepOwnAi({ sealed: 'AIzaPlainKey', hint: 'abcd' }), /unexpected/, 'only a sealed key is ever kept');
  assert.equal(keepOwnAi({ sealed: 'mk1.iv-part.cipher-text', provider: 'gemini', hint: 'abcd' }), null);
  assert.deepEqual(ownAi({}), { sealed: 'mk1.iv-part.cipher-text', provider: 'gemini', hint: 'abcd' });
  dropOwnAi();
  assert.equal(ownAi({}), null);

  const saved = [];
  globalThis.MulloNative = { setProKey() {}, setOwnKey: (s) => { saved.push(s); return 'ok'; }, clearOwnKey: () => saved.push('cleared') };
  try {
    assert.equal(keepOwnAi({ sealed: 'mk1.iv-part.cipher-text', hint: 'wxyz' }), null);
    assert.deepEqual(saved, ['mk1.iv-part.cipher-text']);
    const { disk } = await import('../app/core/disk.js');
    assert.equal(disk.get('echo:own-ai').sealed, undefined, 'not in site storage in the app');
    assert.equal(ownAi({ aiOwnKey: null }), null, 'the app reads it back only from config.json');
    assert.equal(ownAi({ aiOwnKey: 'mk1.iv-part.cipher-text' }).hint, 'wxyz');
    dropOwnAi();
    assert.equal(saved.at(-1), 'cleared');
  } finally {
    delete globalThis.MulloNative;
  }
});

test('S25: a key on this device waits for a Mullo sign-in; where to sign in depends on the server', async () => {
  const { keyWaitsForSignIn, mulloSignInHref, keepOwnAi, dropOwnAi } = await import('../app/core/own-ai.js');
  dropOwnAi();
  assert.equal(keyWaitsForSignIn({ aiPlan: 'pro', aiKey: 'echo_x' }, false), true, 'a Pro key, signed out');
  assert.equal(keyWaitsForSignIn({ aiPlan: 'pro', aiKey: 'echo_x' }, true), false);
  assert.equal(keyWaitsForSignIn({ aiPlan: 'account' }, false), false, 'no key: just signed out, nothing waiting');
  assert.equal(keyWaitsForSignIn({ aiPlan: null }, false), false, 'a dev bridge');
  keepOwnAi({ sealed: 'mk1.iv-part.cipher-text', provider: 'gemini', hint: 'abcd' });
  assert.equal(keyWaitsForSignIn({ aiPlan: 'account' }, false), true, 'their own AI key, signed out');
  assert.equal(keyWaitsForSignIn({ aiPlan: 'account' }, true), false);
  dropOwnAi();
  assert.equal(mulloSignInHref({ ownServer: false }), '#/settings/account');
  assert.equal(mulloSignInHref({ ownServer: true }), '#/settings/mullo-account');
});

test('Privacy Policy and Terms (S23): kept with the plan, asked again when the accepted version is older', async () => {
  const { knownPlan, rememberPlan, forgetPlan } = await import('../app/core/ai-plan.js');
  const { legalPending, noteTicked, takeTicked } = await import('../app/core/legal.js');
  const { on } = await import('../app/core/bus.js');
  forgetPlan();
  let told = 0;
  on('ai-plan', () => { told += 1; });
  const legal = (accepted) => ({ current: 'October 11, 2026', accepted, changes: 'What changed.' });
  rememberPlan('user-1', { plan: 'trial', active: true, legal: legal(null) });
  assert.deepEqual(legalPending(knownPlan('user-1')), legal(null), 'never accepted: ask');
  rememberPlan('user-1', { plan: 'trial', active: true, legal: legal('October 11, 2026') });
  assert.equal(legalPending(knownPlan('user-1')), null, 'accepted the current one');
  assert.equal(told, 2, 'accepting alone re-renders (the card goes, AI resumes)');
  rememberPlan('user-1', { plan: 'trial', active: true, legal: legal('January 1, 2020') });
  assert.ok(legalPending(knownPlan('user-1')), 'an older version: ask again');
  assert.equal(legalPending({ plan: 'pro', active: true }), null, 'no answer about it (a Pro key): nothing to ask');
  assert.equal(legalPending(null), null);
  forgetPlan();

  assert.equal(takeTicked(), false);
  noteTicked();
  assert.equal(takeTicked(), true, 'once, for the sign-in it was ticked for');
  assert.equal(takeTicked(), false);
  noteTicked();
  noteTicked(false); // the sign-in failed
  assert.equal(takeTicked(), false);
});

test('the plan the server last gave is kept per account, and says in words what is left', async () => {
  const { knownPlan, rememberPlan, forgetPlan, planLine } = await import('../app/core/ai-plan.js');
  forgetPlan();
  assert.equal(knownPlan('user-1'), null);
  rememberPlan('user-1', { plan: 'trial', active: true, minutesUsed: 88, minutesAllowed: 300, month: '2026-10' });
  const p = knownPlan('user-1');
  assert.deepEqual([p.plan, p.active, p.minutesUsed, p.month], ['trial', true, 88, undefined]);
  assert.equal(knownPlan('user-2'), null, 'someone else signed in here starts unknown');
  assert.equal(planLine(p), 'Free trial · 212 of 300 minutes left');
  assert.equal(planLine({ plan: 'trial', active: false, minutesUsed: 300, minutesAllowed: 300 }), 'Free trial · used up');
  assert.equal(planLine({ plan: 'none', active: false }), 'No AI on this account yet');
  assert.equal(planLine({ plan: 'free', active: true }), 'Free Mullo Pro');
  const { planLeft, planLow } = await import('../app/core/ai-plan.js');
  assert.equal(planLeft(p), 212 / 300, 'the ring: what is left of the trial');
  const pro = { plan: 'pro', active: true, minutesUsed: 160, minutesAllowed: 1800 };
  assert.equal(planLeft(pro), 1640 / 1800);
  assert.equal(planLine(pro), 'Mullo Pro · 1,640 of 1,800 minutes left this month');
  assert.equal(planLow(pro), false);
  const late = { plan: 'pro', active: true, minutesUsed: 1500, minutesAllowed: 1800 };
  assert.equal(planLow(late), true, 'under a fifth left: amber');
  const capped = { plan: 'pro', active: false, capped: true, minutesUsed: 1805, minutesAllowed: 1800 };
  assert.equal(planLeft(capped), 0);
  assert.match(planLine(capped), /minutes are used, back on the 1st/);
  assert.equal(planLeft({ plan: 'pro', active: true }), 1, 'a key with no numbers yet: full');
  assert.equal(planLeft({ plan: 'pro', active: false }), 0, 'lapsed: empty');
  assert.equal(planLeft({ plan: 'none', active: false }), null, 'no plan: no ring');
  forgetPlan();
});

test('the AI is used only while the gate says yes: nothing is sent to the AI on a "no"', async () => {
  const { useRemoteEngine, useAiGate, canTranscribe, aiEngineOn } = await import('../app/domain/pipeline.js');
  let open = false;
  useRemoteEngine({ transcribe: () => assert.fail('not while closed'), process: () => assert.fail('not while closed') });
  useAiGate(() => open);
  try {
    assert.equal(canTranscribe(), false);
    assert.equal(aiEngineOn(), false);
    open = true;
    assert.equal(canTranscribe(), true);
    assert.equal(aiEngineOn(), true);
  } finally {
    useAiGate(() => true);
    useRemoteEngine(null);
  }
});

test('a signed-in call to Mullo\'s server (Admin): the sign-in goes, the server\'s words come back', async () => {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, method: init.method ?? 'GET', auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    return url.endsWith('/grant')
      ? { ok: false, status: 403, json: async () => ({ error: 'Admins only.' }) }
      : { ok: true, status: 200, json: async () => ({ trialMinutes: 300, trialsPaused: false }) };
  };
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(tokens(1)), fetch, now: () => 1_000_000 });
  assert.deepEqual(await acct.server('https://pro.example', '/api/admin/settings'), { trialMinutes: 300, trialsPaused: false });
  await acct.server('https://pro.example', '/api/admin/settings', { trialMinutes: 100 });
  await assert.rejects(acct.server('https://pro.example', '/api/admin/grant', { email: 'a@b.c', plan: 'free' }), /Admins only/);
  assert.deepEqual(sent.map((s) => [s.method, s.auth, s.body]), [
    ['GET', 'Bearer access-1', null],
    ['POST', 'Bearer access-1', { trialMinutes: 100 }],
    ['POST', 'Bearer access-1', { email: 'a@b.c', plan: 'free' }],
  ]);
  const out = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: () => assert.fail('no network') });
  await assert.rejects(out.server('https://pro.example', '/api/admin/settings'), /Sign in first/);
});

test('sign out forgets the session on the device even when the server is unreachable', async () => {
  const store = memoryStore(tokens(1));
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: async () => { throw new TypeError('offline'); }, now: () => 1_000_000 });
  await acct.signOut();
  assert.equal(acct.user(), null);
  assert.equal(store.peek(), null);
});

// Leaving Mullo's server (endAllAccess): a fake Mullo Worker (W) and Supabase Auth.
function leaveFake({ failGrant = false } = {}) {
  const sent = [];
  const res = (status, data) => ({ ok: status < 300, status, json: async () => data });
  const fetch = async (u, init = {}) => {
    const url = String(u);
    const method = init.method ?? 'GET';
    sent.push(`${method} ${url.replace(URL_, '').replace('https://pro.example', 'W')}`);
    if (url === 'https://pro.example/api/keys') return res(200, { keys: [{ id: 'k1' }, { id: 'k2' }] });
    if (url === 'https://pro.example/api/keys/revoke') return res(200, { revoked: true });
    if (url === `${URL_}/auth/v1/user/oauth/grants`) return res(200, [{ client: { id: 'claude' } }, { client_id: 'keys-client' }]);
    if (url.startsWith(`${URL_}/auth/v1/user/oauth/grants?client_id=`)) return res(failGrant ? 500 : 204, null);
    if (url === `${URL_}/auth/v1/logout?scope=global` || url === `${URL_}/auth/v1/logout?scope=others`) return res(204, null);
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, sent };
}

test('leaving Mullo\'s server: every API key, every connected app, then every session ends', async () => {
  const { fetch, sent } = leaveFake();
  const store = memoryStore(tokens(1));
  const acct = createAccount({ url: URL_, key: KEY, store, fetch, now: () => 1_000_000 });
  assert.deepEqual(await acct.endAllAccess('https://pro.example'), { signedIn: true });
  assert.deepEqual(sent, [
    'GET W/api/keys', 'POST W/api/keys/revoke', 'POST W/api/keys/revoke',
    'GET /auth/v1/user/oauth/grants',
    'DELETE /auth/v1/user/oauth/grants?client_id=claude', 'DELETE /auth/v1/user/oauth/grants?client_id=keys-client',
    'POST /auth/v1/logout?scope=global',
  ]);
  assert.equal(acct.user(), null);
  assert.equal(store.peek(), null);
});

test('leaving Mullo\'s server: a step that fails stops it, signed in as before (the server isn\'t changed)', async () => {
  const { fetch, sent } = leaveFake({ failGrant: true });
  const store = memoryStore(tokens(1));
  const acct = createAccount({ url: URL_, key: KEY, store, fetch, now: () => 1_000_000 });
  await assert.rejects(acct.endAllAccess('https://pro.example'), /disconnecting an app/);
  assert.ok(!sent.some((s) => s.includes('logout')), 'no sign-out after a failed step');
  assert.equal(acct.user()?.id, 'user-1');
});

test('leaving Mullo\'s server signed out: nothing this device can close, nothing sent', async () => {
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: () => assert.fail('no network') });
  assert.deepEqual(await acct.endAllAccess('https://pro.example'), { signedIn: false });
});

test('leaving Mullo\'s server, keeping this device (S25): keys, apps and every OTHER session end; this one stays for the AI', async () => {
  const { fetch, sent } = leaveFake();
  const store = memoryStore(tokens(1));
  const acct = createAccount({ url: URL_, key: KEY, store, fetch, now: () => 1_000_000 });
  assert.deepEqual(await acct.endAllAccess('https://pro.example', { keepThisDevice: true }), { signedIn: true });
  assert.equal(sent.at(-1), 'POST /auth/v1/logout?scope=others');
  assert.ok(sent.includes('POST W/api/keys/revoke') && sent.includes('DELETE /auth/v1/user/oauth/grants?client_id=claude'));
  assert.equal(acct.user()?.id, 'user-1');
  assert.equal(store.peek()?.refresh_token, 'refresh-1', 'kept, to move to the second slot');
});

test('two sign-ins on your own server (S25): the Mullo one has its own store and event, so it never starts syncing', async () => {
  const { on } = await import('../app/core/bus.js');
  const { useAccount, useMulloAccount, mulloAccount, twoAccounts } = await import('../app/core/account.js');
  const heard = [];
  on('account', (u) => heard.push(['account', u?.id ?? null]));
  on('mullo-account', (u) => heard.push(['mullo-account', u?.id ?? null]));
  const { fetch } = fakeServer({ verify: async () => [200, tokens(1)] });
  const notes = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch, now: () => 1_000_000 });
  const mulloStore = memoryStore();
  const mullo = createAccount({ url: URL_, key: KEY, store: mulloStore, fetch, now: () => 1_000_000, event: 'mullo-account' });
  useAccount(notes);
  assert.equal(mulloAccount(), notes, 'one account: the same for the AI');
  assert.equal(twoAccounts(), false);
  useMulloAccount(mullo);
  assert.equal(mulloAccount(), mullo);
  assert.equal(twoAccounts(), true);
  await mullo.verifyCode('me@example.com', '123456');
  assert.deepEqual(heard, [['mullo-account', 'user-1']]);
  assert.equal(notes.user(), null, 'the notes\' sign-in is untouched');
  assert.equal(mulloStore.peek()?.access_token, 'access-1');
  useMulloAccount(null);
});

test('sign out signs out this device only: connected apps and API keys keep their own sessions', async () => {
  const urls = [];
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(tokens(1)), fetch: async (u) => { urls.push(String(u)); return new Response(null, { status: 204 }); }, now: () => 1_000_000 });
  await acct.signOut();
  assert.deepEqual(urls, [`${URL_}/auth/v1/logout?scope=local`]);
});

test('delete account: Mullo\'s server first, then every audio file, then the account; signed out after', async () => {
  const sent = [];
  let audio = ['a1', 'a2', 'a3'];
  const fetch = async (url, init = {}) => {
    const path = url.replace(/^https:\/\/[^/]+\//, '');
    const body = init.body ? JSON.parse(init.body) : null;
    sent.push([init.method ?? 'GET', path, body]);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (path === 'rest/v1/rpc/schema_version') return ok(5);
    if (path === 'api/account/delete') return ok({ deleted: true });
    if (path === 'storage/v1/object/list/audio') return ok(audio.slice(0, 2).map((n) => ({ id: `id-${n}`, name: n })));
    if (path === 'storage/v1/object/audio') { audio = audio.filter((n) => !body.prefixes.includes(`user-1/${n}`)); return ok([]); }
    if (path === 'rest/v1/rpc/delete_my_account') return { ok: true, status: 204, json: async () => null };
    throw new Error(`unexpected ${path}`);
  };
  const store = memoryStore(tokens(1));
  const acct = createAccount({ url: URL_, key: KEY, store, fetch, now: () => 1_000_000 });
  await acct.deleteAccount('https://pro.example');
  assert.deepEqual(sent.map(([m, p]) => `${m} ${p}`), [
    'POST rest/v1/rpc/schema_version',
    'POST api/account/delete',
    'POST storage/v1/object/list/audio', 'DELETE storage/v1/object/audio',
    'POST storage/v1/object/list/audio', 'DELETE storage/v1/object/audio',
    'POST storage/v1/object/list/audio',
    'POST rest/v1/rpc/delete_my_account',
  ]);
  assert.equal(sent[2][2].prefix, 'user-1', 'only their own folder');
  assert.deepEqual(audio, []);
  assert.equal(acct.user(), null);
  assert.equal(store.peek(), null);
});

test('delete account: a server without step 5 (or out of reach) is refused before anything goes', async () => {
  for (const [answer, why] of [[4, /setup step 5/], [null, /No connection/]]) {
    const sent = [];
    const fetch = async (url) => {
      sent.push(url);
      if (answer === null) throw new TypeError('offline');
      return { ok: true, status: 200, json: async () => answer };
    };
    const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(tokens(1)), fetch, now: () => 1_000_000 });
    await assert.rejects(acct.deleteAccount('https://pro.example'), why);
    assert.deepEqual(sent, [`${URL_}/rest/v1/rpc/schema_version`], 'nothing else was called');
    assert.equal(acct.user()?.id, 'user-1', 'still signed in');
  }
});

test('delete account: a refusal at the last step keeps the sign-in, so trying again can finish it', async () => {
  const fetch = async (url) => {
    if (url.endsWith('rpc/schema_version')) return { ok: true, status: 200, json: async () => 5 };
    if (url.endsWith('rpc/delete_my_account')) return { ok: false, status: 500, json: async () => ({ message: 'Database error' }) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(tokens(1)), fetch, now: () => 1_000_000 });
  await assert.rejects(acct.deleteAccount(null), /Database error/);
  assert.equal(acct.user()?.id, 'user-1');
});

test('a browser\'s Google / Apple sign-in: PKCE out and back, the verifier used once, stale starts refused', async () => {
  const { redirectPending } = await import('../app/core/account.js');
  const { createHash } = await import('node:crypto');
  let clock = 1_000_000;
  const store = memoryStore();
  const server = fakeServer({ token: async () => [200, { ...tokens(9), user: { id: 'user-1', email: 'me@example.com' } }] });
  const acct = createAccount({ url: URL_, key: KEY, store, fetch: server.fetch, now: () => clock });

  const to = new URL(await acct.redirectUrl('apple', 'https://mullo.example/app/', { which: 'notes', ticked: true, back: '#/settings/account' }));
  assert.equal(to.origin + to.pathname, `${URL_}/auth/v1/authorize`);
  assert.equal(to.searchParams.get('provider'), 'apple');
  assert.equal(to.searchParams.get('redirect_to'), 'https://mullo.example/app/');
  assert.equal(to.searchParams.get('code_challenge_method'), 's256');
  const pending = redirectPending();
  assert.equal(pending.ticked, true);
  assert.equal(pending.back, '#/settings/account');
  const challenge = createHash('sha256').update(pending.verifier).digest('base64url');
  assert.equal(to.searchParams.get('code_challenge'), challenge, 'the challenge is the verifier\'s SHA-256');
  assert.ok(!to.href.includes(pending.verifier), 'the verifier never leaves the browser');

  const user = await acct.finishRedirect('the-code');
  assert.equal(user.email, 'me@example.com');
  assert.equal(server.calls[0].path, 'token?grant_type=pkce');
  assert.deepEqual(server.calls[0].body, { auth_code: 'the-code', code_verifier: pending.verifier });
  assert.equal(store.peek().refresh_token, 'refresh-9');
  assert.equal(redirectPending(), null, 'kept for one return only');
  await assert.rejects(acct.finishRedirect('the-code'), /Try again/, 'a second return has nothing to finish');

  await acct.redirectUrl('google', 'https://mullo.example/app/');
  clock += 11 * 60_000;
  await assert.rejects(acct.finishRedirect('late'), /too long/);
  assert.equal(server.calls.length, 1, 'a stale start never reaches the server');

  const other = createAccount({ url: 'https://other.example', key: KEY, store: memoryStore(), fetch: server.fetch, now: () => clock });
  await acct.redirectUrl('google', 'https://mullo.example/app/');
  await assert.rejects(other.finishRedirect('x'), /started elsewhere/, 'only the account that started it finishes it');
});

test('providers: what the server switched on; unknown = none', async () => {
  const answer = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const on = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: answer({ external: { google: true, apple: false, email: true } }) });
  assert.deepEqual(await on.providers(), { google: true, apple: false });
  const down = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: answer({}, false) });
  assert.deepEqual(await down.providers(), { google: false, apple: false });
  const offline = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(await offline.providers(), { google: false, apple: false });
});

test('signInMethods: read from the session token; unknown = none', () => {
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const withToken = (claims) => createAccount({ url: URL_, key: KEY, store: memoryStore({ ...tokens(1), access_token: jwt(claims) }), fetch: () => assert.fail('no network') });
  assert.deepEqual(withToken({ app_metadata: { provider: 'apple', providers: ['apple', 'google'] } }).signInMethods(), ['apple', 'google']);
  assert.deepEqual(withToken({ app_metadata: { provider: 'email' } }).signInMethods(), ['email']);
  assert.deepEqual(createAccount({ url: URL_, key: KEY, store: memoryStore(tokens(1)), fetch: () => assert.fail('no network') }).signInMethods(), []);
  assert.deepEqual(createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: () => assert.fail('no network') }).signInMethods(), []);
});

test('the first name from Google or Apple is kept for the greeting; no name = none', async () => {
  const meta = { given_name: 'Sam', full_name: 'Sam Rivers' };
  const server = fakeServer({ token: async () => [200, { ...tokens(7), user: { id: 'user-1', email: 'me@example.com', user_metadata: meta } }] });
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: server.fetch, now: () => 1_000_000 });
  await acct.signInWithIdToken('google', 'google-id-token', 'nonce');
  assert.equal(acct.user().name, 'Sam');

  const plain = fakeServer({ token: async () => [200, { ...tokens(7), user: { id: 'user-1', email: 'me@example.com' } }] });
  const acct2 = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: plain.fetch, now: () => 1_000_000 });
  await acct2.signInWithIdToken('google', 'google-id-token', 'nonce');
  assert.equal('name' in acct2.user(), false, 'no name key at all, so older checks of the user stay equal');
});

test('a full name alone gives its first word', async () => {
  const server = fakeServer({ token: async () => [200, { ...tokens(7), user: { id: 'user-1', email: 'x@y.z', user_metadata: { full_name: '  Or Cohen ' } } }] });
  const acct = createAccount({ url: URL_, key: KEY, store: memoryStore(), fetch: server.fetch, now: () => 1_000_000 });
  await acct.signInWithIdToken('apple', 'apple-id-token', 'nonce');
  assert.equal(acct.user().name, 'Or');
});
