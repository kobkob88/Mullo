import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';
import { disk } from '../app/core/disk.js';
import { createAccount, useAccount } from '../app/core/account.js';
import { setSession, accountSession } from '../app/core/auth.js';
import { flushAudit } from '../app/core/audit.js';
import {
  linkDevice, linkState, syncNow, startCloudSync, status, toServerRow, chunks, noteServer,
  fromServerRow, clashes, clearClashes, whenSignedIn, useForeignHere, switchToThisAccount,
} from '../app/core/cloud-sync.js';
import { db } from '../app/core/db.js';
import { newId } from '../app/core/ids.js';
import { audioInAccount, audioBlob, removeAudioEverywhere } from '../app/core/files.js';

test('another server: what waited for the old one is dropped and the new one starts unlinked', () => {
  disk.remove('echo:cloud:server');
  disk.set('echo:cloud:link', { userId: 'u1', at: 'x' });
  disk.set('echo:cloud:queue', { 'recordings:a': { op: 'put', v: 1 } });
  assert.equal(noteServer('https://mullo.example'), false, 'first run only remembers it');
  assert.ok(disk.get('echo:cloud:link', null), 'an existing link survives the first run');
  assert.equal(noteServer('https://mullo.example'), false, 'same server: nothing happens');
  assert.equal(noteServer('https://own.example'), true);
  assert.equal(disk.get('echo:cloud:link', null), null);
  assert.deepEqual(disk.get('echo:cloud:queue', {}), {});
  disk.remove('echo:cloud:server');
});
import { createRecording, updateRecording, deleteRecording, getRecording } from '../app/domain/recordings.js';
import { saveTranscript } from '../app/domain/transcripts.js';
import { addAction, setActionWhen } from '../app/domain/actions.js';
import { createFolder } from '../app/domain/folders.js';
import { saveAudio } from '../app/core/files.js';

const URL_ = 'https://project.example';
const ME = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'me@example.com' };
const SOMEONE = { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'other@example.com' };

