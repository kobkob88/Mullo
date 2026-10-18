// Every Mullo account has a plan, and only this server decides it:
//   pro   - a Stripe subscription linked to the account (index.mjs, account_users)
//   free  - given by an admin (family, friends): its own monthly allowance, like Pro
//   trial - minutes of audio, once per account and once per mailbox. How many a NEW
//           account gets is a setting an admin changes from the app (no deploy);
//           0 = no trial for new accounts. "Pause" stops every trial at once.
//   none  - signed in, no AI.
// A trial's size is fixed when it starts: lowering the setting doesn't take minutes
// from someone already using theirs.
//
// Emails are never stored here: only the SHA-256 of the normalised address (one trial
// per mailbox, and an admin can grant a plan before the person's first sign-in).

import { ready, usageOf, usageEver } from './usage.mjs';
import { hex } from './stripe.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);

// Settings an admin changes from the app. Defaults until someone sets them.
export const SETTINGS = {
  trial_minutes: { fallback: '0', clean: (v) => String(Math.min(100_000, Math.max(0, Math.floor(Number(v) || 0)))) },
  trials_paused: { fallback: '0', clean: (v) => (v === true || v === '1' || v === 1 ? '1' : '0') },
};

export async function readSettings(env) {
  await ready(env);
  const { results = [] } = await env.DB.prepare('select name, value from settings').all();
  const stored = Object.fromEntries(results.map((r) => [r.name, r.value]));
  return {
    trialMinutes: Number(stored.trial_minutes ?? SETTINGS.trial_minutes.fallback),
    trialsPaused: (stored.trials_paused ?? SETTINGS.trials_paused.fallback) === '1',
  };
}

export async function writeSettings(env, adminId, { trialMinutes, trialsPaused }) {
  await ready(env);
  const changes = [];
  if (trialMinutes !== undefined) changes.push(['trial_minutes', SETTINGS.trial_minutes.clean(trialMinutes)]);
  if (trialsPaused !== undefined) changes.push(['trials_paused', SETTINGS.trials_paused.clean(trialsPaused)]);
  for (const [name, value] of changes) {
    await env.DB.prepare(`insert into settings (name, value, updated_at) values (?, ?, ?)
      on conflict(name) do update set value = excluded.value, updated_at = excluded.updated_at`).bind(name, value, nowSec()).run();
    await log(env, adminId, 'setting', `${name}=${value}`);
  }
  return readSettings(env);
}

// One mailbox, however it's written: case, and for Gmail the dots and +labels
// (a.b+2@gmail.com and ab@gmail.com reach the same inbox).
export function normaliseEmail(email) {
  const clean = String(email ?? '').trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1) return null;
  let local = clean.slice(0, at).split('+')[0];
  let domain = clean.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local && domain ? `${local}@${domain}` : null;
}

export async function emailKey(email) {
  const n = normaliseEmail(email);
  return n ? hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n))) : null;
}

