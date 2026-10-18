// Re-transcribe: the bridge side (request, sanitising Gemini's segments) and
// the app side (old transcript kept in the log, summary rebuilt, nothing
// emptied when the engine hears nothing).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscribeRequest, sanitizeTranscript, clockToMs, transcribeWithGemini, trimRepeats, finishedSegments, tooManyWords } from '../bridge/transcribe.mjs';
import { useRemoteEngine, retranscribe, canTranscribe } from '../app/domain/pipeline.js';
import { createRecording, getRecording, updateRecording, keepTranscriptFixes } from '../app/domain/recordings.js';
import { lineFixes } from '../app/domain/corrections.js';
import { saveTranscript, transcriptFor } from '../app/domain/transcripts.js';
import { actionsFor } from '../app/domain/actions.js';
import { saveAudio } from '../app/core/files.js';
import { listActivity } from '../app/core/audit.js';
import { freshDb } from './helpers.mjs';

test('request: an accent or a cold ("Barina" for Marina) is written as meant when clear, never invented from noise', () => {
  const text = buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: 'en', vocabulary: ['Marina', 'Roland'] }).system_instruction.parts[0].text;
  assert.match(text, /accent, a cold or a blocked nose/);
  assert.match(text, /"Barina" is Marina/);
  assert.match(text, /When it is not clear, write what you heard/);
  assert.match(text, /never for silence or noise/);
});

test('request: language chosen, own script demanded, no translating; auto = detect', () => {
  for (const code of ['he-IL', 'he']) {
    const text = buildTranscribeRequest({ audioBase64: 'AAA', mime: 'audio/webm', language: code }).system_instruction.parts[0].text;
    assert.match(text, /mostly Hebrew.*own script.*never transliterate.*never translate/s);
  }
  assert.match(buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: 'sw' }).system_instruction.parts[0].text, /mostly Swahili/);
  for (const code of ['auto', 'xx-nonsense', null]) {
    assert.match(buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: code }).system_instruction.parts[0].text, /detect it/);
  }
  const body = buildTranscribeRequest({ audioBase64: 'AAA', mime: 'audio/webm', language: 'he' });
  assert.equal(body.contents[0].parts[0].inline_data.mime_type, 'audio/webm');
});

test('clock strings', () => {
  assert.equal(clockToMs('0:05'), 5000);
  assert.equal(clockToMs('1:02:03'), 3_723_000);
  assert.equal(clockToMs('1:05.5'), 65_500);
  assert.equal(clockToMs('0:2'), 2000, 'single-digit seconds, as Gemini actually writes them');
  assert.equal(clockToMs('0:75'), null);
  assert.equal(clockToMs('soon'), null);
});

test('sanitize: times only move forward and stay inside the recording', () => {
  const segs = sanitizeTranscript({ segments: [
    { speaker: 'Speaker 1', start: '0:00', text: 'שלום' },
    { speaker: 'Speaker 2', start: '0:10', text: 'hi' },
    { speaker: 'Speaker 1', start: '0:04', text: 'went backwards' },
    { speaker: 'Speaker 2', start: '9:59', text: 'past the end' },
    { speaker: 'Speaker 1', start: '0:20', text: '   ' },
  ] }, { durationMs: 30_000 });
  assert.deepEqual(segs.map((s) => [s.text, s.start_ms, s.end_ms]), [
    ['שלום', 0, 10_000],
    ['hi', 10_000, 30_000],
    ['went backwards', null, null],
    ['past the end', null, null],
  ]);
});

test('bridge refuses non-audio and oversize before calling Gemini', async () => {
  const never = async () => assert.fail('must not call Gemini');
  await assert.rejects(transcribeWithGemini({ audio: Buffer.from('x'), mime: 'text/plain' }, { apiKey: 'k', fetch: never }), /Not an audio file/);
  await assert.rejects(transcribeWithGemini({ audio: Buffer.alloc(33 * 1024 * 1024), mime: 'audio/webm' }, { apiKey: 'k', fetch: never }), (err) => err.status === 413 && /too large/.test(err.message));
});

