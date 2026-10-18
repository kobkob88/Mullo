import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteEngine, OFFLINE_BEFORE, OFFLINE_DURING, OFFLINE_WAITING } from '../app/domain/engines/remote.js';
import { readTranscribeRequest, cleanSpeechMap, dropQuietSegments, transcribeWithGemini } from '../bridge/transcribe.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// A stand-in Worker with jobs: answers the upload with a job id, then `states` in turn
// (an Error = no signal, a number = that status, an object = that answer).
const JOB = '11111111-2222-4333-8444-555555555555';
function jobServer(states, log = []) {
  return async (url, init = {}) => {
    const req = new Request(url, init);
    log.push(req);
    if (req.method === 'POST' && req.url.endsWith('/api/transcribe/jobs')) return new Response(JSON.stringify({ job: JOB }), { status: 202 });
    const next = states.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return new Response('{"error":"gone"}', { status: next });
    return new Response(JSON.stringify(next), { status: 200 });
  };
}
const fastEngine = (extra = {}) => createRemoteEngine({ bridgeUrl: 'https://bridge.example', authKey: 'echo_test', wait: async () => {}, ...extra });
const done = (texts) => ({ state: 'done', result: { segments: texts.map((text) => ({ text })) } });
const audio = () => new Blob([new Uint8Array([1])], { type: 'audio/mp4' });

test('the app sends the names in the body, and the URL carries nothing personal', async () => {
  const log = [];
  globalThis.fetch = jobServer([done([])], log);
  await fastEngine().transcribe(new Blob([new Uint8Array([1, 2])], { type: 'audio/webm' }),
    { language: 'he', target: 'en', vocabulary: ['נועה (Noa)'], durationMs: 3000.4 });
  const seen = log[0];
  assert.equal(seen.url, 'https://bridge.example/api/transcribe/jobs');
  assert.equal(seen.headers.get('Authorization'), 'Bearer echo_test');
  assert.equal(log[1].url, `https://bridge.example/api/transcribe/jobs/${JOB}`);
  const read = await readTranscribeRequest(seen);
  assert.deepEqual({ ...read, audio: [...read.audio] }, {
    audio: [1, 2], mime: 'audio/webm', language: 'he', target: 'en', vocabulary: ['נועה (Noa)'], durationMs: 3000, speech: null,
  });
});

test('S45: the keep choice rides in the options; the answer names its job; release says "got it" on the same path', async () => {
  const log = [];
  const server = jobServer([done(['hi'])], log);
  globalThis.fetch = async (url, init = {}) => {
    if (init.method !== 'DELETE') return server(url, init);
    log.push(new Request(url, init));
    return new Response(null, { status: 204 });
  };
  const engine = fastEngine();
  const out = await engine.transcribe(audio(), { language: 'en', keep: 'collected' });
  assert.equal(out.job, JOB);
  assert.equal((await readTranscribeRequest(log[0])).keep, 'collected');
  assert.equal(await engine.release(JOB), true);
  const last = log.at(-1);
  assert.equal(last.method, 'DELETE');
  assert.equal(last.url, `https://bridge.example/api/transcribe/jobs/${JOB}`);
  assert.equal(last.headers.get('Authorization'), 'Bearer echo_test');

  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await engine.release(JOB), false, 'no signal: never throws, the server forgets it later');
});

test('reading: bad shapes are dropped, missing audio and broken options are refused', async () => {
  const form = new FormData();
  form.append('options', JSON.stringify({ vocabulary: ['ok', 5, { x: 1 }], lang: 7 }));
  form.append('audio', new Blob([new Uint8Array([9])]), 'audio');
  const read = await readTranscribeRequest(new Request('https://x/api/transcribe', { method: 'POST', body: form }));
  assert.deepEqual(read.vocabulary, ['ok']);
  assert.equal(read.language, null);

  const empty = new FormData();
  empty.append('options', '{}');
  await assert.rejects(readTranscribeRequest(new Request('https://x/api/transcribe', { method: 'POST', body: empty })), (e) => e.status === 400);

  const bad = new FormData();
  bad.append('options', 'not json');
  bad.append('audio', new Blob([new Uint8Array([9])]), 'audio');
  await assert.rejects(readTranscribeRequest(new Request('https://x/api/transcribe', { method: 'POST', body: bad })), (e) => e.status === 400);
});

