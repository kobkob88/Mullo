import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seg } from './helpers.mjs';
import { createRecording, getRecording, updateRecording, listRecordings, deleteRecording } from '../app/domain/recordings.js';
import { saveTranscript, transcriptFor } from '../app/domain/transcripts.js';
import { addAction, actionsFor } from '../app/domain/actions.js';
import { saveAudio, audioFilesFor, audioBlob, unreferencedAudio } from '../app/core/files.js';
import { useRemoteEngine } from '../app/domain/pipeline.js';
import { canJoin, joinedSegments, joinRecordings } from '../app/domain/join.js';
import { loadStorage, removeRecordingAudio, removeOldAudio, freeDeletedAudio, formatBytes } from '../app/domain/storage.js';
import { listActivity, restoreDeleted } from '../app/core/audit.js';
import { disk } from '../app/core/disk.js';

beforeEach(() => { disk.remove('echo:settings'); freshDb(); useRemoteEngine(null); });

const at = (hms, day = '2026-10-06') => `${day}T${hms}.000Z`;

async function note(when, ms, text, { bytes = 1000, transcript = true, status = 'ready' } = {}) {
  const rec = await createRecording({ title: text.slice(0, 24), source: 'watch', recorded_at: when, duration_ms: ms, status });
  const file = await saveAudio(new Blob(['x'.repeat(bytes)], { type: 'audio/mp4' }), { recordingId: rec.id, durationMs: ms });
  await updateRecording(rec.id, { audio_file_id: file.id });
  if (transcript) await saveTranscript(rec.id, [seg(text, 0, ms)], { language: 'he' });
  return getRecording(rec.id);
}

// ── Joining ─────────────────────────────────────────────────────────────
test('only finished notes can be joined', () => {
  assert.equal(canJoin({ status: 'ready', recorded_at: '2026-10-06T08:13:00.000Z' }), true);
  assert.equal(canJoin({ status: 'transcribing', recorded_at: '2026-10-06T08:13:00.000Z' }), false);
});

test('lines move onto one clock; a line without times is stamped where its note began', () => {
  const out = joinedSegments([
    { rec: { recorded_at: at('10:00:00') }, segments: [seg('one', 0, 2000), seg('two', 2000, 4000)] },
    { rec: { recorded_at: at('10:01:30') }, segments: [{ text: 'three', start_ms: null, end_ms: null }, { text: 'four' }] },
  ]);
  assert.deepEqual(out.map((s) => [s.text, s.start_ms, s.end_ms]), [
    ['one', 0, 2000], ['two', 2000, 4000], ['three', 90_000, null], ['four', null, null],
  ]);
});

test('joining makes one note: every line, every audio piece, the tasks a person touched', async () => {
  const a = await note(at('10:00:00'), 10_000, 'צריך לבנות אינטגרציה עם הלוח שנה');
  const b = await note(at('10:01:00'), 20_000, 'וגם עם גוגל טאסקס');
  const c = await note(at('10:03:00'), 5000, 'וחיבור MCP');
  await addAction(b.id, { label: 'Call Dana', status: 'done' }, { reason: 'test' });
  await addAction(c.id, { label: 'engine guess', origin: 'extracted' }, { reason: 'test' });

  const res = await joinRecordings([c.id, a.id, b.id]);
  assert.equal(res.ok, true);
  assert.equal(res.id, a.id, 'the earliest note becomes the joined one');

  const recs = await listRecordings();
  assert.deepEqual(recs.map((r) => r.id), [a.id]);
  const joined = recs[0];
  assert.equal(joined.joined_count, 3);
  assert.equal(joined.duration_ms, 35_000);
  assert.equal(joined.span_ms, 185_000);
  assert.deepEqual(joined.parts.map((p) => p.offset_ms), [0, 60_000, 180_000]);
  for (const p of joined.parts) assert.ok(await audioBlob(p.audio_file_id), 'every piece still plays');
  assert.equal((await audioFilesFor(a.id)).length, 3);

  const t = await transcriptFor(a.id);
  assert.deepEqual(t.segments.map((s) => s.start_ms), [0, 60_000, 180_000]);
  assert.equal(t.origin, 'joined');

  const labels = (await actionsFor(a.id)).map((x) => x.label);
  assert.ok(labels.includes('Call Dana'), 'a ticked task follows its note');
  assert.ok(!labels.includes('engine guess'), 'an untouched engine guess is made again from the whole');
  assert.ok(joined.summary, 'summarised as one');
});

test('the joined-away notes come back together from Activity', async () => {
  const a = await note(at('10:00:00'), 10_000, 'first');
  const b = await note(at('10:01:00'), 10_000, 'second');
  const c = await note(at('10:02:00'), 10_000, 'third');
  await joinRecordings([a.id, b.id, c.id]);
  const entry = (await listActivity()).find((e) => e.action === 'delete' && e.table === 'recordings');
  await restoreDeleted(entry.id);
  assert.deepEqual((await listRecordings()).map((r) => r.id).sort(), [a.id, b.id, c.id].sort());
  assert.ok(await audioBlob((await getRecording(b.id)).audio_file_id), 'still plays after the restore');
});