test('bridge sends the base mime type and the key in a header', async () => {
  let sent;
  const fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"segments":[{"speaker":"Speaker 1","start":"0:01","text":"hello"}]}' }] } }] }));
  };
  const out = await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/webm;codecs=opus', language: 'en-US', durationMs: 5000 }, { apiKey: 'secret', fetch });
  assert.equal(sent.body.contents[0].parts[0].inline_data.mime_type, 'audio/webm');
  assert.doesNotMatch(sent.url, /secret/);
  assert.deepEqual(out.segments, [{ speaker: 'Speaker 1', text: 'hello', start_ms: 1000, end_ms: 5000 }]);
});

// Long meetings: Gemini streams the transcript in pieces (a single reply was cut off
// with a 524 after ~2 minutes on a 28-minute meeting).
const sse = (chunks, status = 200) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''),
  { status, headers: { 'Content-Type': 'text/event-stream' } });
const piece = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, ...extra }] });

test('streamed: the pieces are joined into one transcript', async () => {
  let url;
  const fetch = async (u) => {
    url = u;
    return sse([piece('{"segments":[{"speaker":"Speaker 1",'), piece('"start":"0:01","text":"hello"}]}', { finishReason: 'STOP' })]);
  };
  const out = await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/mp4', durationMs: 5000 }, { apiKey: 'k', fetch });
  assert.match(url, /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(out.segments, [{ speaker: 'Speaker 1', text: 'hello', start_ms: 1000, end_ms: 5000 }]);
});

test('streamed: an error in the stream, a cut-off answer, a 524 and a timeout are each said plainly', async () => {
  const audio = { audio: Buffer.from('abc'), mime: 'audio/mp4' };
  await assert.rejects(transcribeWithGemini(audio, { apiKey: 'k', fetch: async () => sse([piece('{"seg'), { error: { message: 'overloaded' } }]) }), /overloaded/);
  await assert.rejects(transcribeWithGemini(audio, { apiKey: 'k', fetch: async () => sse([piece('{"segments":[', { finishReason: 'MAX_TOKENS' })]) }), /broke off before any usable lines/);
  await assert.rejects(transcribeWithGemini(audio, { apiKey: 'k', fetch: async () => new Response('<html>524</html>', { status: 524 }) }), /Gemini 524/);
  const hang = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(transcribeWithGemini(audio, { apiKey: 'k', fetch: hang, timeoutMs: 10 }), (err) => err.status === 504 && /took longer/.test(err.message));
});

// Rounds: a loop costs one capped answer, not the meeting (flash-lite repeated itself on a
// 28-minute meeting until its 65k limit, 2026-10-07).
const line = (start, text, speaker = 'Speaker 1') => ({ speaker, start, text });
const answer = (segments) => JSON.stringify({ segments });

test('rounds: a looping answer keeps its good lines and the next round continues after them', async () => {
  const sent = [];
  const replies = [
    // Round 1: two good lines, then stuck on one line, cut off mid-object at the cap.
    sse([piece(`${answer([line('0:01', 'Hello all'), line('0:20', 'First the budget'), line('0:40', 'ok so'), line('0:41', 'ok so'), line('0:42', 'ok so')]).slice(0, -2)}, {"speaker":"Spea`, { finishReason: 'MAX_TOKENS' })]),
    // Round 2: overlaps the last good line, then finishes.
    sse([piece(answer([line('0:40', 'ok so'), line('0:41', 'the budget is fine'), line('25:00', 'Thanks everyone', 'Speaker 2')]), { finishReason: 'STOP' })]),
  ];
  const fetch = async (_u, init) => { sent.push(JSON.parse(init.body)); return replies.shift(); };
  const out = await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/mp4', durationMs: 28 * 60_000 }, { apiKey: 'k', fetch });
  assert.deepEqual(out.segments.map((s) => s.text), ['Hello all', 'First the budget', 'ok so', 'the budget is fine', 'Thanks everyone']);
  assert.equal(out.incomplete, undefined);
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[0].system_instruction.parts[0].text, /already written/);
  assert.match(sent[1].system_instruction.parts[0].text, /Everything before 0:41 is already written/);
  // Round 2 knows who spoke so far and the last lines, so it keeps the same numbers.
  assert.match(sent[1].system_instruction.parts[0].text, /Speakers so far: Speaker 1\./);
  assert.match(sent[1].system_instruction.parts[0].text, /\[0:20\] Speaker 1: First the budget/);
  assert.match(sent[1].contents[0].parts[1].text, /Speakers so far/);
  assert.equal(sent[0].generationConfig.maxOutputTokens, 16_384);
  assert.equal(sent[0].generationConfig.temperature, undefined, 'Gemini 3 loops below its default temperature');
  assert.equal(out.segments.at(-1).end_ms, 28 * 60_000);
});

