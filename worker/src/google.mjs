// Google Calendar and Google Tasks (roadmap S9): Mullo's tasks, sent to the person's Google.
//
// The person connects once, in their browser (Google's consent page; Google refuses sign-ins
// inside an app's WebView, so the apps open it outside). Mullo's server is the OAuth client:
// it exchanges the code (PKCE + the Web client's secret) and keeps the refresh token SEALED
// (ownkey.mjs) in D1, like API keys. So one connection serves every device of that account,
// and no Google token ever reaches the web code.
//
// One way only: the app sends its tasks (POST /api/google/push), nothing comes back from Google.
//  - Calendar (scope calendar.app.created: only calendars Mullo itself made): a task with a
//    date is an all-day event in a "Mullo" calendar. The event id is made from the task id,
//    so two devices sending the same task land on the same event, never a copy.
//  - Tasks (scope tasks): every open task in a "Mullo" list. Google picks the task ids, so
//    D1 keeps task id → Google task id (ids only, never the text).
// The server keeps no task text: it passes through to Google and is gone.

import { sealText, openText } from './ownkey.mjs';
import { ready } from './usage.mjs';
import { hex } from './stripe.mjs';

const PURPOSE = 'google-tokens-v1';
const START_TTL_S = 600;
export const MAX_PUSH = 25;
export const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.app.created',
  tasks: 'https://www.googleapis.com/auth/tasks',
};
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const LIST_NAME = 'Mullo';

export const GOOGLE_OFF = 'Google isn\'t switched on on Mullo\'s server yet.';
export const NOT_CONNECTED = 'Google isn\'t connected. Connect it in Settings, Connections.';
export const GOOGLE_GONE = 'Google stopped letting Mullo in. Connect it again in Settings, Connections.';

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const nowSec = () => Math.floor(Date.now() / 1000);
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export const googleReady = (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OWN_KEY_SECRET);
// Google Tasks waits for Google's review of the `tasks` scope (sensitive; owner, 2026-10-14):
// until GOOGLE_TASKS = "on", connecting asks for Calendar only (no review, so no "unverified
// app" warning) and nothing is sent to Google Tasks, even on a grant that already has it.
export const tasksOn = (env) => env.GOOGLE_TASKS === 'on';
const callbackUrl = (origin) => `${origin}/api/google/callback`;

async function linkOf(env, userId) {
  await ready(env);
  return env.DB.prepare('select * from google_links where user_id = ?').bind(userId).first();
}

const parts = (scopes) => ({
  calendar: String(scopes ?? '').split(' ').includes(SCOPES.calendar),
  tasks: String(scopes ?? '').split(' ').includes(SCOPES.tasks),
});

// GET /api/google → { ready, tasksReady, connected, calendar, tasks, gone }
export async function googleStatus(env, user) {
  if (!googleReady(env)) return { ready: false, connected: false };
  const tasksReady = tasksOn(env);
  const link = await linkOf(env, user.userId);
  if (!link) return { ready: true, tasksReady, connected: false };
  const has = parts(link.scopes);
  return { ready: true, tasksReady, connected: true, gone: Boolean(link.dead), calendar: has.calendar, tasks: has.tasks && tasksReady };
}

// POST /api/google/start { back: 'web' | 'app' } → { url } (Google's consent page).
// `back` says where the browser goes afterwards: the web app, or a "go back to Mullo" page
// (the phone apps opened it outside themselves).
export async function startGoogle(env, user, { back, origin }) {
  if (!googleReady(env)) throw fail(503, GOOGLE_OFF);
  await ready(env);
  await env.DB.prepare('delete from google_starts where expires_at < ?').bind(nowSec()).run();
  const state = random(24);
  const verifier = random(48);
  await env.DB.prepare('insert into google_starts (state, user_id, verifier, back, expires_at) values (?, ?, ?, ?, ?)')
    .bind(state, user.userId, verifier, back === 'web' ? 'web' : 'app', nowSec() + START_TTL_S).run();
  const url = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(origin), response_type: 'code',
    scope: tasksOn(env) ? `${SCOPES.calendar} ${SCOPES.tasks}` : SCOPES.calendar, access_type: 'offline', prompt: 'consent',
    state, code_challenge: b64url(await sha256(verifier)), code_challenge_method: 'S256',
  })) url.searchParams.set(k, v);
  return { url: url.toString() };
}