test('joining refuses notes that are not finished or no longer there', async () => {
  const a = await note(at('10:00:00'), 10_000, 'first');
  const b = await note(at('10:01:00'), 10_000, 'second', { status: 'processing' });
  assert.equal((await joinRecordings([a.id, b.id])).ok, false);
  assert.equal((await joinRecordings([a.id, 'gone'])).ok, false);
  assert.equal((await listRecordings()).length, 2, 'nothing changed');
});

// ── Storage ─────────────────────────────────────────────────────────────
test('the report: audio per recording, biggest first, and what only deleted recordings hold', async () => {
  const small = await note(at('10:00:00'), 5000, 'small', { bytes: 2000 });
  const big = await note(at('11:00:00'), 5000, 'big', { bytes: 9000 });
  const raw = await note(at('12:00:00'), 5000, 'not yet', { bytes: 500, transcript: false, status: 'transcribing' });
  const gone = await note(at('13:00:00'), 5000, 'deleted', { bytes: 3000 });
  await deleteRecording(gone, { reason: 'test' });

  const r = await loadStorage();
  assert.deepEqual(r.items.map((i) => i.id), [big.id, small.id, raw.id]);
  assert.equal(r.audio.bytes, 11_500);
  assert.equal(r.items.find((i) => i.id === raw.id).removable, false, 'no transcript yet: keep the audio');
  assert.deepEqual(r.deleted, { count: 1, bytes: 3000 });
});

test('removing a recording\'s audio keeps its words and says why the audio is gone', async () => {
  const rec = await note(at('10:00:00'), 5000, 'keep these words', { bytes: 4000 });
  const res = await removeRecordingAudio(rec.id);
  assert.deepEqual(res, { ok: true, bytes: 4000 });
  assert.equal(await audioBlob(rec.audio_file_id), null);
  assert.equal((await audioFilesFor(rec.id))[0].storage, 'removed');
  assert.equal((await transcriptFor(rec.id)).segments[0].text, 'keep these words');
  assert.equal((await loadStorage()).audio.count, 0);
  assert.ok((await listActivity()).some((e) => e.reason?.startsWith('removed the audio')), 'logged');
});

test('audio is never removed before there is a transcript', async () => {
  const rec = await note(at('10:00:00'), 5000, '-', { transcript: false, status: 'transcribing' });
  assert.equal((await removeRecordingAudio(rec.id)).ok, false);
  assert.ok(await audioBlob(rec.audio_file_id));
});

test('only audio older than 30 days is in the "old" pile', async () => {
  const old = await note(new Date(Date.now() - 40 * 86_400_000).toISOString(), 5000, 'old', { bytes: 1000 });
  await note(new Date().toISOString(), 5000, 'new', { bytes: 1000 });
  const r = await loadStorage();
  assert.deepEqual(r.old.ids, [old.id]);
  assert.deepEqual(await removeOldAudio(r.old.ids), { count: 1, bytes: 1000 });
});

test('freeing deleted recordings\' audio: a later restore brings the words back, without audio', async () => {
  const keep = await note(at('09:00:00'), 5000, 'kept', { bytes: 1000 });
  const gone = await note(at('10:00:00'), 5000, 'deleted', { bytes: 3000 });
  await deleteRecording(gone, { reason: 'test' });
  assert.deepEqual(await freeDeletedAudio(), { count: 1, bytes: 3000 });
  assert.deepEqual(await unreferencedAudio(), []);
  assert.ok(await audioBlob(keep.audio_file_id), 'audio of kept recordings is untouched');

  const entry = (await listActivity()).find((e) => e.action === 'delete' && e.table === 'recordings');
  await restoreDeleted(entry.id);
  const back = await getRecording(gone.id);
  assert.equal((await transcriptFor(back.id)).segments[0].text, 'deleted');
  assert.equal(await audioBlob(back.audio_file_id), null);
});

test('sizes read like a person would say them', () => {
  assert.equal(formatBytes(300), '1 KB');
  assert.equal(formatBytes(180 * 1024), '180 KB');
  assert.equal(formatBytes(5.25 * 1024 * 1024), '5.3 MB');
});

// ── Deleting several ────────────────────────────────────────────────────
test('deleting several from the Library: one batch, one restore brings them all back', async () => {
  const { deleteRecordings } = await import('../app/domain/recordings.js');
  const a = await note(at('10:00:00'), 5000, 'one');
  const b = await note(at('10:05:00'), 5000, 'two', { status: 'transcribing', transcript: false });
  const keep = await note(at('11:00:00'), 5000, 'keep');
  assert.deepEqual(await deleteRecordings([a.id, b.id, 'gone']), { deleted: 2, failed: 0 });
  assert.deepEqual((await listRecordings()).map((r) => r.id), [keep.id]);
  const entry = (await listActivity()).find((e) => e.action === 'delete' && e.table === 'recordings');
  await restoreDeleted(entry.id);
  assert.deepEqual((await listRecordings()).map((r) => r.id).sort(), [a.id, b.id, keep.id].sort());
  assert.equal((await transcriptFor(a.id)).segments[0].text, 'one', 'with their transcripts');
});
