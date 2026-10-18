// The bridge's AI engine against a fake Gemini: request shape, and that
// whatever the model returns is checked before the app sees it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, sanitize, processWithGemini, transcriptText, thinkingConfig, withThinking } from '../bridge/gemini.mjs';
import { askWithGemini } from '../bridge/ask.mjs';
import { chatWithGemini } from '../bridge/chat.mjs';

const segments = [
  { speaker: 'Speaker 1', text: 'Remind me to email Dana tomorrow.', start_ms: 0, end_ms: 4000 },
  { speaker: null, text: 'תזכורת להתקשר ביום שני לספק.', start_ms: 65_000, end_ms: 70_000 },
];

test('request: template headings, today and weekday, JSON schema, key in a header not the URL', async () => {
  const body = buildRequest({ segments, template: 'meeting', today: '2026-10-04' });
  const system = body.system_instruction.parts[0].text;
  assert.match(system, /2026-10-04, a Sunday/);
  assert.match(system, /"Decisions"/);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.match(body.contents[0].parts[0].text, /\[1:05\] תזכורת/);

  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"T","sections":[],"blocks":[],"actions":[]}' }] } }] }));
  };
  await processWithGemini({ segments, template: 'general', today: '2026-10-04' }, { apiKey: 'secret', fetch });
  assert.doesNotMatch(seen.url, /secret/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret');
});

test('sanitize: bad enums, bad dates, impossible times and duplicates are dropped or defaulted', () => {
  const out = sanitize({
    title: 'Call notes',
    sections: [
      { title: 'Start', summary: 'x', start_ms: 0, end_ms: 4000 },
      { title: 'Ghost', summary: 'y', start_ms: 99_999_999, end_ms: -5 },
      { title: '', summary: 'no title' },
    ],
    blocks: [{ heading: 'Model heading', items: ['Short overview.'] }, { heading: 'x', items: ['p1', ''] }],
    actions: [
      { label: 'Email Dana', type: 'draft_email', priority: 'medium', due_date: '2026-10-05' },
      { label: 'email dana', type: 'draft_email' },
      { label: 'Call the supplier', type: 'phone_call', priority: 'urgent!!', due_date: 'next Monday' },
      { label: '', type: 'create_reminder' },
    ],
  }, { template: 'general', segments, model: 'gemini-2.5-flash' });

  // 'Start' is the only section with a time, so it runs to the end of the recording.
  assert.deepEqual(out.sections.map((s) => [s.title, s.start_ms, s.end_ms]), [['Start', 0, 70_000], ['Ghost', null, null]]);
  assert.deepEqual(out.actions.map((a) => [a.label, a.type, a.priority, a.due_date]), [
    ['Email Dana', 'draft_email', 'medium', '2026-10-05'],
    ['Call the supplier', 'create_reminder', 'medium', null],
  ]);
  assert.deepEqual(out.summary.blocks.map((b) => b.heading), ['Overview', 'Key points', 'Next steps'], 'headings come from the template');
  assert.deepEqual(out.summary.blocks[2].items, ['Email Dana', 'Call the supplier'], 'the actions block lists the checked actions');
  assert.equal(out.summary.engine, 'gemini-2.5-flash');
});

test('errors: no key, empty transcript, API error, non-JSON reply', async () => {
  await assert.rejects(processWithGemini({ segments, template: 'general', today: '2026-10-04' }, { apiKey: '' }), /GEMINI_API_KEY/);
  await assert.rejects(processWithGemini({ segments: [], template: 'general', today: '2026-10-04' }, { apiKey: 'k' }), /No transcript/);
  const apiError = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  await assert.rejects(processWithGemini({ segments, template: 'general', today: '2026-10-04' }, { apiKey: 'k', fetch: apiError }), /Gemini 400: API key not valid/);
  const prose = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Sure! Here you go' }] } }] }));
  await assert.rejects(processWithGemini({ segments, template: 'general', today: '2026-10-04' }, { apiKey: 'k', fetch: prose }), /no JSON/);
});

