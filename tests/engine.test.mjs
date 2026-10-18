// The local engine: sections, action items (English + Hebrew), summaries.
// The Hebrew sentences are written in the shape of real Pocket voice notes
// (a reminder phrase followed by a comma-separated task list), not copied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractActions, sectionize, summarize, titleFor, dueDateIn, actionType, splitSentences } from '../app/domain/engines/local.js';
import { seg } from './helpers.mjs';
import { pickerRows } from '../app/core/models.js';

const TODAY = '2026-10-03'; // a Saturday

test('one Hebrew reminder sentence becomes three tasks, the Monday one dated', () => {
  const out = extractActions([seg('תזכורת להתקשר ביום שני לרופא על התור, להתקשר לספק על החשבונית, ולבדוק מה קורה עם ההזמנה.')], { today: TODAY });
  assert.deepEqual(out.map((a) => a.label), [
    'להתקשר ביום שני לרופא על התור',
    'להתקשר לספק על החשבונית',
    'לבדוק מה קורה עם ההזמנה',
  ]);
  assert.equal(out[0].due_date, '2026-10-05');
  assert.equal(out[1].due_date, '2026-10-05', 'a day said once covers the tasks said with it');
  assert.equal(out[2].due_date, '2026-10-05');
});

test('a task put off to "later" in the same sentence keeps no date', () => {
  const out = extractActions([seg('צריך לשלוח מחר את הקייסים, ולבדוק בהמשך את החשבונית.')], { today: TODAY });
  assert.deepEqual(out.map((a) => a.due_date), ['2026-10-04', null]);
});

test('"צריך ל…" and a bare infinitive both open a task', () => {
  const out = extractActions([
    seg('אני צריך להוציא חשבונית שבועית ללקוח.'),
    seg('לשלוח הודעה לדנה מחר.', 3000),
  ], { today: TODAY });
  assert.deepEqual(out.map((a) => [a.label, a.type, a.due_date]), [
    ['להוציא חשבונית שבועית ללקוח', 'create_reminder', null],
    ['לשלוח הודעה לדנה מחר', 'send_message', '2026-10-04'],
  ]);
});

test('English triggers, splitting and types', () => {
  const out = extractActions([
    seg('Okay so remind me to call Guy about the shipment tomorrow, and email the customs broker.'),
    seg('We need to book the truck on Friday. It was a good meeting.', 5000),
    seg("Don't forget to text Sarah the address - it's urgent!", 9000),
  ], { today: TODAY });
  assert.deepEqual(out.map((a) => [a.label, a.type]), [
    ['Call Guy about the shipment tomorrow', 'create_reminder'],
    ['Email the customs broker', 'draft_email'],
    ['Book the truck on Friday', 'create_reminder'],
    ["Text Sarah the address - it's urgent", 'send_message'],
  ]);
  assert.equal(out[0].due_date, '2026-10-04');
  assert.equal(out[2].due_date, '2026-10-09');
  assert.equal(out[3].priority, 'high');
});

test('plain talk produces no actions', () => {
  assert.deepEqual(extractActions([seg('We talked about the weather and lunch.')], { today: TODAY }), []);
});

test('duplicate tasks are kept once', () => {
  const out = extractActions([seg('Remind me to call Dana.'), seg('Remind me to call Dana.', 4000)], { today: TODAY });
  assert.equal(out.length, 1);
});

test('due dates are local and always in the future for weekdays', () => {
  assert.equal(dueDateIn('on saturday', TODAY), '2026-10-10', 'same weekday means next week, not today');
  assert.equal(dueDateIn('ביום ראשון', TODAY), '2026-10-04');
  assert.equal(dueDateIn('next week', TODAY), '2026-10-10');
  assert.equal(dueDateIn('היום', TODAY), TODAY);
  assert.equal(dueDateIn('nothing here', TODAY), null);
});

test('"שני" inside another word is not Monday', () => {
  assert.equal(dueDateIn('יום שנים', TODAY), null);
});

