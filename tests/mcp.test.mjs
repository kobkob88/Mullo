// Mullo as an MCP server (worker/src/mcp.mjs + the /mcp route): run against the Worker in
// Node with a stand-in Supabase whose REST API answers only the token holder's own rows (as
// row-level security does). No network.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../worker/src/index.mjs';
import { forgetKeys } from '../worker/src/signin.mjs';
import { TOOLS } from '../worker/src/mcp.mjs';
import { CONSENT_JS } from '../worker/src/consent.mjs';
import { forgetDiscovery } from '../worker/src/apikeys.mjs';

const SCHEMA = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
const SUPABASE = 'https://project.supabase.test';
const BASE = 'https://mullo.example';
const ME = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';
const now = () => Math.floor(Date.now() / 1000);

const signer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', signer.publicKey)), kid: 'k1', alg: 'ES256' };
const b64 = (s) => Buffer.from(s).toString('base64url');
async function token({ sub = ME, exp = now() + 3600, client_id = 'claude-client' } = {}) {
  const head = b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub, iss: `${SUPABASE}/auth/v1`, exp, role: 'authenticated', aud: 'authenticated', client_id }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const subOf = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub;

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return st;
    },
  };
}

// The server's rows, each with its owner. The stand-in REST API filters by the caller's token.
const rid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
let server;
let calls;
let restDown;
function seed() {
  server = {
    recordings: [
      { id: rid(1), owner_id: ME, title: 'Montreal delivery call', recorded_at: '2026-10-06T14:00:00Z', local_date: '2026-10-06', duration_ms: 600000,
        summary: { blocks: [{ heading: 'Summary', items: ['The truck leaves Friday', 'Dana confirms the dock'] }] }, sections: [], extra: { speakers: { 'Speaker 1': 'Dana' } } },
      { id: rid(2), owner_id: ME, title: 'Dentist', recorded_at: '2026-09-01T09:00:00Z', local_date: '2026-09-01', duration_ms: 60000,
        summary: { blocks: [{ heading: 'Summary', items: ['Cleaning booked'] }] }, sections: [], extra: {} },
      { id: rid(3), owner_id: OTHER, title: 'Montreal secret plans', recorded_at: '2026-10-06T15:00:00Z', local_date: '2026-10-06', duration_ms: 1000,
        summary: { blocks: [] }, sections: [], extra: {} },
    ],
    transcripts: [
      { recording_id: rid(1), owner_id: ME, segments: [{ speaker: 'Speaker 1', start_ms: 5000, text: 'The pallets go on the blue truck' }], extra: {} },
      { recording_id: rid(3), owner_id: OTHER, segments: [{ text: 'blue truck, other person' }], extra: {} },
    ],
    action_items: [
      { id: rid(11), owner_id: ME, recording_id: rid(1), label: 'Call Dana about the dock', type: 'create_reminder', status: 'open', due_date: '2026-10-09', extra: {} },
      { id: rid(12), owner_id: ME, recording_id: rid(2), label: 'Pay the dentist', type: 'create_reminder', status: 'done', due_date: null, extra: {} },
      { id: rid(13), owner_id: OTHER, recording_id: rid(3), label: 'Their secret task', type: 'create_reminder', status: 'open', due_date: null, extra: {} },
    ],
  };
}

function rest(u, init) {
  const auth = (init.headers?.Authorization ?? '').replace(/^Bearer /, '');
  if (init.headers?.apikey !== 'sb_publishable_test') return new Response('no apikey', { status: 401 });
  const owner = subOf(auth);
  const table = u.pathname.replace('/rest/v1/', '');
  let rows = (server[table] ?? []).filter((r) => r.owner_id === owner);
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq') rows = rows.filter((r) => String(r[k]) === val);
    if (op === 'gte') rows = rows.filter((r) => r[k] >= val);
    if (op === 'lte') rows = rows.filter((r) => r[k] <= val);
    if (op === 'in') { const list = val.replace(/^\(|\)$/g, '').split(','); rows = rows.filter((r) => list.includes(r[k])); }
  }
  if (table === 'recordings') rows = [...rows].sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
  const limit = Number(u.searchParams.get('limit') ?? 1000);
  return new Response(JSON.stringify(rows.slice(0, limit).map(({ owner_id, ...r }) => r)), { status: 200 });
}

