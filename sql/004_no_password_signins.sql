-- 004_no_password_signins.sql - Mullo signs in with an email code (or Google), never a password.
--
-- Why: a connected app's token (003) can't write notes, but Supabase lets it change the account
-- itself, including setting a password. A password sign-in then gives an ordinary session with no
-- client_id: full write, AI minutes, and the Worker's admin routes for an admin. Mullo has no
-- password anywhere, so this hook refuses every token from a password sign-in (and the refreshes
-- of one, which keep `password` in amr). Code sign-ins, Google, and connected apps pass unchanged.
--
-- Takes effect only once switched on: Supabase dashboard, Authentication, Auth Hooks,
-- "Customize Access Token (JWT) Claims", Postgres, schema public, function mullo_access_token_hook.
-- On your own Supabase it is optional (harmless if never switched on).
--
-- Safe on a live database: adds one function and replaces schema_version(). Nothing moves.
--
-- ROLLBACK: switch the hook off in the dashboard FIRST (Auth fails every sign-in while it points
-- at a missing function), then: drop function public.mullo_access_token_hook(jsonb);

create or replace function public.mullo_access_token_hook(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if event ->> 'authentication_method' = 'password'
     or coalesce(event -> 'claims' -> 'amr', '[]'::jsonb) @> '[{"method": "password"}]'::jsonb then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Mullo signs in with an email code, not a password.'));
  end if;
  return event;
end $$;

-- Only Supabase Auth runs it; nobody signed in or out can call it through the API.
revoke all on function public.mullo_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.mullo_access_token_hook(jsonb) to supabase_auth_admin;

create or replace function public.schema_version() returns int
language sql immutable set search_path = '' as $$ select 4 $$;

-- After applying: verify, don't assume.
--   select public.schema_version();                                                        -- expect 4
--   select public.mullo_access_token_hook('{"authentication_method":"otp","claims":{"amr":[{"method":"otp"}]}}');
--     -- expect the event back unchanged
--   select public.mullo_access_token_hook('{"authentication_method":"password","claims":{}}');
--     -- expect {"error": {"http_code": 403, ...}}
