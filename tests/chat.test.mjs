// Ask as a chat (S10): the prompt and checks (bridge/chat.mjs, draft.mjs), the provider
// dispatch, and the thread on the device (app/domain/chat.js).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, cleanChatInput, sanitizeChat, sanitizeChanges, sanitizeUpdates, chatWithGemini, MAX_TURNS } from '../bridge/chat.mjs';
import { recordingAsText } from '../app/domain/export.js';
import { sanitizeDraft } from '../bridge/draft.mjs';
import { chatNotes } from '../bridge/providers.mjs';
import { useChat, canChat, getThread, newChat, askAbout, sendChat, applyChange, applyUpdate, draftAsText, HISTORY } from '../app/domain/chat.js';
import { createRecording, getRecording, addNoteUpdate, removeNoteUpdate } from '../app/domain/recordings.js';
import { saveTranscript } from '../app/domain/transcripts.js';
import { addAction, getAction } from '../app/domain/actions.js';
import { freshDb } from './helpers.mjs';

const recordings = [
  { id: 'a', title: 'Call with Daniel', date: '2026-10-02', summary: 'Overview: private label is fine', tasks: [{ id: 'task-1', label: 'Send Daniel the price list', status: 'open', due_date: '2026-10-06' }], transcript: 'Daniel: We can do private label.' },
  { id: 'b', title: 'Groceries', date: '2026-10-03', summary: '', tasks: [], transcript: 'Milk and eggs.' },
];
const geminiSays = (obj) => async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }));
const user = (body) => body.contents[0].parts[0].text;
const system = (body) => body.system_instruction.parts[0].text;

test('bridge: the last message must be the person\'s; earlier turns are capped and keep their drafts', () => {
  assert.throws(() => cleanChatInput({ messages: [], recordings }), /Ask a question/);
  assert.throws(() => cleanChatInput({ messages: [{ role: 'assistant', text: 'hi' }], recordings }), /Ask a question/);
  assert.throws(() => cleanChatInput({ messages: [{ role: 'user', text: 'q' }] }), /No recordings/);
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  const c = cleanChatInput({ messages: [...many, { role: 'user', text: 'now' }], recordings });
  assert.equal(c.turns.length, MAX_TURNS);
  assert.equal(c.message, 'now');
  const d = cleanChatInput({ messages: [{ role: 'assistant', text: 'Here', draft: { kind: 'email', subject: 'Hi', body: 'Body' } }, { role: 'user', text: 'shorter' }], recordings });
  assert.deepEqual(d.turns[0].draft, { kind: 'email', subject: 'Hi', body: 'Body' });
  assert.equal(cleanChatInput({ messages: [{ role: 'assistant', text: 'x', draft: { kind: 'poem', body: 'y' } }, { role: 'user', text: 'q' }], recordings }).turns[0].draft, null);
});

