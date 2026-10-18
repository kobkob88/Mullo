-- 001_core.sql - accounts: every row belongs to one person (spec
-- docs/specs/2026-10-06-accounts-and-spaces-design.md, build step 1).
-- Spaces (sharing with a partner) come in 002 and add columns; nothing here moves.
--
-- Mirrors the device store one-to-one (app/core/surfaces.js) so turning the
-- Supabase driver on changes where rows live, not what they look like.
-- Every table is listed in docs/ops/surface-registry.md (tests enforce it).
-- Tested offline first: tests/sql/core.test.mjs (PGlite, red team).
--
-- Rules:
--   * Opaque uuid keys; labels are plain editable text.
--   * owner_id defaults to the signed-in person and RLS refuses any other value:
--     the client never chooses whose row it writes.
--   * A child row (transcript, task, audio) can only point at a recording of the
--     SAME owner (composite foreign keys). A foreign key check ignores RLS, so
--     without this a stranger who learned an id could attach rows to it or
--     claim its one transcript slot.
--   * updated_at is advanced by a TRIGGER on every insert/update. The client
--     never sends it; compare-and-swap (`.eq('updated_at', expected)`) is only
--     real because of this trigger. Verify it exists on the live table.
--   * activity is append-only (trigger), the recovery mechanism.
--   * anon (signed out) gets nothing: no table, no function except schema_version().
--   * Audio bytes: private bucket "audio", path <owner_id>/<file id>; never public.
--
-- ROLLBACK (only before real data exists):
--   drop table if exists activity, audio_files, action_items, transcripts, recordings, folders cascade;
--   drop function if exists set_updated_at(), activity_append_only(), schema_version();
--   delete from storage.buckets where id = 'audio';  (and the storage.objects policies named audio_*)

-- ── Helpers ─────────────────────────────────────────────────────────────
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();           -- server time, microseconds
  if tg_op = 'INSERT' then new.created_at := coalesce(new.created_at, new.updated_at); end if;
  return new;
end $$;

-- Which numbered step of sql/ this server is at. The app compares it with its
-- own and, on a self-hosted server that is behind, shows the SQL to apply.
create or replace function public.schema_version() returns int
language sql immutable set search_path = '' as $$ select 1 $$;

-- ── Surfaces ────────────────────────────────────────────────────────────
create table public.folders (
  id           uuid primary key,
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, owner_id)
);
-- Label collisions are refused in the app (case-insensitive, trimmed); this
-- index is the structural backstop.
create unique index folders_label_unique on public.folders (owner_id, lower(btrim(label)));

create table public.recordings (
  id            uuid primary key,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title         text not null,
  title_edited  boolean not null default false,
  source        text not null,                 -- device | watch
  external_id   text,
  recorded_at   timestamptz not null,
  local_date    date not null,                 -- the person's local day, never derived from UTC
  duration_ms   bigint,
  language      text,
  template      text,
  status        text not null,
  folder_id     uuid,
  summary       jsonb,
  sections      jsonb not null default '[]',
  audio_file_id uuid,
  engine        text,
  flags         text[] not null default '{}',
  extra         jsonb not null default '{}',   -- fields from newer builds an older one must not drop
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (folder_id, owner_id) references public.folders (id, owner_id) on delete set null (folder_id)
);
create unique index recordings_external on public.recordings (owner_id, source, external_id) where external_id is not null;
create index recordings_delta on public.recordings (owner_id, updated_at);

create table public.transcripts (
  id            uuid primary key,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recording_id  uuid not null,
  language      text,
  origin        text,
  segments      jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (recording_id, owner_id) references public.recordings (id, owner_id) on delete cascade
);
create unique index transcripts_one_per_recording on public.transcripts (recording_id);
create index transcripts_delta on public.transcripts (owner_id, updated_at);

create table public.action_items (
  id            uuid primary key,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recording_id  uuid,
  label         text not null,
  type          text not null,
  priority      text,
  status        text not null,
  due_date      date,                          -- local date
  context       text,
  origin        text,                          -- extracted | manual
  source        text not null default 'device',
  external_id   text,
  payload       jsonb,
  edited        boolean not null default false,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (recording_id, owner_id) references public.recordings (id, owner_id) on delete set null (recording_id)
);
create unique index action_items_external on public.action_items (owner_id, source, external_id) where external_id is not null;
create index action_items_delta on public.action_items (owner_id, updated_at);

