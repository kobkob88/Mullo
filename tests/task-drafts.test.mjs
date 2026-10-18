// S50: Mullo drafts email and message tasks by itself, keeps the draft on the task, never
// pays twice, never writes an address the note didn't say.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { draftOf, addressIn, draftRequest, emailLink, messageText } from '../app/domain/one-tap.js';
import { autoDraft, makeDraft, editDraft, draftToAsk, useChatDraft, wantsDraft } from '../app/domain/task-drafts.js';
import { useChat, newChat, getThread } from '../app/domain/chat.js';
import { useRemoteEngine, processRecording, useAfterSummary } from '../app/domain/pipeline.js';
import { actionsFor, getAction, setActionDraft } from '../app/domain/actions.js';
import { createRecording } from '../app/domain/recordings.js';
import { saveTranscript } from '../app/domain/transcripts.js';
import { reminderPlan } from '../app/domain/reminders.js';
import { updateSettings } from '../app/core/settings.js';
import { freshDb } from './helpers.mjs';

const TASKS = [
  { label: 'Email Guy the quote', type: 'draft_email' },
  { label: 'Text Dana that the delivery is Tuesday', type: 'send_message' },
  { label: 'Call the supplier', type: 'create_reminder' },
];

function engine(tasks = TASKS) {
  return {
    id: 'remote',
    async process() {
      return {
        sections: [], title: 'Call with Guy', actions: tasks.map((t) => ({ ...t })),
        summary: { blocks: [{ heading: 'Note', items: ['Guy wants the quote for 40 litres of acetone.'] }] },
      };
    },
  };
}

let calls;
function chat(reply = (p) => (/email/.test(p.messages[0].text)
  ? { answer: 'Here is an email.', draft: { kind: 'email', subject: 'The quote', body: 'Hi Guy,\n\nHere is the quote.\n\n[Your name]' } }
  : { answer: 'Here is a message.', draft: { kind: 'message', subject: 'ignored', body: 'Delivery is Tuesday.' } })) {
  calls = [];
  useChat({ async chat(p) { calls.push(p); return reply(p); } });
}

async function noteWithTasks(transcript = 'Send it to guy@example.com please.') {
  const rec = await createRecording({ title: 'Call' });
  await saveTranscript(rec.id, [{ text: transcript }]);
  await processRecording(rec.id);
  return rec;
}
const byType = async (recId, type) => (await actionsFor(recId)).find((a) => a.type === type);

beforeEach(() => {
  freshDb();
  newChat();
  updateSettings({ autoDrafts: true });
  useRemoteEngine(engine());
  useAfterSummary(() => {});
  chat();
});

test('the task\'s kind wins: an email draft on a task switched to Message shows and edits as a message; back to Email keeps To and subject', async () => {
  useRemoteEngine(engine([TASKS[0]]));
  const rec = await noteWithTasks();
  await autoDraft(rec.id);
  const email = await byType(rec.id, 'draft_email');
  const { setActionType } = await import('../app/domain/actions.js');
  await setActionType(email, 'send_message');
  const asMessage = await getAction(email.id);
  const d = draftOf(asMessage);
  assert.deepEqual([d.kind, d.to, d.subject], ['message', '', null]);
  assert.equal(messageText(asMessage), d.body);
  assert.deepEqual(await editDraft(email.id, { body: 'PO attached.', to: 'x@y.example', subject: 'ignored' }), { ok: true });
  await setActionType(await getAction(email.id), 'draft_email');
  const back = draftOf(await getAction(email.id));
  assert.deepEqual([back.kind, back.to, back.subject, back.body], ['email', 'guy@example.com', 'The quote', 'PO attached.']);
});

test('pure: a draft is read off the task; "To" only from exactly one address in the note', () => {
  assert.equal(draftOf({ payload: null }), null);
  assert.equal(draftOf({ payload: { draft: { kind: 'email', body: '  ' } } }), null, 'an empty draft is no draft');
  assert.deepEqual(draftOf({ payload: { draft: { kind: 'message', body: 'Hi', to: 7 } } }),
    { kind: 'message', to: '', subject: null, body: 'Hi', made_at: null, edited_at: null });
  assert.equal(addressIn('write to Guy@Example.com', 'again guy@example.com'), 'guy@example.com', 'the same address twice is one');
  assert.equal(addressIn('guy@example.com or dana@example.com'), '', 'two addresses: the person picks');
  assert.equal(addressIn('no address here', null), '');
  assert.match(draftRequest({ type: 'draft_email', label: 'Email Guy', context: 'the quote' }), /email this task needs.*"Email Guy".*the quote.*language the note is in.*email address/);
  assert.doesNotMatch(draftRequest({ type: 'send_message', label: 'Text Dana' }), /email address/);
});

