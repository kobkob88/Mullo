// The capture → transcript → summary → actions loop through the funnels,
// delete-as-one-batch and restore, labels, search, permissions.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecording, getRecording, deleteRecording, renameRecording } from '../app/domain/recordings.js';
import { saveTranscript, transcriptFor, segmentsFromText } from '../app/domain/transcripts.js';
import { actionsFor, setActionStatus, addAction } from '../app/domain/actions.js';
import { processRecording } from '../app/domain/pipeline.js';
import { createFolder, renameFolder } from '../app/domain/folders.js';
import { search, normalize } from '../app/domain/search.js';
import { listActivity, restoreDeleted } from '../app/core/audit.js';
import { labelCollision } from '../app/core/ids.js';
import { setSession, canReach, canWrite, canSeePrivate, landingScreen, roleRemovalCheck } from '../app/core/auth.js';
import { freshDb } from './helpers.mjs';

beforeEach(() => { freshDb(); });

async function recordingWith(text) {
  const rec = await createRecording({ title: 'Voice note', source: 'device', template: 'voice_note' });
  await saveTranscript(rec.id, segmentsFromText(text));
  await processRecording(rec.id);
  return getRecording(rec.id);
}

test('pipeline: transcript → title, sections, summary, actions', async () => {
  const rec = await recordingWith('Call with the warehouse about pallets.\nRemind me to email Dana the quote.');
  assert.equal(rec.status, 'ready');
  assert.equal(rec.title, 'Call with the warehouse about', 'a short gist: at most 5 words');
  assert.ok(rec.sections.length >= 1);
  assert.deepEqual(rec.summary.blocks.map((b) => b.heading), ['Note', 'To do']);
  assert.deepEqual((await actionsFor(rec.id)).map((a) => [a.label, a.type]), [['Email Dana the quote', 'draft_email']]);
});

test('no transcript → needs_transcript, nothing invented', async () => {
  const rec = await createRecording({ title: 'Silent' });
  const res = await processRecording(rec.id);
  assert.equal(res.status, 'needs_transcript');
  assert.equal((await getRecording(rec.id)).summary, null);
});

test('re-processing keeps what a person touched', async () => {
  const rec = await recordingWith('Remind me to call Ana. Remind me to pay rent.');
  const [first] = await actionsFor(rec.id);
  await setActionStatus(first, 'done');
  await addAction(rec.id, { label: 'My own task' });
  await processRecording(rec.id, { template: 'meeting' });
  const labels = (await actionsFor(rec.id)).map((a) => `${a.label}:${a.status}`).sort();
  assert.deepEqual(labels, ['Call Ana:done', 'My own task:open', 'Pay rent:open']);
});

test('a rename writes exactly one row and survives re-processing', async () => {
  const rec = await recordingWith('Something said. Remind me to call Ana.');
  const before = (await listActivity()).length;
  await renameRecording(rec, 'Mine');
  const after = await listActivity();
  assert.equal(after.length - before, 1);
  assert.equal(after[0].table, 'recordings');
  await processRecording(rec.id);
  assert.equal((await getRecording(rec.id)).title, 'Mine');
});

test('deleting a recording takes its children as one batch; one restore brings all back', async () => {
  const rec = await recordingWith('Remind me to call Ana.');
  await deleteRecording(rec, { reason: 'test' });
  assert.equal(await getRecording(rec.id), null);
  assert.equal(await transcriptFor(rec.id), null);
  assert.equal((await actionsFor(rec.id)).length, 0);

  const del = (await listActivity()).find((e) => e.action === 'delete' && e.table === 'recordings');
  const restored = await restoreDeleted(del.id);
  assert.equal(restored, 3, 'recording + transcript + action');
  assert.equal((await getRecording(rec.id)).title, rec.title);
  assert.equal((await transcriptFor(rec.id)).segments.length, 1);
  assert.equal((await actionsFor(rec.id)).length, 1);
});

test('a stale delete is refused', async () => {
  const rec = await recordingWith('Hello.');
  await renameRecording(rec, 'Changed elsewhere');
  const res = await deleteRecording(rec);
  assert.equal(res.ok, false);
  assert.ok(await getRecording(rec.id));
});

test('folder labels: unique, trimmed, case-insensitive; never equal to a key', async () => {
  const a = await createFolder('Work');
  assert.equal((await createFolder('  work ')).error, 'Another folder already has that name');
  assert.equal((await createFolder('')).error, 'A folder needs a name');
  assert.equal(labelCollision(a.row.id.toUpperCase(), [a.row]), 'key');
  assert.equal((await renameFolder(a.row, 'WORK')).ok, true, 'renaming to itself in another case is fine');
});

test('search: Hebrew without niqqud, ranked by where it matched', () => {
  const recordings = [
    { id: 'a', title: 'פגישה עם דניאל', recorded_at: '2026-10-01', summary: null, sections: [] },
    { id: 'b', title: 'Groceries', recorded_at: '2026-10-02', summary: null, sections: [] },
  ];
  const transcripts = [{ recording_id: 'b', segments: [{ text: 'and then Daniel called' }] }];
  const hits = search('דָּנִיֵּאל', { recordings, transcripts, actions: [] });
  assert.deepEqual(hits.map((h) => h.recordingId), ['a']);
  assert.equal(search('daniel', { recordings, transcripts, actions: [] })[0].matches[0].kind, 'transcript');
  assert.equal(normalize('Hello, World!'), 'hello world');
});

test('permissions: three lists, fail closed', () => {
  setSession({ userId: 'u', roles: ['assistant'] });
  assert.ok(canReach('actions'));
  assert.ok(!canReach('activity'));
  assert.ok(canWrite('action_items'));
  assert.ok(!canWrite('recordings'));
  assert.ok(!canSeePrivate('recording'));
  setSession({ userId: 'u', roles: ['made-up'] });
  assert.ok(!canReach('library'));
  assert.equal(landingScreen(), null);
  setSession({ userId: 'u', roles: ['viewer'] });
  assert.equal(landingScreen(), 'library');
});

test('anti-lockout: the last owner cannot drop their own role without confirming', () => {
  const base = { actorId: 'me', targetId: 'me', targetRoles: ['owner'], role: 'owner', ownersLeft: 1 };
  assert.equal(roleRemovalCheck(base).needs, 'confirm');
  assert.equal(roleRemovalCheck({ ...base, confirmed: true }).allowed, true);
  assert.equal(roleRemovalCheck({ ...base, actorId: 'other' }).allowed, false);
  assert.equal(roleRemovalCheck({ ...base, ownersLeft: 2 }).allowed, true);
});

test('typed text becomes segments with optional speakers', () => {
  assert.deepEqual(segmentsFromText('Dana: hi\n\nplain line').map((s) => [s.speaker, s.text]), [['Dana', 'hi'], [null, 'plain line']]);
});
