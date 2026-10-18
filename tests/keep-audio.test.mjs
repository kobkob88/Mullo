// S44 "Keep the recording?": the audio goes once the notes are made (or 7 / 30 days after the
// recording), here and in the account; the words, summary and tasks stay.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seg } from './helpers.mjs';
import { createRecording, getRecording, updateRecording, deleteRecording } from '../app/domain/recordings.js';
import { saveTranscript, transcriptFor } from '../app/domain/transcripts.js';
import { saveAudio, audioFilesFor, audioBlob, unreferencedAudio, setRemoteAudio } from '../app/core/files.js';
import { useRemoteEngine } from '../app/domain/pipeline.js';
import { audioToExpire, expireAudio, loadKeepReport } from '../app/domain/storage.js';
import { updateSettings } from '../app/core/settings.js';
import { disk } from '../app/core/disk.js';

let forgotten;
beforeEach(() => {
  disk.remove('echo:settings');
  freshDb();
  useRemoteEngine(null);
  forgotten = [];
  setRemoteAudio({ available: () => false, fetch: async () => null, forget: (ids) => forgotten.push(...ids) });
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

async function note(text, { days = 0, status = 'ready', origin = 'gemini', transcript = true, extra = {} } = {}) {
  const rec = await createRecording({ title: text, recorded_at: daysAgo(days), duration_ms: 4000, status });
  const file = await saveAudio(new Blob(['x'.repeat(500)], { type: 'audio/mp4' }), { recordingId: rec.id, durationMs: 4000 });
  await updateRecording(rec.id, { audio_file_id: file.id, ...extra });
  if (transcript) await saveTranscript(rec.id, [seg(text, 0, 4000)], { language: 'en', origin });
  return { rec: await getRecording(rec.id), file };
}

test('the choice decides: keep = never; notes = once made; 7 / 30 = that many days after recording', () => {
  const rec = (id, days, more = {}) => ({ id, status: 'ready', recorded_at: daysAgo(days), ...more });
  const recordings = [rec('new', 1), rec('week', 8), rec('month', 31)];
  const files = recordings.map((r) => ({ id: `f-${r.id}`, recording_id: r.id, storage: 'device', bytes: 10 }));
  const made = new Set(recordings.map((r) => r.id));
  const pick = (choice) => audioToExpire({ recordings, files, made, choice, now: NOW }).map((x) => x.id).sort();
  assert.deepEqual(pick('keep'), []);
  assert.deepEqual(pick('notes'), ['month', 'new', 'week']);
  assert.deepEqual(pick('7'), ['month', 'week']);
  assert.deepEqual(pick('30'), ['month']);
  assert.deepEqual(pick('forever'), [], 'an unknown choice deletes nothing');
});

test('notes not made yet keep their audio: still working, no transcript, only the live preview, a failed or waiting job', async () => {
  updateSettings({ keepAudio: 'notes' });
  const kept = [
    await note('working', { status: 'transcribing' }),
    await note('no words', { transcript: false }),
    await note('preview only', { origin: 'device-live' }),
    await note('failed', { extra: { transcribe_error: { message: 'Gemini down' } } }),
    await note('waiting', { extra: { transcribe_job: { id: 'j', language: null, target: null } } }),
  ];
  const res = await expireAudio({ now: NOW });
  assert.equal(res.count, 0);
  for (const { file } of kept) assert.ok(await audioBlob(file.id), 'the audio is still here');
  assert.deepEqual(forgotten, []);
});

test('once the notes are made, the audio goes here and in the account; the words stay', async () => {
  updateSettings({ keepAudio: 'notes' });
  const { rec, file } = await note('Call Ana about the rent');
  const res = await expireAudio({ now: NOW });
  assert.equal(res.count, 1);
  assert.equal(await audioBlob(file.id), null, 'gone from this device');
  assert.equal((await audioFilesFor(rec.id))[0].storage, 'removed', 'the record says why there is no audio');
  assert.deepEqual(forgotten, [file.id], 'the account copy is deleted too');
  assert.equal((await transcriptFor(rec.id)).segments[0].text, 'Call Ana about the rent');
  assert.equal((await expireAudio({ now: NOW })).count, 0, 'a second sweep finds nothing');
});

test('nothing is kept for a restore: a deleted recording\'s audio goes too, here and in the account', async () => {
  updateSettings({ keepAudio: '30' });
  const { rec, file } = await note('Deleted yesterday', { days: 1 });
  await deleteRecording(rec, { reason: 'test: person deleted it' });
  assert.equal((await unreferencedAudio()).length, 1, 'kept for a restore until now');
  await expireAudio({ now: NOW });
  assert.equal((await unreferencedAudio()).length, 0);
  assert.deepEqual(forgotten, [file.id]);
});

test('keep (the default) touches nothing, not even deleted recordings\' audio', async () => {
  const { rec, file } = await note('Old', { days: 400 });
  await note('Also old', { days: 400 });
  await deleteRecording(rec, { reason: 'test' });
  assert.equal((await expireAudio({ now: NOW })).count, 0);
  assert.ok(await audioBlob(file.id));
  assert.deepEqual(forgotten, []);
});

test('the report before switching: how many recordings would lose their audio now', async () => {
  await note('a', { days: 2 });
  await note('b', { days: 10 });
  await note('c', { days: 40 });
  await note('d', { status: 'transcribing' });
  const report = await loadKeepReport({ now: NOW });
  assert.deepEqual({ notes: report.notes, '7': report['7'], '30': report['30'], keep: report.keep }, { notes: 3, '7': 2, '30': 1, keep: 0 });
});
