// sql/001_core.sql on PGlite (Postgres in WASM), with stand-ins for Supabase's
// auth.uid(), roles and Storage. A red team: a second person (and a signed-out
// visitor) trying to reach the first person's notes. Never touches a real database.
// Needs PGlite, which the repo doesn't install (zero dependencies):
//   npm i --no-save @electric-sql/pglite@0.2   then   npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let PGlite = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* skipped below */ }
const skip = PGlite ? false : 'PGlite not installed (npm i --no-save @electric-sql/pglite@0.2)';

// CORE_SQL: run against another file (used to prove the tests catch a broken schema).
const SQL = readFileSync(process.env.CORE_SQL ?? new URL('../../sql/001_core.sql', import.meta.url), 'utf8');
// Every later step, in order, on top (sql/ is applied as numbered steps).
const LATER = process.env.CORE_SQL ? [] : ['002_extra_and_indexes.sql', '003_connected_apps.sql', '004_no_password_signins.sql', '005_delete_account.sql']
  .map((f) => readFileSync(new URL(`../../sql/${f}`, import.meta.url), 'utf8'));
const later = { skip: process.env.CORE_SQL ? 'only 001 under CORE_SQL' : false };
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

let db;
const rows = async (sql, p) => (await db.query(sql, p)).rows;
// Run as a person (or signed out). Errors come back as { error } so a test can expect them.
// app: the token came from a connected app (Supabase OAuth: it carries a client_id).
async function as(who, sql, params, { app = null } = {}) {
  const claims = who ? JSON.stringify({ sub: who, role: 'authenticated', ...(app ? { client_id: app } : {}) }) : '';
  await db.exec(`reset role; set test.uid = '${who ?? ''}'; set test.claims = '${claims}'; set role ${who ? 'authenticated' : 'anon'}`);
  try { return { rows: await rows(sql, params) }; } catch (err) { return { error: err.message }; } finally { await db.exec('reset role'); }
}
const asApp = (who, sql, params) => as(who, sql, params, { app: '9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d' });
const rec = (n, extra = '') => `insert into recordings (id, title, source, recorded_at, local_date, status${extra ? ', ' + extra.split('=')[0] : ''})
  values ('${id(n)}', 'Note ${n}', 'watch', now(), current_date, 'ready'${extra ? `, '${extra.split('=')[1]}'` : ''}) returning id, owner_id`;

before(async () => {
  if (skip) return;
  db = new PGlite();
  // ── Supabase stand-ins ──
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    create schema auth; grant usage on schema auth to anon, authenticated;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.claims', true), ''), '{}')::jsonb $$;
    create schema storage; grant usage on schema storage to anon, authenticated;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    grant all on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    insert into auth.users values ('${A}', 'a@x.test'), ('${B}', 'b@x.test');
  `);
  await db.exec(SQL);
  for (const step of LATER) await db.exec(step);
});

test('signed out: no table, only the schema version', { skip }, async () => {
  for (const t of ['recordings', 'transcripts', 'action_items', 'folders', 'audio_files', 'activity']) {
    assert.match((await as(null, `select * from ${t}`)).error ?? '', /permission denied/, t);
  }
  assert.match((await as(null, rec(1))).error ?? '', /permission denied/);
  assert.deepEqual((await as(null, 'select public.schema_version() v')).rows, [{ v: 1 + LATER.length }]);
  const grants = await rows(`select table_name from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'`);
  assert.deepEqual(grants, []);
});

test('a row is owned by whoever wrote it; another person never sees, changes or deletes it', { skip }, async () => {
  const mine = await as(A, rec(10));
  assert.equal(mine.rows[0].owner_id, A, 'owner_id filled in from the sign-in');
  assert.deepEqual((await as(B, `select id from recordings where id = '${id(10)}'`)).rows, []);
  assert.deepEqual((await as(B, `update recordings set title = 'hacked' where id = '${id(10)}' returning id`)).rows, []);
  assert.deepEqual((await as(B, `delete from recordings where id = '${id(10)}' returning id`)).rows, []);
  assert.equal((await rows(`select title from recordings where id = '${id(10)}'`))[0].title, 'Note 10');
});

test('nobody can write a row in someone else\'s name, or hand their own row to someone else', { skip }, async () => {
  assert.match((await as(B, rec(11, `owner_id=${A}`))).error ?? '', /row-level security/);
  await as(B, rec(12));
  assert.match((await as(B, `update recordings set owner_id = '${A}' where id = '${id(12)}'`)).error ?? '', /row-level security/);
});