test('an app from before the change (raw audio, options in the query) is still read', async () => {
  const req = new Request('https://x/api/transcribe?lang=he&out=en&vocab=a&vocab=b&duration_ms=500', {
    method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: new Uint8Array([7]),
  });
  const read = await readTranscribeRequest(req);
  assert.deepEqual({ ...read, audio: [...read.audio] }, {
    audio: [7], mime: 'audio/mp4', language: 'he', target: 'en', vocabulary: ['a', 'b'], durationMs: 500, speech: null,
  });
});

// ── The speech map on the Worker / bridge ───────────────────────────────
const seg = (s, text = 'x') => ({ speaker: null, text, start_ms: s, end_ms: null });

test('a broken or oversized map is ignored, never trusted', () => {
  assert.equal(cleanSpeechMap(null), null);
  assert.equal(cleanSpeechMap({ ranges: [[0, 1]] }), null, 'no duration');
  assert.equal(cleanSpeechMap({ ranges: [[5, 1]], duration_ms: 10 }), null, 'ends before it starts');
  assert.equal(cleanSpeechMap({ ranges: [[5, 9], [2, 3]], duration_ms: 10 }), null, 'out of order');
  assert.equal(cleanSpeechMap({ ranges: Array.from({ length: 5001 }, (_, i) => [i, i]), duration_ms: 1e9 }), null);
  assert.deepEqual(cleanSpeechMap({ ranges: [['1', 2]], duration_ms: 10 }), { ranges: [[1, 2]], durationMs: 10 });
});

test('lines over a long silence are dropped; near speech, or over a short pause, they stay', () => {
  // Talking 0-20 s, silence 20-60 s, talking 60-70 s.
  const map = { ranges: [[0, 20_000], [60_000, 70_000]], durationMs: 70_000 };
  const { segments, dropped } = dropQuietSegments([
    seg(0, 'real'), seg(21_000, 'Gemini a bit late'), seg(35_000, 'made up'), seg(58_000, 'Gemini a bit early'), seg(61_000, 'real'), seg(null, 'no time'),
  ], map, { durationMs: 70_000 });
  assert.deepEqual(segments.map((s) => s.text), ['real', 'Gemini a bit late', 'Gemini a bit early', 'real', 'no time']);
  assert.equal(dropped, 1);
  assert.equal(segments[1].end_ms, 58_000, 'ends are worked out again without the dropped line');
  const pause = { ranges: [[0, 5_000], [12_000, 20_000]], durationMs: 20_000 };
  assert.equal(dropQuietSegments([seg(8_000)], pause).dropped, 0, 'a 7 s pause is not a silence');
});

test('a silent tail after speech: lines written there are dropped', () => {
  const map = { ranges: [[0, 8_000]], durationMs: 60_000 };
  assert.deepEqual(dropQuietSegments([seg(0, 'real'), seg(40_000, 'thanks for watching')], map).segments.map((s) => s.text), ['real']);
});

test('a map with no sound at all: Gemini is never called', async () => {
  let called = false;
  const out = await transcribeWithGemini(
    { audio: new Uint8Array([1]), mime: 'audio/mp4', language: 'he', speech: { ranges: [], durationMs: 5000 } },
    { apiKey: 'k', fetch: async () => { called = true; return new Response('{}'); } },
  );
  assert.equal(called, false);
  assert.deepEqual(out.segments, []);
  assert.equal(out.silent, true);
});

