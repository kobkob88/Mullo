// Admin reports (S59 round 1, worker/src/admin-reports.mjs): the pure engines, on made-up rows.
// The route (admins only, real D1) is in worker.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportOf, dashboardOf, peopleOf, lastWeeks, REPORTS } from '../worker/src/admin-reports.mjs';
import { toCsv, csvCell, csvName } from '../app/core/csv.js';
import { statsName } from '../app/ui/admin-stats.js';

const NOW = Date.UTC(2026, 9, 18, 12) / 1000; // 2026-10-18 12:00 UTC
const DAY = 86400;
const ACTIVE = new Set(['active', 'trialing']);
const usable = (a, now) => (ACTIVE.has(a.status) && !(a.period_end && a.period_end + 3 * DAY < now) ? null : 'not usable');
const ctx = { now: NOW, month: '2026-10', usable, monthlySeconds: 1800 * 60, monthlyTokens: 10_000_000, legalCurrent: 'v2' };

const empty = () => ({ plans: [], links: [], accounts: [], usage: [], released: [], google: [], keys: [], picks: [], legal: [], reports: [], log: [] });

function sample() {
  const d = empty();
  d.plans = [
    { user_id: 'u-trial-used', plan: 'trial', trial_seconds: 600, created_at: NOW - 2 * DAY },
    { user_id: 'u-trial-idle', plan: 'trial', trial_seconds: 600, created_at: NOW - 10 * DAY },
    { user_id: 'u-free', plan: 'free', trial_seconds: 0, created_at: NOW - 40 * DAY },
    { user_id: 'u-went-pro', plan: 'trial', trial_seconds: 600, created_at: NOW - 20 * DAY },
  ];
  d.accounts = [
    { subscription_id: 'sub_web', customer_id: 'cus_1', email: 'payer@example.com', status: 'active', period_end: NOW + 20 * DAY },
    { subscription_id: 'apple:100', customer_id: 'apple', email: null, status: 'active', period_end: NOW + 20 * DAY },
    { subscription_id: 'sub_late', customer_id: 'cus_2', email: null, status: 'past_due', period_end: NOW - DAY },
    { subscription_id: 'sub_gone', customer_id: 'cus_3', email: null, status: 'canceled', period_end: NOW - 30 * DAY },
  ];
  d.links = [
    { user_id: 'u-went-pro', subscription_id: 'sub_web', linked_at: NOW - 5 * DAY },
    { user_id: 'u-apple', subscription_id: 'apple:100', linked_at: NOW - 3 * DAY },
  ];
  d.usage = [
    { holder: 'user:u-trial-used', month: '2026-10', tokens: 100, calls: 3, seconds: 540 }, // 90% of the trial
    { holder: 'user:u-went-pro', month: '2026-09', tokens: 50, calls: 1, seconds: 120 },
    { holder: 'sub_web', month: '2026-10', tokens: 900, calls: 40, seconds: 1800 * 60 }, // at the cap
    { holder: 'apple:100', month: '2026-10', tokens: 10, calls: 1, seconds: 60 },
    { holder: 'user:u-free', month: '2026-09', tokens: 10, calls: 1, seconds: 1800 * 60 }, // last month: not this one
  ];
  return d;
}

test('people: every account the server has seen, by plan now; a linked usable subscription is Pro', () => {
  const list = peopleOf(sample(), ctx);
  assert.equal(list.length, 5, 'four plans rows + one account seen only through its link');
  const plan = Object.fromEntries(list.map((e) => [e.id, e.plan]));
  assert.deepEqual(plan, { 'u-trial-used': 'trial', 'u-trial-idle': 'trial', 'u-free': 'free', 'u-went-pro': 'pro', 'u-apple': 'pro' });
  const r = reportOf('people', sample(), ctx);
  assert.deepEqual(r.tables.find((t) => t.id === 'plans').rows, [['pro', 2], ['free', 1], ['trial', 2], ['none', 0]]);
});

test('people: the trial funnel shows its sample size, never a bare percentage', () => {
  const funnel = reportOf('people', sample(), ctx).tables.find((t) => t.id === 'trials').rows;
  assert.deepEqual(funnel, [['Started a trial', 3], ['Used some minutes', '2 of 3'], ['Went Pro', '1 of 3']]);
  assert.ok(!JSON.stringify(funnel).includes('%'));
});

