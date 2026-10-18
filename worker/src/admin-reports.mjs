// Admin reports (S59 round 1, spec docs/specs/2026-10-18-admin-reports-design.md): one
// dashboard with a window per area, each opening its report. Patterned on the ERP's reports:
//   - no fake data: what isn't recorded says so and waits, never an estimate;
//   - every report states its blind spots next to the numbers;
//   - every rate shows its sample size ("2 of 3"), never a bare percentage;
//   - Pro counts come from the accounts table, which mirrors Stripe and Apple;
//   - pure reads, never note content (D1 holds none). An email only where the admin must act
//     on someone (Heavy users), never on the dashboard.
// collect() reads D1; everything else is pure (tests/admin-reports.test.mjs).

import { ready, monthOf } from './usage.mjs';

export const REPORTS = ['people', 'subscriptions', 'heavy', 'features', 'legal', 'problems', 'log', 'groups', 'cost'];
const DAY = 86400;
const NEAR = 0.8; // "near the cap" = 80% of an allowance

const ofText = (n, d) => `${n} of ${d}`;
const minutes = (seconds) => Math.ceil((seconds ?? 0) / 60);
const short = (id) => String(id ?? '').slice(0, 8);
const dayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

// Everything the reports read, in one pass. Reports: never the text, the email or the screenshot.
export async function collect(env) {
  await ready(env);
  const all = async (sql) => (await env.DB.prepare(sql).all()).results ?? [];
  const [plans, links, accounts, usage, released, google, keys, picks, legal, reports, log] = await Promise.all([
    all('select user_id, plan, trial_seconds, created_at from plans'),
    all('select user_id, subscription_id, linked_at from account_users'),
    all('select subscription_id, customer_id, email, status, period_end from accounts'),
    all('select subscription_id as holder, month, tokens, calls, seconds from usage'),
    all('select subscription_id, released_at from released_subscriptions'),
    all('select user_id from google_links where dead = 0'),
    all('select user_id from api_keys where dead = 0'),
    all('select user_id, model from model_picks'),
    all('select user_id, version, accepted_at from legal_acceptances'),
    all('select status, details, created_at, closed_at from reports'),
    all('select at, admin_id, action, detail from admin_log order by at desc limit 100'),
  ]);
  return { plans, links, accounts, usage, released, google, keys, picks, legal, reports, log };
}

// ctx: { now (unix seconds), month ('YYYY-MM'), usable(account) → why not | null (index.mjs),
//        monthlySeconds, monthlyTokens, legalCurrent }
export function contextOf(env, extra) {
  return {
    now: Math.floor(Date.now() / 1000), month: monthOf(),
    monthlySeconds: Number(env.MONTHLY_MINUTES ?? 1800) * 60, monthlyTokens: Number(env.MONTHLY_TOKENS ?? 10_000_000),
    ...extra,
  };
}

// Every Mullo account the server has seen: a plans row (any call by a signed-in account that
// isn't Pro) or a linked subscription. Plan now: pro (linked + usable) | free | trial | none.
export function peopleOf(d, ctx) {
  const subs = new Map(d.accounts.map((a) => [a.subscription_id, a]));
  const people = new Map();
  for (const p of d.plans) people.set(p.user_id, { id: p.user_id, plan: p.plan, trialSeconds: p.trial_seconds ?? 0, since: p.created_at, linked: null });
  for (const l of d.links) {
    const e = people.get(l.user_id) ?? { id: l.user_id, plan: 'none', trialSeconds: 0, since: l.linked_at, linked: null };
    e.since = Math.min(e.since, l.linked_at);
    e.linked = l.linked_at;
    const sub = subs.get(l.subscription_id);
    if (sub && !ctx.usable(sub, ctx.now)) e.plan = 'pro';
    people.set(l.user_id, e);
  }
  return [...people.values()];
}

// The last four 7-day windows, newest last: [{ from, to, label }].
export function lastWeeks(now, n = 4) {
  return Array.from({ length: n }, (_, i) => {
    const to = now - (n - 1 - i) * 7 * DAY;
    const from = to - 7 * DAY;
    return { from, to, label: `${dayOf(from + DAY)} to ${dayOf(to)}` };
  });
}

const NOT_SEEN = 'Accounts that signed up but never called Mullo\'s server are not counted: the Worker can\'t list Supabase accounts (and gets no key for it). Count unknown.';

