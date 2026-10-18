// Task reminders (S47): a task's time, the list handed to Android, and Done / Snooze
// tapped on a notification coming back through actions.js.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seg } from './helpers.mjs';
import { disk } from '../app/core/disk.js';
import { db } from '../app/core/db.js';
import { createRecording } from '../app/domain/recordings.js';
import { addAction, getAction, setActionDue, setActionTime, setActionWhen } from '../app/domain/actions.js';
import { reminderPlan, syncReminders, applyReminderTaps, MAX_REMINDERS } from '../app/domain/reminders.js';
import { sanitize } from '../bridge/gemini.mjs';
import { parseRoute } from '../app/ui/router.js';
import { toServerRow, fromServerRow } from '../app/core/cloud-sync.js';

// A stand-in for Android's MulloNative (Reminders.kt): what Mullo hands it, and taps waiting.
function fakePhone(taps = []) {
  const phone = { pushed: [], acked: [], taps };
  globalThis.MulloNative = {
    setReminders: (json) => phone.pushed.push(JSON.parse(json)),
    reminderTaps: () => JSON.stringify(phone.taps),
    reminderTapsDone: (json) => phone.acked.push(...JSON.parse(json)),
  };
  return phone;
}

beforeEach(() => { freshDb(); disk.remove('echo:settings'); });
afterEach(() => { delete globalThis.MulloNative; });

const NOW = new Date(2026, 9, 15, 14, 30); // Thu 15 Oct 2026, 14:30 local
const task = (over) => ({ id: over.label, status: 'open', due_date: null, due_time: null, recording_id: 'r1', ...over });

test('plan: only open tasks with a day AND a time still ahead, nearest first, with the note they came from', () => {
  const plan = reminderPlan([
    task({ label: 'Call Dana', due_date: '2026-10-16', due_time: '15:00' }),
    task({ label: 'Pay rent', due_date: '2026-10-15', due_time: '14:30' }), // this minute still rings
    task({ label: 'Gone by', due_date: '2026-10-15', due_time: '14:29' }),
    task({ label: 'Day only', due_date: '2026-10-15' }),
    task({ label: 'Done one', due_date: '2026-10-16', due_time: '09:00', status: 'done' }),
    task({ label: 'Dropped', due_date: '2026-10-16', due_time: '09:00', status: 'cancelled' }),
    task({ label: 'Bad time', due_date: '2026-10-16', due_time: '9am' }),
    task({ label: 'Loose', due_date: '2026-10-17', due_time: '08:00', recording_id: null }),
  ], (id) => (id === 'r1' ? 'Tuesday meeting' : null), NOW);
  assert.deepEqual(plan, [
    { id: 'Pay rent', at: '2026-10-15T14:30', text: 'Pay rent', from: 'Tuesday meeting' },
    { id: 'Call Dana', at: '2026-10-16T15:00', text: 'Call Dana', from: 'Tuesday meeting' },
    { id: 'Loose', at: '2026-10-17T08:00', text: 'Loose', from: null },
  ]);
});

test('plan: at most the nearest 64', () => {
  const many = Array.from({ length: 70 }, (_, i) => task({ label: `t${i}`, due_date: '2026-11-01', due_time: `${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` }));
  assert.equal(reminderPlan(many, () => null, NOW).length, MAX_REMINDERS);
});

test('a time needs a day; moving the day keeps it, taking the day away takes it too', async () => {
  const rec = await createRecording({ title: 'Note' });
  let res = await addAction(rec.id, { label: 'Call Dana', due_time: '15:00' });
  assert.equal(res.row.due_time, null, 'a time without a day is dropped');
  res = await addAction(rec.id, { label: 'Call Guy', due_date: '2026-10-16', due_time: '25:00' });
  assert.equal(res.row.due_time, null, 'not a clock time');

  let a = (await addAction(rec.id, { label: 'Send the quote' })).row;
  assert.equal((await setActionTime(a, '09:00')).ok, false, 'pick a day first');
  await setActionDue(a, '2026-10-16');
  a = await getAction(a.id);
  assert.equal((await setActionTime(a, '9:00')).ok, false);
  await setActionTime(a, '09:00');
  a = await getAction(a.id);
  assert.deepEqual([a.due_date, a.due_time, a.edited], ['2026-10-16', '09:00', true]);
  await setActionDue(a, '2026-10-17');
  a = await getAction(a.id);
  assert.deepEqual([a.due_date, a.due_time], ['2026-10-17', '09:00'], 'the time stays when only the day moves');
  await setActionDue(a, null);
  a = await getAction(a.id);
  assert.deepEqual([a.due_date, a.due_time], [null, null]);
});

test('the time rides in extra to the server and comes back as a field', () => {
  const row = { id: 'a', label: 'Call Dana', type: 'create_reminder', status: 'open', due_date: '2026-10-16', due_time: '15:00' };
  const sent = toServerRow('action_items', row);
  assert.equal('due_time' in sent, false, 'no column for it');
  assert.equal(sent.extra.due_time, '15:00');
  assert.equal(fromServerRow('action_items', { ...sent, updated_at: 'x' }).due_time, '15:00');
});