test('knowing a recording id is not enough to attach a transcript, task or audio to it', { skip }, async () => {
  await as(A, rec(20));
  const attach = [
    `insert into transcripts (id, recording_id, segments) values ('${id(21)}', '${id(20)}', '[]')`,
    `insert into action_items (id, recording_id, label, type, status) values ('${id(22)}', '${id(20)}', 'x', 'create_reminder', 'open')`,
    `insert into audio_files (id, recording_id, mime, bytes) values ('${id(23)}', '${id(20)}', 'audio/mp4', 1)`,
  ];
  for (const sql of attach) assert.match((await as(B, sql)).error ?? '', /foreign key/, sql.slice(12, 30));
  // ...so A's one transcript slot is still free for A.
  assert.ok((await as(A, `insert into transcripts (id, recording_id) values ('${id(24)}', '${id(20)}') returning id`)).rows?.length);
});

test('updated_at is the server\'s: it moves on every write and a client value is ignored', { skip }, async () => {
  await as(A, rec(30));
  const [first] = (await as(A, `select updated_at from recordings where id = '${id(30)}'`)).rows;
  await as(A, `update recordings set title = 'renamed', updated_at = '2000-01-01' where id = '${id(30)}'`);
  const [after] = (await as(A, `select updated_at from recordings where id = '${id(30)}'`)).rows;
  assert.ok(after.updated_at > first.updated_at, 'advanced, and not the 2000 value sent');
  // Compare-and-swap against the old stamp now matches nothing.
  assert.deepEqual((await as(A, `update recordings set title = 'stale' where id = '${id(30)}' and updated_at = $1 returning id`, [first.updated_at])).rows, []);
});

test('the activity log: append-only, and private to its owner', { skip }, async () => {
  const entry = `insert into activity (id, at, seq, actor, action, "table", record_id) values ('${id(40)}', now(), '1', 'me', 'create', 'recordings', 'x')`;
  assert.equal((await as(A, entry)).error, undefined);
  assert.deepEqual((await as(B, `select id from activity`)).rows.filter((r) => r.id === id(40)), []);
  assert.match((await as(A, `update activity set reason = 'x' where id = '${id(40)}'`)).error ?? '', /permission denied|append-only/);
  assert.match((await as(A, `delete from activity where id = '${id(40)}'`)).error ?? '', /permission denied|append-only/);
});

test('folder names clash only within one person\'s folders', { skip }, async () => {
  await as(A, `insert into folders (id, label) values ('${id(50)}', 'Work')`);
  assert.match((await as(A, `insert into folders (id, label) values ('${id(51)}', ' work ')`)).error ?? '', /duplicate key/);
  assert.equal((await as(B, `insert into folders (id, label) values ('${id(52)}', 'Work')`)).error, undefined);
});

test('audio bytes: your own folder only', { skip }, async () => {
  const put = (who, path) => as(who, `insert into storage.objects (bucket_id, name) values ('audio', '${path}') returning name`);
  assert.equal((await put(A, `${A}/${id(60)}`)).error, undefined);
  assert.match((await put(B, `${A}/${id(61)}`)).error ?? '', /row-level security/, 'into someone else\'s folder');
  assert.match((await put(B, `${id(62)}`)).error ?? '', /row-level security/, 'outside any folder');
  assert.deepEqual((await as(B, `select name from storage.objects where name like '${A}/%'`)).rows, []);
  assert.deepEqual((await as(B, `delete from storage.objects where name like '${A}/%' returning name`)).rows, []);
  assert.equal((await rows(`select public from storage.buckets where id = 'audio'`))[0].public, false);
});

test('deleting an account deletes everything it owned', { skip }, async () => {
  await db.exec(`insert into auth.users values ('${id(99)}', 'gone@x.test')`);
  await as(id(99), rec(70));
  await as(id(99), `insert into transcripts (id, recording_id) values ('${id(71)}', '${id(70)}')`);
  await db.exec(`delete from auth.users where id = '${id(99)}'`);
  assert.deepEqual(await rows(`select id from recordings where owner_id = '${id(99)}' union all select id from transcripts where owner_id = '${id(99)}'`), []);
});

