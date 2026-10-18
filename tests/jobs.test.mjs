import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAndSummarise, retranscribeInBackground, resumePending, runInBackground, isRunning, activeJobs } from '../app/domain/jobs.js';
import { useRemoteEngine } from '../app/domain/pipeline.js';
import { createRecording, getRecording, updateRecording } from '../app/domain/recordings.js';
import { saveTranscript, transcriptFor } from '../app/domain/transcripts.js';
import { saveAudio } from '../app/core/files.js';
import { on } from '../app/core/bus.js';
import { disk } from '../app/core/disk.js';
import { freshDb } from './helpers.mjs';

const engine = ({ fail = false, segments = [{ text: 'Remind me to call Ana.' }] } = {}) => ({
  id: 'remote',
  calls: 0,
  async transcribe() { this.calls += 1; if (fail) throw new Error('bridge down'); return { segments, engine: 'gemini' }; },
  async process() { throw new Error('offline engine for this test'); },
});

async function saved({ status = 'transcribing', live = [] } = {}) {
  const rec = await createRecording({ title: 'Voice note', language: 'he', duration_ms: 4000, status });
  const file = await saveAudio(new Blob(['a'], { type: 'audio/webm' }), { recordingId: rec.id });
  await updateRecording(rec.id, { audio_file_id: file.id });
  await saveTranscript(rec.id, live);
  return rec.id;
}

beforeEach(() => { disk.remove('echo:settings'); freshDb(); useRemoteEngine(null); });

test('after Stop: Gemini transcript replaces the preview, then it is summarised and ready', async () => {
  useRemoteEngine(engine());
  const id = await saved({ live: [{ text: 'garbled preview' }] });
  const res = await transcribeAndSummarise(id, { language: 'he' });
  assert.equal(res.ok, true);
  assert.equal((await transcriptFor(id)).segments[0].text, 'Remind me to call Ana.');
  assert.equal((await getRecording(id)).status, 'ready');
});

test('Gemini unreachable: the live preview is summarised instead, and the result says why', async () => {
  useRemoteEngine(engine({ fail: true }));
  const id = await saved({ live: [{ text: 'Remind me to pay rent.' }] });
  const res = await transcribeAndSummarise(id, { language: 'he' });
  assert.equal(res.ok, true);
  assert.match(res.transcribeError, /bridge down/);
  assert.equal((await transcriptFor(id)).segments[0].text, 'Remind me to pay rent.');
  assert.equal((await getRecording(id)).status, 'ready');
});

test('one job per recording; a second request joins the first', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = runInBackground('x', () => gate.then(() => ({ ok: true })));
  const b = runInBackground('x', () => assert.fail('must not start twice'));
  assert.equal(a, b);
  assert.ok(isRunning('x'));
  assert.equal(activeJobs(), 1);
  release();
  await a;
  assert.ok(!isRunning('x'));
});

test('job-done is announced with the result', async () => {
  const seen = [];
  const off = on('job-done', (e) => seen.push(e));
  await runInBackground('y', async () => ({ ok: true, segments: 2 }));
  off();
  assert.deepEqual(seen, [{ recordingId: 'y', ok: true, segments: 2 }]);
});

test('a throwing job is reported, not lost', async () => {
  const res = await runInBackground('z', async () => { throw new Error('boom'); });
  assert.deepEqual(res, { ok: false, error: 'boom' });
});

test('re-transcribe in the background: failure puts the old status back and keeps the transcript', async () => {
  useRemoteEngine(engine({ segments: [] }));
  const id = await saved({ status: 'ready', live: [{ text: 'keep me' }] });
  const res = await retranscribeInBackground(id, { language: 'he' });
  assert.equal(res.ok, false);
  assert.equal((await getRecording(id)).status, 'ready');
  assert.equal((await transcriptFor(id)).segments[0].text, 'keep me');
});

test('re-transcribe: the chosen language shows while it runs, and comes back on failure', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  useRemoteEngine({ id: 'remote', async transcribe() { await gate; return { segments: [] }; } });
  const id = await saved({ status: 'ready', live: [{ text: 'keep me' }] });
  const job = retranscribeInBackground(id, { language: 'en' });
  while ((await getRecording(id)).status !== 'transcribing') await new Promise((r) => setTimeout(r, 1));
  assert.equal((await getRecording(id)).language, 'en', 'the picker re-renders from this while it runs');
  release();
  assert.equal((await job).ok, false);
  assert.equal((await getRecording(id)).language, 'he');
});

