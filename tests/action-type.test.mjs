import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seg } from './helpers.mjs';
import { addAction, getAction, setActionType, actionsFor, replaceExtracted } from '../app/domain/actions.js';
import { actionType } from '../app/domain/engines/local.js';
import { buildRequest } from '../bridge/gemini.mjs';

beforeEach(() => { freshDb(); });

test('one tap turns a "Send" into a reminder, and summarising again keeps it', async () => {
  const added = await addAction('rec-1', { label: 'לשלוח לדנה את הקובץ', type: 'send_message', origin: 'extracted' }, { reason: 'test' });
  const res = await setActionType(added.row, 'create_reminder');
  assert.equal(res.ok, true);
  const now = await getAction(added.row.id);
  assert.equal(now.type, 'create_reminder');
  assert.equal(now.edited, true);
  await replaceExtracted('rec-1', [{ label: 'something new', type: 'create_reminder' }], { engine: 'test' });
  assert.ok((await actionsFor('rec-1')).some((a) => a.id === added.row.id && a.type === 'create_reminder'), 'the person\'s choice survives');
});

test('only the three kinds exist', async () => {
  const added = await addAction('rec-1', { label: 'x' }, { reason: 'test' });
  assert.equal((await setActionType(added.row, 'tweet')).ok, false);
});

test('offline: "remind me to text" is a reminder; a message to send stays a message', () => {
  assert.equal(actionType('Remind me to text Dana the quote'), 'create_reminder');
  assert.equal(actionType('תזכיר לי לשלוח הודעה לדנה'), 'create_reminder');
  assert.equal(actionType('Send a WhatsApp message to Dana'), 'send_message');
});

test('Gemini is told a reminder is the default, even for sending something later', () => {
  const system = buildRequest({ segments: [seg('x')], template: 'voice_note', today: '2026-10-06' }).system_instruction.parts[0].text;
  assert.match(system, /"create_reminder" for anything to remember or do later, including sending something later/);
  assert.match(system, /When unsure, "create_reminder"/);
});

test('Gemini is reminded, next to the transcript, to keep each task in the language it was said', () => {
  const body = buildRequest({ segments: [seg('Need to transfer Andre his payment')], template: 'voice_note', today: '2026-10-06' });
  const user = body.contents[0].parts[0].text;
  assert.match(user, /^Transcript:\n/);
  assert.match(user, /said in English → an English task.*never list the same task twice in two languages\.$/s);
});