function people(d, ctx) {
  const list = peopleOf(d, ctx);
  const byPlan = ['pro', 'free', 'trial', 'none'].map((p) => [p, list.filter((e) => e.plan === p).length]);
  const monthStart = Date.UTC(Number(ctx.month.slice(0, 4)), Number(ctx.month.slice(5, 7)) - 1, 1) / 1000;
  const newThisMonth = list.filter((e) => e.since >= monthStart).length;
  const weeks = lastWeeks(ctx.now).map((w) => [w.label, list.filter((e) => e.since > w.from && e.since <= w.to).length]);
  const ever = new Map();
  for (const u of d.usage) ever.set(u.holder, (ever.get(u.holder) ?? 0) + (u.seconds ?? 0));
  const trials = list.filter((e) => e.trialSeconds > 0);
  const used = trials.filter((e) => (ever.get(`user:${e.id}`) ?? 0) > 0).length;
  const pro = trials.filter((e) => e.linked).length;
  return {
    title: 'People & plans',
    window: { value: list.length, line: `${weeks.at(-1)[1]} new in the last 7 days` },
    tiles: [
      { label: 'Accounts', value: list.length },
      { label: `New in ${ctx.month}`, value: newThisMonth },
      { label: 'New in the last 7 days', value: weeks.at(-1)[1] },
    ],
    blind: [NOT_SEEN],
    tables: [
      { id: 'plans', title: 'Accounts by plan now', columns: ['Plan', 'Accounts'], rows: byPlan },
      { id: 'weeks', title: 'New accounts, last 4 weeks', columns: ['Week', 'New accounts'], rows: weeks, bars: true },
      { id: 'trials', title: 'Trial funnel', columns: ['Step', 'Accounts'], rows: [
        ['Started a trial', trials.length],
        ['Used some minutes', ofText(used, trials.length)],
        ['Went Pro', ofText(pro, trials.length)],
      ] },
    ],
  };
}

const storeOf = (a) => (String(a.subscription_id).startsWith('apple:') || a.customer_id === 'apple' ? 'Apple' : 'Stripe');
function statusOf(a, ctx) {
  if (!ctx.usable(a, ctx.now)) return 'Active';
  if (a.status === 'past_due' || a.status === 'unpaid') return 'Past due';
  if (a.status === 'canceled' || a.status === 'incomplete_expired') return 'Cancelled';
  if (a.status === 'active' || a.status === 'trialing') return 'Ended (paid period over)';
  return `Other (${a.status})`;
}

function subscriptions(d, ctx) {
  const linked = new Set(d.links.map((l) => l.subscription_id));
  const rows = d.accounts.map((a) => ({ store: storeOf(a), status: statusOf(a, ctx), linked: linked.has(a.subscription_id) }));
  const active = rows.filter((r) => r.status === 'Active');
  const statuses = [...new Set(rows.map((r) => r.status))].sort((a, b) => (a === 'Active' ? -1 : b === 'Active' ? 1 : a.localeCompare(b)));
  const count = (status, store) => rows.filter((r) => r.status === status && (!store || r.store === store)).length;
  const stripe = active.filter((r) => r.store === 'Stripe').length;
  const apple = active.length - stripe;
  const unlinked = active.filter((r) => !r.linked).length;
  return {
    title: 'Subscriptions',
    window: { value: active.length, line: `Pro: ${stripe} Stripe, ${apple} Apple` },
    tiles: [
      { label: 'Active Pro', value: active.length },
      { label: 'Stripe', value: stripe },
      { label: 'Apple', value: apple },
      { label: 'Past due', value: count('Past due') },
    ],
    blind: [
      'Revenue isn\'t recorded here: amounts, tax and fees live in Stripe and App Store Connect. Active counts here should equal theirs; a difference means a missed store notice.',
      ...(unlinked ? [`${ofText(unlinked, active.length)} active subscriptions aren't linked to a Mullo account (bought on the website, key never used in the app).`] : []),
      ...(d.released.length ? [`${d.released.length} App Store subscriptions belong to deleted accounts and may still be billed by Apple (only the person can cancel).`] : []),
    ],
    tables: [
      { id: 'status', title: 'Subscriptions by status and store', columns: ['Status', 'Stripe', 'Apple', 'All'],
        rows: statuses.map((s) => [s, count(s, 'Stripe'), count(s, 'Apple'), count(s)]) },
    ],
  };
}