test('re-transcribe: a dropped connection stays on the recording until a try works', async () => {
  useRemoteEngine({ id: 'remote', async transcribe() { throw Object.assign(new Error('The connection dropped'), { offline: true }); } });
  const id = await saved({ status: 'ready', live: [{ text: 'keep me' }] });
  const res = await retranscribeInBackground(id, { language: 'en' });
  assert.equal(res.offline, true);
  const kept = (await getRecording(id)).transcribe_error;
  assert.equal(kept.offline, true);
  assert.equal(kept.message, 'The connection dropped');

  useRemoteEngine(engine());
  await retranscribeInBackground(id, { language: 'en' });
  assert.equal((await getRecording(id)).transcribe_error, null);
});

test('after Stop: a dropped connection is kept on the recording and reported as one', async () => {
  useRemoteEngine({ id: 'remote', async transcribe() { throw Object.assign(new Error('The connection dropped'), { offline: true }); }, async process() { throw new Error('offline'); } });
  const id = await saved({ live: [{ text: 'Remind me to pay rent.' }] });
  const res = await transcribeAndSummarise(id, { language: 'he' });
  assert.equal(res.offline, true);
  assert.equal((await getRecording(id)).transcribe_error.offline, true);
});

test('send now, collect later: the job id stays on the recording through a lost signal, and is collected next time', async () => {
  const seen = [];
  useRemoteEngine({
    id: 'remote',
    async transcribe(_blob, { job }) {
      seen.push(job.resume);
      if (job.resume) return { segments: [{ text: 'collected' }], engine: 'gemini' };
      await job.started('job-1');
      throw Object.assign(new Error('still working'), { offline: true, pending: true });
    },
    async process() { throw new Error('offline engine for this test'); },
  });
  const id = await saved({ status: 'ready', live: [{ text: 'keep me' }] });
  const first = await retranscribeInBackground(id, { language: 'en' });
  assert.equal(first.ok, false);
  assert.equal((await getRecording(id)).transcribe_job.id, 'job-1');

  await retranscribeInBackground(id, { language: 'en' });
  assert.deepEqual(seen, [null, 'job-1'], 'the second try collects instead of sending again');
  assert.equal((await transcriptFor(id)).segments[0].text, 'collected');
  assert.equal((await getRecording(id)).transcribe_job, null);
  assert.equal((await getRecording(id)).transcribe_error, null);
});

test('send now, collect later: another language is a new job; a failed job is dropped', async () => {
  const seen = [];
  useRemoteEngine({
    id: 'remote',
    async transcribe(_blob, { job }) { seen.push(job.resume); await job.started('job-2'); throw new Error('Gemini 503: overloaded'); },
    async process() { throw new Error('offline engine for this test'); },
  });
  const id = await saved({ status: 'ready' });
  await updateRecording(id, { transcribe_job: { id: 'job-he', language: 'he', target: null } });
  await retranscribeInBackground(id, { language: 'en' });
  assert.deepEqual(seen, [null], 'the Hebrew job is not collected for an English try');
  assert.equal((await getRecording(id)).transcribe_job, null, 'a failed job is not kept');
});

test('on start: a transcript left waiting on the server is collected', async () => {
  let resumed = null;
  useRemoteEngine({ id: 'remote', async transcribe(_b, { job }) { resumed = job.resume; return { segments: [{ text: 'x' }] }; }, async process() { throw new Error('offline'); } });
  const id = await saved({ status: 'ready' });
  await updateRecording(id, { transcribe_job: { id: 'job-3', language: 'he', target: null } });
  assert.equal(await resumePending(), 1);
  while (activeJobs()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(resumed, 'job-3');
});

test('re-transcribe: a success keeps the chosen language', async () => {
  useRemoteEngine(engine());
  const id = await saved({ status: 'ready' });
  await retranscribeInBackground(id, { language: 'en' });
  assert.equal((await getRecording(id)).language, 'en');
});

test('on start: recordings left mid-way are finished', async () => {
  const e = engine();
  useRemoteEngine(e);
  const waiting = await saved({ status: 'transcribing' });
  const done = await saved({ status: 'ready', live: [{ text: 'x' }] });
  const typed = await createRecording({ title: 'typed', status: 'processing' });
  await saveTranscript(typed.id, [{ text: 'Remind me to call Dana.' }]);
  assert.equal(await resumePending(), 2);
  while (activeJobs()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(e.calls, 1, 'only the one still transcribing goes to Gemini');
  assert.equal((await getRecording(waiting)).status, 'ready');
  assert.equal((await getRecording(typed.id)).status, 'ready');
  assert.equal((await getRecording(done)).status, 'ready');
});