export const isAdmin = (env, userId) => Boolean(userId)
  && String(env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(userId);

async function log(env, adminId, action, detail) {
  await env.DB.prepare('insert into admin_log (at, admin_id, action, detail) values (?, ?, ?, ?)')
    .bind(nowSec(), adminId, action, detail ?? null).run();
}

// The account's own plan (not Pro: index.mjs checks a linked subscription first).
// Starts a trial on the first look when trials are open and this mailbox hasn't had one.
// → { holder: 'user:<id>', plan: 'free'|'trial'|'none', trialSeconds }
export async function planFor(env, user) {
  await ready(env);
  const holder = `user:${user.userId}`;
  const key = await emailKey(user.email);
  let row = await env.DB.prepare('select * from plans where user_id = ?').bind(user.userId).first();
  if (!row || row.plan === 'none') {
    const t = nowSec();
    const grant = key ? await env.DB.prepare('select plan from grants where email_key = ?').bind(key).first() : null;
    let plan = row?.plan ?? 'none';
    let trialSeconds = row?.trial_seconds ?? 0;
    if (grant?.plan === 'free') plan = 'free';
    else if (key) {
      const { trialMinutes } = await readSettings(env);
      if (trialMinutes > 0) {
        // One trial per mailbox: the claim is taken first, so two sign-ins at once can't both start one.
        await env.DB.prepare('insert into trial_claims (email_key, user_id, claimed_at) values (?, ?, ?) on conflict(email_key) do nothing')
          .bind(key, user.userId, t).run();
        const claim = await env.DB.prepare('select user_id from trial_claims where email_key = ?').bind(key).first();
        if (claim?.user_id === user.userId) { plan = 'trial'; trialSeconds = trialMinutes * 60; }
      }
    }
    if (!row || plan !== row.plan) {
      await env.DB.prepare(`insert into plans (user_id, plan, trial_seconds, email_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?)
        on conflict(user_id) do update set plan = excluded.plan, trial_seconds = excluded.trial_seconds,
          email_key = excluded.email_key, updated_at = excluded.updated_at`)
        .bind(user.userId, plan, trialSeconds, key, t, t).run();
    }
    row = { plan, trial_seconds: trialSeconds };
  }
  return { holder, plan: row.plan, trialSeconds: row.trial_seconds ?? 0 };
}

// Pro and free: minutes of recordings a month (MONTHLY_MINUTES, the number people
// see), plus a hidden token limit (MONTHLY_TOKENS) for a month of mostly Ask.
export const monthlyMinutes = (env) => Number(env.MONTHLY_MINUTES ?? 1800);
export const MONTH_USED_UP = 'You have used this month\'s minutes. They come back on the 1st.';

export async function monthlyProblem(env, holder) {
  const used = await usageOf(env, holder);
  if (used.seconds >= monthlyMinutes(env) * 60 || used.tokens >= Number(env.MONTHLY_TOKENS ?? 10_000_000)) return [429, MONTH_USED_UP];
  return null;
}

// → { minutesUsed, minutesAllowed, tokensUsed, capped } for this month.
export async function monthlyReport(env, holder) {
  const used = await usageOf(env, holder);
  return {
    minutesUsed: Math.ceil(used.seconds / 60), minutesAllowed: monthlyMinutes(env), tokensUsed: used.tokens,
    capped: Boolean(await monthlyProblem(env, holder)) || undefined,
  };
}

// Why this plan can't start AI work now, or null. Pro is checked in index.mjs.
export async function planProblem(env, p) {
  if (p.plan === 'free') return monthlyProblem(env, p.holder);
  if (p.plan === 'trial') {
    if ((await readSettings(env)).trialsPaused) return [402, 'Free minutes are paused right now. Try again later, or start Mullo Pro.'];
    const used = await usageEver(env, p.holder);
    const tokenCap = (p.trialSeconds / 60) * Number(env.TRIAL_TOKENS_PER_MINUTE ?? 6000);
    if (used.seconds >= p.trialSeconds || used.tokens >= tokenCap) return [402, 'Your free minutes are used up. Start Mullo Pro to keep going.'];
    return null;
  }
  return [402, 'Mullo AI isn\'t on this Mullo account yet. Start Mullo Pro, or use your own AI key.'];
}

// What /api/me says about the account's own plan.
export async function planReport(env, p) {
  const out = { plan: p.plan, active: !(await planProblem(env, p)) };
  if (p.plan === 'trial') {
    const used = await usageEver(env, p.holder);
    Object.assign(out, { minutesUsed: Math.ceil(used.seconds / 60), minutesAllowed: Math.round(p.trialSeconds / 60) });
  }
  if (p.plan === 'free') Object.assign(out, await monthlyReport(env, p.holder));
  return out;
}

// Give (or take back) a free plan by email. Works before the person's first sign-in:
// the grant waits for that mailbox. Taking it back leaves no new trial behind.
export async function grantByEmail(env, adminId, email, plan) {
  await ready(env);
  if (!['free', 'none'].includes(plan)) throw Object.assign(new Error('plan must be free or none'), { status: 400 });
  const key = await emailKey(email);
  if (!key) throw Object.assign(new Error('That doesn\'t look like an email address.'), { status: 400 });
  const t = nowSec();
  if (plan === 'free') {
    await env.DB.prepare(`insert into grants (email_key, plan, granted_by, granted_at) values (?, 'free', ?, ?)
      on conflict(email_key) do update set plan = 'free', granted_by = excluded.granted_by, granted_at = excluded.granted_at`)
      .bind(key, adminId, t).run();
  } else {
    await env.DB.prepare('delete from grants where email_key = ?').bind(key).run();
  }
  // Someone with this mailbox is already known: their plan changes now.
  await env.DB.prepare('update plans set plan = ?, granted_by = ?, updated_at = ? where email_key = ?').bind(plan, adminId, t, key).run();
  // A free plan taken back doesn't turn into a fresh trial.
  await env.DB.prepare('insert into trial_claims (email_key, user_id, claimed_at) values (?, ?, ?) on conflict(email_key) do nothing')
    .bind(key, 'granted', t).run();
  await log(env, adminId, plan === 'free' ? 'grant_free' : 'grant_removed', key.slice(0, 12));
  const known = await env.DB.prepare('select count(*) as n from plans where email_key = ?').bind(key).first();
  return { plan, signedUp: (known?.n ?? 0) > 0 };
}
