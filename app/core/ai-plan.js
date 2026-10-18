// What Mullo's server last said about this account's AI plan (worker/src/plans.mjs):
// pro, free, trial or none, and whether it can start AI work now. Only the server
// decides; this is its last answer, kept so the app knows offline and at start
// whether to send recordings to the AI or keep them for later.
//
// Kept per account: someone else signing in on this phone starts unknown.

import { disk } from './disk.js';
import { emit } from './bus.js';

const KEY = 'echo:ai-plan';

// → { plan, active, minutesUsed?, minutesAllowed?, tokensUsed?, tokensAllowed?, admin?, at } or null
export function knownPlan(userId) {
  const saved = userId ? disk.get(KEY, null) : null;
  return saved?.userId === userId ? saved : null;
}

export function rememberPlan(userId, me) {
  if (!userId || !me?.plan) return;
  // legal: which Privacy Policy and Terms version is current and which was accepted (core/legal.js).
  const keep = ['plan', 'active', 'capped', 'minutesUsed', 'minutesAllowed', 'periodEnd', 'admin', 'legal'];
  const next = { userId, at: Date.now(), ...Object.fromEntries(keep.filter((k) => me[k] !== undefined).map((k) => [k, me[k]])) };
  const before = disk.get(KEY, null);
  disk.set(KEY, next);
  const legalMoved = before?.legal?.current !== next.legal?.current || before?.legal?.accepted !== next.legal?.accepted;
  if (before?.userId !== userId || before.plan !== next.plan || before.active !== next.active || legalMoved) emit('ai-plan', next);
}

export function forgetPlan() { disk.remove(KEY); }

// Minutes left: a trial's once, Pro's and free's this month. null = not known yet.
export function minutesLeft(p) {
  if (!p?.minutesAllowed) return null;
  return Math.max(0, p.minutesAllowed - (p.minutesUsed ?? 0));
}

// How much of the plan is left, 0..1 (the ring around the profile photo), or
// null with no plan. In minutes, like everything people see.
export function planLeft(p) {
  if (!['trial', 'pro', 'free'].includes(p?.plan)) return null;
  if (p.plan !== 'trial' && !p.active && !p.capped) return 0; // lapsed
  const left = minutesLeft(p);
  if (left === null) return p.plan === 'trial' ? 0 : 1; // a key with no numbers yet: full
  return left / p.minutesAllowed;
}

// Under a fifth left: the ring and the line turn amber, so it's seen before a recording is refused.
export const planLow = (p) => planLeft(p) !== null && planLeft(p) < 0.2;

const n = (x) => Number(x).toLocaleString('en-US');

// Words for a plan, for Settings.
export function planLine(p) {
  if (!p) return 'Checking your plan…';
  if (p.plan === 'pro' || p.plan === 'free') {
    const name = p.plan === 'pro' ? 'Mullo Pro' : 'Free Mullo Pro';
    if (p.capped) return `${name} · this month's minutes are used, back on the 1st`;
    if (!p.active) return `${name} · not active`;
    const left = minutesLeft(p);
    return left === null ? name : `${name} · ${n(left)} of ${n(p.minutesAllowed)} minutes left this month`;
  }
  if (p.plan === 'trial') {
    const left = minutesLeft(p) ?? 0;
    return p.active ? `Free trial · ${n(left)} of ${n(p.minutesAllowed)} minutes left` : 'Free trial · used up';
  }
  return 'No AI on this account yet';
}