// A fake Supabase: PostgREST upserts/deletes per table with the schema's
// foreign keys, and the Storage bucket. Atomic per request, like Postgres.
function fakeSupabase() {
  const tables = { folders: new Map(), recordings: new Map(), audio_files: new Map(), transcripts: new Map(), action_items: new Map(), activity: new Map() };
  const objects = new Map();
  const log = [];
  let down = false;
  const refuse = new Set(); // row ids the server refuses (a bad row)
  const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });
  // The server's clock: Postgres-shaped, microseconds, always rising (the set_updated_at trigger).
  let micros = Date.now() * 1000;
  const stamp = () => {
    micros += 1;
    return `${new Date(Math.floor(micros / 1000)).toISOString().slice(0, 23)}${String(micros % 1000).padStart(3, '0')}+00:00`;
  };
  let owner = ME.id;

  function check(table, row) {
    if (refuse.has(row.id)) return { status: 400, code: '22P02', message: 'invalid input syntax' };
    // Row-level security: an id another account owns is not this one's to write.
    const held = tables[table].get(row.id);
    if (held && held.owner_id !== owner) return { status: 403, code: '42501', message: `new row violates row-level security policy for table "${table}"` };
    const parent = (t, id) => id == null || tables[t].has(id);
    if (['transcripts', 'action_items', 'audio_files'].includes(table) && !parent('recordings', row.recording_id)) {
      return { status: 409, code: '23503', message: `insert or update on table "${table}" violates foreign key constraint` };
    }
    if (table === 'recordings' && !parent('folders', row.folder_id)) return { status: 409, code: '23503', message: 'folder fk' };
    return null;
  }

  const fetch = async (url, init) => {
    if (down) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '');
    log.push({ method: init.method, path, query: u.search, auth: init.headers.Authorization, prefer: init.headers.Prefer });
    let m;
    if ((m = /^rest\/v1\/(\w+)$/.exec(path)) && init.method === 'POST') {
      const table = m[1];
      const rows = JSON.parse(init.body);
      for (const row of rows) {
        const bad = check(table, row);
        if (bad) return answer(bad.status, bad);
        assert.equal(row.owner_id, undefined, 'owner_id is never sent');
        assert.equal(row.updated_at, undefined, 'updated_at is never sent');
      }
      for (const row of rows) {
        if (table === 'activity') { if (!tables.activity.has(row.id)) tables.activity.set(row.id, { ...row, owner_id: owner, received_at: stamp() }); continue; }
        tables[table].set(row.id, { ...(tables[table].get(row.id) ?? {}), ...row, owner_id: owner, updated_at: stamp() });
      }
      return answer(201, null);
    }
    if ((m = /^rest\/v1\/(\w+)$/.exec(path)) && init.method === 'GET') {
      const col = m[1] === 'activity' ? 'received_at' : 'updated_at';
      const [field, dir] = u.searchParams.get('order').split(',')[0].split('.');
      assert.deepEqual([field, dir], [col, 'asc'], 'deltas are read oldest first by the server\'s stamp');
      const gte = u.searchParams.get(col)?.replace(/^gte\./, '');
      const rows = [...tables[m[1]].values()]
        .filter((r) => !gte || Date.parse(r[col]) >= Date.parse(gte))
        .sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : a.id < b.id ? -1 : 1))
        .slice(0, Number(u.searchParams.get('limit')));
      return answer(200, structuredClone(rows));
    }
    if ((m = /^storage\/v1\/object\/authenticated\/audio\/([^/]+)\/([^/]+)$/.exec(path))) {
      const obj = m[1] === owner ? objects.get(`${owner}/${m[2]}`) ?? (owner === ME.id ? objects.get(m[2]) : null) : null;
      if (!obj) return answer(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return { ...answer(200, null), blob: async () => new Blob([new Uint8Array(obj.size)]) };
    }
    if ((m = /^rest\/v1\/(\w+)$/.exec(path)) && init.method === 'DELETE') {
      const ids = /^in\.\((.*)\)$/.exec(u.searchParams.get('id'))[1].split(',');
      for (const id of ids) tables[m[1]].delete(id);
      if (m[1] === 'recordings') for (const t of ['transcripts', 'action_items']) for (const [id, r] of tables[t]) if (ids.includes(r.recording_id)) tables[t].delete(id);
      return answer(204, null);
    }
    // S44: Storage's bulk delete; RLS (audio_delete) lets each account remove only its own folder.
    if (path === 'storage/v1/object/audio' && init.method === 'DELETE') {
      const removed = [];
      for (const p of JSON.parse(init.body).prefixes) {
        const [folder, id] = p.split('/');
        const okey = owner === ME.id ? id : `${owner}/${id}`;
        if (folder === owner && objects.delete(okey)) removed.push({ name: p });
      }
      return answer(200, removed);
    }
    if ((m = /^storage\/v1\/object\/audio\/([^/]+)\/([^/]+)$/.exec(path))) {
      if (m[1] !== owner) return answer(403, { statusCode: '403', message: 'new row violates row-level security policy' });
      const okey = owner === ME.id ? m[2] : `${owner}/${m[2]}`;
      if (objects.has(okey)) return answer(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      objects.set(okey, { type: init.headers['Content-Type'], size: init.body.size });
      return answer(200, { Key: `audio/${m[1]}/${m[2]}` });
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  // Another device of the same person writing straight into the account.
  const write = (table, row) => tables[table].set(row.id, { ...(tables[table].get(row.id) ?? {}), ...row, owner_id: owner, updated_at: stamp() });
  const log_ = (entry) => tables.activity.set(entry.id, { ...entry, owner_id: owner, received_at: stamp() });
  return { fetch, tables, objects, log, refuse, write, logEntry: log_, setDown: (v) => { down = v; }, setOwner: (id) => { owner = id; } };
}

function signIn(server, user = ME) {
  const session = { access_token: 'tok', refresh_token: 'ref', expires_at: Math.floor(Date.now() / 1000) + 3600, user };
  let held = session;
  const acct = createAccount({ url: URL_, key: 'pk', fetch: server.fetch, store: { load: () => held, save: (s) => { held = s; }, clear: () => { held = null; } } });
  useAccount(acct);
  setSession(accountSession(acct.user()));
  return acct;
}

const audio = (n = 10) => new Blob([new Uint8Array(n)], { type: 'audio/mp4' });

// Everything sync keeps on the device (a reset phone has none of it).
function resetDevice() {
  for (const k of ['queue', 'audio', 'stuck', 'link', 'last', 'base', 'clashes', 'pulled']) disk.remove(`echo:cloud:${k}`);
  for (const t of ['folders', 'recordings', 'audio_files', 'transcripts', 'action_items', 'activity']) disk.remove(`echo:cursor:cloud:${t}`);
}

// The same person on a second (new or reset) phone: an empty store, signed in, linked, pulled.
async function newPhone(server) {
  freshDb();
  resetDevice();
  startCloudSync();
  signIn(server);
  await linkDevice();
  await syncNow({ pull: true });
}

beforeEach(() => {
  freshDb();
  resetDevice();
  useAccount(createAccount({}));
  startCloudSync();
});

async function someNotes() {
  const folder = (await createFolder('Work')).row;
  const rec = await createRecording({ title: 'Planning call', folder_id: folder.id, duration_ms: 61234.6 });
  await updateRecording(rec.id, { speakers: { 'Speaker 1': 'Dana' } });
  await saveTranscript(rec.id, [{ text: 'hello', start_ms: 0, end_ms: 900 }], { language: 'en' });
  const task = (await addAction(rec.id, { label: 'Email Dana' })).row;
  await setActionWhen(task, '2026-10-16', '09:00'); // due_time has no column: it rides in extra
  const file = await saveAudio(audio(), { recordingId: rec.id, durationMs: 61_000 });
  await updateRecording(rec.id, { audio_file_id: file.id });
  await flushAudit();
  return { folder, rec, task, file };
}

test('a device row → the server\'s shape: columns, extra for the rest, never who or when', () => {
  const row = toServerRow('recordings', {
    id: 'r1', title: 'T', source: 'watch', recorded_at: 'x', local_date: '2026-10-07', status: 'ready',
    duration_ms: 1500.7, speakers: { 'Speaker 1': 'Dana' }, transcribe_job: { id: 'j' }, owner_id: 'evil', updated_at: 'u',
  });
  assert.equal(row.duration_ms, 1501);
  assert.deepEqual(row.sections, []);
  assert.deepEqual(row.flags, []);
  assert.equal(row.title_edited, false);
  assert.deepEqual(row.extra, { speakers: { 'Speaker 1': 'Dana' }, transcribe_job: { id: 'j' } });
  assert.ok(!('owner_id' in row) && !('updated_at' in row));
  assert.ok(!('extra' in toServerRow('activity', { id: 'a', table: 'recordings', surprise: 1 })), 'activity has no extra');
});

test('nothing leaves the device until the person links it', async () => {
  const server = fakeSupabase();
  signIn(server);
  await someNotes();
  assert.equal(linkState(), 'off');
  await syncNow();
  assert.deepEqual(server.log, []);
  assert.equal(status().pending, 0, 'writes before linking are not queued');
});

test('linking copies everything: parents first, extra fields kept, audio into the person\'s folder', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec, task, file } = await someNotes();
  const queued = await linkDevice();
  assert.ok(queued > 6);
  await syncNow();

  assert.equal(server.tables.folders.size, 1);
  assert.equal(server.tables.recordings.get(rec.id).title, 'Planning call');
  assert.equal(server.tables.recordings.get(rec.id).duration_ms, 61235);
  assert.deepEqual(server.tables.recordings.get(rec.id).extra.speakers, { 'Speaker 1': 'Dana' });
  assert.equal(server.tables.transcripts.size, 1);
  assert.equal(server.tables.action_items.get(task.id).extra.due_time, '09:00');
  assert.ok(server.tables.activity.size >= 6, 'the activity log goes too');
  assert.deepEqual(server.objects.get(file.id), { type: 'audio/mp4', size: 10 });
  assert.ok(server.log.every((c) => c.auth === 'Bearer tok'));
  const order = server.log.filter((c) => c.method === 'POST').map((c) => c.path.split('/').pop());
  assert.deepEqual([...new Set(order)], ['folders', 'recordings', 'audio_files', 'transcripts', 'action_items', 'activity', file.id]);
  const s = status();
  assert.deepEqual([s.state, s.pending, s.audioPending, s.stuck], ['mine', 0, 0, 0]);
  assert.ok(s.lastDone);
});

