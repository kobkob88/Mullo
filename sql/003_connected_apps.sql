-- 003_connected_apps.sql - apps a person connects (Claude, ChatGPT, scripts) can read, never write.
-- Spec docs/specs/2026-10-08-connections-design.md.
--
-- Connected apps sign in through Supabase's OAuth server. Their tokens are ordinary sign-ins
-- (role authenticated, the person's own id) plus a `client_id` claim, and they work against
-- the REST API directly, not only through Mullo's MCP server. So the limit lives here:
-- restrictive policies (ANDed with the *_own ones) refuse every insert, update and delete from
-- a token that carries a client_id, and audio bytes aren't readable by them at all.
-- The app's own sign-in has no client_id and is unaffected.
--
-- Safe on a live database: adds policies and replaces schema_version(). Nothing moves.
--
-- ROLLBACK:
--   drop policy <name> on <table>;  for every policy named *_apps_* below
--   drop function public.from_connected_app();   (and schema_version() back to 2)

create or replace function public.from_connected_app() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'client_id', '') <> ''
$$;
revoke all on function public.from_connected_app() from public, anon;
grant execute on function public.from_connected_app() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['folders', 'recordings', 'transcripts', 'action_items', 'audio_files', 'activity'] loop
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (not public.from_connected_app())', t || '_apps_no_insert', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (not public.from_connected_app()) with check (not public.from_connected_app())', t || '_apps_no_update', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (not public.from_connected_app())', t || '_apps_no_delete', t);
  end loop;
end $$;

-- Audio: nothing at all for connected apps (a summary is shareable; a recording of a conversation isn't).
create policy audio_apps_none on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'audio' or not public.from_connected_app())
  with check (bucket_id <> 'audio' or not public.from_connected_app());

create or replace function public.schema_version() returns int
language sql immutable set search_path = '' as $$ select 3 $$;

-- After applying: verify, don't assume.
--   select public.schema_version();                                                  -- expect 3
--   select count(*) from pg_policies where policyname like '%_apps_%';               -- expect 19
--   select tablename, policyname, permissive from pg_policies where policyname like '%_apps_%';  -- all RESTRICTIVE