// A dropped signal is said as that, never as "no speech" or "Gemini didn't answer".
test('network: no signal, a drop while waiting and a cut-off answer are each said as a connection problem', async () => {
  const engine = createRemoteEngine({ bridgeUrl: 'https://bridge.example' });
  const blob = new Blob([new Uint8Array([1])], { type: 'audio/mp4' });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(engine.transcribe(blob, {}), (err) => err.offline === true && err.message === OFFLINE_DURING);
  globalThis.fetch = async () => new Response('{"segm', { status: 200 });
  await assert.rejects(engine.transcribe(blob, {}), (err) => err.offline === true && err.message === OFFLINE_DURING);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Gemini 524: error' }), { status: 502 });
  await assert.rejects(engine.transcribe(blob, {}), (err) => !err.offline && /524/.test(err.message));

  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  let sent = false;
  globalThis.fetch = async () => { sent = true; return new Response('{}'); };
  try {
    await assert.rejects(engine.transcribe(blob, {}), (err) => err.offline === true && err.message === OFFLINE_BEFORE);
    assert.equal(sent, false);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
  }
});

// Send now, collect later: the server keeps working whatever the signal does.
test('jobs: uploads once, keeps the id, and waits out a dropped signal and a server hiccup', async () => {
  const kept = [];
  const log = [];
  globalThis.fetch = jobServer([{ state: 'queued' }, new TypeError('Failed to fetch'), 503, { state: 'working' }, done(['Hello all'])], log);
  const out = await fastEngine().transcribe(audio(), { job: { resume: null, started: async (id) => { kept.push(id); } } });
  assert.deepEqual(out.segments.map((s) => s.text), ['Hello all']);
  assert.deepEqual(kept, [JOB]);
  assert.equal(log.filter((r) => r.method === 'POST').length, 1, 'the audio goes up once');
});

test('jobs: a job kept from before is collected without sending the audio again; a gone one is sent anew', async () => {
  const log = [];
  globalThis.fetch = jobServer([done(['from before'])], log);
  const out = await fastEngine().transcribe(audio(), { job: { resume: JOB } });
  assert.deepEqual(out.segments.map((s) => s.text), ['from before']);
  assert.equal(log.filter((r) => r.method === 'POST').length, 0);

  const again = [];
  globalThis.fetch = jobServer([404, done(['sent anew'])], again);
  const fresh = await fastEngine().transcribe(audio(), { job: { resume: 'gone-job' } });
  assert.deepEqual(fresh.segments.map((s) => s.text), ['sent anew']);
  assert.equal(again.filter((r) => r.method === 'POST').length, 1);
});

test('jobs: no signal for 2 minutes says the server is still on it; a failed job says why', async () => {
  let t = 0;
  const lost = Array.from({ length: 100 }, () => new TypeError('Failed to fetch'));
  globalThis.fetch = jobServer([{ state: 'working' }, ...lost]);
  const engine = fastEngine({ wait: async (ms) => { t += ms; }, now: () => t });
  await assert.rejects(engine.transcribe(audio(), {}), (err) => err.offline && err.pending && err.message === OFFLINE_WAITING);

  globalThis.fetch = jobServer([{ state: 'failed', error: 'Gemini 503: overloaded' }]);
  await assert.rejects(fastEngine().transcribe(audio(), {}), (err) => !err.offline && /overloaded/.test(err.message));
});

test('jobs: a server without them (the PC bridge, an older Worker) gets the one-request way', async () => {
  const log = [];
  globalThis.fetch = async (url, init) => {
    log.push(new Request(url, init).url);
    if (String(url).endsWith('/jobs')) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(JSON.stringify({ segments: [{ text: 'direct' }] }), { status: 200 });
  };
  const out = await fastEngine().transcribe(audio(), {});
  assert.deepEqual(out.segments.map((s) => s.text), ['direct']);
  assert.deepEqual(log, ['https://bridge.example/api/transcribe/jobs', 'https://bridge.example/api/transcribe']);
});

test('process: "Summarise again with" sends the model; without one, no model key (the pick on the server)', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ title: 'T', sections: [], blocks: [], actions: [] }));
  };
  const input = { segments: [{ speaker: null, text: 'Hi', start_ms: 0, end_ms: 1000 }], template: 'general', language: 'en', today: '2026-10-17' };
  await fastEngine().process({ ...input, model: 'gemini-3.5-flash-lite' });
  await fastEngine().process(input);
  assert.equal(bodies[0].model, 'gemini-3.5-flash-lite');
  assert.ok(!('model' in bodies[1]));
});
