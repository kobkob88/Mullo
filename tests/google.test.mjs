// Google Calendar and Tasks (roadmap S9): worker/src/google.mjs against a fake Google
// (calendars, events, task lists, tasks, the token endpoint) and a real SQLite D1;
// app/domain/google.js's pure planning. No network.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  googleStatus, startGoogle, finishGoogle, forgetGoogle, pushGoogle, cleanItem, eventIdFor, SCOPES, MAX_PUSH, GOOGLE_GONE,
} from '../worker/src/google.mjs';
import { handle } from '../worker/src/index.mjs';
import { payloadFor, planPush, applyResults, fingerprint } from '../app/domain/google.js';

const SCHEMA = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
const ORIGIN = 'https://mullo.example';
const USER = { userId: 'aaaaaaaa-1111-2222-3333-444444444444' };
const BOTH = `${SCOPES.calendar} ${SCOPES.tasks}`;

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { if (a.some((v) => v === undefined)) throw new Error('D1 rejects undefined binds'); args = a; return st; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
      };
      return st;
    },
  };
}

// Google, as far as Mullo uses it.
let g;
function freshGoogle() {
  return {
    calls: [], revoked: [], codes: { good: BOTH, calOnly: SCOPES.calendar, none: 'openid' },
    deadRefresh: new Set(), calendars: new Map(), lists: new Map(), n: 0,
  };
}
const reply = (status, body) => Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status }));
function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  g.calls.push({ url: String(url), method, body: init.body, headers: init.headers });
  if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
    const form = new URLSearchParams(init.body);
    if (form.get('client_secret') !== 'secret') return reply(401, { error: 'invalid_client' });
    if (form.get('grant_type') === 'authorization_code') {
      const scope = g.codes[form.get('code')];
      if (!scope) return reply(400, { error: 'invalid_grant' });
      g.lastVerifier = form.get('code_verifier');
      return reply(200, { access_token: 'at-1', refresh_token: `rt-${form.get('code')}`, scope, expires_in: 3600 });
    }
    if (g.deadRefresh.has(form.get('refresh_token'))) return reply(400, { error: 'invalid_grant' });
    return reply(200, { access_token: 'at-2', expires_in: 3600 });
  }
  if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
    g.revoked.push(new URLSearchParams(init.body).get('token'));
    return reply(200, {});
  }
  const body = init.body ? JSON.parse(init.body) : null;
  const cal = /^\/calendar\/v3\/calendars(?:\/([^/]+)\/events(?:\/([^/]+))?)?$/.exec(u.pathname);
  if (u.host === 'www.googleapis.com' && cal) {
    if (!cal[1]) { const id = `cal${++g.n}`; g.calendars.set(id, new Map()); return reply(200, { id, summary: body.summary }); }
    const events = g.calendars.get(decodeURIComponent(cal[1]));
    if (!events) return reply(404, { error: { message: 'Not Found' } });
    const id = cal[2];
    if (method === 'POST') {
      if (events.has(body.id)) return reply(409, { error: { message: 'duplicate' } });
      events.set(body.id, body); return reply(200, body);
    }
    if (!events.has(id)) return reply(404, { error: { message: 'Not Found' } });
    if (method === 'PUT') { events.set(id, { id, ...body }); return reply(200, events.get(id)); }
    if (method === 'DELETE') { events.delete(id); return reply(204); }
  }
  if (u.host === 'tasks.googleapis.com') {
    if (u.pathname === '/tasks/v1/users/@me/lists') {
      if (method === 'GET') return reply(200, { items: [...g.lists].map(([id, l]) => ({ id, title: l.title })) });
      const id = `list${++g.n}`; g.lists.set(id, { title: body.title, tasks: new Map() }); return reply(200, { id, title: body.title });
    }
    const m = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(u.pathname);
    const list = m && g.lists.get(decodeURIComponent(m[1]));
    if (!list) return reply(404, { error: { message: 'Not Found' } });
    if (method === 'POST') { const id = `t${++g.n}`; list.tasks.set(id, body); return reply(200, { id, ...body }); }
    const id = decodeURIComponent(m[2]);
    if (!list.tasks.has(id)) return reply(404, { error: { message: 'Not Found' } });
    if (method === 'PATCH') { list.tasks.set(id, { ...list.tasks.get(id), ...body }); return reply(200, list.tasks.get(id)); }
    if (method === 'DELETE') { list.tasks.delete(id); return reply(204); }
  }
  return reply(599, { error: { message: `unexpected ${method} ${url}` } });
}

