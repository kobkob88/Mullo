// Storage on this device: what takes the space, and freeing it.
// Everything lives on the phone until Supabase is switched on, and audio is
// nearly all of it. Two ways to free space, both only when a person asks:
// - the audio of deleted recordings (kept so a restore brings it back);
// - the audio of recordings already transcribed (the words stay).

import { db } from '../core/db.js';
import { newId } from '../core/ids.js';
import { listAudioFiles, audioFilesFor, removeAudioBytes, removeAudioEverywhere, unreferencedAudio, dropUnreferencedAudio } from '../core/files.js';
import { getSettings } from '../core/settings.js';
import { getRecording, listRecordings } from './recordings.js';
import { listTranscripts } from './transcripts.js';

export const OLD_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

// Audio may go only once the words are safe: a finished recording with a transcript.
export const canRemoveAudio = (rec, transcribed) => rec.status === 'ready' && transcribed.has(rec.id);

// Pure: rows → what the Storage page shows.
export function storageReport({ recordings, files, transcribed, unreferenced, usage = null, now = Date.now() }) {
  const bytesOf = new Map();
  for (const f of files) {
    if (f.storage === 'removed') continue;
    bytesOf.set(f.recording_id, (bytesOf.get(f.recording_id) ?? 0) + (f.bytes ?? 0));
  }
  const items = recordings
    .filter((r) => bytesOf.has(r.id))
    .map((r) => ({
      id: r.id, title: r.title, recorded_at: r.recorded_at, bytes: bytesOf.get(r.id),
      removable: canRemoveAudio(r, transcribed),
      old: now - Date.parse(r.recorded_at) > OLD_AFTER_DAYS * DAY_MS,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  const old = items.filter((i) => i.removable && i.old);
  const sum = (list) => list.reduce((n, x) => n + x.bytes, 0);
  return {
    usage,
    audio: { count: items.length, bytes: sum(items) },
    items,
    old: { count: old.length, bytes: sum(old), ids: old.map((i) => i.id) },
    deleted: { count: unreferenced.length, bytes: sum(unreferenced) },
  };
}

export async function loadStorage() {
  const [recordings, files, transcripts, unreferenced, estimate] = await Promise.all([
    listRecordings(), listAudioFiles(), listTranscripts(), unreferencedAudio(), db.estimate().catch(() => null),
  ]);
  const transcribed = new Set(transcripts.filter((t) => t.segments?.length).map((t) => t.recording_id));
  return storageReport({ recordings, files, transcribed, unreferenced, usage: estimate?.usage ?? null });
}

// One recording's audio, for good. The transcript, summary and tasks stay.
export async function removeRecordingAudio(recordingId, { batch = newId() } = {}) {
  const rec = await getRecording(recordingId);
  if (!rec) return { ok: false, error: 'That recording is gone.' };
  const transcribed = new Set((await listTranscripts()).filter((t) => t.segments?.length).map((t) => t.recording_id));
  if (!canRemoveAudio(rec, transcribed)) return { ok: false, error: 'Keep the audio until it has a transcript.' };
  let bytes = 0;
  for (const f of await audioFilesFor(rec.id)) {
    if (f.storage === 'removed') continue;
    const res = await removeAudioBytes(f, { reason: 'removed the audio to free space (the words stay)', batch });
    if (res.ok) bytes += f.bytes ?? 0;
  }
  return { ok: true, bytes };
}

export async function removeOldAudio(ids) {
  const batch = newId();
  let bytes = 0;
  let count = 0;
  for (const id of ids) {
    const res = await removeRecordingAudio(id, { batch });
    if (res.ok && res.bytes) { bytes += res.bytes; count += 1; }
  }
  return { count, bytes };
}

export const freeDeletedAudio = () => dropUnreferencedAudio();

// ── S44: Keep the recording? ────────────────────────────────────────────
// Settings keepAudio: 'keep' (default) | 'notes' | '7' | '30'. The audio goes, here AND in the
// account, once the notes are made (or that many days after the recording); the transcript,
// summary and tasks stay. Nothing is kept for a restore either (deleted recordings' audio goes
// too). What's lost, said in Settings: playback, Re-transcribe.
const KEEP_DAYS = { notes: 0, 7: 7, 30: 30 };

// The notes are made: finished, with a real transcript (not only the phone's live preview,
// which Re-transcribe would still want to replace), and no transcription failed or waiting.
const notesMade = (rec, transcript) => rec.status === 'ready' && Boolean(transcript?.segments?.length)
  && transcript.origin !== 'device-live' && !rec.transcribe_job && !rec.transcribe_error;

// Pure: which recordings lose their audio now under `choice`. made: ids with their notes made.
export function audioToExpire({ recordings, files, made, choice, now = Date.now() }) {
  if (!Object.hasOwn(KEEP_DAYS, choice)) return [];
  const withAudio = new Set(files.filter((f) => f.storage !== 'removed').map((f) => f.recording_id));
  const age = KEEP_DAYS[choice] * DAY_MS;
  return recordings.filter((r) => withAudio.has(r.id) && made.has(r.id) && now - Date.parse(r.recorded_at) >= age);
}

async function keepRows() {
  const [recordings, files, transcripts] = await Promise.all([listRecordings(), listAudioFiles(), listTranscripts()]);
  const byRec = new Map(transcripts.map((t) => [t.recording_id, t]));
  const made = new Set(recordings.filter((r) => notesMade(r, byRec.get(r.id))).map((r) => r.id));
  return { recordings, files, made };
}

// The sweep: on app start, after each finished job, and when the choice changes.
// → { count: recordings whose audio went, bytes }
export async function expireAudio({ now = Date.now(), choice = getSettings().keepAudio } = {}) {
  if (!Object.hasOwn(KEEP_DAYS, choice)) return { count: 0, bytes: 0 };
  const rows = await keepRows();
  const batch = newId();
  let count = 0;
  let bytes = 0;
  for (const rec of audioToExpire({ ...rows, choice, now })) {
    let gone = 0;
    for (const f of rows.files.filter((x) => x.recording_id === rec.id && x.storage !== 'removed')) {
      const res = await removeAudioEverywhere(f, { reason: 'deleted the audio, as Settings says (the words stay)', batch });
      if (res.ok) { gone += 1; bytes += f.bytes ?? 0; }
    }
    if (gone) count += 1;
  }
  const deleted = await dropUnreferencedAudio({ everywhere: true });
  return { count, bytes: bytes + deleted.bytes };
}

// What each choice would delete right now: Settings asks before a choice deletes audio.
export async function loadKeepReport({ now = Date.now() } = {}) {
  const rows = await keepRows();
  const out = { keep: 0 };
  for (const choice of Object.keys(KEEP_DAYS)) out[choice] = audioToExpire({ ...rows, choice, now }).length;
  return out;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
