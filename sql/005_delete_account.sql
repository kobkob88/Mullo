-- 005_delete_account.sql - delete your account from inside Mullo (2026-10-10).
--
-- Settings, Account, Delete account. The signed-in person removes their OWN account: the
-- auth.users row, and with it (every owner_id is `on delete cascade`, 001) all their folders,
-- recordings, transcripts, tasks, audio file rows and activity history. The audio BYTES in the
-- private "audio" bucket are removed by the app first, through the Storage API (Supabase
-- refuses deleting storage.objects from SQL). App stores require this (Apple 5.1.1(v), Google
-- Play's account deletion policy).
--
-- Only the person's own sign-in can run it: never a connected app (a token with a client_id,
-- 003), never someone signed out, and it takes no argument, so nobody can name another account.
--
-- Safe on a live database: adds one function and replaces schema_version(). Nothing moves.
--
-- ROLLBACK:
--   drop function public.delete_my_account();   (and schema_version() back to 4)

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Sign in to delete your account.' using errcode = '42501';
  end if;
  if coalesce((select auth.jwt()) ->> 'client_id', '') <> '' then
    raise exception 'A connected app can''t delete the account.' using errcode = '42501';
  end if;
  delete from auth.users where id = me;
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

create or replace function public.schema_version() returns int
language sql immutable set search_path = '' as $$ select 5 $$;

-- After applying: verify, don't assume.
--   select public.schema_version();                                                  -- expect 5
--   select proname, prosecdef from pg_proc where proname = 'delete_my_account';      -- expect true
--   select grantee, privilege_type from information_schema.routine_privileges
--     where routine_name = 'delete_my_account';             -- authenticated (and the owner), never anon
