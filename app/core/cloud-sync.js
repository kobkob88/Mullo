// Keeping this device and the person's Mullo account (Supabase) in step.
// The device store stays the first stop for every write (recording works with
// no signal); this copies what landed up, in the background, and brings what
// other devices wrote down (see "Bringing the account down" below).
//
// - Signing in turns it on (whenSignedIn): that links this device to that
//   account; another account signing in here later copies nothing. Signed
//   out, nothing leaves.
// - Every confirmed write is queued (core/db.js tells us), as ONE entry per
//   row: the newest action wins. The row is read fresh when it is sent.
// - Deletes are only the ones a person made (db.remove). A row that isn't
//   here is never deleted there.
// - Parents before children (folders, recordings, then what hangs off them),
//   so the server's foreign keys hold.
// - A row the server refuses is set aside with the reason, never retried in a
//   loop and never blocking the rest. It is tried again on the next start.
// - Audio bytes go to the private bucket, <user id>/<file id>, after the rows.

import { db, setWriteHook } from './db.js';
import { disk } from './disk.js';
import { emit } from './bus.js';
import { account } from './account.js';
import { cursor, advanceCursor, mergeDelta } from './sync.js';
import { setRemoteAudio } from './files.js';
import { newId } from './ids.js';

const QUEUE = 'echo:cloud:queue';   // { "<table>:<id>": { op, v } }
const AUDIO = 'echo:cloud:audio';   // { "<file id>": v }
const STUCK = 'echo:cloud:stuck';   // { "<table>:<id>": { op, error, at } }
const LINK = 'echo:cloud:link';     // { userId, at }
const LAST = 'echo:cloud:last';     // ISO time of the last full pass with nothing left
const BASE = 'echo:cloud:base';     // { "<table>:<id>": row as it was before its unsent edit }
const CLASHES = 'echo:cloud:clashes'; // [{ table, id, field, at }] for the person to see
const PULLED = 'echo:cloud:pulled'; // ISO time of the last pull that finished
const AUDIO_GONE = 'echo:cloud:audio-gone'; // { "<file id>": v } audio to delete from the account (S44)
const cursorName = (table) => `cloud:${table}`; // sync.js keeps it as echo:cursor:cloud:<table>

// Server columns per surface (sql/001_core.sql + 002). owner_id and updated_at
// are never sent: the server fills in who and when.
export const COLUMNS = {
  folders: ['id', 'label', 'created_at'],
  recordings: ['id', 'title', 'title_edited', 'source', 'external_id', 'recorded_at', 'local_date', 'duration_ms', 'language',
    'template', 'status', 'folder_id', 'summary', 'sections', 'audio_file_id', 'engine', 'flags', 'created_at'],
  audio_files: ['id', 'recording_id', 'mime', 'bytes', 'duration_ms', 'supersedes', 'storage', 'created_at'],
  transcripts: ['id', 'recording_id', 'language', 'origin', 'segments', 'created_at'],
  action_items: ['id', 'recording_id', 'label', 'type', 'priority', 'status', 'due_date', 'context', 'origin', 'source',
    'external_id', 'payload', 'edited', 'completed_at', 'created_at'],
  activity: ['id', 'at', 'seq', 'actor', 'action', 'table', 'record_id', 'before', 'after', 'reason', 'batch'],
};
export const ORDER = ['folders', 'recordings', 'audio_files', 'transcripts', 'action_items', 'activity'];
const NEVER_SENT = new Set(['owner_id', 'updated_at', 'extra']);
// Not-null columns the server has a default for: never send them as null.
const FILL = {
  recordings: { title_edited: false, sections: [], flags: [] },
  action_items: { edited: false, source: 'device' },
  transcripts: { segments: [] },
};
const WHOLE = new Set(['duration_ms', 'bytes']);
// A request carries at most this many rows, and about this much JSON (a long
// meeting's transcript, or an activity entry holding one, is tens of KB).
const CHUNK = 100;
const CHUNK_BYTES = 800_000;