async function tokenCall(env, doFetch, form) {
  return doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...form }).toString(),
  });
}

async function revoke(doFetch, token) {
  if (!token) return;
  await doFetch(REVOKE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => {});
}

// GET /api/google/callback?state&code (or &error) → { back, title, text } for the page to show.
// The state is single-use and names the Mullo account that asked; nothing else is trusted.
export async function finishGoogle(env, doFetch, { state, code, error, origin }) {
  if (!googleReady(env)) throw fail(503, GOOGLE_OFF);
  await ready(env);
  const start = state ? await env.DB.prepare('select * from google_starts where state = ? and expires_at >= ?').bind(state, nowSec()).first() : null;
  if (start) await env.DB.prepare('delete from google_starts where state = ?').bind(state).run();
  // Owner, 2026-10-14: this showed on a second load of the same return link, right after the
  // first had connected. Used or too old can't be told apart here, so it says both.
  if (!start) return { back: 'app', ok: false, title: 'This link was already used', text: 'Go back to Mullo: if it says Google is connected, you\'re done. If not, tap Connect Google again (the link works for 10 minutes, once).' };
  if (error || !code) return { back: start.back, ok: false, title: 'Google wasn\'t connected', text: 'Nothing was connected. You can try again from Mullo any time.' };
  const res = await tokenCall(env, doFetch, { grant_type: 'authorization_code', code, code_verifier: start.verifier, redirect_uri: callbackUrl(origin) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    if (body.access_token) await revoke(doFetch, body.access_token);
    return { back: start.back, ok: false, title: 'Google wasn\'t connected', text: 'Google didn\'t finish the connection. Go back to Mullo and try again.' };
  }
  const granted = parts(body.scope);
  if (!tasksOn(env)) granted.tasks = false;
  if (!granted.calendar && !granted.tasks) {
    await revoke(doFetch, body.refresh_token);
    const need = tasksOn(env) ? 'Google Calendar or Google Tasks (or both)' : 'Google Calendar';
    return { back: start.back, ok: false, title: 'Google wasn\'t connected', text: `Mullo needs ${need}. Try again and leave it ticked.` };
  }
  const old = await linkOf(env, start.user_id);
  if (old) await revoke(doFetch, await openText(env, old.refresh_sealed, PURPOSE));
  // The Mullo calendar and list ids are kept: the same Google account finds them again, and
  // another account's ids just aren't found there (they're made again on first use).
  await env.DB.prepare(`insert into google_links (user_id, refresh_sealed, scopes, calendar_id, tasklist_id, created_at, dead)
    values (?, ?, ?, null, null, ?, 0)
    on conflict(user_id) do update set refresh_sealed = excluded.refresh_sealed, scopes = excluded.scopes, dead = 0`)
    .bind(start.user_id, await sealText(env, body.refresh_token, PURPOSE), String(body.scope ?? ''), nowSec()).run();
  tokens.delete(start.user_id);
  const what = granted.calendar && granted.tasks ? 'Google Calendar and Google Tasks' : granted.calendar ? 'Google Calendar' : 'Google Tasks';
  return { back: start.back, ok: true, title: 'Google is connected', text: `Go back to Mullo. Your tasks go to ${what} from now on.` };
}

// Disconnect (Settings) and Delete account: Google lets go of Mullo, then the rows go.
// The Mullo calendar and list stay in the person's Google account (theirs to delete).
export async function forgetGoogle(env, doFetch, userId) {
  await ready(env);
  const link = await linkOf(env, userId);
  if (link) await revoke(doFetch, await openText(env, link.refresh_sealed, PURPOSE));
  await env.DB.prepare('delete from google_links where user_id = ?').bind(userId).run();
  await env.DB.prepare('delete from google_tasks where user_id = ?').bind(userId).run();
  await env.DB.prepare('delete from google_starts where user_id = ?').bind(userId).run();
  tokens.delete(userId);
  return { connected: false };
}

// Access tokens live an hour; kept per isolate, never stored.
const tokens = new Map();
async function accessToken(env, doFetch, link) {
  const hit = tokens.get(link.user_id);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const refresh = await openText(env, link.refresh_sealed, PURPOSE);
  if (!refresh) throw fail(401, GOOGLE_GONE, 'google_gone');
  const res = await tokenCall(env, doFetch, { grant_type: 'refresh_token', refresh_token: refresh });
  const body = await res.json().catch(() => ({}));
  if (body.error === 'invalid_grant') {
    await env.DB.prepare('update google_links set dead = 1 where user_id = ?').bind(link.user_id).run();
    throw fail(401, GOOGLE_GONE, 'google_gone');
  }
  if (!res.ok || !body.access_token) throw fail(502, 'Google didn\'t answer. Mullo tries again later.');
  tokens.set(link.user_id, { token: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

// What the app sends, checked: { id, title, notes, due, done, gone }.
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id ?? ''))) return null;
  const due = DAY.test(String(raw.due ?? '')) && !Number.isNaN(Date.parse(`${raw.due}T00:00:00Z`)) ? raw.due : null;
  return { id: raw.id, title: clip(raw.title, 500) || 'Task', notes: clip(raw.notes, 4000), due, done: raw.done === true, gone: raw.gone === true };
}

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
// Calendar lets the caller pick an event id: base32hex (0-9, a-v), 5 to 1024 characters.
export const eventIdFor = async (taskId) => `mullo${hex(await sha256(`task:${taskId}`)).slice(0, 40)}`;