test('bridge: the prompt holds the notes, the conversation and the draft rules', () => {
  const { refs, body } = buildChatRequest({
    messages: [
      { role: 'user', text: 'Write an email to Daniel about the call' },
      { role: 'assistant', text: 'Here is an email to Daniel.', draft: { kind: 'email', subject: 'Private label', body: 'Hi Daniel, ...' } },
      { role: 'user', text: 'make it shorter' },
    ],
    today: '2026-10-11',
    recordings,
  });
  assert.deepEqual(refs.map((r) => r.ref), ['r1', 'r2']);
  assert.match(user(body), /### r1 - "Call with Daniel" \(2026-10-02\)/);
  assert.match(user(body), /Person: Write an email to Daniel/);
  assert.match(user(body), /You: Here is an email to Daniel\.\n\[Draft email, subject "Private label"\]\nHi Daniel/);
  assert.match(user(body), /Person \(now\): make it shorter$/);
  assert.match(system(body), /Never invent/);
  assert.match(system(body), /square brackets/);
  assert.match(system(body), /Follow-ups refer to the conversation/);
  assert.match(system(body), /Today is 2026-10-11/);
  assert.deepEqual(body.generationConfig.responseSchema.properties.draft_kind.enum, ['none', 'email', 'message', 'document']);
});

test('bridge: one chosen recording gets room for its whole transcript', () => {
  const long = { ...recordings[0], transcript: 'word '.repeat(4000) };
  const wide = user(buildChatRequest({ messages: [{ role: 'user', text: 'q' }], recordings: [long], focus: true }).body);
  const narrow = user(buildChatRequest({ messages: [{ role: 'user', text: 'q' }], recordings: [long, recordings[1]] }).body);
  assert.ok(wide.length > narrow.length + 10_000);
  assert.match(system(buildChatRequest({ messages: [{ role: 'user', text: 'q' }], recordings: [long], focus: true }).body), /ONE recording/);
});

test('bridge: refs map back to ids, drafts are tidied, a message has no subject', () => {
  const refs = [{ ref: 'r1', id: 'a' }, { ref: 'r2', id: 'b' }];
  assert.deepEqual(sanitizeChat({ answer: 'Yes', found: true, sources: ['r2', 'r9', 'r2'], draft_kind: 'none', draft_body: null }, refs),
    { answer: 'Yes', found: true, sources: ['b'], draft: null, changes: [], updates: [] });
  const out = sanitizeChat({ answer: 'Here — a message', found: false, sources: ['r1'], draft_kind: 'message', draft_subject: 'x', draft_body: 'Hey — sounds good\n\n\n\nSee you' }, refs);
  assert.equal(out.answer, 'Here - a message');
  assert.deepEqual(out.draft, { kind: 'message', subject: null, body: 'Hey - sounds good\n\nSee you' });
  assert.equal(sanitizeChat({ answer: '', found: false, sources: [], draft_kind: 'email', draft_subject: 'Hi', draft_body: 'Body' }, refs).answer, 'Here is a draft.');
  assert.throws(() => sanitizeChat({ answer: 'Here is a draft email', draft_kind: 'email', draft_body: null }, refs), (err) => err.missingDraft === true);
  assert.equal(sanitizeChat({ answer: 'x', draft_kind: 'none', draft_subject: 'Weekend', draft_body: '- Buy milk' }, refs).draft, null,
    'no draft kind = no draft (a stray text once became a fake "message" saying the task was updated)');
  assert.throws(() => sanitizeDraft({ body: ' ' }, { kind: 'email' }), /empty draft/);
});

test('bridge: every field is required, the draft comes before the answer (flash-lite skipped optional ones)', () => {
  const schema = buildChatRequest({ messages: [{ role: 'user', text: 'q' }], recordings }).body.generationConfig.responseSchema;
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.propertyOrdering.slice(0, 3), ['draft_kind', 'draft_subject', 'draft_body']);
});

test('bridge + providers: a draft announced without its text is asked for once more, then said plainly', async () => {
  const replies = [
    { answer: 'Here is a draft email', found: true, sources: [], draft_kind: 'email', draft_subject: 'Weekend', draft_body: null },
    { answer: 'Here is a draft email', found: true, sources: [], draft_kind: 'email', draft_subject: 'Weekend', draft_body: '- Buy milk' },
  ];
  let n = 0;
  const gemini = async () => geminiSays(replies[Math.min(n++, 1)])();
  const out = await chatWithGemini({ messages: [{ role: 'user', text: 'email my todo list' }], recordings }, { apiKey: 'k', fetch: gemini });
  assert.equal(n, 2);
  assert.equal(out.draft.body, '- Buy milk');

  let calls = 0;
  const claude = async () => { calls += 1; return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(replies[0]) }] })); };
  await assert.rejects(chatNotes({ messages: [{ role: 'user', text: 'email it' }], recordings }, { provider: 'anthropic', apiKey: 'k', model: 'm', fetch: claude }), /sent none - try again/);
  assert.equal(calls, 2);
});

