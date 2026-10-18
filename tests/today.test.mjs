import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greetingWord, todayNumbers } from '../app/domain/today.js';

test('the greeting follows the hour on the device', () => {
  assert.equal(greetingWord(3), 'Good evening');
  assert.equal(greetingWord(8), 'Good morning');
  assert.equal(greetingWord(12), 'Good afternoon');
  assert.equal(greetingWord(17), 'Good afternoon');
  assert.equal(greetingWord(18), 'Good evening');
});

const now = new Date(2026, 9, 17, 15, 30); // Oct 17, local time

test('counts are for the local day; done and cancelled tasks are left out', () => {
  const recordings = [
    { id: 'r1', local_date: '2026-10-17', duration_ms: 12 * 60000 },
    { id: 'r2', local_date: '2026-10-17', duration_ms: 41 * 60000 + 20000 },
    { id: 'r3', local_date: '2026-10-16', duration_ms: 5 * 60000 },
  ];
  const actions = [
    { id: 'a', status: 'open' }, { id: 'b', status: 'in_progress' },
    { id: 'c', status: 'done' }, { id: 'd', status: 'cancelled' },
  ];
  const n = todayNumbers({ recordings, actions, now });
  assert.equal(n.greeting, 'Good afternoon');
  assert.equal(n.today, '2026-10-17');
  assert.equal(n.recordingsToday, 2);
  assert.equal(n.minutesToday, 53);
  assert.equal(n.openCount, 2);
  assert.deepEqual(n.tasks.map((t) => t.id), ['a', 'b']);
});

test('tasks: overdue first, then nearest dates (the time breaks a tie), then no date; capped', () => {
  const actions = [
    { id: 'none', status: 'open' },
    { id: 'next-week', status: 'open', due_date: '2026-10-24' },
    { id: 'today-late', status: 'open', due_date: '2026-10-17', due_time: '16:00' },
    { id: 'today-early', status: 'open', due_date: '2026-10-17', due_time: '09:00' },
    { id: 'old', status: 'open', due_date: '2026-10-01' },
    { id: 'late', status: 'open', due_date: '2026-10-15' },
  ];
  const n = todayNumbers({ recordings: [], actions, now });
  assert.deepEqual(n.tasks.map((t) => t.id), ['old', 'late', 'today-early', 'today-late', 'next-week', 'none']);
  const capped = todayNumbers({ recordings: [], actions, now, limit: 2 });
  assert.equal(capped.tasks.length, 2);
  assert.equal(capped.openCount, 6, 'the count is all open tasks, not just the ones shown');
});