function api(doFetch, token) {
  return async (method, url, body) => {
    const res = await doFetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  };
}

const gone = (status) => status === 404 || status === 410;
const googleSays = (r) => fail(502, `Google answered ${r.status}${r.data?.error?.message ? `: ${String(r.data.error.message).slice(0, 120)}` : ''}`);

async function calendarOf(env, call, link, { fresh = false } = {}) {
  if (link.calendar_id && !fresh) return link.calendar_id;
  const r = await call('POST', `${CAL}/calendars`, { summary: LIST_NAME, description: 'Tasks with a date, from Mullo.' });
  if (!r.ok || !r.data.id) throw googleSays(r);
  link.calendar_id = r.data.id;
  await env.DB.prepare('update google_links set calendar_id = ? where user_id = ?').bind(r.data.id, link.user_id).run();
  return r.data.id;
}

async function tasklistOf(env, call, link, { fresh = false } = {}) {
  if (link.tasklist_id && !fresh) return link.tasklist_id;
  let id = null;
  const listed = await call('GET', `${TASKS}/users/@me/lists?maxResults=100`);
  if (listed.ok) id = (listed.data.items ?? []).find((l) => l.title === LIST_NAME)?.id ?? null;
  if (!id) {
    const r = await call('POST', `${TASKS}/users/@me/lists`, { title: LIST_NAME });
    if (!r.ok || !r.data.id) throw googleSays(r);
    id = r.data.id;
  }
  link.tasklist_id = id;
  await env.DB.prepare('update google_links set tasklist_id = ? where user_id = ?').bind(id, link.user_id).run();
  return id;
}

// The Mullo calendar or list deleted in Google: made again once, then the step is retried.
async function withContainer(get, step) {
  const first = await step(await get({}));
  if (first !== 'container-gone') return first;
  const again = await step(await get({ fresh: true }));
  if (again === 'container-gone') throw fail(502, 'Google lost Mullo\'s calendar or list. Mullo tries again later.');
  return again;
}

