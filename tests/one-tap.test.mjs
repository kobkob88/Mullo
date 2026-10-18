import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { emailLink, messageText, whatsappLink, buildIcs, icsEscape, icsFold, icsFilename, reminderDate } from '../app/domain/one-tap.js';
import { createRecording, getRecording, nameSpeaker, speakerName } from '../app/domain/recordings.js';
import { saveTranscript } from '../app/domain/transcripts.js';
import { useRemoteEngine, processRecording } from '../app/domain/pipeline.js';
import { freshDb } from './helpers.mjs';

const action = (over = {}) => ({ id: 'a1', label: 'Email Dana the quote', type: 'draft_email', context: 'From the planning call', due_date: '2026-10-05', ...over });

test('email: subject + body, spaces as %20 not +, Pocket payload wins', () => {
  assert.equal(emailLink(action()), 'mailto:?subject=Email%20Dana%20the%20quote&body=From%20the%20planning%20call');
  const fromPocket = action({ payload: { email: { to: 'dana@example.com', subject: 'Quote', body: 'Hi Dana' } } });
  assert.equal(emailLink(fromPocket), 'mailto:dana%40example.com?subject=Quote&body=Hi%20Dana');
});

test('message text prefers the drafted message', () => {
  assert.equal(messageText(action({ type: 'send_message', label: 'Text Sarah' })), 'Text Sarah');
  assert.equal(messageText(action({ payload: { message: { body: 'On my way' } } })), 'On my way');
  assert.equal(whatsappLink('שלום & bye'), 'https://wa.me/?text=%D7%A9%D7%9C%D7%95%D7%9D%20%26%20bye');
});

test('calendar event: all-day on the due date, alert at 9:00, escaped text, CRLF', () => {
  const ics = buildIcs(action({ label: 'Call A; then B, then C' }), { now: new Date('2026-10-04T12:00:00Z') });
  assert.match(ics, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006\r\n/);
  assert.match(ics, /SUMMARY:Call A\\; then B\\, then C\r\n/);
  assert.match(ics, /TRIGGER;RELATED=START:PT9H/);
  assert.match(ics, /DTSTAMP:20261004T120000Z/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('no due date → tomorrow (local)', () => {
  assert.equal(reminderDate(action({ due_date: null }), '2026-10-31'), '2026-11-01');
});

test('long Hebrew lines fold by bytes, never splitting a letter', () => {
  const line = `SUMMARY:${'להתקשר לספק על החשבונית '.repeat(6)}`;
  const folded = icsFold(line);
  for (const part of folded.split('\r\n')) assert.ok(new TextEncoder().encode(part).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), line);
  assert.equal(icsEscape('a\nb\\c'), 'a\\nb\\\\c');
});

test('file names keep Hebrew, drop punctuation', () => {
  assert.equal(icsFilename(action({ label: 'להתקשר לספק!' })), 'להתקשר-לספק.ics');
  assert.equal(icsFilename(action({ label: '!!!' })), 'reminder.ics');
});

// ── Speaker names ───────────────────────────────────────────────────────
beforeEach(() => { freshDb(); useRemoteEngine(null); });

test('naming a speaker keeps the transcript labels and feeds the names to the summary', async () => {
  let seen = null;
  useRemoteEngine({
    id: 'remote',
    async process({ segments }) { seen = segments; return { sections: [], actions: [], summary: null, title: null }; },
  });
  const rec = await createRecording({ title: 'Call' });
  await saveTranscript(rec.id, [{ speaker: 'Speaker 1', text: 'I will send it.' }, { speaker: 'Speaker 2', text: 'Thanks.' }]);
  await nameSpeaker(await getRecording(rec.id), 'Speaker 1', '  Dana ');
  await processRecording(rec.id);
  assert.deepEqual(seen.map((s) => s.speaker), ['Dana', 'Speaker 2']);
  const after = await getRecording(rec.id);
  assert.equal(speakerName(after, 'Speaker 1'), 'Dana');
  await nameSpeaker(after, 'Speaker 1', '');
  assert.equal(speakerName(await getRecording(rec.id), 'Speaker 1'), 'Speaker 1');
});

test('naming a speaker on a stale copy is refused', async () => {
  const rec = await createRecording({ title: 'Call' });
  await nameSpeaker(rec, 'Speaker 1', 'Dana');
  const res = await nameSpeaker(rec, 'Speaker 1', 'Avi');
  assert.equal(res.ok, false);
});