test('sync to the phone: the whole list, the lock-screen choice, nothing when switched off', async () => {
  const phone = fakePhone();
  const rec = await createRecording({ title: 'Supplier call' });
  await addAction(rec.id, { label: 'Call Dana', due_date: '2099-01-02', due_time: '15:00' });
  await addAction(rec.id, { label: 'No time', due_date: '2099-01-02' });
  await syncReminders();
  assert.deepEqual(phone.pushed.at(-1), {
    on: true,
    hideOnLock: false,
    items: [{ id: phone.pushed.at(-1).items[0].id, at: '2099-01-02T15:00', text: 'Call Dana', from: 'Supplier call' }],
  });
  disk.set('echo:settings', { reminders: false, remindersHidden: true });
  await syncReminders();
  assert.deepEqual(phone.pushed.at(-1), { on: false, hideOnLock: true, items: [] });
});

test('no phone app (a browser): nothing is pushed and no taps are read', async () => {
  await syncReminders();
  assert.equal(await applyReminderTaps(), 0);
});

test('Done and Snooze tapped on a notification are written through actions.js, audited, then let go', async () => {
  const rec = await createRecording({ title: 'Note' });
  const call = (await addAction(rec.id, { label: 'Call Dana', due_date: '2026-10-15', due_time: '15:00' })).row;
  const pay = (await addAction(rec.id, { label: 'Pay rent', due_date: '2026-10-15', due_time: '16:00' })).row;
  const gone = (await addAction(rec.id, { label: 'Old one', due_date: '2026-10-15', due_time: '17:00' })).row;
  await db.remove('action_items', gone.id, { intent: 'test' });
  const phone = fakePhone([
    { key: 'k1', id: call.id, act: 'done' },
    { key: 'k2', id: pay.id, act: 'snooze', date: '2026-10-16', time: '16:00' },
    { key: 'k3', id: gone.id, act: 'done' },
    { key: 'k4', id: pay.id, act: 'snooze', date: 'soon', time: '16:00' },
  ]);
  assert.equal(await applyReminderTaps(), 2);
  assert.equal((await getAction(call.id)).status, 'done');
  const moved = await getAction(pay.id);
  assert.deepEqual([moved.due_date, moved.due_time, moved.status], ['2026-10-16', '16:00', 'open']);
  assert.deepEqual(phone.acked, ['k1', 'k2', 'k3', 'k4'], 'every tap is let go, written or not, so none loops');
  const log = await db.list('activity');
  assert.ok(log.some((e) => e.reason === 'done from the reminder'));
  assert.ok(log.some((e) => e.reason === 'snoozed to 2026-10-16 16:00'));
});

test('a task done meanwhile is not snoozed back open', async () => {
  const rec = await createRecording({ title: 'Note' });
  const a = (await addAction(rec.id, { label: 'Call Dana', due_date: '2026-10-15', due_time: '15:00', status: 'done' })).row;
  fakePhone([{ key: 'k', id: a.id, act: 'snooze', date: '2026-10-16', time: '15:00' }]);
  assert.equal(await applyReminderTaps(), 0);
  assert.deepEqual([(await getAction(a.id)).due_date, (await getAction(a.id)).status], ['2026-10-15', 'done']);
});

test('setActionWhen refuses anything that is not a day and a clock time', async () => {
  const rec = await createRecording({ title: 'Note' });
  const a = (await addAction(rec.id, { label: 'Call Dana' })).row;
  assert.equal((await setActionWhen(a, '2026-10-16', '3pm')).ok, false);
  assert.equal((await setActionWhen(a, null, '15:00')).ok, false);
});

test('the AI may give a time only with a day; "9:00" reads as 09:00', () => {
  const out = sanitize({
    title: 'x', sections: [], blocks: [],
    actions: [
      { label: 'Call Dana', type: 'create_reminder', due_date: '2026-10-20', due_time: '15:00' },
      { label: 'Call Guy', type: 'create_reminder', due_date: '2026-10-20', due_time: '9:00' },
      { label: 'Pay rent', type: 'create_reminder', due_date: null, due_time: '10:00' },
      { label: 'Book flights', type: 'create_reminder', due_date: '2026-10-20', due_time: '24:00' },
      { label: 'Send quote', type: 'create_reminder', due_date: '2026-10-20', due_time: 'morning' },
    ],
  }, { template: 'general', segments: [seg('hi')], model: 'm' });
  assert.deepEqual(out.actions.map((a) => a.due_time), ['15:00', '09:00', null, null, null]);
});

test('#/actions/<task id> opens Actions with that task first', () => {
  assert.deepEqual(parseRoute('#/actions/3f2a-9c'), { screen: 'actions', params: { focus: '3f2a-9c' } });
  assert.deepEqual(parseRoute('#/actions'), { screen: 'actions', params: { focus: null } });
});