test('after linking, edits and deletes follow; a delete is only one a person made', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();

  await updateRecording(rec.id, { title: 'Planning call (renamed)' });
  await syncNow();
  assert.equal(server.tables.recordings.get(rec.id).title, 'Planning call (renamed)');

  const other = await createRecording({ title: 'Second' });
  await syncNow();
  assert.ok(server.tables.recordings.has(other.id));

  await deleteRecording(await getRecording(rec.id), { reason: 'test' });
  await flushAudit();
  await syncNow();
  assert.equal(server.tables.recordings.has(rec.id), false);
  assert.equal(server.tables.transcripts.size, 0);
  assert.ok(server.tables.recordings.has(other.id), 'the other note is untouched');
  assert.ok([...server.tables.activity.values()].some((e) => e.action === 'delete' && e.record_id === rec.id), 'the delete is in the log, restorable');
});

test('offline loses nothing: the queue waits and goes when the connection is back', async () => {
  const server = fakeSupabase();
  signIn(server);
  await someNotes();
  await linkDevice();
  server.setDown(true);
  const s = await syncNow();
  assert.equal(s.error, 'Waiting for a connection');
  assert.ok(s.pending > 0);
  server.setDown(false);
  await syncNow();
  assert.equal(status().pending, 0);
  assert.equal(server.tables.recordings.size, 1);
});