// Sync copies rows up with an upsert (PostgREST: insert ... on conflict (id) do update).
test('sync upserts: your own row is updated in place; someone else\'s id can\'t be taken over', { skip }, async () => {
  const up = (title) => `insert into recordings (id, title, source, recorded_at, local_date, status, extra)
    values ('${id(80)}', '${title}', 'device', now(), current_date, 'ready', '{"speakers":{"Speaker 1":"Dana"}}')
    on conflict (id) do update set title = excluded.title, extra = excluded.extra returning title, extra`;
  assert.equal((await as(A, up('first'))).rows[0].title, 'first');
  assert.equal((await as(A, up('second'))).rows[0].title, 'second', 'the same id again updates it');
  assert.match((await as(B, up('mine now'))).error ?? '', /row-level security/, 'B can\'t overwrite A\'s row by reusing its id');
  assert.equal((await rows(`select title from recordings where id = '${id(80)}'`))[0].title, 'second');
});

test('002: every surface keeps the fields it has no column for', { skip: skip || later.skip }, async () => {
  const tables = await rows(`select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'extra' order by 1`);
  assert.deepEqual(tables.map((r) => r.table_name), ['action_items', 'audio_files', 'folders', 'recordings', 'transcripts']);
  await as(A, rec(81));
  const saved = await as(A, `insert into action_items (id, recording_id, label, type, status, extra)
    values ('${id(82)}', '${id(81)}', 'x', 'create_reminder', 'open', '{"merge_dismissed":true}') returning extra`);
  assert.deepEqual(saved.rows[0].extra, { merge_dismissed: true });
});

test('002: the composite foreign keys have covering indexes', { skip: skip || later.skip }, async () => {
  const idx = (await rows(`select indexname from pg_indexes where schemaname = 'public'`)).map((r) => r.indexname);
  for (const name of ['transcripts_recording_owner', 'action_items_recording_owner', 'audio_files_recording_owner',
    'audio_files_supersedes_owner', 'recordings_folder_owner']) assert.ok(idx.includes(name), name);
});

// 003: an app the person connected (Claude through MCP, a script with an API key) holds a real
// token for them, usable against the REST API directly. It may read; it may never write.
test('003: a connected app reads your notes but can\'t add, change or delete anything', { skip: skip || later.skip }, async () => {
  await as(A, rec(90));
  await as(A, `insert into action_items (id, recording_id, label, type, status) values ('${id(91)}', '${id(90)}', 'Call Dana', 'create_reminder', 'open')`);
  assert.equal((await asApp(A, `select title from recordings where id = '${id(90)}'`)).rows[0]?.title, 'Note 90', 'reads');
  assert.equal((await asApp(A, `select label from action_items where id = '${id(91)}'`)).rows[0]?.label, 'Call Dana');

  assert.match((await asApp(A, rec(92))).error ?? '', /row-level security/, 'insert');
  assert.match((await asApp(A, `insert into folders (id, label) values ('${id(93)}', 'From Claude')`)).error ?? '', /row-level security/);
  assert.match((await asApp(A, `insert into activity (id, at, seq, actor, action, "table", record_id)
    values ('${id(94)}', now(), '1', 'claude', 'create', 'recordings', 'x')`)).error ?? '', /row-level security/, 'can\'t write the log either');
  assert.deepEqual((await asApp(A, `update recordings set title = 'x' where id = '${id(90)}' returning id`)).rows, [], 'update');
  assert.deepEqual((await asApp(A, `update action_items set status = 'done' where id = '${id(91)}' returning id`)).rows, []);
  assert.deepEqual((await asApp(A, `delete from action_items where id = '${id(91)}' returning id`)).rows, [], 'delete');
  assert.deepEqual((await asApp(A, `delete from recordings where id = '${id(90)}' returning id`)).rows, []);
  // A sync-style upsert on an existing id is an update, and is refused too.
  assert.match((await asApp(A, `insert into recordings (id, title, source, recorded_at, local_date, status)
    values ('${id(90)}', 'x', 'device', now(), current_date, 'ready') on conflict (id) do update set title = excluded.title`)).error ?? '', /row-level security/);
  assert.equal((await rows(`select title from recordings where id = '${id(90)}'`))[0].title, 'Note 90', 'nothing changed');
  assert.equal((await rows(`select status from action_items where id = '${id(91)}'`))[0].status, 'open');
});

test('003: a connected app sees only its person\'s rows, like any sign-in', { skip: skip || later.skip }, async () => {
  await as(A, rec(95));
  assert.deepEqual((await asApp(B, `select id from recordings where id = '${id(95)}'`)).rows, []);
});