async function pushEvent(env, call, link, item) {
  const eventId = await eventIdFor(item.id);
  return withContainer((o) => calendarOf(env, call, link, o), async (calId) => {
    const at = `${CAL}/calendars/${encodeURIComponent(calId)}/events`;
    if (item.gone || !item.due) {
      const r = await call('DELETE', `${at}/${eventId}`);
      if (r.ok || gone(r.status)) return 'ok';
      throw googleSays(r);
    }
    const event = {
      summary: `${item.done ? '✓ ' : ''}${item.title}`,
      description: item.notes,
      start: { date: item.due }, end: { date: nextDay(item.due) },
      status: 'confirmed', transparency: 'transparent',
    };
    // Update first (also brings back an event deleted earlier: Calendar keeps it as cancelled).
    let r = await call('PUT', `${at}/${eventId}`, event);
    if (r.ok) return 'ok';
    if (!gone(r.status)) throw googleSays(r);
    r = await call('POST', at, { id: eventId, ...event });
    if (r.ok) return 'ok';
    if (r.status === 409) { // another device made it meanwhile
      r = await call('PUT', `${at}/${eventId}`, event);
      if (r.ok) return 'ok';
    }
    if (gone(r.status)) return 'container-gone';
    throw googleSays(r);
  });
}

async function pushTask(env, call, link, item) {
  const mapped = await env.DB.prepare('select task_id from google_tasks where user_id = ? and action_id = ?').bind(link.user_id, item.id).first();
  return withContainer((o) => tasklistOf(env, call, link, o), async (listId) => {
    const at = `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`;
    if (item.gone) {
      if (mapped) {
        const r = await call('DELETE', `${at}/${encodeURIComponent(mapped.task_id)}`);
        if (!r.ok && !gone(r.status)) throw googleSays(r);
        await env.DB.prepare('delete from google_tasks where user_id = ? and action_id = ?').bind(link.user_id, item.id).run();
      }
      return 'ok';
    }
    const task = {
      title: item.title, notes: item.notes,
      due: item.due ? `${item.due}T00:00:00.000Z` : null,
      status: item.done ? 'completed' : 'needsAction',
      ...(item.done ? {} : { completed: null }),
    };
    if (mapped) {
      const r = await call('PATCH', `${at}/${encodeURIComponent(mapped.task_id)}`, task);
      if (r.ok) return 'ok';
      if (!gone(r.status)) throw googleSays(r);
    }
    const r = await call('POST', at, task);
    if (gone(r.status)) return 'container-gone';
    if (!r.ok || !r.data.id) throw googleSays(r);
    await env.DB.prepare(`insert into google_tasks (user_id, action_id, task_id) values (?, ?, ?)
      on conflict(user_id, action_id) do update set task_id = excluded.task_id`).bind(link.user_id, item.id, r.data.id).run();
    return 'ok';
  });
}

// POST /api/google/push { items } → { results: [{ id, ok, error? }] }. One task failing
// doesn't stop the rest; Google refusing the connection stops the whole batch.
export async function pushGoogle(env, doFetch, user, body) {
  if (!googleReady(env)) throw fail(503, GOOGLE_OFF);
  const link = await linkOf(env, user.userId);
  if (!link) throw fail(409, NOT_CONNECTED, 'google_not_connected');
  if (link.dead) throw fail(401, GOOGLE_GONE, 'google_gone');
  const raw = Array.isArray(body?.items) ? body.items : [];
  if (raw.length > MAX_PUSH) throw fail(400, `At most ${MAX_PUSH} tasks at a time.`);
  const items = raw.map(cleanItem);
  const want = parts(link.scopes);
  if (!tasksOn(env)) want.tasks = false;
  const call = api(doFetch, await accessToken(env, doFetch, link));
  const results = [];
  for (let i = 0; i < raw.length; i++) {
    const item = items[i];
    if (!item) { results.push({ id: String(raw[i]?.id ?? ''), ok: false, error: 'not a task' }); continue; }
    try {
      if (want.calendar) await pushEvent(env, call, link, item);
      if (want.tasks) await pushTask(env, call, link, item);
      results.push({ id: item.id, ok: true });
    } catch (err) {
      if (err.code === 'google_gone') throw err;
      results.push({ id: item.id, ok: false, error: err.message });
    }
  }
  if (results.some((r) => /answered 401/.test(r.error ?? ''))) tokens.delete(link.user_id); // a fresh token next time
  return { results };
}