test('bridge: Gemini key goes in a header, never the URL', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return geminiSays({ answer: 'On Friday.', found: true, sources: ['r1'], draft_kind: 'none' })(); };
  const out = await chatWithGemini({ messages: [{ role: 'user', text: 'When?' }], recordings }, { apiKey: 'secret', fetch });
  assert.doesNotMatch(seen.url, /secret/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret');
  assert.deepEqual(out.sources, ['a']);
});

test('providers: Claude chats with the same prompt and checks (strict schema)', async () => {
  let sent;
  const fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answer: 'Here.', found: true, sources: ['r1'], draft_kind: 'email', draft_subject: 'Price list', draft_body: 'Hi Daniel — attached' }) }] }));
  };
  const out = await chatNotes({ messages: [{ role: 'user', text: 'email Daniel' }], recordings }, { provider: 'anthropic', apiKey: 'k', model: 'm', fetch });
  assert.deepEqual(out.draft, { kind: 'email', subject: 'Price list', body: 'Hi Daniel - attached' });
  assert.match(sent.system, /own recorded conversations/);
  const schema = sent.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.draft_body.type, ['string', 'null']);
});

beforeEach(() => { freshDb(); useChat(null); newChat(); });

test('app: no engine → clear message; the thread keeps both sides and sends earlier turns', async () => {
  assert.equal(canChat(), false);
  assert.match((await sendChat('anything')).error, /bridge is off/);
  const rec = await createRecording({ title: 'Call with Daniel' });
  await saveTranscript(rec.id, [{ text: 'Private label is fine.' }]);
  await addAction(rec.id, { label: 'Send Daniel the price list' });
  const sent = [];
  useChat({
    async chat(payload) {
      sent.push(payload);
      return sent.length === 1
        ? { answer: 'He agreed.', found: true, sources: [rec.id, 'not-sent'], draft: null }
        : { answer: 'Here is an email.', found: true, sources: [rec.id], draft: { kind: 'email', subject: 'Price list', body: 'Hi Daniel' } };
    },
  });
  assert.equal(canChat(), true);
  const first = await sendChat('What did Daniel say?');
  assert.equal(first.ok, true);
  assert.deepEqual(first.reply.sources, [rec.id], 'a source that was not sent is dropped');
  assert.equal(sent[0].recordings[0].transcript, 'Private label is fine.');
  assert.deepEqual(sent[0].messages, [{ role: 'user', text: 'What did Daniel say?' }]);
  assert.equal(sent[0].focus, false);

  const second = await sendChat('Write him an email about it');
  assert.deepEqual(second.reply.draft, { kind: 'email', subject: 'Price list', body: 'Hi Daniel' });
  assert.deepEqual(sent[1].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(sent[1].recordings[0].id, rec.id, 'the recording the chat used comes first');
  const t = getThread();
  assert.equal(t.messages.length, 4);
  assert.equal(draftAsText(t.messages[3].draft), 'Price list\n\nHi Daniel');
});

test('app: only the last few messages ride along', async () => {
  await createRecording({ title: 'Note' });
  const sent = [];
  useChat({ async chat(p) { sent.push(p); return { answer: 'ok', found: false, sources: [], draft: null }; } });
  for (let i = 0; i < 8; i += 1) await sendChat(`q${i}`);
  assert.equal(sent.at(-1).messages.length, HISTORY + 1);
  assert.equal(sent.at(-1).messages.at(-1).text, 'q7');
});

test('app: "Ask about this" sends only that recording; a failed send leaves the thread as it was', async () => {
  const rec = await createRecording({ title: 'Call with Daniel' });
  await createRecording({ title: 'Other' });
  const sent = [];
  useChat({ async chat(p) { sent.push(p); if (p.messages.at(-1).text === 'fail') throw new Error('Gemini 503: overloaded'); return { answer: 'ok', found: true, sources: [rec.id], draft: null }; } });

  askAbout(rec.id);
  assert.match((await sendChat('what?')).error, /nothing in this recording/, 'no transcript or summary yet');
  await saveTranscript(rec.id, [{ text: 'Private label is fine.' }]);
  assert.equal((await sendChat('what?')).ok, true);
  assert.equal(sent[0].recordings.length, 1);
  assert.equal(sent[0].focus, true);
  assert.equal(askAbout(rec.id).messages.length, 2, 'a chat already about it carries on');

  const res = await sendChat('fail');
  assert.match(res.error, /Could not answer: Gemini 503/);
  assert.equal(getThread().messages.length, 2);
  assert.equal(newChat().focus, null);
});

test('app: an answer for a chat that was replaced meanwhile is not added to the new one', async () => {
  await createRecording({ title: 'Note' });
  useChat({ async chat() { newChat(); return { answer: 'late', found: false, sources: [], draft: null }; } });
  const res = await sendChat('q');
  assert.equal(res.dropped, true);
  assert.equal(getThread().messages.length, 0);
});

// Task changes: the owner asked "can I push this to next week?", got "I updated it" and nothing
// changed (2026-10-11). Now the AI suggests, the app shows a button, a tap applies it.
test('bridge: tasks go as refs with their day; ids never reach the AI; the AI is told it changes nothing', () => {
  const { tasks, body } = buildChatRequest({ messages: [{ role: 'user', text: 'push it to next week' }], today: '2026-10-11', recordings });
  assert.deepEqual(tasks.map((t) => [t.ref, t.id]), [['t1', 'task-1']]);
  assert.match(user(body), /Tasks: \[t1\] Send Daniel the price list \(due 2026-10-06, Tuesday\)/);
  assert.doesNotMatch(user(body), /task-1/);
  assert.match(system(body), /Today is 2026-10-11 \(Sunday\)/);
  assert.match(system(body), /Never say you did/);
  assert.match(system(body), /tap Move to confirm/);
  assert.ok(body.generationConfig.responseSchema.required.includes('task_changes'));
});

test('bridge: an app from before build 33 (tasks as text) still shows its tasks, without refs', () => {
  const old = [{ id: 'a', title: 'Call', date: '2026-10-02', summary: '', actions: ['Return the pocket (due 2026-10-06)'], transcript: 'x' }];
  const { tasks, body } = buildChatRequest({ messages: [{ role: 'user', text: 'q' }], recordings: old });
  assert.equal(tasks.length, 0);
  assert.match(user(body), /Tasks \(cannot be changed from here\): Return the pocket \(due 2026-10-06\)/);
});

test('bridge: suggested changes keep only real tasks, real dates and real changes', () => {
  const tasks = [{ ref: 't1', id: 'task-1', due_date: '2026-10-06', status: 'open' }, { ref: 't2', id: 'task-2', due_date: null, status: 'open' }];
  assert.deepEqual(sanitizeChanges([
    { task: '[t1]', due_date: '2026-10-13', remove_date: false, status: 'same' },
    { task: 't9', due_date: '2026-10-13', remove_date: false, status: 'same' },
    { task: 't2', due_date: 'next week', remove_date: true, status: 'same' },
    { task: 't1', due_date: '2026-10-20', remove_date: false, status: 'same' },
  ], tasks), [{ id: 'task-1', due_date: '2026-10-13', remove_date: false, status: 'same' }],
  'unknown ref, no real date, no date to remove, and a second change to the same task all drop');
  assert.deepEqual(sanitizeChanges([{ task: 't2', due_date: null, remove_date: false, status: 'done' }], tasks), [{ id: 'task-2', due_date: null, remove_date: false, status: 'done' }]);
  const out = sanitizeChat({ answer: 'I can move it to Tuesday, Oct 13 - tap Move to confirm.', found: true, sources: [], draft_kind: 'none', draft_subject: null, draft_body: null, task_changes: [{ task: 't1', due_date: '2026-10-13', remove_date: false, status: 'same' }] }, [], tasks);
  assert.equal(out.changes.length, 1);
  assert.equal(out.draft, null);
  assert.equal(sanitizeChat({ answer: 'x', draft_kind: 'none', draft_body: 'stray text' }, [], tasks).draft, null, 'text without a draft kind is not shown as a draft');
});

test('app: a suggested move changes nothing until tapped, then moves the task once; the next turn knows', async () => {
  const rec = await createRecording({ title: 'החזרת הפוקט' });
  await saveTranscript(rec.id, [{ text: 'להחזיר את הפוקט ביום שלישי' }]);
  const added = await addAction(rec.id, { label: 'להחזיר את הפוקט', due_date: '2026-10-06' });
  const id = added.row.id;
  const sent = [];
  useChat({
    async chat(p) {
      sent.push(p);
      return { answer: 'I can move it to Tuesday, Oct 13 - tap Move to confirm.', found: true, sources: [rec.id], draft: null,
        changes: [{ id, due_date: '2026-10-13', remove_date: false, status: 'same' }, { id: 'not-sent', due_date: '2026-10-13', status: 'same' }] };
    },
  });
  askAbout(rec.id);
  const res = await sendChat('אפשר להזיז את זה לשבוע הבא?');
  assert.deepEqual(sent[0].recordings[0].tasks, [{ id, label: 'להחזיר את הפוקט', status: 'open', due_date: '2026-10-06' }]);
  assert.equal(res.reply.changes.length, 1, 'a task that was not sent is dropped');
  assert.equal((await getAction(id)).due_date, '2026-10-06', 'nothing changed yet');

  const applied = await applyChange(1, 0);
  assert.equal(applied.ok, true);
  assert.equal((await getAction(id)).due_date, '2026-10-13');
  assert.equal(getThread().messages[1].changes[0].applied, true);
  assert.equal((await applyChange(1, 0)).ok, true, 'a second tap does nothing more');

  await sendChat('thanks');
  assert.deepEqual(sent[1].messages[1].changes, [{ label: 'להחזיר את הפוקט', due_date: '2026-10-13', remove_date: false, status: 'same', applied: true }]);
});

test('app: marking done through a suggestion; a deleted task says so', async () => {
  const rec = await createRecording({ title: 'Note' });
  const a = (await addAction(rec.id, { label: 'Call Dana' })).row;
  useChat({ async chat() { return { answer: 'Tap to mark it done.', found: true, sources: [], draft: null, changes: [{ id: a.id, due_date: null, remove_date: false, status: 'done' }] }; } });
  await sendChat('I called Dana');
  assert.equal((await applyChange(1, 0)).ok, true);
  assert.equal((await getAction(a.id)).status, 'done');
  assert.match((await applyChange(5, 0)).error, /gone/);
});

test('bridge: suggested note updates keep only notes that were sent, one each; the AI is told how', () => {
  const refs = [{ ref: 'r1', id: 'a' }, { ref: 'r2', id: 'b' }];
  assert.deepEqual(sanitizeUpdates([
    { note: '[r1]', text: ' Told Tina — by the end of next week. ' },
    { note: 'r9', text: 'made up' },
    { note: 'r2', text: '   ' },
    { note: 'r1', text: 'a second one for the same note' },
  ], refs), [{ id: 'a', text: 'Told Tina - by the end of next week.' }]);
  const out = sanitizeChat({ answer: 'I can add this to the note - tap Add to note.', found: true, sources: ['r1'], draft_kind: 'none', draft_subject: null, draft_body: null, task_changes: [], note_updates: [{ note: 'r1', text: 'Done.' }] }, refs, []);
  assert.deepEqual(out.updates, [{ id: 'a', text: 'Done.' }]);
  assert.deepEqual(sanitizeChat({ answer: 'x', draft_kind: 'none' }, refs, []).updates, [], 'an answer without the field has no updates');

  const { body } = buildChatRequest({
    messages: [
      { role: 'user', text: 'add that I told her' },
      { role: 'assistant', text: 'Tap Add to note.', updates: [{ title: 'Call with Daniel', text: 'Told her.', applied: true }] },
      { role: 'user', text: 'and now?' },
    ],
    recordings: [{ ...recordings[0], updates: [{ date: '2026-10-18', text: 'Price list sent.' }] }],
  });
  assert.match(user(body), /Updates added later: \(2026-10-18\) Price list sent\./);
  assert.match(user(body), /\[Suggested update to "Call with Daniel": Told her\.; the person added it\]/);
  assert.match(system(body), /note_updates/);
  assert.match(system(body), /stays a plan in the update/, 'a plan ("to update her tomorrow") is never written as done');
  assert.ok(body.generationConfig.responseSchema.required.includes('note_updates'));
});

test('app: a suggested note update adds nothing until tapped, then adds one dated line; the next turn knows', async () => {
  const rec = await createRecording({ title: 'עדכון משלוח לתינה' });
  await saveTranscript(rec.id, [{ text: 'לעדכן את תינה לגבי המשלוח' }]);
  const sent = [];
  useChat({
    async chat(p) {
      sent.push(p);
      return { answer: 'I can add this to the note - tap Add to note.', found: true, sources: [rec.id], draft: null, changes: [],
        updates: [{ id: rec.id, text: 'תינה עודכנה: המשלוח עד סוף השבוע הבא.' }, { id: 'not-sent', text: 'x' }] };
    },
  });
  askAbout(rec.id);
  const res = await sendChat('Add to this note that she has been updated, it will only happen by end of next week');
  assert.equal(res.reply.updates.length, 1, 'a note that was not sent is dropped');
  assert.equal((await getRecording(rec.id)).updates, undefined, 'nothing added yet');

  assert.equal((await applyUpdate(1, 0)).ok, true);
  const after = await getRecording(rec.id);
  assert.equal(after.updates.length, 1);
  assert.equal(after.updates[0].text, 'תינה עודכנה: המשלוח עד סוף השבוע הבא.');
  assert.equal(after.updates[0].by, 'ask');
  assert.match(after.updates[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await applyUpdate(1, 0)).ok, true, 'a second tap does nothing more');
  assert.equal((await getRecording(rec.id)).updates.length, 1);

  await sendChat('thanks');
  assert.deepEqual(sent[1].messages[1].updates, [{ title: 'עדכון משלוח לתינה', text: 'תינה עודכנה: המשלוח עד סוף השבוע הבא.', applied: true }]);
  assert.deepEqual(sent[1].recordings[0].updates, [{ date: after.updates[0].date, text: 'תינה עודכנה: המשלוח עד סוף השבוע הבא.' }], 'the note now carries its update to the AI');
  assert.match((await applyUpdate(9, 0)).error, /gone/);
});

test('app: updates typed on the note; removing one; empty text refused; Share and search see them', async () => {
  const rec = await createRecording({ title: 'Delivery' });
  assert.match((await addNoteUpdate(rec.id, '   ')).error, /Write the update/);
  assert.equal((await addNoteUpdate(rec.id, 'Told Tina')).ok, true);
  assert.equal((await addNoteUpdate(rec.id, 'Moved to Wednesday')).ok, true);
  let now = await getRecording(rec.id);
  assert.deepEqual(now.updates.map((u) => [u.text, u.by]), [['Told Tina', 'me'], ['Moved to Wednesday', 'me']], 'oldest first');
  assert.match(recordingAsText(now, { actions: [] }), /Updates\n- \d{4}-\d{2}-\d{2}: Told Tina\n- \d{4}-\d{2}-\d{2}: Moved to Wednesday/);
  assert.equal((await removeNoteUpdate(now, now.updates[0].id)).ok, true);
  now = await getRecording(rec.id);
  assert.deepEqual(now.updates.map((u) => u.text), ['Moved to Wednesday']);
  assert.match((await addNoteUpdate('missing', 'x')).error, /gone/);
});