test('rounds: no progress stops with what came back, marked incomplete', async () => {
  const stuck = () => sse([piece(answer([line('0:05', 'one'), line('0:06', 'same'), line('0:07', 'same'), line('0:08', 'same')]), { finishReason: 'MAX_TOKENS' })]);
  let calls = 0;
  const out = await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/mp4', durationMs: 600_000 }, { apiKey: 'k', fetch: async () => { calls += 1; return stuck(); } });
  assert.deepEqual(out.segments.map((s) => s.text), ['one', 'same']);
  assert.equal(out.incomplete, true);
  assert.equal(calls, 2, 'the second round made no progress, so it stopped');
});

// Over the inline limit: one Files API upload, every round points at it, deleted after.
function filesApi({ uploadUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u1', state = 'ACTIVE', replies }) {
  const calls = [];
  const uri = 'https://generativelanguage.googleapis.com/v1beta/files/abc';
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });
    if (url.endsWith('/upload/v1beta/files')) return new Response('{}', { headers: { 'x-goog-upload-url': uploadUrl } });
    if (url === uploadUrl) return Response.json({ file: { name: 'files/abc', uri, state } });
    if (url.endsWith('/v1beta/files/abc')) return method === 'GET' ? Response.json({ name: 'files/abc', uri, state: 'ACTIVE' }) : new Response('{}');
    return replies.shift();
  };
  return { calls, fetch };
}

test('big recording: uploaded once, every round uses the upload, deleted after', async () => {
  const api = filesApi({ state: 'PROCESSING', replies: [
    sse([piece(answer([line('0:01', 'Hello all'), line('0:20', 'First the budget')]), { finishReason: 'MAX_TOKENS' })]),
    sse([piece(answer([line('0:30', 'Fine', 'Speaker 2')]), { finishReason: 'STOP' })]),
  ] });
  const out = await transcribeWithGemini({ audio: Buffer.from('abcdef'), mime: 'audio/mp4', durationMs: 60_000 },
    { apiKey: 'secret', fetch: api.fetch, inlineMaxBytes: 3, sleep: async () => {} });
  assert.deepEqual(out.segments.map((s) => s.text), ['Hello all', 'First the budget', 'Fine']);
  const rounds = api.calls.filter((c) => /streamGenerateContent/.test(c.url)).map((c) => JSON.parse(c.body));
  assert.equal(rounds.length, 2);
  for (const r of rounds) {
    assert.deepEqual(r.contents[0].parts[0], { file_data: { mime_type: 'audio/mp4', file_uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } });
  }
  assert.equal(api.calls.filter((c) => c.url.endsWith('/upload/v1beta/files')).length, 1, 'uploaded once');
  assert.equal(api.calls.at(-1).method, 'DELETE');
  assert.ok(api.calls.every((c) => !c.url.includes('secret')), 'the key stays in a header');
});