test('a format whose only text block is the overview gets every specific, not 1-2 sentences', () => {
  const system = (template) => buildRequest({ segments, template, today: '2026-10-14' }).system_instruction.parts[0].text;
  assert.match(system('voice_note'), /"Note" \(short bullet points: one line for a short note, more for a conversation/);
  assert.match(system('meeting'), /"Overview" \(1–2 sentences\)/);
  assert.match(system('general'), /every price or amount \(with its currency and what it is per/);
  assert.match(system('general'), /"85" cents and "\$1\.50" → \$2\.35/);
});

test('Gemini busy: 503/500 asked again twice, then the error; 429 never retried', async () => {
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"T","sections":[],"blocks":[],"actions":[]}' }] } }] }));
  const busy = (status = 503) => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status });
  const scripted = (replies) => { let n = 0; const f = async () => { n += 1; return replies.shift(); }; f.count = () => n; return f; };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const input = { segments, template: 'general', today: '2026-10-14' };

  const recovers = scripted([busy(), busy(500), ok()]);
  assert.equal((await processWithGemini(input, { apiKey: 'k', fetch: recovers, sleep })).title, 'T');
  assert.deepEqual(waits, [2_000, 5_000]);

  const down = scripted([busy(), busy(), busy()]);
  await assert.rejects(processWithGemini(input, { apiKey: 'k', fetch: down, sleep }), /Gemini 503: overloaded/);
  assert.equal(down.count(), 3);

  const quota = scripted([busy(429)]);
  await assert.rejects(processWithGemini(input, { apiKey: 'k', fetch: quota, sleep }), /Gemini 429/);
  assert.equal(quota.count(), 1);
});

test('transcript lines carry time and speaker', () => {
  assert.equal(transcriptText([{ speaker: 'A', text: 'hi', start_ms: 3000 }, { text: 'plain' }]), '[0:03] A: hi\nplain');
});

// A 28-minute meeting's sections came out at 0:00, 0:06, 0:10: asked for ms, flash-lite
// wrote minutes as seconds (2026-10-07). Now it copies the [m:ss] mark; the code converts.
test('sections: Gemini copies the [m:ss] mark, the code turns it into the line\'s time; each ends where the next begins', () => {
  const meeting = [0, 65_000, 372_000, 371_000 + 240_000, 1_690_000].map((start_ms, i) => ({ speaker: 'Speaker 1', text: `line ${i}`, start_ms, end_ms: start_ms + 5000 }));
  const out = sanitize({
    title: 'Shipping', blocks: [], actions: [],
    sections: [
      { title: 'Overview', summary: 'a', start: '0:00' },
      { title: 'Requirements', summary: 'b', start: '6:12' },
      { title: 'Next steps', summary: 'c', start: '[10:12]' },
      { title: 'Out of order', summary: 'd', start: '1:05' },
      { title: 'No mark', summary: 'e', start: null },
    ],
  }, { template: 'general', segments: meeting, model: 'm' });
  assert.deepEqual(out.sections.map((s) => [s.title, s.start_ms, s.end_ms]), [
    ['Overview', 0, 372_000],
    ['Requirements', 372_000, 611_000],
    ['Next steps', 611_000, 1_695_000],
    ['Out of order', null, null],
    ['No mark', null, null],
  ]);
});

test('sections: the request asks for the mark as written, not for milliseconds', () => {
  const req = buildRequest({ segments: [{ text: 'hi', start_ms: 372_000 }], template: 'general', today: '2026-10-07' });
  const props = req.generationConfig.responseSchema.properties.sections.items.properties;
  assert.deepEqual(Object.keys(props), ['title', 'summary', 'start']);
  assert.match(req.system_instruction.parts[0].text, /copied exactly as it is written/);
  assert.match(req.contents[0].parts[0].text, /\[6:12\] hi/);
});

test('thinking per model: none = budget 0 (Flash-Lite), low = thinkingLevel low (models that refuse 0)', async () => {
  assert.deepEqual(thinkingConfig('none'), { thinkingBudget: 0 });
  assert.deepEqual(thinkingConfig('low'), { thinkingLevel: 'low' });
  assert.deepEqual(thinkingConfig('minimal'), { thinkingLevel: 'minimal' });
  const body = { generationConfig: { temperature: 0, thinkingConfig: { thinkingBudget: 0 } } };
  assert.equal(withThinking(body, undefined), body, 'no setting: the body as built');
  assert.deepEqual(withThinking(body, 'low').generationConfig, { temperature: 0, thinkingConfig: { thinkingLevel: 'low' } });

  const sent = [];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const text = sent.length === 1 ? '{"title":"T","sections":[],"blocks":[],"actions":[]}'
      : sent.length === 2 ? '{"answer":"a","found":false,"sources":[]}'
      : '{"draft_kind":"none","draft_subject":null,"draft_body":null,"task_changes":[],"answer":"a","found":false,"sources":[]}';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  };
  const opts = { apiKey: 'k', model: 'gemini-4-argon', thinking: 'low', fetch };
  await processWithGemini({ segments, template: 'general', today: '2026-10-04' }, opts);
  await askWithGemini({ question: 'When?', today: '2026-10-04', recordings: [] }, opts);
  await chatWithGemini({ messages: [{ role: 'user', text: 'When?' }], today: '2026-10-04', recordings: [] }, opts);
  for (const b of sent) assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});