test('a row the server refuses is set aside with the reason; the rest still go, and it gets another go on the next start', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { task } = await someNotes();
  const extra = (await addAction((await createRecording({ title: 'B' })).id, { label: 'Call the broker' })).row;
  server.refuse.add(task.id);
  await linkDevice();
  await syncNow();
  assert.ok(server.tables.action_items.has(extra.id), 'the good task in the same request went');
  assert.equal(server.tables.action_items.has(task.id), false);
  assert.equal(status().stuck, 1);
  assert.match(status().stuckReasons[0], /invalid input/);

  server.refuse.delete(task.id);
  startCloudSync(); // next start
  await syncNow();
  assert.ok(server.tables.action_items.has(task.id));
  assert.equal(status().stuck, 0);
});

test('audio already in the account counts as copied', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { file } = await someNotes();
  server.objects.set(file.id, { type: 'audio/mp4', size: 10 });
  await linkDevice();
  await syncNow();
  assert.deepEqual([status().audioPending, status().stuck], [0, 0]);
});

test('S44: audio deleted for good goes from the account too, once, after the rows; offline it waits', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { file } = await someNotes();
  await linkDevice();
  await syncNow();
  assert.ok(server.objects.has(file.id));

  server.setDown(true);
  const res = await removeAudioEverywhere(await db.get('audio_files', file.id), { reason: 'test' });
  assert.equal(res.ok, true);
  await syncNow();
  assert.ok(server.objects.has(file.id), 'no signal: still there, still queued');
  assert.ok(disk.get('echo:cloud:audio-gone', {})[file.id] != null, 'waiting to be deleted');

  server.setDown(false);
  await syncNow();
  assert.equal(server.objects.has(file.id), false, 'gone from the account');
  assert.equal(server.tables.audio_files.get(file.id).storage, 'removed', 'the row says why, for the other devices');
  const deletes = server.log.filter((c) => c.method === 'DELETE' && c.path === 'storage/v1/object/audio');
  assert.equal(deletes.length, 1);
  assert.deepEqual(disk.get('echo:cloud:audio-gone', {}), {});
  await syncNow();
  assert.equal(server.log.filter((c) => c.method === 'DELETE' && c.path === 'storage/v1/object/audio').length, 1, 'asked once');
  assert.equal(await audioBlob(file.id), null, 'and nothing to fetch back down');
});