test('people: new per week over the last 4 weeks, newest last, and the blind spot is stated', () => {
  const r = reportOf('people', sample(), ctx);
  const weeks = r.tables.find((t) => t.id === 'weeks').rows;
  assert.equal(weeks.length, 4);
  assert.deepEqual(weeks.map((w) => w[1]), [0, 1, 1, 2]);
  assert.equal(r.tiles.find((t) => t.label === 'New in 2026-10').value, 3);
  assert.match(r.blind[0], /never called Mullo's server/);
  assert.deepEqual(lastWeeks(NOW).map((w) => w.label).at(-1), '2026-10-12 to 2026-10-18');
});

test('subscriptions: counts by store and status equal the accounts table; revenue is a blind spot, not a guess', () => {
  const d = sample();
  d.released = [{ subscription_id: 'apple:9', released_at: NOW }];
  const r = reportOf('subscriptions', d, ctx);
  const tile = (l) => r.tiles.find((t) => t.label === l).value;
  assert.equal(tile('Active Pro'), d.accounts.filter((a) => !usable(a, NOW)).length);
  assert.equal(tile('Stripe'), 1);
  assert.equal(tile('Apple'), 1);
  assert.equal(tile('Past due'), 1);
  const all = r.tables[0].rows.reduce((n, row) => n + row[3], 0);
  assert.equal(all, d.accounts.length, 'every subscription is in exactly one row');
  assert.match(r.blind[0], /Revenue isn't recorded/);
  assert.ok(r.blind.some((b) => /1 App Store subscriptions belong to deleted accounts/.test(b)));
  assert.ok(!JSON.stringify(r).match(/\$\d/), 'no money figure');
});

test('heavy users: at or near a cap this month, with the sample size; a trial counts its whole trial', () => {
  const r = reportOf('heavy', sample(), ctx);
  assert.equal(r.tiles[0].value, '2 of 3');
  assert.equal(r.tiles[1].value, 1);
  const rows = r.tables[0].rows;
  assert.deepEqual(rows[0], ['payer@example.com', 'pro', 1800, 1800, '100%']);
  assert.deepEqual(rows[1], ['account u-trial-', 'trial', 9, 10, '90%']);
});

test('the dashboard: one window per report, and no email or account id anywhere in it', () => {
  const d = sample();
  d.reports = [{ status: 'open', details: '{"platform":"android-app","version":"95"}', created_at: NOW - DAY, closed_at: null }];
  d.log = [{ at: NOW, admin_id: 'admin-0000-1111', action: 'grant_free', detail: 'abc' }];
  const dash = dashboardOf(d, ctx);
  assert.deepEqual(dash.windows.map((w) => w.name), REPORTS);
  const text = JSON.stringify(dash);
  assert.ok(!text.includes('@'), 'no email');
  for (const id of ['u-trial-used', 'u-went-pro', 'sub_web', 'apple:100', 'admin-0000']) assert.ok(!text.includes(id), id);
  assert.equal(dash.windows.find((w) => w.name === 'problems').value, 1);
});

test('not recorded yet = said, never an empty table that reads as zero', () => {
  const groups = reportOf('groups', sample(), ctx);
  assert.equal(groups.since, null);
  assert.deepEqual(groups.tables, []);
  assert.match(groups.blind[0], /Not counted yet/);
  const cost = reportOf('cost', sample(), ctx);
  assert.match(cost.blind[0], /Cost isn't recorded yet/);
  assert.equal(cost.tiles[0].value, Math.ceil((540 + 1800 * 60 + 60) / 60), 'minutes this month are real usage rows');
});

test('legal and features: rates carry their sample size', () => {
  const d = sample();
  d.legal = [
    { user_id: 'u-free', version: 'v1', accepted_at: 1 }, { user_id: 'u-free', version: 'v2', accepted_at: 2 },
    { user_id: 'u-apple', version: 'v1', accepted_at: 1 },
  ];
  d.google = [{ user_id: 'u-free' }];
  d.keys = [{ user_id: 'u-free' }, { user_id: 'u-free' }];
  d.picks = [{ user_id: 'u-free', model: 'model-a' }];
  const legal = reportOf('legal', d, ctx);
  assert.equal(legal.tiles[0].value, '1 of 5');
  assert.equal(legal.tiles[1].value, 1);
  assert.equal(legal.tiles[2].value, 3);
  const f = reportOf('features', d, ctx);
  assert.equal(f.tiles[0].value, '1 of 5');
  assert.equal(f.tiles[1].value, '1 of 5', 'two keys, one account');
});

test('problem reports: by platform and version, median time to close with its count', () => {
  const d = empty();
  d.reports = [
    { status: 'open', details: '{"platform":"ios-app","version":"95"}', created_at: NOW - DAY, closed_at: null },
    { status: 'closed', details: '{"platform":"ios-app","version":"94"}', created_at: NOW - 3 * DAY, closed_at: NOW - 3 * DAY + 7200 },
    { status: 'closed', details: 'not json', created_at: NOW - 2 * DAY, closed_at: NOW - 2 * DAY + 3600 * 4 },
  ];
  const r = reportOf('problems', d, ctx);
  assert.equal(r.tiles[2].value, '3 h (2 closed)');
  assert.deepEqual(r.tables[0].rows, [['ios-app', 1, 1], ['not said', 0, 1]]);
  assert.equal(reportOf('nope', d, ctx), null);
});

test('CSV: quotes, line breaks and formula-looking text are made safe; numbers stay numbers', () => {
  assert.equal(toCsv({ columns: ['Who', 'N'], rows: [['a, b', 3], ['say "hi"', -2], ['=HYPERLINK("x")', 0], ['two\nlines', null]] }),
    'Who,N\r\n"a, b",3\r\n"say ""hi""",-2\r\n"\'=HYPERLINK(""x"")",0\r\n"two\nlines",');
  assert.equal(csvCell('-5'), '\'-5', 'a typed minus is text');
  assert.equal(csvName('people', 'plans', '2026-10'), 'mullo-people-plans-2026-10.csv');
  assert.equal(statsName('admin-stats-heavy'), 'heavy');
  assert.equal(statsName('admin-dashboard'), null);
});
