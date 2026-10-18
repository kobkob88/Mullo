import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { speechInSamples, checkSpeech, WATCH_EDGES } from '../app/capture/silence.js';
import { transcribeAndSummarise, retranscribeInBackground } from '../app/domain/jobs.js';
import { useRemoteEngine, useSpeechCheck } from '../app/domain/pipeline.js';
import { createRecording, getRecording, updateRecording } from '../app/domain/recordings.js';
import { saveTranscript, transcriptFor } from '../app/domain/transcripts.js';
import { saveAudio } from '../app/core/files.js';
import { disk } from '../app/core/disk.js';
import { freshDb } from './helpers.mjs';

const RATE = 8000;
const fromDb = (d) => 10 ** (d / 20);

// Seconds of noise at a level, with optional louder stretches [from, to, dB].
function audio(seconds, floorDb, bursts = [], seed = 1) {
  let x = seed;
  const rand = () => { x = (x * 16807) % 2147483647; return (x / 2147483647) * 2 - 1; };
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    const burst = bursts.find(([a, b]) => t >= a && t < b);
    out[i] = rand() * fromDb(burst ? burst[2] : floorDb) * Math.SQRT2;
  }
  return out;
}

test('digital silence and a quiet room are not speech', () => {
  assert.equal(speechInSamples(new Float32Array(RATE * 5), RATE).speech, false);
  assert.equal(speechInSamples(audio(8, -62), RATE).speech, false);
});

test('a short click or a cough-length bump is not speech', () => {
  assert.equal(speechInSamples(audio(6, -60, [[2, 2.2, -30]]), RATE).speech, false);
});

test('normal talking and a whisper close to the mic are speech', () => {
  const talk = speechInSamples(audio(6, -60, [[1, 3.5, -25]]), RATE);
  assert.equal(talk.speech, true);
  assert.ok(talk.speechMs >= 2000);
  assert.equal(speechInSamples(audio(6, -66, [[1, 2.5, -48]]), RATE).speech, true, 'a whisper ~18 dB over a quiet room');
});

test('a loud steady room (fan, traffic) is not speech by itself', () => {
  assert.equal(speechInSamples(audio(8, -35), RATE).speech, false);
});

// 2026-10-14: a 1.9 s accidental watch note (start buzz + the Stop tap) passed as
// speech and Gemini wrote a to-do nobody said.
test('a watch note\'s start buzz and Stop tap are not speech', () => {
  const tap = audio(1.9, -60, [[0, 0.35, -25], [1.65, 1.9, -25]]);
  assert.equal(speechInSamples(tap, RATE).speech, true, 'counted whole, the edges add up to 0.6 s');
  const res = speechInSamples(tap, RATE, WATCH_EDGES);
  assert.equal(res.speech, false);
  assert.equal(res.ranges.length, 2, 'the map still says where the sounds were');
});

test('on a watch note, words straight after the buzz still count', () => {
  const quick = speechInSamples(audio(2.5, -60, [[0, 1.6, -25]]), RATE, WATCH_EDGES);
  assert.equal(quick.speech, true);
  assert.ok(quick.speechMs >= 1000);
});

test('when it can\'t check, it counts as speech (never drops words on a doubt)', async () => {
  assert.deepEqual(await checkSpeech(new Blob(['x']), { durationMs: 10 * 60_000 }), { speech: true, checked: false });
  assert.equal((await checkSpeech(new Blob(['not audio']))).speech, true);
});

// ── In the pipeline ─────────────────────────────────────────────────────
const engine = () => ({
  id: 'remote', calls: 0,
  async transcribe() { this.calls += 1; return { segments: [{ text: 'invented words' }], engine: 'gemini' }; },
  async process() { return { sections: [], actions: [], summary: null, title: 'x' }; },
});