function heavy(d, ctx) {
  const people = new Map(peopleOf(d, ctx).map((e) => [e.id, e]));
  const subs = new Map(d.accounts.map((a) => [a.subscription_id, a]));
  const ever = new Map();
  for (const u of d.usage) ever.set(u.holder, (ever.get(u.holder) ?? 0) + (u.seconds ?? 0));
  const month = d.usage.filter((u) => u.month === ctx.month && (u.calls || u.seconds || u.tokens));
  const list = [];
  for (const u of month) {
    let who; let plan; let used = u.seconds ?? 0; let allowed = ctx.monthlySeconds; let tokenShare = (u.tokens ?? 0) / ctx.monthlyTokens;
    if (u.holder.startsWith('user:')) {
      const e = people.get(u.holder.slice(5));
      // Now Pro (its allowance is the subscription's) or no plan: no own allowance to be near.
      if (!e || e.plan === 'pro' || e.plan === 'none') continue;
      plan = e.plan;
      who = `account ${short(u.holder.slice(5))}`;
      if (e.plan === 'trial') { used = ever.get(u.holder) ?? 0; allowed = e.trialSeconds; tokenShare = 0; }
    } else {
      plan = 'pro';
      who = subs.get(u.holder)?.email ?? `subscription ${short(u.holder)}`;
    }
    const share = Math.max(allowed ? used / allowed : 0, tokenShare);
    if (share >= NEAR) list.push({ who, plan, used, allowed, share });
  }
  list.sort((a, b) => b.share - a.share);
  const capped = list.filter((r) => r.share >= 1).length;
  return {
    title: 'Heavy users & limits',
    window: { value: list.length, line: `at or near a cap, of ${month.length} using AI this month` },
    tiles: [
      { label: 'At or near a cap', value: ofText(list.length, month.length) },
      { label: 'At the cap', value: capped },
    ],
    blind: [
      'Emails are known only for website Pro (from Stripe checkout); everyone else shows a short account id.',
      'Per-minute limit hits aren\'t kept (the counter keeps 5 minutes); they start being counted with the failures recording.',
      'Own AI keys use no Mullo allowance and never show here.',
    ],
    tables: [
      { id: 'heavy', title: `At 80% or more of an allowance, ${ctx.month}`, columns: ['Who', 'Plan', 'Minutes used', 'Minutes allowed', 'Share'],
        rows: list.map((r) => [r.who, r.plan, minutes(r.used), minutes(r.allowed), `${Math.round(r.share * 100)}%`]) },
    ],
  };
}

function features(d, ctx) {
  const n = peopleOf(d, ctx).length;
  const keyPeople = new Set(d.keys.map((k) => k.user_id)).size;
  const byModel = new Map();
  for (const p of d.picks) byModel.set(p.model, (byModel.get(p.model) ?? 0) + 1);
  return {
    title: 'Feature use',
    window: { value: d.google.length, line: `Google connected, ${keyPeople} with API keys` },
    tiles: [
      { label: 'Google connected', value: ofText(d.google.length, n) },
      { label: 'Accounts with API keys', value: ofText(keyPeople, n) },
      { label: 'Picked a summary model', value: ofText(d.picks.length, n) },
    ],
    blind: [
      'Own AI keys aren\'t recorded: the Worker keeps no key. They start being counted when account switches are recorded (S59 next step).',
      'Connected apps (Claude, ChatGPT) sign in through Supabase and aren\'t listed in D1; only API keys are.',
    ],
    tables: [
      { id: 'features', title: 'Features in use', columns: ['Feature', 'Accounts', 'Count'], rows: [
        ['Google Calendar / Tasks', d.google.length, d.google.length],
        ['API keys (live)', keyPeople, d.keys.length],
        ['Summary model picked', d.picks.length, d.picks.length],
      ] },
      { id: 'models', title: 'Summary model picks', columns: ['Model', 'Accounts'], rows: [...byModel].sort((a, b) => b[1] - a[1]) },
    ],
  };
}

function legal(d, ctx) {
  const list = peopleOf(d, ctx);
  const latest = new Map();
  for (const r of d.legal) if (!latest.has(r.user_id) || r.accepted_at > latest.get(r.user_id).accepted_at) latest.set(r.user_id, r);
  const byVersion = new Map();
  for (const r of latest.values()) byVersion.set(r.version, (byVersion.get(r.version) ?? 0) + 1);
  const current = byVersion.get(ctx.legalCurrent) ?? 0;
  const never = list.filter((e) => !latest.has(e.id)).length;
  return {
    title: 'Privacy & Terms',
    window: { value: ofText(current, list.length), line: 'on the current version' },
    tiles: [
      { label: 'On the current version', value: ofText(current, list.length) },
      { label: 'On an older version', value: latest.size - current },
      { label: 'Never accepted', value: never },
    ],
    blind: [`Current version: "${ctx.legalCurrent}". Accounts on an older one are asked again when they open Mullo.`],
    tables: [
      { id: 'versions', title: 'Newest version each account accepted', columns: ['Version', 'Accounts'],
        rows: [...[...byVersion].sort((a, b) => (a[0] === ctx.legalCurrent ? -1 : b[0] === ctx.legalCurrent ? 1 : 0)), ['Never accepted', never]] },
    ],
  };
}