test('another account signed in on a linked device: nothing is copied to it', async () => {
  const server = fakeSupabase();
  signIn(server);
  await someNotes();
  await linkDevice();
  await syncNow();
  const before = server.log.length;

  signIn(server, SOMEONE);
  assert.equal(linkState(), 'other');
  await createRecording({ title: 'Written while someone else is signed in' });
  await syncNow();
  assert.equal(server.log.length, before, 'nothing sent under the other account');
  await assert.rejects(linkDevice(), /another account/);
});

test('signed out on a linked device: changes wait for the same person to sign back in', async () => {
  const server = fakeSupabase();
  signIn(server);
  await someNotes();
  await linkDevice();
  await syncNow();
  useAccount(createAccount({}));
  const later = await createRecording({ title: 'Recorded while signed out' });
  await syncNow();
  assert.equal(server.tables.recordings.has(later.id), false);
  signIn(server);
  await syncNow();
  assert.ok(server.tables.recordings.has(later.id));
});

test('signing in turns syncing on by itself; signed out, or another account\'s device, it does not', async () => {
  const server = fakeSupabase();
  whenSignedIn();
  assert.equal(linkState(), 'off', 'signed out: nothing');
  signIn(server);
  const { rec } = await someNotes();
  whenSignedIn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(linkState(), 'mine');
  await syncNow();
  assert.ok(server.tables.recordings.has(rec.id));

  signIn(server, SOMEONE);
  whenSignedIn();
  assert.equal(linkState(), 'other', 'never switched to another person by itself');
});

test('starting the app signed in, on a device that never synced: it starts', async () => {
  const server = fakeSupabase();
  signIn(server);
  await someNotes();
  startCloudSync();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(linkState(), 'mine');
});

// ── Sync down ───────────────────────────────────────────────────────────

// An activity entry another device wrote (its delete, say).
const entry = (fields) => ({
  id: newId(), at: new Date().toISOString(), seq: 'x', actor: ME.id, before: null, after: null, reason: null, batch: null, ...fields,
});

test('a server row → the device\'s shape: extra spread back out, the server\'s stamp kept', () => {
  const row = fromServerRow('recordings', { id: 'r1', title: 'T', owner_id: 'o', updated_at: 's1', extra: { speakers: { a: 'Dana' } } });
  assert.deepEqual(row, { speakers: { a: 'Dana' }, id: 'r1', title: 'T', owner_id: 'o', updated_at: 's1' });
  assert.deepEqual(fromServerRow('activity', { id: 'a', owner_id: 'o', received_at: 'r', action: 'insert' }), { id: 'a', action: 'insert' });
});

test('a new phone gets the whole account; nothing it pulled is copied back up', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { folder, rec, task, file } = await someNotes();
  await linkDevice();
  await syncNow();

  await newPhone(server);
  const here = await getRecording(rec.id);
  assert.equal(here.title, 'Planning call');
  assert.equal(here.folder_id, folder.id);
  assert.deepEqual(here.speakers, { 'Speaker 1': 'Dana' }, 'fields without a column come back from extra');
  assert.equal((await db.get('action_items', task.id)).due_time, '09:00');
  assert.equal((await db.list('transcripts')).length, 1);
  assert.equal((await db.list('activity')).length, server.tables.activity.size, 'the history comes too (Activity, restore)');
  assert.equal(status().pending, 0);
  assert.ok(status().lastPulled);
  const afterPull = server.log.length;
  await syncNow({ pull: true });
  assert.equal(server.log.slice(afterPull).filter((c) => c.method !== 'GET').length, 0, 'nothing went back up');

  // Audio: the record came, the bytes wait in the account until asked for.
  assert.equal(await db.getBlob(file.id), null);
  assert.equal(await audioInAccount(file.id), true);
  const blob = await audioBlob(file.id);
  assert.equal(blob.size, 10);
  assert.equal(blob.type, 'audio/mp4');
  assert.ok(await db.getBlob(file.id), 'kept here once fetched');
  assert.equal(await audioInAccount(file.id), false);
});