async function saved(live = []) {
  const rec = await createRecording({ title: 'Watch', language: 'he', duration_ms: 4000, status: 'transcribing', source: 'watch' });
  const file = await saveAudio(new Blob(['a'], { type: 'audio/mp4' }), { recordingId: rec.id });
  await updateRecording(rec.id, { audio_file_id: file.id });
  await saveTranscript(rec.id, live);
  return rec.id;
}

beforeEach(() => { disk.remove('echo:settings'); freshDb(); useRemoteEngine(null); useSpeechCheck(null); });

test('a silent recording is never sent to the AI, and says so', async () => {
  const e = engine();
  useRemoteEngine(e);
  useSpeechCheck(async () => ({ speech: false, checked: true, speechMs: 0, floorDb: -70, peakDb: -60 }));
  const id = await saved();
  const res = await transcribeAndSummarise(id, { language: 'he' });
  assert.equal(res.silent, true);
  assert.equal(e.calls, 0);
  const rec = await getRecording(id);
  assert.equal(rec.no_speech, true);
  assert.equal(rec.title, 'No speech heard');
  assert.equal(rec.status, 'needs_transcript');
  assert.equal(rec.audio_check.peakDb, -60, 'levels kept, to tune the check on real recordings');
});

test('Re-transcribe sends anyway, and a real transcript clears the flag', async () => {
  const e = engine();
  useRemoteEngine(e);
  useSpeechCheck(async () => ({ speech: false, checked: true }));
  const id = await saved();
  await transcribeAndSummarise(id, { language: 'he' });
  await retranscribeInBackground(id, { language: 'he' });
  assert.equal(e.calls, 1);
  assert.equal((await transcriptFor(id)).segments[0].text, 'invented words');
  assert.equal((await getRecording(id)).no_speech, false);
});

test('if the phone\'s live preview heard words, those are summarised as before', async () => {
  useRemoteEngine(engine());
  useSpeechCheck(async () => ({ speech: false, checked: true }));
  const id = await saved([{ text: 'Remind me to pay rent.' }]);
  await transcribeAndSummarise(id, { language: 'he' });
  const rec = await getRecording(id);
  assert.notEqual(rec.no_speech, true);
  assert.equal((await transcriptFor(id)).segments[0].text, 'Remind me to pay rent.');
});

// ── The speech map ──────────────────────────────────────────────────────
test('the speech map marks where sound was, joining sounds under a second apart', () => {
  const res = speechInSamples(audio(30, -60, [[1, 2, -25], [2.5, 4, -25], [20, 21, -25]]), RATE);
  assert.equal(res.audioMs, 30_000);
  assert.equal(res.ranges.length, 2, 'the 0.5 s pause is one stretch; the 16 s gap is not');
  const [[a0, a1], [b0, b1]] = res.ranges;
  assert.ok(Math.abs(a0 - 1000) <= 50 && Math.abs(a1 - 4000) <= 50, `first stretch ${a0}-${a1}`);
  assert.ok(Math.abs(b0 - 20_000) <= 50 && Math.abs(b1 - 21_000) <= 50, `second stretch ${b0}-${b1}`);
  assert.deepEqual(speechInSamples(new Float32Array(RATE * 5), RATE).ranges, []);
});

test('the map travels with the audio, and is not stored with the levels', async () => {
  const seen = [];
  useRemoteEngine({ ...engine(), async transcribe(_blob, opts) { seen.push(opts); return { segments: [{ text: 'hi' }], engine: 'gemini' }; } });
  const asked = [];
  useSpeechCheck(async (_blob, opts) => { asked.push(opts); return { speech: true, checked: true, speechMs: 900, audioMs: 4000, ranges: [[500, 1400]] }; });
  const id = await saved();
  await transcribeAndSummarise(id, { language: 'he' });
  assert.deepEqual(seen[0].speech, { ranges: [[500, 1400]], duration_ms: 4000 });
  assert.deepEqual(asked, [{ durationMs: 4000, watch: true }], 'a watch note is checked as one');
  const rec = await getRecording(id);
  assert.equal(rec.audio_check.speechMs, 900);
  assert.equal('ranges' in rec.audio_check, false);
});