test('action types', () => {
  assert.equal(actionType('send the deck by email'), 'draft_email');
  assert.equal(actionType('WhatsApp the driver'), 'send_message');
  assert.equal(actionType('לשלוח מייל לרואה החשבון'), 'draft_email');
  assert.equal(actionType('call mom'), 'create_reminder');
});

test('sections break on long pauses and long stretches', () => {
  const s = sectionize([
    seg('First topic starts here. More on it.', 0, 4000),
    seg('Still first topic.', 5000, 7000),
    seg('After a long pause, second topic.', 30_000, 33_000),
    seg('Way later.', 200_000, 202_000),
  ]);
  assert.equal(s.length, 3);
  assert.equal(s[0].title, 'First topic starts here.');
  assert.deepEqual([s[1].start_ms, s[1].end_ms], [30_000, 33_000]);
});

test('summary follows the template and lists the actions', () => {
  const segments = [seg('We decided to move the launch to May. Remind me to email Dana.')];
  const actions = extractActions(segments, { today: TODAY });
  const sum = summarize('meeting', segments, sectionize(segments), actions);
  assert.deepEqual(sum.blocks.map((b) => b.heading), ['Overview', 'Decisions', 'Discussion', 'Action items']);
  assert.deepEqual(sum.blocks[1].items, ['We decided to move the launch to May.']);
  assert.deepEqual(sum.blocks[3].items, ['Email Dana']);
});

test('unknown template falls back to general', () => {
  assert.equal(summarize('nope', [], [], []).template, 'general');
});

test('title is a short gist: at most 5 words, 40 characters', () => {
  assert.equal(titleFor([seg('Quarterly planning with the warehouse team. Then other things.')]), 'Quarterly planning with the warehouse');
  assert.equal(titleFor([seg('אור, אנחנו צריכים לקנות חלב, ביצים, כביסה.')]), 'אור, אנחנו צריכים לקנות חלב');
  assert.equal(titleFor([]), null);
  assert.ok(titleFor([seg('x'.repeat(200))]).length <= 40);
});

// A first real Hebrew note (2026-10-04) became 6 "tasks" - every
// comma-separated word, plus "בסדר". A list is one task; filler is dropped.
test('a shopping list is one task; asides and filler are not tasks', () => {
  const out = extractActions([seg('אור, אנחנו צריכים לקנות חלב, ביצים, כביסה, למרות שכביסה לא קונים, ונעליים לימילה שכבר קנינו, בסדר?')], { today: TODAY });
  assert.deepEqual(out.map((a) => a.label), ['לקנות חלב, ביצים, כביסה']);
  const en = extractActions([seg('We need to buy milk, eggs, bread, and call the plumber, okay?')], { today: TODAY });
  assert.deepEqual(en.map((a) => a.label), ['Buy milk, eggs, bread', 'Call the plumber']);
});

test('sentence split handles Hebrew and newlines', () => {
  assert.deepEqual(splitSentences('שלום. מה נשמע?\nטוב'), ['שלום.', 'מה נשמע?', 'טוב']);
});

test('picker rows: what this plan allows, which one is in use; an own Gemini key unlocks Max', () => {
  const report = { using: 'gemini-3.1-flash-lite', pick: 'gemini-3.8-flash', models: [
    { id: 'gemini-3.1-flash-lite', label: 'Lite', tier: 'standard', badge: 'recommended', isDefault: true, allowed: true },
    { id: 'gemini-3.8-flash', label: 'Flash', tier: 'max', badge: 'none', isDefault: false, allowed: false },
  ] };
  assert.deepEqual(pickerRows(report).map((r) => [r.id, r.allowed, r.current]),
    [['gemini-3.1-flash-lite', true, true], ['gemini-3.8-flash', false, false]]);
  assert.deepEqual(pickerRows(report, { ownGemini: true }).map((r) => r.allowed), [true, true]);
  assert.deepEqual(pickerRows(null), []);
});