test('big recording: deleted even when Gemini fails; a foreign upload address never gets the key', async () => {
  const busy = () => new Response('{"error":{"message":"overloaded"}}', { status: 503 });
  const failing = filesApi({ replies: [busy(), busy(), busy()] });
  await assert.rejects(transcribeWithGemini({ audio: Buffer.from('abcdef'), mime: 'audio/mp4' }, { apiKey: 'k', fetch: failing.fetch, inlineMaxBytes: 3, sleep: async () => {} }), /overloaded/);
  assert.equal(failing.calls.at(-1).method, 'DELETE');
  const foreign = filesApi({ uploadUrl: 'https://evil.example/upload', replies: [] });
  await assert.rejects(transcribeWithGemini({ audio: Buffer.from('abcdef'), mime: 'audio/mp4' }, { apiKey: 'k', fetch: foreign.fetch, inlineMaxBytes: 3 }), /no upload address/);
  assert.ok(foreign.calls.every((c) => !c.url.startsWith('https://evil.example')));
});

test('Gemini busy (503) is asked again after a short wait; the prompt keeps prices as meant', async () => {
  const waits = [];
  const api = filesApi({ replies: [
    new Response('{"error":{"message":"overloaded"}}', { status: 503 }),
    sse([piece(answer([line('0:01', 'It was 2.35')]), { finishReason: 'STOP' })]),
  ] });
  const out = await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/mp4' },
    { apiKey: 'k', fetch: api.fetch, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(out.segments.map((s) => s.text), ['It was 2.35']);
  assert.deepEqual(waits, [2_000]);
  assert.match(JSON.parse(api.calls[0].body).system_instruction.parts[0].text, /"two thirty-five" is 2\.35/);
});

test('more words than the audio could hold are made up: nothing is kept', async () => {
  // The owner's 1.6 s watch clip (2026-10-14): 14 words built from the Names & words list.
  const invented = [{ text: 'שלום, אפשר להוציא מחר את הקייסים, יש לי תשלום חודשי שצריך לסגור עם ה-acetone.' }];
  assert.equal(tooManyWords(invented, 1_589), true);
  assert.equal(tooManyWords([{ text: 'Buy milk, eggs and bread tomorrow' }], 1_600), false, 'a fast 6-word note fits');
  assert.equal(tooManyWords([{ text: 'Call Dana about the Montreal delivery on Monday morning please' }], 3_000), false);
  assert.equal(tooManyWords(invented, null), false, 'no length known: nothing to compare');
  assert.equal(tooManyWords([{ text: 'one two three four five six seven eight nine' }], 1_600, { translated: true }), false);

  const api = filesApi({ replies: [sse([piece(answer([line('0:01', invented[0].text)]), { finishReason: 'STOP' })])] });
  const out = await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/mp4', durationMs: 1_589, vocabulary: ['acetone'] }, { apiKey: 'k', fetch: api.fetch });
  assert.deepEqual(out.segments, []);
  assert.equal(out.madeUp, true);
  const system = JSON.parse(api.calls[0].body).system_instruction.parts[0].text;
  assert.match(system, /only for spelling words you actually hear/);
  assert.match(system, /If you are not sure anything was said, return an empty list/);
});

test('small recording stays inline', async () => {
  const api = filesApi({ replies: [sse([piece(answer([line('0:01', 'hi')]), { finishReason: 'STOP' })])] });
  await transcribeWithGemini({ audio: Buffer.from('abc'), mime: 'audio/mp4' }, { apiKey: 'k', fetch: api.fetch });
  assert.equal(api.calls.length, 1);
  assert.ok(JSON.parse(api.calls[0].body).contents[0].parts[0].inline_data);
});

test('loops: a line repeated 3 times, or a phrase looping inside a long line, ends the round there', () => {
  const t = (text) => ({ text });
  assert.deepEqual(trimRepeats([t('a'), t('b'), t('b')]), { kept: [t('a'), t('b'), t('b')], repeating: false });
  assert.deepEqual(trimRepeats([t('a'), t('B!'), t('b'), t('b.')]), { kept: [t('a'), t('B!')], repeating: true });
  const looping = t(`so ${'we will see '.repeat(20)}`);
  assert.deepEqual(trimRepeats([t('a'), looping, t('c')]), { kept: [t('a')], repeating: true });
  assert.equal(trimRepeats([t('yes yes yes yes yes yes yes')]).repeating, false, 'a short emphatic line is a person');
  assert.deepEqual(finishedSegments('{"segments":[{"text":"a \\"}\\" b"},{"text":"c"},{"te'), [{ text: 'a "}" b' }, { text: 'c' }]);
});

// ── App side ────────────────────────────────────────────────────────────
async function recordingWithAudio(lines) {
  const rec = await createRecording({ title: 'Voice note', source: 'device', language: 'en-US', duration_ms: 20_000 });
  const file = await saveAudio(new Blob(['fake'], { type: 'audio/webm' }), { recordingId: rec.id, durationMs: 20_000 });
  await updateRecording(rec.id, { audio_file_id: file.id });
  if (lines) await saveTranscript(rec.id, lines.map((text) => ({ text })));
  return rec.id;
}

const fakeEngine = (segments) => ({
  id: 'remote',
  calls: [],
  async transcribe(blob, { job, ...opts }) { this.calls.push({ type: blob.type, ...opts }); return { segments, engine: 'gemini-2.5-flash' }; },
  async process() { throw new Error('use the local engine for this test'); },
});

beforeEach(() => { freshDb(); useRemoteEngine(null); });

test('no AI engine → a clear refusal, nothing touched', async () => {
  assert.equal(canTranscribe(), false);
  const id = await recordingWithAudio(['old words']);
  const res = await retranscribe(id, { language: 'he-IL' });
  assert.equal(res.ok, false);
  assert.equal((await transcriptFor(id)).segments[0].text, 'old words');
});

test('re-transcribe replaces the transcript, keeps the old one in the log, rebuilds actions, records the language', async () => {
  const engine = fakeEngine([{ speaker: 'Speaker 1', text: 'תזכורת להתקשר לדנה מחר.', start_ms: 0, end_ms: 4000 }]);
  useRemoteEngine(engine);
  const id = await recordingWithAudio(['Shalom, tizkoret lehitkasher']);
  const res = await retranscribe(id, { language: 'he-IL' });
  assert.equal(res.ok, true);
  assert.deepEqual(engine.calls, [{ type: 'audio/webm', language: 'he-IL', target: null, vocabulary: [], durationMs: 20_000, keep: '24h' }]);
  assert.equal((await transcriptFor(id)).segments[0].text, 'תזכורת להתקשר לדנה מחר.');
  assert.equal((await getRecording(id)).language, 'he-IL');
  assert.deepEqual((await actionsFor(id)).map((a) => a.label), ['להתקשר לדנה מחר']);
  const edit = (await listActivity()).find((e) => e.table === 'transcripts' && e.action === 'update');
  assert.equal(edit.before.segments[0].text, 'Shalom, tizkoret lehitkasher');
});

test('a hand fix survives Re-transcribe: sent as a word for this recording, and put back', async () => {
  const engine = fakeEngine([{ speaker: 'Speaker 1', text: 'Uh, 235?', start_ms: 33_000, end_ms: 35_000 }]);
  useRemoteEngine(engine);
  const id = await recordingWithAudio(['Uh, 2.35?']);
  await keepTranscriptFixes(await getRecording(id), lineFixes('Uh, 235?', 'Uh, 2.35?'));
  assert.equal((await retranscribe(id, { language: 'en-US' })).ok, true);
  assert.deepEqual(engine.calls[0].vocabulary, ['2.35 (heard as 235)']);
  assert.equal((await transcriptFor(id)).segments[0].text, 'Uh, 2.35?');
  assert.deepEqual((await getRecording(id)).transcript_fixes, [{ heard: '235', meant: '2.35' }], 'still kept for next time');
});

test('engine hears nothing → old transcript kept', async () => {
  useRemoteEngine(fakeEngine([]));
  const id = await recordingWithAudio(['keep me']);
  const res = await retranscribe(id);
  assert.equal(res.ok, false);
  assert.equal((await transcriptFor(id)).segments[0].text, 'keep me');
});

test('a recording without audio says so', async () => {
  useRemoteEngine(fakeEngine([{ text: 'x' }]));
  const rec = await createRecording({ title: 'Typed' });
  assert.match((await retranscribe(rec.id)).error, /no audio/);
});
