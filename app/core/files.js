// Files and uploads (spec §09). Audio is evidence:
// - Bytes live in object storage (IndexedDB blobs now, a private Storage
//   bucket later), never inside a table row.
// - The metadata row (audio_files) is a write surface with the full set of
//   protections. Bytes and the record about them are two different things.
// - Immutable once stored: a correction is a new file that supersedes the
//   old one, and the old one stays.
// - Type and size checks here are a courtesy to the user. The server
//   (Storage policy / edge function) is the control.

import { db } from './db.js';
import { newId } from './ids.js';

export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)/;

export async function saveAudio(blob, { recordingId, durationMs, supersedes = null }) {
  if (!AUDIO_TYPES.test(blob.type || '')) throw new Error(`Unsupported audio type: ${blob.type || 'unknown'}`);
  if (blob.size > MAX_AUDIO_BYTES) throw new Error('Recording is too large to store');
  const id = newId();
  await db.putBlob(id, blob);
  const res = await db.put('audio_files', {
    id,
    recording_id: recordingId,
    mime: blob.type,
    bytes: blob.size,
    duration_ms: durationMs ?? null,
    supersedes,
    storage: 'device',
  });
  return res.row;
}

// Audio that came down from the account has its record but not its bytes:
// those come on demand (core/cloud-sync.js registers how), then stay here.
// { available(), fetch(id), forget(ids): delete these from the account too (S44) }
let remote = null;
export function setRemoteAudio(source) { remote = source; }

// Only what is on this device: opening a recording never downloads.
export async function audioUrl(fileId) {
  const blob = await db.getBlob(fileId);
  return blob ? URL.createObjectURL(blob) : null;
}

// Can this audio be fetched from the account? (Not here, not freed on purpose.)
export async function audioInAccount(fileId) {
  if (!remote?.available() || await db.getBlob(fileId)) return false;
  const file = await db.get('audio_files', fileId);
  return Boolean(file) && file.storage !== 'removed';
}

// The bytes, from the account when they aren't here. → Blob or null.
export async function audioBlob(fileId) {
  const here = await db.getBlob(fileId);
  if (here || !(await audioInAccount(fileId))) return here;
  return remote.fetch(fileId);
}

export async function audioFilesFor(recordingId) {
  return db.list('audio_files', (f) => f.recording_id === recordingId);
}

// The metadata row goes; the bytes stay, so a restore from the activity log
// brings the audio back with it.
export async function forgetAudio(fileId, { intent, batch }) {
  return db.remove('audio_files', fileId, { intent, batch });
}

export async function listAudioFiles() {
  return db.list('audio_files');
}

// Joining notes: the file now belongs to another recording. The bytes don't move.
export async function moveAudio(file, recordingId, { reason, batch } = {}) {
  return db.put('audio_files', { id: file.id, recording_id: recordingId }, { expected: file.updated_at, reason, batch });
}

// Freeing space: the bytes go for good, the record stays (marked removed) so
// the recording can say why it has no audio. Bytes are dropped only after the
// record says so.
export async function removeAudioBytes(file, { reason, batch } = {}) {
  const res = await db.put('audio_files', {
    id: file.id, storage: 'removed', removed_at: new Date().toISOString(),
  }, { expected: file.updated_at, reason, batch });
  if (res.ok) await db.dropBlob(file.id, { intent: 'removed audio to free space' });
  return res;
}

// S44 "Keep the recording?": the bytes go here AND in the account (cloud-sync queues the
// account's delete), unlike freeing space, which leaves the account its copy.
export async function removeAudioEverywhere(file, { reason, batch } = {}) {
  const res = await removeAudioBytes(file, { reason, batch });
  if (res.ok) remote?.forget?.([file.id]);
  return res;
}

// Bytes no record points at: the audio of deleted recordings.
export async function unreferencedAudio() {
  const [blobs, files] = await Promise.all([db.listBlobs(), db.list('audio_files')]);
  const known = new Set(files.map((f) => f.id));
  return blobs.filter((b) => !known.has(b.id));
}

// Re-checked at the moment of deleting: a restore may have claimed some back.
// everywhere (S44): the account's copies go too, so nothing is kept for a restore.
export async function dropUnreferencedAudio({ everywhere = false } = {}) {
  const gone = await unreferencedAudio();
  for (const b of gone) await db.dropBlob(b.id, { intent: 'freed the audio of deleted recordings' });
  if (everywhere) remote?.forget?.(gone.map((b) => b.id));
  return { count: gone.length, bytes: gone.reduce((n, b) => n + b.bytes, 0) };
}
