// Who accepted which version of the Privacy Policy and Terms (S23, 2026-10-11). The app ticks
// both at sign-in and tells the Worker; /api/me says the current version and the newest one this
// account accepted; when they differ the app asks again. A version is LEGAL_UPDATED (legal.mjs):
// a change to either page bumps it, so everyone is asked again.
//
// Kept in Mullo's own D1 (`legal_acceptances`, made by ready()), one row per account and version,
// the first acceptance time kept. Deleted with the account (index.mjs deleteAccountRoute).

import { ready } from './usage.mjs';
import { LEGAL_UPDATED, LEGAL_CHANGES } from './legal.mjs';

export const LEGAL_FIRST = 'Mullo\'s Privacy Policy and Terms were updated. Open Mullo and accept them to keep using AI (if Mullo doesn\'t ask, update the app).';

// AI waits for the current version only once LEGAL_GATE is "on" (wrangler.toml): apps from
// before S23 can't accept yet, so the switch is turned on once the new app is installed.
export const legalGateOn = (env) => env.LEGAL_GATE === 'on';

// → { current, accepted (null = never), changes }
export async function legalState(env, userId) {
  await ready(env);
  const row = await env.DB.prepare('select version from legal_acceptances where user_id = ? order by accepted_at desc, rowid desc limit 1')
    .bind(userId).first();
  return { current: LEGAL_UPDATED, accepted: row?.version ?? null, changes: LEGAL_CHANGES };
}

// The person accepted the pages as they are now. `version`, when the app sends one, is the
// version it showed: an older one means the pages changed meanwhile, so it must ask again.
// → true, or false when that version isn't the current one.
export async function acceptLegal(env, userId, version) {
  if (version != null && version !== LEGAL_UPDATED) return false;
  await ready(env);
  await env.DB.prepare(`insert into legal_acceptances (user_id, version, accepted_at) values (?, ?, ?)
    on conflict(user_id, version) do nothing`).bind(userId, LEGAL_UPDATED, Math.floor(Date.now() / 1000)).run();
  return true;
}

// Why this signed-in person can't start AI work now: [status, message] or null.
export async function legalProblem(env, userId) {
  if (!legalGateOn(env) || !userId) return null;
  const { current, accepted } = await legalState(env, userId);
  return accepted === current ? null : [403, LEGAL_FIRST];
}