test('after the first pull only what changed comes down', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();
  await newPhone(server);

  server.write('recordings', { id: rec.id, title: 'Renamed on the other phone' });
  const before = server.log.length;
  await syncNow({ pull: true });
  assert.equal((await getRecording(rec.id)).title, 'Renamed on the other phone');
  const gets = server.log.slice(before).filter((c) => c.method === 'GET');
  assert.ok(gets.every((c) => /(updated_at|received_at)=gte\./.test(decodeURIComponent(c.query))), 'a delta, never the full table');
});

test('own writes coming back keep this phone\'s stamp (no false "changed meanwhile")', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();
  const stamp = (await getRecording(rec.id)).updated_at;
  await syncNow({ pull: true });
  assert.equal((await getRecording(rec.id)).updated_at, stamp);
});

test('a delete made on another device comes down from its activity entry; a restore there is not undone', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  const kept = await createRecording({ title: 'Deleted, then restored there' });
  await flushAudit();
  await linkDevice();
  await syncNow();
  await newPhone(server);

  server.tables.recordings.delete(rec.id);
  server.logEntry(entry({ action: 'delete', table: 'recordings', record_id: rec.id }));
  server.logEntry(entry({ action: 'delete', table: 'recordings', record_id: kept.id }));
  server.write('recordings', { id: kept.id, title: 'Deleted, then restored there' }); // the restore
  await syncNow({ pull: true });
  assert.equal(await getRecording(rec.id), null);
  assert.ok(await getRecording(kept.id));
  assert.equal(status().pending, 0, 'a delete that came down is not sent back');
});

test('edited here offline and there: merged field by field, this phone\'s field wins, the clash is listed', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();

  server.setDown(true);
  await updateRecording(rec.id, { title: 'Title from this phone' });
  await syncNow();
  server.setDown(false);
  server.write('recordings', { id: rec.id, title: 'Title from the other phone', summary: 'Summary from the other phone' });

  await syncNow({ pull: true });
  const here = await getRecording(rec.id);
  assert.equal(here.title, 'Title from this phone');
  assert.equal(here.summary, 'Summary from the other phone', 'their untouched-here field comes down');
  assert.equal(server.tables.recordings.get(rec.id).title, 'Title from this phone', 'the merged row went up');
  assert.equal(server.tables.recordings.get(rec.id).summary, 'Summary from the other phone');
  assert.deepEqual(clashes().map((c) => [c.id, c.field]), [[rec.id, 'title']]);
  assert.equal(status().clashes, 1);
  clearClashes();
  assert.equal(status().clashes, 0);
});

test('a field edited only there, with an unsent edit of another field here: no clash', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();
  server.setDown(true);
  await updateRecording(rec.id, { title: 'Mine' });
  await syncNow();
  server.setDown(false);
  server.write('recordings', { id: rec.id, summary: 'Theirs' });
  await syncNow({ pull: true });
  const here = await getRecording(rec.id);
  assert.deepEqual([here.title, here.summary], ['Mine', 'Theirs']);
  assert.equal(status().clashes, 0);
});

test('deleted there, edited here: the edit is kept and listed, not lost', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();
  server.setDown(true);
  await new Promise((r) => setTimeout(r, 5));
  server.tables.recordings.delete(rec.id);
  server.logEntry(entry({ action: 'delete', table: 'recordings', record_id: rec.id, at: new Date(Date.now() + 60_000).toISOString() }));
  await updateRecording(rec.id, { title: 'Still editing here' });
  await syncNow();
  server.setDown(false);
  await syncNow({ pull: true });
  assert.equal((await getRecording(rec.id)).title, 'Still editing here');
  assert.deepEqual(clashes().map((c) => c.field), ['*']);
});

test('a person\'s edit while the pull runs is not overwritten', async () => {
  const server = fakeSupabase();
  signIn(server);
  const { rec } = await someNotes();
  await linkDevice();
  await syncNow();
  await newPhone(server);
  server.write('recordings', { id: rec.id, title: 'From the account' });
  // The pull read the row; a person saves before the account's copy lands.
  const adopt = db.adopt;
  db.adopt = async (table, row, opts) => {
    if (table === 'recordings') await updateRecording(rec.id, { title: 'Typed meanwhile' });
    db.adopt = adopt;
    return adopt(table, row, opts);
  };
  await syncNow({ pull: true });
  assert.equal((await getRecording(rec.id)).title, 'Typed meanwhile');
  assert.equal(server.tables.recordings.get(rec.id).title, 'Typed meanwhile', 'and it went up');
});

