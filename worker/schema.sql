-- Mullo Pro (Cloudflare D1). Apply once:
--   npx wrangler d1 execute echo --remote --file=worker/schema.sql
--
-- No passwords, no recordings, no transcripts here. Only who pays, the hash of
-- their key, what plan each Mullo account has, and how much AI they used.

create table if not exists accounts (
  subscription_id text primary key,      -- Stripe subscription id
  customer_id     text not null,         -- Stripe customer id (for the billing portal)
  email           text,                  -- from Checkout, for support only
  status          text not null,         -- Stripe status: active | trialing | past_due | canceled | ...
  period_end      integer,               -- unix seconds, end of the paid period
  key_hash        text unique,           -- sha-256 of the subscription key; the key itself is never stored
  key_issued_at   integer,
  updated_at      integer not null
);

-- Which Mullo account (Supabase user id) a subscription belongs to. Linked once,
-- with the key AND the sign-in; from then on either one reaches the same
-- allowance. One account per subscription, one subscription per account.
-- (The Worker creates every table below accounts on its own if missing: src/usage.mjs ready().)
create table if not exists account_users (
  user_id         text primary key,
  subscription_id text not null unique,
  linked_at       integer not null
);

-- Tokens Gemini reported and seconds of audio it heard, per holder per calendar month
-- (UTC). A holder is a subscription id, or user:<Mullo account id> for an account's own
-- plan (a trial or a granted plan).
create table if not exists usage (
  subscription_id text not null,         -- the holder
  month           text not null,         -- YYYY-MM
  tokens          integer not null default 0,
  calls           integer not null default 0,
  seconds         integer not null default 0,
  primary key (subscription_id, month)
);

-- Per-minute cap, so a leaked key can't burn a month in an hour.
create table if not exists rate (
  subscription_id text not null,
  minute          integer not null,      -- unix minutes
  n               integer not null default 0,
  primary key (subscription_id, minute)
);

-- Stripe retries webhooks: each event is applied once.
create table if not exists stripe_events (
  id          text primary key,
  received_at integer not null
);

-- A Mullo account's own plan when no subscription is linked (src/plans.mjs):
-- free (given by an admin), trial (trial_seconds fixed when it began), none.
-- email_key = sha-256 of the normalised address; the address itself is not kept.
create table if not exists plans (
  user_id       text primary key,
  plan          text not null,
  trial_seconds integer not null default 0,
  email_key     text,
  granted_by    text,
  created_at    integer not null,
  updated_at    integer not null
);
create index if not exists plans_email on plans (email_key);

-- One trial per mailbox, however the address is written.
create table if not exists trial_claims (
  email_key  text primary key,
  user_id    text not null,
  claimed_at integer not null
);

-- A plan given by email, waiting for (or applied at) that mailbox's sign-in.
create table if not exists grants (
  email_key  text primary key,
  plan       text not null,
  granted_by text,
  granted_at integer not null
);

-- Admin-set values (trial_minutes, trials_paused), changed from the app, no deploy.
create table if not exists settings (
  name       text primary key,
  value      text not null,
  updated_at integer not null
);

-- Every admin change: who, what, when.
create table if not exists admin_log (
  at       integer not null,
  admin_id text not null,
  action   text not null,
  detail   text
);

-- Problem reports (S56, src/reports.mjs). Deleted with the account, and 90 days after closing.
create table if not exists reports (
  id         text primary key,
  user_id    text not null,
  email      text,
  text       text not null,
  details    text not null,
  screenshot text,              -- base64 JPEG, at most 400 KB of image
  status     text not null default 'open',
  created_at integer not null,
  closed_at  integer
);
create index if not exists reports_user on reports (user_id, created_at);