let env;
beforeEach(() => {
  g = freshGoogle();
  env = {
    DB: fakeD1(), GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_TASKS: 'on',
    OWN_KEY_SECRET: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString('base64url'),
  };
});

async function connect(code = 'good', user = USER) {
  const { url } = await startGoogle(env, user, { back: 'web', origin: ORIGIN });
  const state = new URL(url).searchParams.get('state');
  return finishGoogle(env, fakeFetch, { state, code, origin: ORIGIN });
}
const events = () => [...g.calendars.values()].flatMap((m) => [...m.values()]);
const tasks = () => [...g.lists.values()].flatMap((l) => [...l.tasks.values()]);
const item = (over = {}) => ({ id: 'a1', title: 'Call the bank', notes: 'From Mullo', due: '2026-10-20', done: false, gone: false, ...over });

test('off until the client id, its secret and the sealing secret are all set', async () => {
  delete env.GOOGLE_CLIENT_SECRET;
  assert.deepEqual(await googleStatus(env, USER), { ready: false, connected: false });
  await assert.rejects(startGoogle(env, USER, { back: 'web', origin: ORIGIN }), { status: 503 });
  await assert.rejects(pushGoogle(env, fakeFetch, USER, { items: [] }), { status: 503 });
});

test('connect: Google\'s page with both scopes, offline access and PKCE; the state works once, for that account', async () => {
  const { url } = await startGoogle(env, USER, { back: 'app', origin: ORIGIN });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin, 'https://accounts.google.com');
  assert.equal(q.get('client_id'), env.GOOGLE_CLIENT_ID);
  assert.equal(q.get('redirect_uri'), `${ORIGIN}/api/google/callback`);
  assert.equal(q.get('scope'), BOTH);
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('code_challenge_method'), 'S256');

  const out = await finishGoogle(env, fakeFetch, { state: q.get('state'), code: 'good', origin: ORIGIN });
  assert.equal(out.ok, true);
  assert.equal(out.back, 'app');
  assert.match(out.text, /Google Calendar and Google Tasks/);
  // The verifier Google got matches the challenge in the link.
  assert.equal(createHash('sha256').update(g.lastVerifier).digest('base64url'), q.get('code_challenge'));
  // Sealed: the refresh token isn't readable in D1.
  const row = env.DB.raw.prepare('select * from google_links').get();
  assert.equal(row.user_id, USER.userId);
  assert.ok(!row.refresh_sealed.includes('rt-good'));
  assert.deepEqual(await googleStatus(env, USER), { ready: true, tasksReady: true, connected: true, gone: false, calendar: true, tasks: true });

  const again = await finishGoogle(env, fakeFetch, { state: q.get('state'), code: 'good', origin: ORIGIN });
  assert.equal(again.ok, false, 'a used state is refused');
  assert.equal((await finishGoogle(env, fakeFetch, { state: 'made-up', code: 'good', origin: ORIGIN })).ok, false);
});

test('connect: refused at Google, or nothing Mullo needs ticked, connects nothing (and gives the token back)', async () => {
  const { url } = await startGoogle(env, USER, { back: 'web', origin: ORIGIN });
  const denied = await finishGoogle(env, fakeFetch, { state: new URL(url).searchParams.get('state'), error: 'access_denied', origin: ORIGIN });
  assert.equal(denied.ok, false);
  assert.equal(denied.back, 'web');
  const none = await connect('none');
  assert.equal(none.ok, false);
  assert.match(none.text, /Calendar or Google Tasks/);
  assert.deepEqual(g.revoked, ['rt-none']);
  assert.equal((await googleStatus(env, USER)).connected, false);
});

test('connect again: the old grant is given back to Google, the new one kept', async () => {
  await connect('good');
  const out = await connect('calOnly');
  assert.equal(out.ok, true);
  assert.deepEqual(g.revoked, ['rt-good']);
  assert.deepEqual(await googleStatus(env, USER), { ready: true, tasksReady: true, connected: true, gone: false, calendar: true, tasks: false });
});

