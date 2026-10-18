-- 002_extra_and_indexes.sql - before sync switches on (2026-10-07).
--
-- 1. `extra` on every surface, like recordings already has: fields the app keeps
--    that have no column yet (a task "kept separate", when audio bytes were
--    removed...). Without it a copy into the account would drop them, and an
--    older build would erase a newer build's data.
-- 2. Indexes behind the composite foreign keys (Supabase advisor 0001): every
--    delete of a recording or folder checks the rows pointing at it.
--
-- Safe on a live database: adds a column with a constant default (no rewrite)
-- and indexes on tables that start empty. Nothing is dropped or moved.
--
-- ROLLBACK:
--   alter table public.transcripts  drop column extra;
--   alter table public.action_items drop column extra;
--   alter table public.folders      drop column extra;
--   alter table public.audio_files  drop column extra;
--   drop index public.transcripts_recording_owner, public.action_items_recording_owner,
--     public.audio_files_recording_owner, public.audio_files_supersedes_owner, public.recordings_folder_owner;
--   (and schema_version() back to 1)

alter table public.transcripts  add column extra jsonb not null default '{}';
alter table public.action_items add column extra jsonb not null default '{}';
alter table public.folders      add column extra jsonb not null default '{}';
alter table public.audio_files  add column extra jsonb not null default '{}';

create index transcripts_recording_owner  on public.transcripts  (recording_id, owner_id);
create index action_items_recording_owner on public.action_items (recording_id, owner_id);
create index audio_files_recording_owner  on public.audio_files  (recording_id, owner_id);
create index audio_files_supersedes_owner on public.audio_files  (supersedes, owner_id);
create index recordings_folder_owner      on public.recordings   (folder_id, owner_id);

create or replace function public.schema_version() returns int
language sql immutable set search_path = '' as $$ select 2 $$;

-- After applying: verify, don't assume.
--   select public.schema_version();                                              -- expect 2
--   select table_name from information_schema.columns
--     where table_schema = 'public' and column_name = 'extra' order by 1;      -- expect 5 tables
