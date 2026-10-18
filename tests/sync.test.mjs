// Sync groundwork rules, fixed before the network arrives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDelta, advanceCursor, cursor, recordReceipt, dueReceipts, RECEIPT_CHECK_MS, heldSet, saveHeldSet } from '../app/core/sync.js';
import { massDeleteAlerts, pendingLevel } from '../app/core/watchdog.js';
import { shouldReload, createVersionWatch } from '../app/core/version.js';
import { localDate, addDays, nextWeekday } from '../app/core/dates.js';

test('absence from a delta is NOT a delete', () => {
  const local = { a: { id: 'a', v: 1 }, b: { id: 'b', v: 1 } };
  const { next } = mergeDelta({ base: local, local, changed: [{ id: 'a', v: 2 }] });
  assert.deepEqual(Object.keys(next).sort(), ['a', 'b']);
  assert.equal(next.a.v, 2);
});

test('an intent delete removes the row unless it has unsent local edits', () => {
  const local = { a: { id: 'a' }, b: { id: 'b' } };
  const { next, conflicts } = mergeDelta({ base: local, local, deleted: ['a', 'b'], dirty: new Set(['b']) });
  assert.deepEqual(Object.keys(next), ['b']);
  assert.equal(conflicts.length, 1);
});

test('three-way: my field edit survives the server\'s other-field edit; same-field clash is reported, mine kept', () => {
  const base = { a: { id: 'a', title: 'T', status: 'open', note: 'n' } };
  const local = { a: { id: 'a', title: 'Mine', status: 'open', note: 'n' } };
  const remote = { id: 'a', title: 'Theirs', status: 'done', note: 'n' };
  const { next, conflicts } = mergeDelta({ base, local, changed: [remote], dirty: new Set(['a']) });
  assert.deepEqual(next.a, { id: 'a', title: 'Mine', status: 'done', note: 'n' });
  assert.deepEqual(conflicts.map((c) => c.key), ['title']);
});

test('only an applied pull advances the cursor', () => {
  advanceCursor('t', 'c1', { applied: true });
  advanceCursor('t', 'c2', { applied: false });
  assert.equal(cursor('t'), 'c1');
});

test('held-set persists', () => {
  saveHeldSet('recordings', new Set(['x', 'y']));
  assert.deepEqual([...heldSet('recordings')].sort(), ['x', 'y']);
});

test('write receipts come due after 90 seconds', () => {
  recordReceipt('recordings', 'r1', 's', 1_000);
  assert.equal(dueReceipts(1_000 + RECEIPT_CHECK_MS - 1).length, 0);
  assert.equal(dueReceipts(1_000 + RECEIPT_CHECK_MS).length, 1);
});

test('mass-delete detector fires on rows, and only inside the window', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const at = new Date(now - 60_000).toISOString();
  const many = Array.from({ length: 30 }, (_, i) => ({ action: 'delete', table: 'recordings', id: String(i), batch: 'one', at }));
  assert.equal(massDeleteAlerts(many, { now })[0].rows, 30);
  assert.deepEqual(massDeleteAlerts(many.slice(0, 5), { now }), []);
  assert.deepEqual(massDeleteAlerts(many, { now: now + 3_600_000 }), []);
});

test('pending work escalates with age', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(pendingLevel(null, now), 'none');
  assert.equal(pendingLevel(new Date(now - 60_000).toISOString(), now), 'ok');
  assert.equal(pendingLevel(new Date(now - 10 * 60_000).toISOString(), now), 'warn');
  assert.equal(pendingLevel(new Date(now - 60 * 60_000).toISOString(), now), 'alert');
});

test('update reload: only when higher, online and not busy', () => {
  assert.ok(shouldReload({ remote: 2, local: 1, online: true, busy: false }));
  assert.ok(!shouldReload({ remote: 2, local: 1, online: false, busy: false }));
  assert.ok(!shouldReload({ remote: 2, local: 1, online: true, busy: true }));
  assert.ok(!shouldReload({ remote: 1, local: 1, online: true, busy: false }));
  assert.ok(!shouldReload({ remote: Number.NaN, local: 1, online: true, busy: false }));
});

test('version watch saves drafts before reloading, and survives a failed probe', async () => {
  const calls = [];
  const watch = createVersionWatch({
    fetchVersion: async () => 999,
    isOnline: () => true,
    isBusy: () => false,
    beforeReload: () => calls.push('save'),
    reload: () => calls.push('reload'),
  });
  assert.equal(await watch.check(), true);
  assert.deepEqual(calls, ['save', 'reload']);
  const failing = createVersionWatch({
    fetchVersion: async () => { throw new Error('offline'); },
    isOnline: () => true, isBusy: () => false, beforeReload: () => {}, reload: () => assert.fail('must not reload'),
  });
  assert.equal(await failing.check(), false);
});

// Never stub a varying input as a constant: walk a whole year of days.
test('local dates: every day of a year, across DST, round-trips', () => {
  let d = '2026-01-01';
  for (let i = 0; i < 366; i += 1) {
    const next = addDays(d, 1);
    assert.equal(addDays(next, -1), d);
    assert.notEqual(next, d);
    d = next;
  }
  assert.equal(d, '2027-01-02');
  assert.equal(localDate(new Date(2026, 9, 3, 23, 59)), '2026-10-03', '11:59pm is still today');
  for (let wd = 0; wd < 7; wd += 1) {
    const n = nextWeekday('2026-10-03', wd);
    assert.ok(n > '2026-10-03' && n <= '2026-10-10');
  }
});