test('push: a dated task is an all-day event in a Mullo calendar and a task in a Mullo list', async () => {
  await connect();
  const { results } = await pushGoogle(env, fakeFetch, USER, { items: [item()] });
  assert.deepEqual(results, [{ id: 'a1', ok: true }]);
  assert.equal(g.calendars.size, 1);
  const [event] = events();
  assert.equal(event.id, await eventIdFor('a1'));
  assert.match(event.id, /^[0-9a-v]{5,1024}$/, 'Calendar event ids are base32hex');
  assert.deepEqual([event.summary, event.start, event.end], ['Call the bank', { date: '2026-10-20' }, { date: '2026-10-21' }]);
  assert.deepEqual([...g.lists.values()].map((l) => l.title), ['Mullo']);
  const [task] = tasks();
  assert.deepEqual([task.title, task.due, task.status], ['Call the bank', '2026-10-20T00:00:00.000Z', 'needsAction']);
  // Bearer = the access token from the refresh, never the refresh token.
  assert.ok(g.calls.filter((c) => /googleapis\.com\/(calendar|tasks)/.test(c.url)).every((c) => c.headers.Authorization === 'Bearer at-2'));
});

test('push: the same task from a second device lands on the same event and task, never a copy', async () => {
  await connect();
  await pushGoogle(env, fakeFetch, USER, { items: [item()] });
  await pushGoogle(env, fakeFetch, USER, { items: [item({ title: 'Call the bank today' })] });
  assert.equal(events().length, 1);
  assert.equal(events()[0].summary, 'Call the bank today');
  assert.equal(tasks().length, 1);
  assert.equal(tasks()[0].title, 'Call the bank today');
  assert.equal(g.calendars.size, 1, 'the calendar is made once');
  assert.equal(g.lists.size, 1, 'the list is made once');
});

test('push: done ticks it, no date takes the event away, cancelled or deleted takes both away', async () => {
  await connect();
  await pushGoogle(env, fakeFetch, USER, { items: [item(), item({ id: 'a2', due: null })] });
  assert.equal(events().length, 1, 'no date, no event');
  assert.equal(tasks().length, 2, 'every open task is a task');

  await pushGoogle(env, fakeFetch, USER, { items: [item({ done: true })] });
  assert.equal(events()[0].summary, '✓ Call the bank');
  assert.equal(tasks()[0].status, 'completed');

  await pushGoogle(env, fakeFetch, USER, { items: [item({ due: null })] });
  assert.equal(events().length, 0, 'the date went, so did the event');

  const { results } = await pushGoogle(env, fakeFetch, USER, { items: [item({ gone: true }), item({ id: 'a2', gone: true }), item({ id: 'never-sent', gone: true })] });
  assert.ok(results.every((r) => r.ok));
  assert.equal(tasks().length, 0);
  assert.equal(env.DB.raw.prepare('select count(*) n from google_tasks').get().n, 0);
});

test('push: a Mullo calendar or list deleted in Google is made again', async () => {
  await connect();
  await pushGoogle(env, fakeFetch, USER, { items: [item()] });
  g.calendars.clear();
  g.lists.clear();
  const { results } = await pushGoogle(env, fakeFetch, USER, { items: [item({ title: 'Again' })] });
  assert.deepEqual(results, [{ id: 'a1', ok: true }]);
  assert.equal(events()[0].summary, 'Again');
  assert.equal(tasks()[0].title, 'Again');
});

test('push: only the parts the person allowed', async () => {
  await connect('calOnly');
  await pushGoogle(env, fakeFetch, USER, { items: [item()] });
  assert.equal(events().length, 1);
  assert.equal(g.lists.size, 0);
  assert.ok(!g.calls.some((c) => c.url.includes('tasks.googleapis.com')));
});

