// The context the device picks (app/domain/ask.js) and the older one-question route
// (/api/ask, bridge/ask.mjs, kept for apps from before the chat). The chat: chat.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAskRequest, sanitizeAnswer, askWithGemini } from '../bridge/ask.mjs';
import { pickContext } from '../app/domain/ask.js';

const recs = [
  { id: 'a', title: 'Call with Daniel', local_date: '2026-10-02', recorded_at: '2026-10-02T20:00:00Z', summary: { blocks: [{ heading: 'Overview', items: ['Exclusivity on hypochlorous acid'] }] }, speakers: { 'Speaker 1': 'Daniel' } },
  { id: 'b', title: 'Groceries', local_date: '2026-10-03', recorded_at: '2026-10-03T10:00:00Z', summary: null },
  { id: 'c', title: 'Invoice Guy', local_date: '2026-10-04', recorded_at: '2026-10-04T10:00:00Z', summary: null },
];
const transcripts = [{ recording_id: 'a', segments: [{ speaker: 'Speaker 1', text: 'We can do private label.' }] }];
const actions = [{ id: 'x1', recording_id: 'a', label: 'Talk to Daniel about exclusivity', status: 'open', due_date: '2026-10-06' }, { id: 'x2', recording_id: 'a', label: 'Old idea', status: 'cancelled', due_date: null }];

test('context: matches first, topped up with recent ones; speaker names applied; tasks listed with ids', () => {
  const ctxt = pickContext('Daniel exclusivity', { recordings: recs, actions, transcripts });
  assert.equal(ctxt[0].id, 'a');
  assert.deepEqual(ctxt.map((r) => r.id).sort(), ['a', 'b', 'c'], 'few matches → topped up with recent');
  assert.equal(ctxt[0].transcript, 'Daniel: We can do private label.');
  assert.deepEqual(ctxt[0].tasks, [{ id: 'x1', label: 'Talk to Daniel about exclusivity', status: 'open', due_date: '2026-10-06' }], 'cancelled tasks stay out');
});

test('context: roles without "private" never send transcripts', () => {
  const ctxt = pickContext('private label', { recordings: recs, actions, transcripts }, { includeTranscripts: false });
  assert.ok(ctxt.every((r) => r.transcript === ''));
});

test('context is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, title: `Note ${i}`, local_date: '2026-10-01', recorded_at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z` }));
  assert.equal(pickContext('note', { recordings: many, actions: [], transcripts: [] }, { max: 12 }).length, 12);
});

test('bridge: refs map back to ids; refs that were not sent are dropped; no sources = not found', () => {
  const { refs, body } = buildAskRequest({ question: 'what about Daniel?', today: '2026-10-04', recordings: [{ id: 'a', title: 'Call', date: '2026-10-02' }, { id: 'b', title: 'Other', date: '2026-10-03' }] });
  assert.match(body.contents[0].parts[0].text, /### r1 - "Call" \(2026-10-02\)/);
  assert.deepEqual(sanitizeAnswer({ answer: 'Yes', found: true, sources: ['r2', 'r9', 'r2', 'a'] }, refs), { answer: 'Yes', found: true, sources: ['b'] });
  assert.equal(sanitizeAnswer({ answer: 'Maybe', found: true, sources: [] }, refs).found, false);
});

test('bridge: key in a header, question required', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"answer":"x","found":false,"sources":[]}' }] } }] })); };
  await askWithGemini({ question: 'q', today: '2026-10-04', recordings: [] }, { apiKey: 'secret', fetch });
  assert.doesNotMatch(seen.url, /secret/);
  await assert.rejects(askWithGemini({ question: '  ', today: '2026-10-04', recordings: [] }, { apiKey: 'k', fetch }), /Ask a question/);
});

test('context: recordings the chat already used stay on top, even when the follow-up matches nothing', () => {
  const ctxt = pickContext('make it shorter', { recordings: recs, actions, transcripts }, { first: ['c', 'gone'] });
  assert.equal(ctxt[0].id, 'c');
  assert.deepEqual(ctxt.map((r) => r.id).sort(), ['a', 'b', 'c'], 'still topped up with recent ones');
  assert.equal(pickContext('note', { recordings: recs, actions: [], transcripts: [] }, { first: ['a', 'b', 'c'], max: 2 }).length, 2);
});