test('requests stay small: big rows are split by size as well as count', () => {
  const big = { payload: { text: 'x'.repeat(300_000) } };
  assert.deepEqual(chunks([big, big, big, big]).map((c) => c.length), [2, 2]);
  assert.deepEqual(chunks(Array.from({ length: 250 }, (_, i) => ({ payload: i }))).map((c) => c.length), [100, 100, 50]);
});

// Owner, 2026-10-16: a second account on a phone whose notes are in the first one (Hide My Email,
// or a new sign-up after Delete account).
async function secondAccount() {
  const server = fakeSupabase();
  signIn(server);
  const notes = await someNotes();
  await linkDevice();
  await syncNow();
  signIn(server, SOMEONE);
  server.setOwner(SOMEONE.id);
  return { server, ...notes };
}

test('notes another account holds: refused as that account\'s, said plainly, not mixed in', async () => {
  const { server, rec } = await secondAccount();
  assert.equal(linkState(), 'other', 'never switched by itself');
  await switchToThisAccount();
  assert.equal(linkState(), 'mine');
  await syncNow();
  const s = status();
  assert.ok(s.foreign > 0);
  assert.equal(s.foreignNotes, 1, 'one recording, counted as one note');
  assert.deepEqual(s.stuckReasons, [], 'not shown as an unexplained failure');
  assert.equal(server.tables.recordings.get(rec.id).owner_id, ME.id, 'the first account\'s copy is untouched');
});

test('"Use them in this account": new ids, every link kept, audio moved, all copied; the old account keeps its copy', async () => {
  const { server, rec, task, file, folder } = await secondAccount();
  await switchToThisAccount();
  await syncNow();
  const renamed = await useForeignHere();
  assert.ok(renamed >= 5, 'folder, recording, audio, transcript, task (and their log entries)');
  await syncNow();
  assert.equal(status().stuck, 0, 'nothing left set aside');
  assert.equal(await db.get('recordings', rec.id), null, 'the old id is gone from the phone');

  const [mine] = (await db.list('recordings')).filter((r) => r.title === 'Planning call');
  assert.notEqual(mine.id, rec.id);
  const [myFolder] = await db.list('folders');
  assert.notEqual(myFolder.id, folder.id);
  assert.equal(mine.folder_id, myFolder.id, 'the recording points at the new folder');
  const [myTask] = (await db.list('action_items')).filter((a) => a.label === 'Email Dana');
  assert.notEqual(myTask.id, task.id);
  assert.equal(myTask.recording_id, mine.id);
  const [myFile] = await db.list('audio_files');
  assert.notEqual(myFile.id, file.id);
  assert.equal(myFile.recording_id, mine.id);
  assert.equal(mine.audio_file_id, myFile.id, 'a reference inside the row follows too');
  assert.ok(await db.getBlob(myFile.id), 'the audio bytes moved to the new id');
  assert.equal(await db.getBlob(file.id), null);

  for (const [table, id] of [['recordings', mine.id], ['folders', myFolder.id], ['action_items', myTask.id], ['audio_files', myFile.id]]) {
    assert.equal(server.tables[table].get(id)?.owner_id, SOMEONE.id, `${table} copied into this account`);
  }
  assert.ok(server.objects.has(`${SOMEONE.id}/${myFile.id}`), 'audio uploaded into this account\'s folder');
  assert.equal(server.tables.recordings.get(rec.id).owner_id, ME.id, 'the first account keeps its copy');
});

test('nothing another account holds: "use them here" changes nothing', async () => {
  const server = fakeSupabase();
  signIn(server);
  await someNotes();
  await linkDevice();
  await syncNow();
  assert.equal(await useForeignHere(), 0);
  assert.equal(status().foreign, 0);
});