test('Google Tasks off (GOOGLE_TASKS not "on"): Calendar only is asked, and nothing goes to Google Tasks, even on a grant with it', async () => {
  delete env.GOOGLE_TASKS;
  const { url } = await startGoogle(env, USER, { back: 'web', origin: ORIGIN });
  assert.equal(new URL(url).searchParams.get('scope'), SCOPES.calendar);
  const out = await finishGoogle(env, fakeFetch, { state: new URL(url).searchParams.get('state'), code: 'good', origin: ORIGIN });
  assert.equal(out.ok, true);
  assert.match(out.text, /to Google Calendar from now on/);
  assert.deepEqual(await googleStatus(env, USER), { ready: true, tasksReady: false, connected: true, gone: false, calendar: true, tasks: false });
  await pushGoogle(env, fakeFetch, USER, { items: [item()] });
  assert.equal(events().length, 1);
  assert.ok(!g.calls.some((c) => c.url.includes('tasks.googleapis.com')));
  // Switched on later: the same grant (it has the scope) sends to Google Tasks too.
  env.GOOGLE_TASKS = 'on';
  await pushGoogle(env, fakeFetch, USER, { items: [item({ title: 'Call the bank today' })] });
  assert.equal(tasks().length, 1);
});

test('push: not connected, too many, bad items', async () => {
  await assert.rejects(pushGoogle(env, fakeFetch, USER, { items: [item()] }), { status: 409, code: 'google_not_connected' });
  await connect();
  await assert.rejects(pushGoogle(env, fakeFetch, USER, { items: Array.from({ length: MAX_PUSH + 1 }, (_, i) => item({ id: `a${i}` })) }), { status: 400 });
  const { results } = await pushGoogle(env, fakeFetch, USER, { items: [{ id: '../x' }, null, item()] });
  assert.deepEqual(results.map((r) => r.ok), [false, false, true]);
});

test('cleanItem: ids, dates and text are checked', () => {
  assert.equal(cleanItem({ id: 'has space' }), null);
  assert.equal(cleanItem({ id: 'x'.repeat(81) }), null);
  assert.equal(cleanItem({ id: 'a', due: '2026-13-45' }).due, null);
  assert.equal(cleanItem({ id: 'a', due: '20261020' }).due, null);
  assert.equal(cleanItem({ id: 'a', title: '' }).title, 'Task');
  assert.equal(cleanItem({ id: 'a', title: 'x'.repeat(900) }).title.length, 500);
  assert.equal(cleanItem({ id: 'a', done: 'yes' }).done, false);
});

test('Google refusing the grant: the link is marked gone, the batch stops, status says so', async () => {
  await connect();
  g.deadRefresh.add('rt-good');
  await assert.rejects(pushGoogle(env, fakeFetch, USER, { items: [item()] }), { status: 401, code: 'google_gone', message: GOOGLE_GONE });
  assert.equal((await googleStatus(env, USER)).gone, true);
  await assert.rejects(pushGoogle(env, fakeFetch, USER, { items: [item()] }), { code: 'google_gone' });
  // Connecting again clears it.
  g.deadRefresh.clear();
  await connect();
  assert.equal((await googleStatus(env, USER)).gone, false);
});

test('disconnect: Google lets go, every row of theirs goes', async () => {
  await connect();
  await pushGoogle(env, fakeFetch, USER, { items: [item()] });
  assert.deepEqual(await forgetGoogle(env, fakeFetch, USER.userId), { connected: false });
  assert.deepEqual(g.revoked, ['rt-good']);
  for (const t of ['google_links', 'google_tasks', 'google_starts']) assert.equal(env.DB.raw.prepare(`select count(*) n from ${t}`).get().n, 0, t);
  assert.equal((await googleStatus(env, USER)).connected, false);
});

test('one account never reaches another\'s Google', async () => {
  await connect();
  const other = { userId: 'bbbbbbbb-1111-2222-3333-444444444444' };
  assert.equal((await googleStatus(env, other)).connected, false);
  await assert.rejects(pushGoogle(env, fakeFetch, other, { items: [item()] }), { code: 'google_not_connected' });
});