// Supabase's OAuth server, as far as API keys use it: register a client, authorize (→ the
// consent page with an authorization id), exchange a code (PKCE), refresh (rotating), log out.
let oauth;
function freshOauth() {
  oauth = { clients: 0, starts: new Map(), refresh: new Map(), n: 0, logouts: 0, approve: null };
}
async function oauthServer(u, init) {
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/auth/v1/oauth/clients/register') { oauth.clients += 1; return json({ client_id: `api-client-${oauth.clients}` }); }
  if (u.pathname === '/auth/v1/oauth/authorize') {
    const id = `auth-${oauth.starts.size + 1}`;
    oauth.starts.set(id, Object.fromEntries(u.searchParams));
    return new Response(null, { status: 302, headers: { Location: `${BASE}/oauth/consent?authorization_id=${id}` } });
  }
  if (u.pathname === '/auth/v1/oauth/token') {
    const f = new URLSearchParams(init.body);
    const issue = async (sub, client) => {
      const rt = `rt-${oauth.n += 1}`;
      oauth.refresh.set(rt, { sub, client });
      return json({ access_token: await token({ sub, client_id: client }), refresh_token: rt, expires_in: 3600, token_type: 'bearer' });
    };
    if (f.get('grant_type') === 'authorization_code') {
      const start = [...oauth.starts.values()].find((s) => s.approvedCode === f.get('code'));
      if (!start || start.redirect_uri !== f.get('redirect_uri') || start.client_id !== f.get('client_id')) return json({ error: 'invalid_grant' }, 400);
      const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.get('code_verifier')))).toString('base64url');
      if (challenge !== start.code_challenge) return json({ error: 'invalid_grant' }, 400);
      start.approvedCode = null; // one use
      return issue(start.approvedBy, start.client_id);
    }
    if (f.get('grant_type') === 'refresh_token') {
      const held = oauth.refresh.get(f.get('refresh_token'));
      if (!held || held.client !== f.get('client_id')) return json({ error: 'invalid_grant' }, 400);
      oauth.refresh.delete(f.get('refresh_token'));
      return issue(held.sub, held.client);
    }
  }
  if (u.pathname === '/auth/v1/logout') {
    oauth.logouts += 1;
    const sub = subOf((init.headers?.Authorization ?? '').replace('Bearer ', ''));
    for (const [rt, held] of oauth.refresh) if (held.sub === sub) oauth.refresh.delete(rt);
    return new Response(null, { status: 204 });
  }
  return null;
}

// What the app does between start and finish: approve with its own sign-in (Supabase's
// consent API) and take the redirect it is given.
function approve(authorizationId, sub = ME) {
  const start = oauth.starts.get(authorizationId);
  start.approvedBy = sub;
  start.approvedCode = `code-${authorizationId}`;
  return `${start.redirect_uri}?code=${start.approvedCode}&state=${start.state}`;
}

async function fakeFetch(url, init = {}) {
  calls.push(String(url));
  const u = new URL(url);
  if (u.origin === SUPABASE && u.pathname === '/auth/v1/.well-known/jwks.json') return new Response(JSON.stringify({ keys: [jwk] }));
  if (u.origin === SUPABASE && u.pathname === '/.well-known/oauth-authorization-server/auth/v1') {
    return new Response(JSON.stringify({
      issuer: `${SUPABASE}/auth/v1`, authorization_endpoint: `${SUPABASE}/auth/v1/oauth/authorize`,
      token_endpoint: `${SUPABASE}/auth/v1/oauth/token`, registration_endpoint: `${SUPABASE}/auth/v1/oauth/clients/register`,
    }));
  }
  if (u.origin === SUPABASE) { const answer = await oauthServer(u, init); if (answer) return answer; }
  if (u.origin === SUPABASE && u.pathname.startsWith('/rest/v1/')) return restDown ? new Response('down', { status: 503 }) : rest(u, init);
  return new Response('unexpected', { status: 599 });
}