test('003: the app\'s own sign-in still writes as before', { skip: skip || later.skip }, async () => {
  assert.equal((await as(A, rec(96))).error, undefined);
  assert.deepEqual((await as(A, `update recordings set title = 'ok' where id = '${id(96)}' returning title`)).rows, [{ title: 'ok' }]);
  assert.deepEqual((await as(A, `delete from recordings where id = '${id(96)}' returning id`)).rows, [{ id: id(96) }]);
});

test('003: a connected app gets no audio, not even the person\'s own', { skip: skip || later.skip }, async () => {
  await as(A, `insert into storage.objects (bucket_id, name) values ('audio', '${A}/${id(97)}')`);
  assert.deepEqual((await asApp(A, `select name from storage.objects where name = '${A}/${id(97)}'`)).rows, []);
  assert.match((await asApp(A, `insert into storage.objects (bucket_id, name) values ('audio', '${A}/${id(98)}')`)).error ?? '', /row-level security/);
  assert.deepEqual((await asApp(A, `delete from storage.objects where name = '${A}/${id(97)}' returning name`)).rows, []);
  assert.equal((await as(A, `select name from storage.objects where name = '${A}/${id(97)}'`)).rows.length, 1, 'the app itself still reads it');
});

// 004: Supabase Auth calls the hook with the token it is about to issue (as supabase_auth_admin).
const hook = async (event, role = 'supabase_auth_admin') => {
  await db.exec(`reset role; set role ${role}`);
  try { return { out: (await rows('select public.mullo_access_token_hook($1::jsonb) out', [JSON.stringify(event)]))[0].out }; }
  catch (err) { return { error: err.message }; } finally { await db.exec('reset role'); }
};
const ev = (method, amr = method) => ({ user_id: A, authentication_method: method, claims: { sub: A, role: 'authenticated', amr: [{ method: amr, timestamp: 1 }] } });

test('004: a password sign-in gets no token, nor do the refreshes of one', { skip: skip || later.skip }, async () => {
  for (const e of [ev('password'), ev('token_refresh', 'password'), { ...ev('otp'), claims: { ...ev('otp').claims, amr: [{ method: 'otp', timestamp: 1 }, { method: 'password', timestamp: 2 }] } }]) {
    const { out } = await hook(e);
    assert.equal(out.error?.http_code, 403, JSON.stringify(e));
    assert.equal(out.claims, undefined);
  }
});

test('004: code, Google, refresh and connected-app sign-ins pass unchanged', { skip: skip || later.skip }, async () => {
  for (const e of [ev('otp'), ev('magiclink'), ev('oauth'), ev('token_refresh', 'otp'), ev('oauth_provider/authorization_code', 'otp'), { user_id: A, authentication_method: 'otp', claims: { sub: A } }]) {
    assert.deepEqual((await hook(e)).out, e, JSON.stringify(e));
  }
});

test('004: only Supabase Auth can run the hook', { skip: skip || later.skip }, async () => {
  for (const role of ['anon', 'authenticated']) assert.match((await hook(ev('otp'), role)).error ?? '', /permission denied/, role);
});

test('005: deleting your own account takes every row of yours with it, and nobody else\'s', { skip: skip || later.skip }, async () => {
  await db.exec(`insert into auth.users values ('${id(98)}', 'leaving@x.test')`);
  await as(id(98), rec(80));
  await as(id(98), `insert into transcripts (id, recording_id) values ('${id(81)}', '${id(80)}')`);
  await as(B, rec(82));
  const before = await rows(`select count(*)::int n from recordings where owner_id <> '${id(98)}'`);
  assert.equal((await as(id(98), 'select public.delete_my_account()')).error, undefined);
  assert.deepEqual(await rows(`select id from auth.users where id = '${id(98)}'`), []);
  assert.deepEqual(await rows(`select id from recordings where owner_id = '${id(98)}' union all select id from transcripts where owner_id = '${id(98)}'`), []);
  assert.deepEqual(await rows(`select count(*)::int n from recordings where owner_id <> '${id(98)}'`), before);
});

test('005: a connected app or a signed-out visitor can\'t delete an account', { skip: skip || later.skip }, async () => {
  assert.match((await asApp(A, 'select public.delete_my_account()')).error ?? '', /connected app/);
  assert.match((await as(null, 'select public.delete_my_account()')).error ?? '', /permission denied/);
  assert.equal((await rows(`select count(*)::int n from auth.users where id = '${A}'`))[0].n, 1);
});
