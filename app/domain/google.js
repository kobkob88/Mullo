// Google Calendar and Google Tasks (roadmap S9). Mullo's server holds the connection
// (worker/src/google.mjs); this side decides which tasks to send and when.
//
// Each device remembers what it last sent per task (a fingerprint, `echo:google:sent`), and
// sends only what changed since. A new open task goes; a done task goes only if Google
// already has it (so connecting doesn't fill Google with old finished tasks); a cancelled or
// deleted one is taken out of Google. Two devices sending the same change is harmless: the
// server lands both on the same event and task.
// One way only: what's changed in Google doesn't come back.

import { disk } from '../core/disk.js';
import { account } from '../core/account.js';
import { listActions } from './actions.js';
import { listRecordings } from './recordings.js';

const ON = 'echo:google:on';     // the Mullo user id whose Google is connected (as last seen)
const SENT = 'echo:google:sent'; // { user, items: { taskId: fingerprint } }
export const BATCH = 25;         // = the server's MAX_PUSH

let server = null; // Mullo's server, when this copy uses it (null: own server, PC bridge)
export function useGoogle(url) { server = url || null; }
export const googleAvailable = () => Boolean(server);

const me = () => account().user()?.id ?? null;
export const googleOn = () => Boolean(me()) && disk.get(ON, null) === me();

// Where a task came from, in its own direction. Google lays out a Hebrew task right to left, and
// 'From "X" in Mullo' came out as 'in Mullo "X" From' (owner, 2026-10-14). A Hebrew task gets a
// Hebrew line; any other right-to-left task a line with no English words to flip.
function fromLine(label, recordingTitle) {
  if (!recordingTitle) return 'From Mullo'; // all left to right: nothing to flip
  if (/\p{Script=Hebrew}/u.test(label)) return `מתוך "${recordingTitle}" ב-Mullo`;
  if (/[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u.test(label)) return `"${recordingTitle}" · Mullo`;
  return `From "${recordingTitle}" in Mullo`;
}

// What Google gets for one task. Notes carry the context and where it came from.
export function payloadFor(action, recordingTitle) {
  const notes = [action.context, fromLine(String(action.label ?? ''), recordingTitle)]
    .map((s) => String(s ?? '').trim()).filter(Boolean).join('\n\n');
  return {
    id: action.id,
    title: String(action.label ?? '').trim(),
    notes,
    due: action.due_date || null,
    done: action.status === 'done',
    gone: action.status === 'cancelled',
  };
}

export const fingerprint = (p) => JSON.stringify([p.title, p.notes, p.due, p.done, p.gone]);

// → the items to send: changed since last sent, new open tasks, and tasks gone from here.
export function planPush(actions, sent, titleOf = () => '') {
  const out = [];
  const here = new Set();
  for (const a of actions) {
    here.add(a.id);
    const p = payloadFor(a, titleOf(a.recording_id));
    const before = sent[a.id];
    if (before === undefined) { if (!p.done && !p.gone) out.push(p); }
    else if (before !== fingerprint(p)) out.push(p);
  }
  for (const id of Object.keys(sent)) if (!here.has(id)) out.push({ id, title: '', notes: '', due: null, done: false, gone: true });
  return out;
}

// After the server answered: remember what landed, forget what's gone.
export function applyResults(sent, items, results) {
  const next = { ...sent };
  const ok = new Set(results.filter((r) => r.ok).map((r) => r.id));
  for (const p of items) {
    if (!ok.has(p.id)) continue;
    if (p.gone) delete next[p.id];
    else next[p.id] = fingerprint(p);
  }
  return next;
}

function sentFor(user) {
  const s = disk.get(SENT, null);
  return s?.user === user && s.items && typeof s.items === 'object' ? s.items : {};
}

function forgetHere() {
  disk.remove(ON);
  disk.remove(SENT);
}

// The last pass, for Settings: { at, sent, failed, error }.
let last = null;
export const lastGoogleSync = () => last;

// One pass. Quiet when Google isn't connected, signed out, or offline (the next pass retries).
let running = null;
export function syncGoogle() {
  if (!running) running = pass().finally(() => { running = null; });
  return running;
}

async function pass() {
  const user = me();
  if (!server || !user || !googleOn()) return last;
  const [actions, recordings] = await Promise.all([listActions(), listRecordings()]);
  const titles = new Map(recordings.map((r) => [r.id, r.title]));
  let sent = sentFor(user);
  const todo = planPush(actions, sent, (id) => titles.get(id) ?? '');
  let done = 0;
  let failed = 0;
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const items = todo.slice(i, i + BATCH);
      const { results = [] } = await account().server(server, '/api/google/push', { items });
      sent = applyResults(sent, items, results);
      disk.set(SENT, { user, items: sent });
      done += results.filter((r) => r.ok).length;
      failed += results.filter((r) => !r.ok).length;
    }
    last = { at: Date.now(), sent: done, failed, error: failed ? 'Some tasks didn\'t reach Google. Mullo tries again later.' : null };
  } catch (err) {
    if (err.code === 'google_not_connected') forgetHere();
    last = { at: Date.now(), sent: done, failed, error: err.offline ? null : err.message, offline: Boolean(err.offline), gone: err.code === 'google_gone' };
  }
  return last;
}

// A pass a little later; changes in a row make one pass.
let timer = null;
export function googleSoon(ms = 3000) {
  if (!server || !googleOn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncGoogle().catch(() => {}); }, ms);
}

// Settings. → { ready, connected, calendar, tasks, gone }
export async function googleStatus() {
  const user = me();
  if (!server || !user) return { ready: false, connected: false };
  const s = await account().server(server, '/api/google');
  if (s.connected) {
    if (disk.get(ON, null) !== user) { disk.set(ON, user); disk.remove(SENT); }
  } else if (disk.get(ON, null) !== null) forgetHere();
  return s;
}

// → Google's consent page. `back`: 'web' comes back into this web app, 'app' to a page
// saying "go back to Mullo" (the phone apps open it in the browser).
export async function connectGoogle(back) {
  const { url } = await account().server(server, '/api/google/start', { back });
  return url;
}

export async function disconnectGoogle() {
  await account().server(server, '/api/google/disconnect', {});
  forgetHere();
  last = null;
}