test('pure: the one-tap buttons send the kept draft; a reminder says "Draft ready"', () => {
  const task = { id: 't', label: 'Email Guy', type: 'draft_email', status: 'open', due_date: '2099-01-01', due_time: '09:00',
    payload: { draft: { kind: 'email', to: 'guy@example.com', subject: 'Quote', body: 'Hi Guy' }, email: { body: 'older' } } };
  assert.equal(emailLink(task), 'mailto:guy%40example.com?subject=Quote&body=Hi%20Guy');
  assert.equal(messageText({ ...task, payload: { draft: { kind: 'message', body: 'On my way' } } }), 'On my way');
  assert.equal(reminderPlan([task])[0].text, 'Draft ready: Email Guy');
  assert.equal(reminderPlan([{ ...task, payload: null }])[0].text, 'Email Guy');
});

test('after a summary: email and message tasks get drafts from that one note; reminders do not', async () => {
  const rec = await noteWithTasks();
  assert.equal(await autoDraft(rec.id), 2);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.focus, true, 'only the task\'s own note goes');
    assert.deepEqual(c.recordings.map((r) => r.id), [rec.id]);
    assert.equal(c.messages.length, 1);
  }
  const email = draftOf(await byType(rec.id, 'draft_email'));
  assert.equal(email.kind, 'email');
  assert.equal(email.to, 'guy@example.com', 'the note said the address');
  assert.equal(email.subject, 'The quote');
  assert.ok(email.made_at);
  const message = draftOf(await byType(rec.id, 'send_message'));
  assert.deepEqual([message.kind, message.subject, message.to, message.body], ['message', null, '', 'Delivery is Tuesday.']);
  assert.equal(draftOf(await byType(rec.id, 'create_reminder')), null);
  const reminder = await byType(rec.id, 'create_reminder');
  assert.equal(reminder.edited ?? false, false, 'a made draft is not a person\'s edit');

  assert.equal(await autoDraft(rec.id), 0, 'at most once per task');
  assert.equal(calls.length, 2);
});

test('no address in the note: "To" stays empty, whatever the AI says', async () => {
  chat(() => ({ answer: 'x', draft: { kind: 'email', subject: 'Quote', body: 'Hi Guy, write to guy@made-up.example' } }));
  useRemoteEngine(engine([TASKS[0]]));
  const rec = await noteWithTasks('Send Guy the quote.');
  await autoDraft(rec.id);
  assert.equal(draftOf(await byType(rec.id, 'draft_email')).to, '');
});

test('the switch off: no drafts by themselves, but "Draft it" still works on a tap', async () => {
  updateSettings({ autoDrafts: false });
  const rec = await noteWithTasks();
  assert.equal(await autoDraft(rec.id), 0);
  assert.equal(calls.length, 0);
  const task = await byType(rec.id, 'draft_email');
  assert.equal(wantsDraft(task), true);
  assert.deepEqual(await makeDraft(task.id), { ok: true });
  assert.ok(draftOf(await getAction(task.id)));
});

test('the pipeline asks for drafts only after an AI summary', async () => {
  const seen = [];
  useAfterSummary((id) => seen.push(id));
  const rec = await noteWithTasks();
  assert.deepEqual(seen, [rec.id]);
  useRemoteEngine(null); // the offline engine
  const offline = await noteWithTasks('Email Guy the quote tomorrow.');
  assert.deepEqual(seen, [rec.id], 'the offline engine\'s tasks are not drafted');
  assert.ok(offline);
});