test('routes: a sign-in for everything but the callback; the callback answers with a page', async () => {
  const call = (path) => handle(new Request(`${ORIGIN}${path}`), env, { fetch: fakeFetch });
  assert.equal((await call('/api/google')).status, 401);
  const expired = await call('/api/google/callback?state=nope&code=good');
  assert.equal(expired.status, 200);
  assert.match(expired.headers.get('Content-Type'), /text\/html/);
  const page = await expired.text();
  assert.match(page, /already used/);
  assert.match(page, /href="mullo:\/\/open">Back to Mullo</, 'back into the app, not to the website');
  assert.doesNotMatch(page, /href="\/">Back</);
  const { url } = await startGoogle(env, USER, { back: 'web', origin: ORIGIN });
  const back = await call(`/api/google/callback?state=${new URL(url).searchParams.get('state')}&code=good`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('Location'), `${ORIGIN}/app/#/settings/google`);
  delete env.GOOGLE_CLIENT_ID;
  const off = await call('/api/google/callback?state=x');
  assert.equal(off.status, 503);
  assert.match(off.headers.get('Content-Type'), /text\/html/);
});

// The app's side: what to send.
const action = (over = {}) => ({ id: 'a1', recording_id: 'r1', label: 'Call the bank', context: 'about the loan', due_date: '2026-10-20', status: 'open', ...over });

test('payloadFor: context and where it came from go in the notes; cancelled = gone', () => {
  const p = payloadFor(action(), 'Monday meeting');
  assert.deepEqual(p, { id: 'a1', title: 'Call the bank', notes: 'about the loan\n\nFrom "Monday meeting" in Mullo', due: '2026-10-20', done: false, gone: false });
  assert.equal(payloadFor(action({ context: '' }), '').notes, 'From Mullo');
  // Google lays out a Hebrew task right to left: the "from" line follows (owner, 2026-10-14).
  assert.equal(payloadFor(action({ label: 'לסגור עם אלכס את ההזמנה', context: '' }), 'הזמנת אצטון ומדבקות').notes, 'מתוך "הזמנת אצטון ומדבקות" ב-Mullo');
  assert.equal(payloadFor(action({ label: 'اتصل بالبنك', context: '' }), 'اجتماع').notes, '"اجتماع" · Mullo');
  assert.equal(payloadFor(action({ context: '' }), 'הזמנת אצטון').notes, 'From "הזמנת אצטון" in Mullo', 'an English task keeps the English line');
  assert.equal(payloadFor(action({ status: 'done' })).done, true);
  assert.equal(payloadFor(action({ status: 'cancelled' })).gone, true);
  assert.equal(payloadFor(action({ due_date: undefined })).due, null);
});

test('planPush: new open tasks, changed ones and deleted ones go; old finished tasks and unchanged ones don\'t', () => {
  const sent = {};
  const first = planPush([action(), action({ id: 'old', status: 'done' }), action({ id: 'x', status: 'cancelled' })], sent);
  assert.deepEqual(first.map((p) => p.id), ['a1'], 'connecting sends only open tasks');

  const after = applyResults(sent, first, [{ id: 'a1', ok: true }]);
  assert.equal(after.a1, fingerprint(first[0]));
  assert.deepEqual(planPush([action()], after), [], 'nothing changed, nothing sent');

  const done = planPush([action({ status: 'done' })], after);
  assert.deepEqual(done.map((p) => [p.id, p.done]), [['a1', true]], 'done goes because Google has it');
  assert.deepEqual(planPush([action({ label: 'Call the bank today' })], after).map((p) => p.title), ['Call the bank today']);
  assert.deepEqual(planPush([action()], after, () => 'Renamed').length, 1, 'a renamed recording changes the notes');

  const deleted = planPush([], after);
  assert.deepEqual(deleted, [{ id: 'a1', title: '', notes: '', due: null, done: false, gone: true }]);
  assert.deepEqual(applyResults(after, deleted, [{ id: 'a1', ok: true }]), {}, 'gone from Google, forgotten here');
});

test('applyResults: a failed task is sent again next time', () => {
  const items = planPush([action(), action({ id: 'a2' })], {});
  const sent = applyResults({}, items, [{ id: 'a1', ok: true }, { id: 'a2', ok: false, error: 'Google answered 500' }]);
  assert.deepEqual(Object.keys(sent), ['a1']);
  assert.deepEqual(planPush([action(), action({ id: 'a2' })], sent).map((p) => p.id), ['a2']);
});