const json = (s) => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const duration = (sec) => (sec == null ? '-' : sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : sec < 2 * DAY ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / DAY)} days`);

function problems(d) {
  const open = d.reports.filter((r) => r.status === 'open');
  const closed = d.reports.filter((r) => r.status === 'closed' && r.closed_at);
  const tally = (key) => {
    const m = new Map();
    for (const r of d.reports) {
      const k = String(json(r.details)[key] ?? 'not said');
      const row = m.get(k) ?? [k, 0, 0];
      row[r.status === 'open' ? 1 : 2] += 1;
      m.set(k, row);
    }
    return [...m.values()].sort((a, b) => (b[1] + b[2]) - (a[1] + a[2]));
  };
  const toClose = median(closed.map((r) => r.closed_at - r.created_at));
  return {
    title: 'Problem reports',
    window: { value: open.length, line: open.length === 1 ? 'open report' : 'open reports' },
    tiles: [
      { label: 'Open', value: open.length },
      { label: 'Closed (last 90 days)', value: closed.length },
      { label: 'Median time to close', value: closed.length ? `${duration(toClose)} (${closed.length} closed)` : '-' },
    ],
    blind: ['Closed reports are deleted 90 days after closing, so closed counts cover about the last 90 days only.'],
    link: { href: '#/settings/admin-reports', label: 'Open the reports' },
    tables: [
      { id: 'platform', title: 'By platform', columns: ['Platform', 'Open', 'Closed'], rows: tally('platform') },
      { id: 'version', title: 'By app version', columns: ['Version', 'Open', 'Closed'], rows: tally('version') },
    ],
  };
}

function log(d) {
  return {
    title: 'Admin log',
    window: { value: d.log.length, line: d.log.length ? `latest: ${d.log[0].action}, ${dayOf(d.log[0].at)}` : 'nothing yet' },
    tiles: [],
    blind: d.log.length >= 100 ? ['Showing the newest 100 entries.'] : [],
    tables: [
      { id: 'log', title: 'Newest first', columns: ['When (UTC)', 'Admin', 'Action', 'Detail'],
        rows: d.log.map((r) => [new Date(r.at * 1000).toISOString().slice(0, 16).replace('T', ' '), short(r.admin_id), r.action, r.detail ?? '']) },
    ],
  };
}

// "How people use Mullo" (Bridge users). Nothing is counted yet: an empty table would read as
// zero, so the report says it hasn't started instead.
function groups() {
  return {
    title: 'How people use Mullo',
    since: null,
    window: { value: '-', line: 'not counted yet' },
    tiles: [],
    blind: [
      'Not counted yet. The groups (As is, Mixed, Bridge users through us, Bridge users fully theirs, Device only, Left) need the account switches and the anonymous daily count, which start in the next S59 step (the daily count waits for the owner\'s decision 2).',
    ],
    tables: [],
  };
}

function cost(d, ctx) {
  const month = d.usage.filter((u) => u.month === ctx.month);
  const kinds = new Map();
  for (const u of month) {
    const k = u.holder.startsWith('user:') ? 'Trial / free (own plan)' : 'Pro';
    const row = kinds.get(k) ?? [k, 0, 0, 0, 0];
    row[1] += 1; row[2] += u.seconds ?? 0; row[3] += u.calls ?? 0; row[4] += u.tokens ?? 0;
    kinds.set(k, row);
  }
  const seconds = month.reduce((n, u) => n + (u.seconds ?? 0), 0);
  const calls = month.reduce((n, u) => n + (u.calls ?? 0), 0);
  return {
    title: 'AI use & cost',
    window: { value: minutes(seconds), line: `minutes in ${ctx.month}, cost not recorded yet` },
    tiles: [
      { label: `Minutes in ${ctx.month}`, value: minutes(seconds) },
      { label: 'AI calls', value: calls },
    ],
    blind: [
      'Cost isn\'t recorded yet: usage has no model and no input/output split, so any cost here would be an estimate. Cost per model and job starts with the next S59 step.',
      'Own AI keys are paid by the person and never counted.',
    ],
    tables: [
      { id: 'plans', title: `AI use by plan, ${ctx.month}`, columns: ['Plan', 'Accounts', 'Minutes', 'Calls', 'Tokens'],
        rows: [...kinds.values()].map((r) => [r[0], r[1], minutes(r[2]), r[3], r[4]]) },
    ],
  };
}

const BUILD = { people, subscriptions, heavy, features, legal, problems, log, groups, cost };

export function reportOf(name, data, ctx) {
  if (!BUILD[name]) return null;
  const { window, ...report } = BUILD[name](data, ctx);
  return { name, generatedAt: ctx.now, month: ctx.month, ...report };
}

// The dashboard: one window per report, a number and one line. No emails, no ids.
export function dashboardOf(data, ctx) {
  return {
    generatedAt: ctx.now, month: ctx.month,
    windows: REPORTS.map((name) => {
      const r = BUILD[name](data, ctx);
      return { name, title: r.title, value: r.window.value, line: r.window.line, blind: r.blind.length };
    }),
  };
}