-- Metadata about bytes in the private "audio" bucket. Bytes are immutable: a
-- correction is a new file with `supersedes` set.
create table public.audio_files (
  id            uuid primary key,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recording_id  uuid,
  mime          text not null,
  bytes         bigint not null,
  duration_ms   bigint,
  supersedes    uuid,
  storage       text not null default 'bucket',
  received_at   timestamptz not null default now(),   -- server time, not the phone's
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, owner_id),
  foreign key (recording_id, owner_id) references public.recordings (id, owner_id) on delete set null (recording_id),
  foreign key (supersedes, owner_id) references public.audio_files (id, owner_id) on delete set null (supersedes)
);
create index audio_files_delta on public.audio_files (owner_id, updated_at);

-- The activity log: full row before and after every write. Append-only.
create table public.activity (
  id            uuid primary key,              -- client-generated: retries are free
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at            timestamptz not null,
  seq           text not null,                 -- client monotonic stamp: orders same-millisecond entries
  received_at   timestamptz not null default now(),
  actor         text not null,
  action        text not null,
  "table"       text not null,
  record_id     text not null,
  before        jsonb,
  after         jsonb,
  reason        text,
  batch         uuid
);
create index activity_deletes on public.activity (owner_id, "table", at) where action = 'delete';
create index activity_delta on public.activity (owner_id, received_at);

create or replace function public.activity_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'activity is append-only';
end $$;
create trigger activity_no_update before update or delete on public.activity
  for each row execute function public.activity_append_only();

-- ── updated_at triggers (the compare-and-swap depends on these) ─────────
create trigger folders_stamp      before insert or update on public.folders      for each row execute function public.set_updated_at();
create trigger recordings_stamp   before insert or update on public.recordings   for each row execute function public.set_updated_at();
create trigger transcripts_stamp  before insert or update on public.transcripts  for each row execute function public.set_updated_at();
create trigger action_items_stamp before insert or update on public.action_items for each row execute function public.set_updated_at();
create trigger audio_files_stamp  before insert or update on public.audio_files  for each row execute function public.set_updated_at();

-- ── Row-level security: your rows, nobody else's ────────────────────────
alter table public.folders      enable row level security;
alter table public.recordings   enable row level security;
alter table public.transcripts  enable row level security;
alter table public.action_items enable row level security;
alter table public.audio_files  enable row level security;
alter table public.activity     enable row level security;

-- (select auth.uid()) is evaluated once per query, not once per row.
create policy folders_own      on public.folders      for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy recordings_own   on public.recordings   for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy transcripts_own  on public.transcripts  for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy action_items_own on public.action_items for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy audio_files_own  on public.audio_files  for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy activity_read    on public.activity for select to authenticated using (owner_id = (select auth.uid()));
create policy activity_insert  on public.activity for insert to authenticated with check (owner_id = (select auth.uid()));

-- Signed out = nothing. Supabase grants new tables to anon by default.
revoke all on public.folders, public.recordings, public.transcripts, public.action_items,
  public.audio_files, public.activity from anon;
-- The log can't be rewritten even through a policy slip.
revoke update, delete, truncate on public.activity from authenticated;
revoke all on function public.set_updated_at(), public.activity_append_only() from public, anon, authenticated;
grant execute on function public.schema_version() to anon, authenticated;

-- ── Audio bytes: private bucket, a folder per person ────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio', 'audio', false, 209715200, array['audio/*'])
on conflict (id) do nothing;

-- No update policy: audio is immutable (a correction is a new file).
create policy audio_read   on storage.objects for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy audio_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy audio_delete on storage.objects for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- After applying: verify, don't assume.
--   select tablename, rowsecurity from pg_tables where schemaname = 'public';
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--     where table_schema = 'public' and grantee = 'anon';                       -- expect none
--   select tgname, tgrelid::regclass from pg_trigger where tgname like '%_stamp';  -- expect 5