let env;
beforeEach(() => {
  env = {
    DB: fakeD1(), SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', APP_ORIGINS: 'https://app.mullo.lizai.io',
    OWN_KEY_SECRET: Buffer.alloc(32, 3).toString('base64url'),
  };
  forgetKeys();
  forgetDiscovery();
  freshOauth();
  seed();
  calls = [];
  restDown = false;
});

const call = (path, init = {}) => handle(new Request(`${BASE}${path}`, init), env, { fetch: fakeFetch });
let nextId = 1;
async function mcp(method, params, { auth } = {}) {
  const t = auth === undefined ? await token() : auth;
  const res = await call('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
  return { res, body: res.status === 200 ? await res.json() : null };
}
const tool = async (name, args, opts) => (await mcp('tools/call', { name, arguments: args }, opts)).body.result;

test('no sign-in: 401 that says where to sign in, and the sign-in server is Supabase', async () => {
  const { res } = await mcp('tools/list', null, { auth: null });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('WWW-Authenticate'), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  assert.equal(res.headers.get('Access-Control-Expose-Headers').includes('WWW-Authenticate'), true);

  const meta = await (await call('/.well-known/oauth-protected-resource')).json();
  assert.equal(meta.resource, `${BASE}/mcp`);
  assert.deepEqual(meta.authorization_servers, [`${SUPABASE}/auth/v1`]);
  const as = await (await call('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, `${SUPABASE}/auth/v1`, 'passed through from Supabase for older clients');
});

test('a forged, expired or foreign token is nobody', async () => {
  assert.equal((await mcp('tools/list', null, { auth: 'not.a.token' })).res.status, 401);
  assert.equal((await mcp('tools/list', null, { auth: await token({ exp: now() - 10 }) })).res.status, 401);
  const forged = (await token()).replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await mcp('tools/list', null, { auth: forged })).res.status, 401);
  assert.equal((await mcp('tools/list', null, { auth: 'echo_somekey' })).res.status, 401, 'a Pro key is not a sign-in');
});

test('initialize, tools/list, ping; notifications get 202 and no body', async () => {
  const init = (await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).body.result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'mullo');
  assert.ok(init.capabilities.tools);
  assert.equal((await mcp('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion, '2025-06-18', 'unknown version: ours');

  const { tools } = (await mcp('tools/list')).body.result;
  assert.deepEqual(tools.map((t) => t.name), ['search', 'recent_recordings', 'get_recording', 'list_tasks']);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true), 'every tool says it only reads');
  assert.deepEqual((await mcp('ping')).body.result, {});

  const note = await call('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  assert.equal((await mcp('resources/list')).body.error.code, -32601);
  assert.equal((await call('/mcp', { method: 'GET', headers: { Authorization: `Bearer ${await token()}` } })).status, 405);
});

test('search finds your notes (titles, summaries, tasks, transcripts) and never someone else\'s', async () => {
  const r = await tool('search', { query: 'Montreal' });
  assert.deepEqual(r.structuredContent.results.map((x) => x.id), [rid(1)]);
  assert.match(r.content[0].text, /Montreal delivery call/);
  assert.doesNotMatch(r.content[0].text, /secret/);

  const words = await tool('search', { query: 'blue truck' });
  assert.deepEqual(words.structuredContent.results.map((x) => x.id), [rid(1)], 'from the transcript, mine only');
  assert.match(words.structuredContent.results[0].matched.join(' '), /transcript/);

  assert.equal((await tool('search', { query: 'dentist' })).structuredContent.results[0].id, rid(2));
  assert.deepEqual((await tool('search', { query: 'zebra' })).structuredContent.results, []);
  assert.equal((await tool('search', { query: '  ' })).isError, true);
});

test('the other person\'s token sees only theirs', async () => {
  const r = await tool('search', { query: 'Montreal' }, { auth: await token({ sub: OTHER }) });
  assert.deepEqual(r.structuredContent.results.map((x) => x.id), [rid(3)]);
  const mine = await tool('get_recording', { id: rid(1) }, { auth: await token({ sub: OTHER }) });
  assert.equal(mine.isError, true, 'my recording is not there for them');
});

test('recent_recordings: by days or dates, newest first, with an overview', async () => {
  const all = await tool('recent_recordings', { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(all.structuredContent.recordings.map((r) => r.id), [rid(1), rid(2)]);
  assert.equal(all.structuredContent.recordings[0].overview, 'The truck leaves Friday · Dana confirms the dock');
  const sept = await tool('recent_recordings', { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(sept.structuredContent.recordings.map((r) => r.id), [rid(2)]);
  assert.ok(calls.some((c) => c.includes('local_date=gte.2026-09-01') && c.includes('local_date=lte.2026-09-30')), 'the server filters, not us');
});

test('get_recording: summary and tasks; the transcript only when asked, with speaker names', async () => {
  const plain = await tool('get_recording', { id: rid(1) });
  assert.match(plain.content[0].text, /The truck leaves Friday/);
  assert.match(plain.content[0].text, /\[ \] Call Dana about the dock \(2026-10-09\)/);
  assert.doesNotMatch(plain.content[0].text, /pallets/);
  assert.ok(!calls.some((c) => c.includes('/transcripts')), 'no transcript fetched when not asked');

  const full = await tool('get_recording', { id: rid(1), include_transcript: true });
  assert.match(full.content[0].text, /\[0:05\] Dana: The pallets go on the blue truck/);
  assert.equal((await tool('get_recording', { id: 'nope' })).isError, true);
  assert.equal((await tool('get_recording', { id: rid(99) })).isError, true);
});

test('list_tasks: open by default, with the recording each came from', async () => {
  const open = await tool('list_tasks', {});
  assert.deepEqual(open.structuredContent.tasks.map((t) => t.label), ['Call Dana about the dock']);
  assert.equal(open.structuredContent.tasks[0].recording.title, 'Montreal delivery call');
  const done = await tool('list_tasks', { status: 'done' });
  assert.deepEqual(done.structuredContent.tasks.map((t) => t.label), ['Pay the dentist']);
  assert.match(done.content[0].text, /^\[x\] Pay the dentist/);
});

test('every request to Supabase carries the person\'s own token and the public key, never a secret', async () => {
  const t = await token();
  const seen = [];
  const spy = async (url, init = {}) => { if (String(url).includes('/rest/v1/')) seen.push(init.headers); return fakeFetch(url, init); };
  await handle(new Request(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'truck' } } }) }), env, { fetch: spy });
  assert.ok(seen.length >= 3);
  for (const h of seen) { assert.equal(h.Authorization, `Bearer ${t}`); assert.equal(h.apikey, 'sb_publishable_test'); }
});

test('a server hiccup is a tool error the AI can read, not a crash', async () => {
  restDown = true;
  const r = await tool('search', { query: 'truck' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /503/);
});

test('rate limited per person', async () => {
  const t = await token();
  let last;
  for (let i = 0; i < 61; i++) last = await mcp('ping', null, { auth: t });
  assert.equal(last.res.status, 429);
  assert.equal((await mcp('ping', null, { auth: await token({ sub: OTHER }) })).res.status, 200, 'someone else is not slowed');
});

test('consent page: one same-origin script, talks only to Mullo\'s Supabase', async () => {
  const res = await call('/oauth/consent?authorization_id=abc123def456');
  assert.equal(res.status, 200);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, new RegExp(`connect-src ${SUPABASE}(;|$)`));
  assert.match(csp, /frame-ancestors 'none'/);
  const page = await res.text();
  assert.match(page, /data-key="sb_publishable_test"/);
  assert.doesNotMatch(page, /<script>/, 'no inline script');
  const js = await call('/oauth/consent.js');
  assert.match(js.headers.get('Content-Type'), /javascript/);
  // The page never builds HTML from what the app or server says.
  assert.doesNotMatch(CONSENT_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(CONSENT_JS, /javascript\|data\|vbscript/, 'refuses script and data addresses');
});

// ── API keys (apikeys.mjs) ──
const appToken = (sub = ME) => token({ sub, client_id: null }); // the Mullo app's own sign-in
const keys = async (path, body, auth) => call(`/api/keys${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth ?? await appToken()}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function makeKey(name = 'n8n', sub = ME) {
  const auth = await appToken(sub);
  const started = await (await keys('/start', { name }, auth)).json();
  const done = await keys('/finish', { redirectUrl: approve(started.authorizationId, sub) }, auth);
  return done.json();
}
const get = async (path, key) => call(path, { headers: { Authorization: `Bearer ${key}` } });
const rawDb = () => env.DB.prepare('select * from api_keys').all().then((r) => r.results);

test('API key: made through Supabase\'s OAuth server; shown once, kept only as a hash and sealed tokens', async () => {
  const made = await makeKey('My script');
  assert.match(made.key, /^mullo_[\w-]{43}$/);
  assert.equal(made.name, 'My script');
  const rows = await rawDb();
  assert.equal(rows.length, 1);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(made.key), 'the key itself is not kept');
  assert.ok(!dump.includes('rt-1') && !/eyJ/.test(dump), 'tokens are sealed, not readable');
  const start = [...oauth.starts.values()][0];
  assert.equal(start.code_challenge_method, 'S256', 'PKCE');
  assert.equal(start.redirect_uri, `${BASE}/api/keys/callback`);
  const listed = await (await keys('')).json();
  assert.deepEqual(listed.keys.map((k) => [k.name, k.working]), [['My script', true]]);
  assert.equal(JSON.stringify(listed).includes('mullo_'), false, 'the list never shows a key');
  await makeKey('second');
  assert.equal(oauth.clients, 1, 'Mullo\'s API client is registered once');
});

test('API key: reads your notes as JSON, and works for MCP clients too', async () => {
  const { key } = await makeKey();
  const list = await (await get('/v1/recordings?from=2026-01-01&to=2026-12-31', key)).json();
  assert.deepEqual(list.recordings.map((r) => r.id), [rid(1), rid(2)]);
  const found = await (await get('/v1/recordings?q=truck', key)).json();
  assert.deepEqual(found.recordings.map((r) => r.id), [rid(1)]);
  const one = await (await get(`/v1/recordings/${rid(1)}?transcript=1`, key)).json();
  assert.equal(one.recording.title, 'Montreal delivery call');
  assert.deepEqual(one.recording.transcript, [{ speaker: 'Dana', start_ms: 5000, text: 'The pallets go on the blue truck' }]);
  assert.deepEqual(one.recording.tasks.map((t) => t.label), ['Call Dana about the dock']);
  assert.equal((await get(`/v1/recordings/${rid(3)}`, key)).status, 404, 'someone else\'s recording is not there');
  const tasks = await (await get('/v1/tasks', key)).json();
  assert.deepEqual(tasks.tasks.map((t) => t.label), ['Call Dana about the dock']);
  assert.equal((await call('/v1/tasks', { method: 'POST', headers: { Authorization: `Bearer ${key}` } })).status, 405, 'read-only');
  const viaMcp = await mcp('tools/call', { name: 'list_tasks', arguments: {} }, { auth: key });
  assert.equal(viaMcp.body.result.structuredContent.tasks.length, 1);
  assert.equal((await get('/v1/tasks', 'mullo_madeup')).status, 401);
});

test('API key: its token is refreshed when it runs out, and the new refresh token is kept', async () => {
  const { key } = await makeKey();
  env.DB.prepare('update api_keys set access_exp = 0').run();
  assert.equal((await get('/v1/tasks', key)).status, 200);
  assert.ok(calls.some((c) => c.endsWith('/auth/v1/oauth/token')), 'refreshed');
  assert.ok(!oauth.refresh.has('rt-1') && oauth.refresh.has('rt-2'), 'rotated at Supabase');
  env.DB.prepare('update api_keys set access_exp = 0').run();
  assert.equal((await get('/v1/tasks', key)).status, 200, 'the rotated token works next time');
});

test('API key: revoked keys stop, and their Supabase session is signed out', async () => {
  const { key, id } = await makeKey();
  assert.equal((await keys('/revoke', { id })).status, 200);
  assert.equal(oauth.logouts, 1);
  assert.equal((await get('/v1/tasks', key)).status, 401);
  assert.equal((await keys('/revoke', { id })).status, 404);
});

test('API key: disconnecting Mullo\'s API in Supabase turns the key off', async () => {
  const { key } = await makeKey();
  oauth.refresh.clear(); // the grant was revoked (Settings, Developers, Disconnect)
  env.DB.prepare('update api_keys set access_exp = 0').run();
  assert.equal((await get('/v1/tasks', key)).status, 401);
  assert.deepEqual((await (await keys('')).json()).keys.map((k) => k.working), [false], 'shown as not working');
});

test('API key: only the person in the Mullo app makes or manages keys', async () => {
  const { key, id } = await makeKey();
  const other = await appToken(OTHER);
  assert.deepEqual((await (await keys('', undefined, other)).json()).keys, [], 'someone else sees none of mine');
  assert.equal((await keys('/revoke', { id }, other)).status, 404, 'and can\'t revoke mine');
  assert.equal((await keys('/start', { name: 'x' }, await token())).status, 403, 'a connected app\'s token can\'t make keys');
  assert.equal((await keys('', undefined, key)).status, 401, 'nor can an API key');
});

test('API key: an approval only finishes for the person who started it, once, in time', async () => {
  const auth = await appToken();
  const started = await (await keys('/start', { name: 'x' }, auth)).json();
  const back = approve(started.authorizationId);
  assert.equal((await keys('/finish', { redirectUrl: back }, await appToken(OTHER))).status, 400, 'another person');
  const again = await (await keys('/start', { name: 'x' }, auth)).json();
  const back2 = approve(again.authorizationId);
  assert.equal((await keys('/finish', { redirectUrl: back2.replace(BASE, 'https://evil.example') }, auth)).status, 400, 'somewhere else');
  assert.equal((await keys('/finish', { redirectUrl: back2 }, auth)).status, 200);
  assert.equal((await keys('/finish', { redirectUrl: back2 }, auth)).status, 400, 'used once');
  assert.equal((await keys('/finish', { redirectUrl: `${BASE}/api/keys/callback?error=access_denied&state=x` }, auth)).status, 400);
});

test('a connected app\'s token reads notes but never spends AI minutes, pays or links', async () => {
  const appT = await token(); // carries a client_id, like Claude's
  for (const [path, body] of [['/api/ask', { question: 'q', recordings: [] }], ['/api/billing/checkout', {}], ['/api/link', { key: 'echo_x' }]]) {
    const res = await call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appT}` }, body: JSON.stringify(body) });
    assert.equal(res.status, 403, path);
  }
  assert.equal((await call('/api/me', { headers: { Authorization: `Bearer ${appT}` } })).status, 403);
});

test('tools are described without long dashes', () => {
  assert.doesNotMatch(JSON.stringify(TOOLS), /—/);
});
