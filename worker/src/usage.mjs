// What each allowance holder has used: Gemini's own token counts and seconds of audio,
// per UTC month. A holder is a Stripe subscription id (Mullo Pro) or `user:<id>` (a
// Mullo account's own plan: a trial or a granted plan, plans.mjs).
// Shared by the request routes (index.mjs) and the background transcriptions (jobs.mjs).

export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7); // UTC calendar month

// Tables and columns added after the first deploy, made on a database that doesn't
// have them yet (schema.sql has them all). Once per database per isolate.
const made = new WeakMap();
export function ready(env) {
  if (!made.has(env.DB)) {
    made.set(env.DB, (async () => {
      const run = (sql) => env.DB.prepare(sql).run();
      await run(`create table if not exists account_users (
        user_id text primary key, subscription_id text not null unique, linked_at integer not null)`);
      await run('create table if not exists settings (name text primary key, value text not null, updated_at integer not null)');
      await run(`create table if not exists plans (
        user_id text primary key, plan text not null, trial_seconds integer not null default 0,
        email_key text, granted_by text, created_at integer not null, updated_at integer not null)`);
      await run('create index if not exists plans_email on plans (email_key)');
      await run('create table if not exists trial_claims (email_key text primary key, user_id text not null, claimed_at integer not null)');
      await run('create table if not exists grants (email_key text primary key, plan text not null, granted_by text, granted_at integer not null)');
      await run('create table if not exists admin_log (at integer not null, admin_id text not null, action text not null, detail text)');
      // API keys (apikeys.mjs).
      await run('create table if not exists api_clients (redirect_uri text primary key, client_id text not null, created_at integer not null)');
      await run(`create table if not exists api_keys (
        id text primary key, user_id text not null, client_id text not null, name text not null, key_hash text not null unique,
        refresh_sealed text not null, access_sealed text, access_exp integer not null default 0,
        created_at integer not null, last_used_at integer, dead integer not null default 0)`);
      await run('create index if not exists api_keys_user on api_keys (user_id)');
      await run(`create table if not exists api_key_starts (
        state text primary key, user_id text not null, name text not null, verifier text not null, expires_at integer not null)`);
      // Google Calendar and Tasks (google.mjs): the sealed grant, sign-ins in progress, and
      // Mullo task id → Google task id (ids only).
      await run(`create table if not exists google_links (
        user_id text primary key, refresh_sealed text not null, scopes text not null,
        calendar_id text, tasklist_id text, created_at integer not null, dead integer not null default 0)`);
      await run(`create table if not exists google_starts (
        state text primary key, user_id text not null, verifier text not null, back text not null, expires_at integer not null)`);
      await run(`create table if not exists google_tasks (
        user_id text not null, action_id text not null, task_id text not null, primary key (user_id, action_id))`);
      // Privacy Policy and Terms accepted (acceptance.mjs): which version, when.
      await run(`create table if not exists legal_acceptances (
        user_id text not null, version text not null, accepted_at integer not null, primary key (user_id, version))`);
      // Own AI keys sealed before they carried their account: which account claimed each
      // (index.mjs checkOwner). holder = fingerprint of the sealed text.
      await run('create table if not exists own_key_claims (holder text primary key, user_id text not null, claimed_at integer not null)');
      // App Store subscriptions whose Mullo account was deleted while Apple still bills them
      // (only Apple can cancel those): the next account to restore the purchase may take it over
      // (appstore.mjs claimApple). The subscription id only, never who had it.
      await run('create table if not exists released_subscriptions (subscription_id text primary key, released_at integer not null)');
      // The summary model each account picked (S54, models.mjs). Deleted with the account.
      await run('create table if not exists model_picks (user_id text primary key, model text not null, updated_at integer not null)');
      // Problem reports (S56, reports.mjs): the screenshot is base64 JPEG text. Deleted with the
      // account, and 90 days after closing.
      await run(`create table if not exists reports (
        id text primary key, user_id text not null, email text, text text not null, details text not null,
        screenshot text, status text not null default 'open', created_at integer not null, closed_at integer)`);
      await run('create index if not exists reports_user on reports (user_id, created_at)');
      try {
        await run('alter table usage add column seconds integer not null default 0');
      } catch (err) {
        if (!/duplicate column/i.test(String(err?.message ?? err))) throw err;
      }
    })().catch((err) => { made.delete(env.DB); throw err; }));
  }
  return made.get(env.DB);
}

export async function usageOf(env, holder, month = monthOf()) {
  await ready(env);
  const row = await env.DB.prepare('select tokens, calls, seconds from usage where subscription_id = ? and month = ?').bind(holder, month).first();
  return { tokens: row?.tokens ?? 0, calls: row?.calls ?? 0, seconds: row?.seconds ?? 0 };
}

// Every month together: a trial is used once, not per month.
export async function usageEver(env, holder) {
  await ready(env);
  const row = await env.DB.prepare('select sum(tokens) as tokens, sum(seconds) as seconds from usage where subscription_id = ?').bind(holder).first();
  return { tokens: row?.tokens ?? 0, seconds: row?.seconds ?? 0 };
}

export async function addUsage(env, holder, tokens, seconds = 0) {
  await ready(env);
  await env.DB.prepare(`insert into usage (subscription_id, month, tokens, calls, seconds) values (?, ?, ?, 1, ?)
    on conflict(subscription_id, month) do update set tokens = tokens + excluded.tokens, calls = calls + 1,
      seconds = seconds + excluded.seconds`)
    .bind(holder, monthOf(), tokens, Math.max(0, Math.round(seconds))).run();
}

// Gemini turns each second of audio into 32 tokens and reports them per modality.
export const AUDIO_TOKENS_PER_SECOND = 32;

// A fetch that adds up Gemini's reported tokens for this request, and keeps the
// longest audio it heard in one call: a long meeting goes in rounds, each sending the
// same audio again, so its minutes are the biggest round, never the sum.
export function meteredFetch(doFetch, meter) {
  meter.seconds ??= 0;
  return async (url, init) => {
    const res = await doFetch(url, init);
    try {
      const used = usageIn(await res.clone().text());
      meter.tokens += used.tokens;
      meter.seconds = Math.max(meter.seconds, used.audioTokens / AUDIO_TOKENS_PER_SECOND);
    } catch { /* unreadable */ }
    return res;
  };
}

// One JSON reply, or a stream of "data:" pieces (transcribe) where each piece repeats
// the running count: the last one is the total.
export function usageIn(body) {
  const read = (s) => {
    try {
      const m = JSON.parse(s)?.usageMetadata;
      if (!m) return null;
      const audio = (m.promptTokensDetails ?? []).filter((d) => d?.modality === 'AUDIO').reduce((n, d) => n + (d.tokenCount ?? 0), 0);
      return { tokens: m.totalTokenCount ?? 0, audioTokens: audio };
    } catch { return null; }
  };
  if (!/^\s*data:/m.test(body)) return read(body) ?? { tokens: 0, audioTokens: 0 };
  let last = { tokens: 0, audioTokens: 0 };
  for (const line of body.split(/\r?\n/)) if (line.startsWith('data:')) last = read(line.slice(5)) ?? last;
  return last;
}

export const tokensIn = (body) => usageIn(body).tokens;