export function chunks(items, size = (x) => JSON.stringify(x.payload ?? x).length) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const item of items) {
    const n = size(item);
    if (cur.length && (cur.length >= CHUNK || bytes + n > CHUNK_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(item);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// A device row → the server's shape. Fields without a column ride in `extra`
// (activity has none: its before/after already hold whole rows).
export function toServerRow(table, row) {
  const cols = COLUMNS[table];
  const out = {};
  for (const c of cols) {
    let v = row[c] ?? FILL[table]?.[c] ?? null;
    if (WHOLE.has(c) && typeof v === 'number') v = Math.round(v);
    out[c] = v;
  }
  if (table !== 'activity') {
    const extra = { ...(row.extra ?? {}) };
    for (const [k, v] of Object.entries(row)) if (!cols.includes(k) && !NEVER_SENT.has(k)) extra[k] = v;
    out.extra = extra;
  }
  return out;
}

// ── Queue ───────────────────────────────────────────────────────────────
let version = Date.now();
const bump = () => (version += 1);

export const link = () => disk.get(LINK, null);
const queue = () => disk.get(QUEUE, {});

function enqueue(entries) {
  const q = queue();
  for (const [table, id, op] of entries) {
    const key = `${table}:${id}`;
    // An append is for good; a put after a delete (a restore) or a delete after
    // a put: the newest wins.
    q[key] = { op, v: bump() };
  }
  disk.set(QUEUE, q);
}

function enqueueAudio(ids) {
  const a = disk.get(AUDIO, {});
  for (const id of ids) a[id] = bump();
  disk.set(AUDIO, a);
}

// S44 "Keep the recording?": audio this phone deleted for good goes from the account too.
// Kept until the account says so (a pass with no signal tries again); never copied up meanwhile.
function forgetAccountAudio(ids) {
  if (!ids.length) return;
  const gone = disk.get(AUDIO_GONE, {});
  const up = disk.get(AUDIO, {});
  for (const id of ids) { gone[id] = bump(); delete up[id]; }
  disk.set(AUDIO_GONE, gone);
  disk.set(AUDIO, up);
  syncSoon(1000);
}

// Removes the keys that weren't queued again while they were being sent. A
// row that is settled is the account's copy again: its base isn't needed.
function settle(storeKey, sent) {
  const q = disk.get(storeKey, {});
  const base = storeKey === QUEUE ? disk.get(BASE, {}) : null;
  for (const [key, v] of sent) {
    const now = q[key];
    if (now != null && (now.v ?? now) === v) {
      delete q[key];
      if (base) delete base[key];
    }
  }
  disk.set(storeKey, q);
  if (base) disk.set(BASE, base);
}

// foreign: the server keeps a row with this id for ANOTHER account (row-level security said no).
// Typical after signing in with a second account on a phone whose notes are in the first one.
function setAside(key, op, error, foreign = false) {
  disk.set(STUCK, { ...disk.get(STUCK, {}), [key]: { op, error: String(error).slice(0, 300), at: new Date().toISOString(), ...(foreign ? { foreign: true } : {}) } });
}
const isForeign = (err) => err?.status === 403 || err?.code === '42501';

// Rows set aside last time get another go (a parent may have arrived since).
function retryStuck() {
  const stuck = disk.get(STUCK, {});
  const keys = Object.keys(stuck);
  if (!keys.length) return;
  const split = keys.map((k) => k.split(':'));
  enqueue(split.filter(([t]) => t !== 'audio').map(([t, id]) => [t, id, stuck[`${t}:${id}`].op]));
  enqueueAudio(split.filter(([t]) => t === 'audio').map(([, id]) => id));
  disk.set(STUCK, {});
}

// ── Linking ─────────────────────────────────────────────────────────────
// "Copy my notes into my account": everything on this device, then every
// change after it.
export async function linkDevice() {
  const user = account().user();
  if (!user) throw new Error('Sign in first.');
  const held = link();
  if (held && held.userId !== user.id) throw new Error('This device is copying to another account.');
  const entries = [];
  for (const table of ORDER) {
    for (const row of await db.list(table)) entries.push([table, row.id, table === 'activity' ? 'append' : 'put']);
  }
  enqueue(entries);
  const files = await db.list('audio_files');
  enqueueAudio(files.filter((f) => f.storage === 'device').map((f) => f.id));
  disk.set(LINK, { userId: user.id, at: new Date().toISOString() });
  emit('cloud', status());
  syncSoon(0);
  return entries.length;
}

// ── Changing servers (Settings → Developers → Your own server) ─────────
// Copies belong to one server. When this copy of Mullo now points at another one, what was
// waiting for the old server is dropped (the phone still has every row) and the new server
// starts unlinked: "Copy my notes" there is the move. → true when the server changed.
const SERVER = 'echo:cloud:server';
// The sql/ step this build needs on the server (its schema_version()). tests/setup-sql.test.mjs
// keeps it equal to the newest file in sql/.
export const SCHEMA_STEP = 5;
export function noteServer(url) {
  const before = disk.get(SERVER, null);
  if (before === (url ?? null)) return false;
  if (before !== null) forgetAccountCopy();
  disk.set(SERVER, url ?? null);
  return before !== null;
}

// The device lets go of the account copy: no link, nothing waiting, no cursors. On a server
// change, and after Delete account (a new sign-up then links this device afresh). The notes
// on this device are untouched.
export function forgetAccountCopy() {
  for (const k of [LINK, QUEUE, AUDIO, STUCK, LAST, BASE, CLASHES, PULLED]) disk.remove(k);
  for (const t of ORDER) disk.remove(`echo:cursor:${cursorName(t)}`);
}

// The move's check: rows here vs rows in the account, per table. → [{ table, here, there }]
// (there = null when the server couldn't say).
export async function compareCounts() {
  const out = [];
  for (const table of ORDER) {
    const here = (await db.list(table)).length;
    let there = null;
    try {
      const res = await account().request(`rest/v1/${table}?select=id`, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
      const total = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '');
      if (res.ok && total) there = Number(total[1]);
    } catch { /* offline: unknown */ }
    out.push({ table, here, there });
  }
  return out;
}

// Is this device copying, and to whom? 'off' | 'mine' | 'other'.
export function linkState() {
  const held = link();
  if (!held) return 'off';
  return held.userId === account().user()?.id ? 'mine' : 'other';
}

function onWrite({ op, table, id, previous }) {
  if (!link()) return;
  // The first unsent edit of a row keeps the row as it was: the base a later
  // pull merges against (what changed here vs what changed there).
  const key = `${table}:${id}`;
  if (op === 'put' && previous && !queue()[key]) {
    const base = disk.get(BASE, {});
    if (!base[key]) disk.set(BASE, { ...base, [key]: previous });
  }
  enqueue([[table, id, op]]);
  if (table === 'audio_files' && op === 'put') {
    db.get('audio_files', id).then((f) => {
      if (f?.storage === 'device' && !disk.get(AUDIO, {})[id]) { enqueueAudio([id]); syncSoon(); }
    }).catch(() => {});
  }
  syncSoon();
}

// ── Sending ─────────────────────────────────────────────────────────────
class Refused extends Error {}

async function call(path, init) {
  const res = await account().request(path, init);
  if (res.ok) return res;
  const body = await res.json().catch(() => null);
  const message = body?.message ?? body?.error ?? body?.msg ?? `${res.status}`;
  // 5xx, a timeout, too many requests: the server's problem, try again later.
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    const err = new Error(message);
    err.later = true;
    throw err;
  }
  const err = new Refused(message);
  err.status = res.status;
  err.code = body?.code ?? body?.statusCode ?? null;
  throw err;
}

const json = { 'Content-Type': 'application/json' };

async function sendRows(table, rows) {
  const prefer = table === 'activity'
    ? 'resolution=ignore-duplicates,return=minimal'
    : 'resolution=merge-duplicates,return=minimal,missing=default';
  await call(`rest/v1/${table}?on_conflict=id`, { method: 'POST', headers: { ...json, Prefer: prefer }, body: JSON.stringify(rows) });
}

async function sendDeletes(table, ids) {
  await call(`rest/v1/${table}?id=in.(${ids.join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

// A chunk the server refused: one by one, so only the bad row is set aside.
async function oneByOne(items, send) {
  const done = [];
  for (const item of items) {
    try {
      await send([item.payload]);
      done.push(item);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      setAside(item.key, item.op, err.message, isForeign(err));
      done.push(item); // settled: it's in STUCK now, not the queue
    }
  }
  return done;
}

async function pushRows() {
  const snapshot = Object.entries(queue());
  if (!snapshot.length) return 0;
  const byTable = new Map(ORDER.map((t) => [t, { put: [], delete: [] }]));
  for (const [key, { op, v }] of snapshot) {
    const [table, id] = key.split(':');
    const slot = byTable.get(table);
    if (!slot) { settle(QUEUE, [[key, v]]); continue; }
    (op === 'delete' ? slot.delete : slot.put).push({ key, id, op, v });
  }
  let sent = 0;
  // Writes parents first; deletes children first.
  for (const table of ORDER) {
    const items = [];
    for (const it of byTable.get(table).put) {
      const row = await db.get(table, it.id);
      if (!row) { settle(QUEUE, [[it.key, it.v]]); continue; } // deleted since; its delete is queued
      items.push({ ...it, payload: toServerRow(table, row) });
    }
    for (const chunk of chunks(items)) {
      let done = chunk;
      try {
        await sendRows(table, chunk.map((x) => x.payload));
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        done = await oneByOne(chunk, (rows) => sendRows(table, rows));
      }
      settle(QUEUE, done.map((x) => [x.key, x.v]));
      sent += done.length;
      emit('cloud', status());
    }
  }
  for (const table of [...ORDER].reverse()) {
    for (const chunk of chunks(byTable.get(table).delete, () => 40)) {
      let done = chunk;
      try {
        await sendDeletes(table, chunk.map((x) => x.id));
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        done = await oneByOne(chunk.map((x) => ({ ...x, payload: x.id })), (ids) => sendDeletes(table, ids));
      }
      settle(QUEUE, done.map((x) => [x.key, x.v]));
      sent += done.length;
    }
  }
  return sent;
}

const baseType = (mime) => String(mime ?? '').split(';')[0].trim() || 'application/octet-stream';

async function pushAudio(userId) {
  let sent = 0;
  for (const [id, v] of Object.entries(disk.get(AUDIO, {}))) {
    const [file, blob] = await Promise.all([db.get('audio_files', id), db.getBlob(id)]);
    if (!file || !blob) { settle(AUDIO, [[id, v]]); continue; } // gone from this device: nothing to copy
    try {
      await call(`storage/v1/object/audio/${userId}/${id}`, {
        method: 'POST', body: blob, headers: { 'Content-Type': baseType(file.mime), 'x-upsert': 'false', 'cache-control': '3600' },
      });
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      // Audio never changes: already there means done.
      if (!/exists|duplicate/i.test(err.message)) {
        setAside(`audio:${id}`, 'upload', err.status === 413 ? 'Too big for the account\'s file limit' : err.message);
      }
    }
    settle(AUDIO, [[id, v]]);
    sent += 1;
    emit('cloud', status());
  }
  return sent;
}

// S44: one call for up to 100 files, through the existing `audio_delete` policy (own folder only).
// Supabase answers 200 with the objects it removed; one already gone is simply not listed.
async function dropAccountAudio(userId) {
  const gone = Object.entries(disk.get(AUDIO_GONE, {}));
  for (let i = 0; i < gone.length; i += 100) {
    const part = gone.slice(i, i + 100);
    try {
      await call('storage/v1/object/audio', {
        method: 'DELETE', headers: json, body: JSON.stringify({ prefixes: part.map(([id]) => `${userId}/${id}`) }),
      });
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      // Refused: not ours to delete (another account's), or nothing there. Nothing left to try.
    }
    settle(AUDIO_GONE, part);
  }
  return gone.length;
}

// ── Bringing the account down ───────────────────────────────────────────
// A new or reset phone gets the account's rows; after that only what changed
// (a delta per table, against the server's own stamps: updated_at, and
// received_at for the activity log). Audio stays in the account until someone
// opens it (fetchAudio).
//
// - What comes down is written through db.adopt: no audit entry (the device
//   that made the change logged it, and that entry comes down too) and never
//   queued to go back up.
// - A row with an unsent edit here is merged field by field (sync.js
//   mergeDelta, against the row as it was before that edit): this phone's
//   edited fields win and go up with the next push; a field changed on both
//   sides is a clash, kept here and listed for the person.
// - Deletes come from the activity log (an entry with action 'delete'), never
//   from a row being absent. One is skipped when the row came back since (a
//   restore) or was changed here after it.
// - A row a person edited here while the pull was running isn't overwritten;
//   that table's cursor stays put so the next pull merges it properly.
// - The cursor only moves past rows that were applied; each pull starts a few
//   minutes before it (a write that committed late is still seen; applying a
//   row twice changes nothing).
const PAGE = 200;
const OVERLAP_MS = 5 * 60_000;
const PULL_EVERY_MS = 60_000;
const stampOf = (table) => (table === 'activity' ? 'received_at' : 'updated_at');

// A server row → the device's shape: `extra` spread back out, the server's
// updated_at kept (it is the row's stamp here too).
export function fromServerRow(table, row) {
  const { extra, received_at: _r, ...rest } = row;
  if (table === 'activity') { delete rest.owner_id; return rest; }
  return { ...(extra ?? {}), ...rest };
}

// Key order differs between a row made here and one rebuilt from `extra`.
const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const sameContent = (table, a, b) =>
  JSON.stringify(canonical(toServerRow(table, a))) === JSON.stringify(canonical(toServerRow(table, b)));

const since = (stamp) => new Date(Date.parse(stamp) - OVERLAP_MS).toISOString();
const later = (a, b) => Date.parse(a) > Date.parse(b);

function noteClashes(found) {
  if (!found.length) return;
  const at = new Date().toISOString();
  disk.set(CLASHES, [...disk.get(CLASHES, []), ...found.map((c) => ({ ...c, at }))].slice(-50));
}

// One row from the account. → false when a person's edit here got in between.
async function adoptRow(table, remote, base) {
  const key = `${table}:${remote.id}`;
  const local = await db.get(table, remote.id);
  // This phone's own write coming back: same content, only the server's stamp.
  // Left alone, so a screen holding this row's stamp doesn't see a false conflict.
  if (local && (local.updated_at === remote.updated_at || sameContent(table, local, remote))) return true;
  const current = local?.updated_at ?? null;
  const dirty = queue()[key]?.op === 'put';
  if (!local || !dirty) return (await db.adopt(table, remote, { current })).ok;
  const b = base[key];
  const { next, conflicts } = mergeDelta({
    base: b ? { [remote.id]: b } : {}, local: { [remote.id]: local }, changed: [remote], dirty: new Set([remote.id]),
  });
  // Keeps this phone's stamp: the merged row still goes up as an edit.
  const res = await db.adopt(table, { ...next[remote.id], updated_at: local.updated_at }, { current });
  if (!res.ok) return false;
  // What's agreed with the account now: the next merge compares against it.
  disk.set(BASE, { ...disk.get(BASE, {}), [key]: remote });
  noteClashes(conflicts.map((c) => ({ table, id: c.id, field: c.key })));
  return true;
}

// Deletes another device made, from its activity entries.
async function applyDeletes(entries, arrived) {
  let ok = true;
  const clashes = [];
  for (const e of entries) {
    if (e.action !== 'delete' || e.table === 'activity' || !COLUMNS[e.table]) continue;
    if (arrived.get(e.table)?.has(e.record_id)) continue; // it's in the account again
    const local = await db.get(e.table, e.record_id);
    if (!local) continue;
    if (local.updated_at && later(local.updated_at, e.at)) continue; // changed or restored here since
    if (queue()[`${e.table}:${e.record_id}`]?.op === 'put') {
      clashes.push({ table: e.table, id: e.record_id, field: '*' }); // deleted there, edited here: kept
      continue;
    }
    if (!(await db.forget(e.table, e.record_id, { current: local.updated_at ?? null })).ok) ok = false;
  }
  noteClashes(clashes);
  return ok;
}

async function pullTable(table, arrived) {
  const stamp = stampOf(table);
  const name = cursorName(table);
  const from = cursor(name);
  const seen = new Set();
  let after = from ? since(from) : null;
  let held = false; // a row wasn't applied: the cursor stays where it was
  let count = 0;
  for (;;) {
    const q = new URLSearchParams({ select: '*', order: `${stamp}.asc,id.asc`, limit: String(PAGE) });
    if (after) q.set(stamp, `gte.${after}`);
    const page = await (await call(`rest/v1/${table}?${q}`, { method: 'GET' })).json();
    const fresh = page.filter((r) => !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    const rows = fresh.map((r) => fromServerRow(table, r));
    let ok = true;
    if (table === 'activity') {
      for (const e of rows) await db.adoptLog(e);
      ok = await applyDeletes(rows, arrived);
    } else {
      const base = disk.get(BASE, {});
      for (const r of rows) if (!(await adoptRow(table, r, base))) ok = false;
      const ids = arrived.get(table) ?? new Set();
      for (const r of rows) ids.add(r.id);
      arrived.set(table, ids);
    }
    if (!ok) held = true;
    if (page.length && !held) advanceCursor(name, page[page.length - 1][stamp], { applied: true });
    count += fresh.length;
    if (fresh.length) emit('changed', { table, pulled: fresh.length });
    if (page.length < PAGE || !fresh.length) break;
    after = page[page.length - 1][stamp];
  }
  return count;
}

let pulledAt = 0;
let pulling = false;

// Parents first, the activity log (and so the deletes) last.
async function pullAll() {
  pulling = true;
  emit('cloud', status());
  try {
    const arrived = new Map();
    let count = 0;
    for (const table of ORDER) count += await pullTable(table, arrived);
    pulledAt = Date.now();
    disk.set(PULLED, new Date().toISOString());
    return count;
  } finally {
    pulling = false;
  }
}

// Audio that came down as a record only: its bytes from the account, kept here.
export async function fetchAudio(fileId) {
  if (linkState() !== 'mine') return null;
  const file = await db.get('audio_files', fileId);
  if (!file || file.storage === 'removed') return null;
  const have = await db.getBlob(fileId);
  if (have) return have;
  let blob;
  try {
    const res = await call(`storage/v1/object/authenticated/audio/${file.owner_id ?? link().userId}/${fileId}`, { method: 'GET' });
    blob = await res.blob();
  } catch (err) {
    if (err instanceof Refused) return null; // not uploaded (yet) from the phone that made it
    throw err;
  }
  if (!blob.type && file.mime) blob = new Blob([blob], { type: file.mime });
  await db.putBlob(fileId, blob);
  return blob;
}

export const clashes = () => disk.get(CLASHES, []);
export function clearClashes() {
  disk.remove(CLASHES);
  emit('cloud', status());
}

// ── Running ─────────────────────────────────────────────────────────────
let running = null;
let timer = null;
let lastError = null;

export function syncSoon(ms = 4000) {
  if (linkState() !== 'mine') return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow().catch(() => {}); }, ms);
}

// One pass: what changed in the account (at most once a minute unless asked),
// then everything queued here, then the audio. Single-flight. Pulling first
// means an edit here is merged with the account's newer copy before it goes up.
export function syncNow({ pull = false } = {}) {
  if (!running) {
    running = (async () => {
      if (linkState() !== 'mine') return status();
      try {
        if (pull || Date.now() - pulledAt >= PULL_EVERY_MS) await pullAll();
        await pushRows();
        await pushAudio(link().userId);
        await dropAccountAudio(link().userId);
        lastError = null;
        if (!Object.keys(queue()).length && !Object.keys(disk.get(AUDIO, {})).length && !Object.keys(disk.get(AUDIO_GONE, {})).length) disk.set(LAST, new Date().toISOString());
      } catch (err) {
        lastError = err.offline ? 'Waiting for a connection' : err.signedOut ? 'Signed out' : err.message;
        if (err.later) syncSoon(60_000);
      }
      emit('cloud', status());
      return status();
    })().finally(() => { running = null; });
  }
  return running;
}

export function status() {
  const stuck = disk.get(STUCK, {});
  return {
    state: linkState(),
    pending: Object.keys(queue()).length,
    audioPending: Object.keys(disk.get(AUDIO, {})).length,
    stuck: Object.keys(stuck).length,
    stuckReasons: [...new Set(Object.values(stuck).filter((s) => !s.foreign).map((s) => s.error))].slice(0, 3),
    // Rows here that the server keeps for another account; recordings are what a person counts.
    foreign: Object.values(stuck).filter((s) => s.foreign).length,
    foreignNotes: Object.entries(stuck).filter(([k, s]) => s.foreign && k.startsWith('recordings:')).length,
    lastDone: disk.get(LAST, null),
    lastPulled: disk.get(PULLED, null),
    clashes: clashes().length,
    error: lastError,
    running: Boolean(running),
    pulling,
  };
}

// ── Notes another account holds (owner, 2026-10-16) ─────────────────────
// Signed in with a second account (a Hide My Email address, a new sign-up after Delete account)
// on a phone whose notes are already in the first one: the server refuses those rows here
// (their ids are the other account's). "Use them in this account" gives each of them a new id,
// rewrites every reference to it on this phone (children, the audit log, anything in a row),
// moves its audio bytes, and copies them up as new rows. The other account keeps its copy.
// Only on a person's tap: on a shared phone, signing in must never pull someone else's notes in.
// → how many rows got a new id.
export async function useForeignHere() {
  if (!account().user() || linkState() !== 'mine') throw new Error('Sign in first.');
  const stuck = disk.get(STUCK, {});
  const ids = new Map();
  for (const [key, s] of Object.entries(stuck)) {
    const [table, id] = key.split(':');
    if (s.foreign && table !== 'audio') ids.set(id, newId());
  }
  if (!ids.size) return 0;
  const swap = (value) => {
    if (typeof value === 'string') return ids.get(value) ?? value;
    if (Array.isArray(value)) { const out = value.map(swap); return out.some((v, i) => v !== value[i]) ? out : value; }
    if (value && typeof value === 'object') {
      let changed = false;
      const out = {};
      for (const [k, v] of Object.entries(value)) { out[k] = swap(v); if (out[k] !== v) changed = true; }
      return changed ? out : value;
    }
    return value;
  };
  const queued = [];
  const audio = [];
  for (const table of ORDER) {
    for (const row of await db.list(table)) {
      const next = swap(row);
      if (next === row) continue;
      const renamed = ids.has(row.id);
      if (table === 'activity') {
        // Append-only: a log entry keeps its words; only one the other account holds is re-filed.
        if (!renamed) continue;
        await db.adoptLog(next);
        await db.forget('activity', row.id, { current: row.updated_at ?? null });
      } else if (renamed) {
        await db.adopt(table, next, { current: null });
        await db.forget(table, row.id, { current: row.updated_at ?? null });
      } else {
        await db.adopt(table, next, { current: row.updated_at ?? null });
      }
      queued.push([table, next.id, table === 'activity' ? 'append' : 'put']);
      if (table === 'audio_files' && renamed) audio.push([row.id, next.id]);
    }
  }
  // Audio bytes live under their file's id. Without bytes here the record comes along but the
  // sound stays with the other account.
  for (const [before, after] of audio) {
    const blob = await db.getBlob(before);
    if (!blob) continue;
    await db.putBlob(after, blob);
    await db.dropBlob(before, { intent: 'moved to its new id (notes used in this account)' });
    enqueueAudio([after]);
  }
  const left = {};
  for (const [key, s] of Object.entries(stuck)) {
    const [table, id] = key.split(':');
    if (s.foreign || (table === 'audio' && ids.has(id))) continue;
    left[key] = s;
  }
  disk.set(STUCK, left);
  enqueue(queued);
  retryStuck(); // a child refused for its foreign parent goes again now
  emit('changed', { table: null });
  emit('cloud', status());
  syncSoon(0);
  return ids.size;
}

// Linked to ANOTHER account (state 'other'), and the person says this phone should sync with the
// one signed in now: let go of the old link, link to this one. Only on a tap (whenSignedIn never
// switches). Rows the server keeps for the other account are refused as foreign, not mixed in.
export async function switchToThisAccount() {
  if (!account().user()) throw new Error('Sign in first.');
  forgetAccountCopy();
  return linkDevice();
}

// "Try again": the set-aside rows, now (after a server fix, say).
export function retryNow() {
  retryStuck();
  return syncNow();
}

// Signed in: syncing is on (owner, 2026-10-09: automatic, no "Copy my notes" tap).
// A device already copying to ANOTHER account is never switched over by itself:
// that would mix two people's notes.
export function whenSignedIn() {
  if (!account().user()) return;
  if (linkState() === 'off') linkDevice().catch(() => {});
  else syncSoon(1000);
}

// At boot: listen for writes, give set-aside rows another go, and start.
export function startCloudSync() {
  setWriteHook(onWrite);
  setRemoteAudio({ available: () => linkState() === 'mine', fetch: fetchAudio, forget: forgetAccountAudio });
  if (linkState() === 'mine') { retryStuck(); syncSoon(1500); }
  else whenSignedIn();
}