test('a draft that landed meanwhile (another device) wins; nothing is paid twice', async () => {
  useRemoteEngine(engine([TASKS[0]]));
  const rec = await noteWithTasks();
  const task = await byType(rec.id, 'draft_email');
  chat(async () => {
    // Sync brought the other device's draft while this one was asking.
    const now = await getAction(task.id);
    await setActionDraft(now, { kind: 'email', to: '', subject: 'Theirs', body: 'From the computer' });
    return { answer: 'x', draft: { kind: 'email', subject: 'Mine', body: 'From the phone' } };
  });
  assert.deepEqual(await makeDraft(task.id), { ok: true });
  assert.equal(draftOf(await getAction(task.id)).subject, 'Theirs');
});

test('summarising again moves a draft to the same task instead of paying again', async () => {
  const rec = await noteWithTasks();
  await autoDraft(rec.id);
  assert.equal(calls.length, 2);
  await processRecording(rec.id);
  assert.equal(await autoDraft(rec.id), 0);
  assert.equal(calls.length, 2);
  assert.equal(draftOf(await byType(rec.id, 'draft_email')).subject, 'The quote');
});

test('Write again replaces the draft; the address the person typed stays', async () => {
  useRemoteEngine(engine([TASKS[0]]));
  const rec = await noteWithTasks('Send Guy the quote.');
  await autoDraft(rec.id);
  const task = await byType(rec.id, 'draft_email');
  assert.deepEqual(await editDraft(task.id, { to: ' guy@example.com ' }), { ok: true });
  chat(() => ({ answer: 'x', draft: { kind: 'email', subject: 'Again', body: 'Hello again' } }));
  assert.deepEqual(await makeDraft(task.id, { redo: true }), { ok: true });
  const d = draftOf(await getAction(task.id));
  assert.deepEqual([d.to, d.subject, d.body], ['guy@example.com', 'Again', 'Hello again']);
});

test('editing: saved on the task, marked edited (re-summarising keeps it); an empty body is refused', async () => {
  useRemoteEngine(engine([TASKS[1]]));
  const rec = await noteWithTasks();
  await autoDraft(rec.id);
  const task = await byType(rec.id, 'send_message');
  assert.deepEqual(await editDraft(task.id, { body: 'Delivery moved to Wednesday.', subject: 'not for a message' }), { ok: true });
  const after = await getAction(task.id);
  assert.equal(after.edited, true);
  assert.equal(draftOf(after).body, 'Delivery moved to Wednesday.');
  assert.equal(draftOf(after).subject, null);
  assert.ok(draftOf(after).edited_at);
  assert.equal((await editDraft(task.id, { body: '   ' })).ok, false);
  await processRecording(rec.id);
  assert.equal(draftOf(await getAction(task.id)).body, 'Delivery moved to Wednesday.', 'the person\'s task stays');
});

test('a failed draft leaves the task as it was, for a "Draft it" tap later', async () => {
  chat(() => ({ answer: 'I could not.', draft: null }));
  useRemoteEngine(engine([TASKS[0]]));
  const rec = await noteWithTasks();
  assert.equal(await autoDraft(rec.id), 0);
  const task = await byType(rec.id, 'draft_email');
  assert.equal(draftOf(task), null);
  assert.match((await makeDraft(task.id)).error, /no draft/);
});

test('Change in Ask: the chat starts with the draft; a new one goes back on the task', async () => {
  useRemoteEngine(engine([TASKS[0]]));
  const rec = await noteWithTasks();
  await autoDraft(rec.id);
  const task = await byType(rec.id, 'draft_email');
  const res = await draftToAsk(task.id);
  assert.deepEqual(res, { ok: true, recordingId: rec.id });
  const t = getThread();
  assert.equal(t.focus, rec.id);
  assert.equal(t.task, task.id);
  assert.equal(t.messages[0].draft.subject, 'The quote');
  t.messages.push({ role: 'user', text: 'shorter' }, { role: 'assistant', text: 'Shorter.', draft: { kind: 'email', subject: 'Quote', body: 'Quote attached.' } });
  newChat({ focus: t.focus, task: t.task, messages: t.messages });
  const used = await useChatDraft(2);
  assert.equal(used.ok, true);
  const d = draftOf(await getAction(task.id));
  assert.deepEqual([d.to, d.subject, d.body], ['guy@example.com', 'Quote', 'Quote attached.']);
  newChat();
  assert.equal((await useChatDraft(0)).ok, false, 'a chat not started from a task can\'t replace one');
});
