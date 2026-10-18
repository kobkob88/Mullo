// Recordings - the ONE funnel for the recordings surface. Every caller that
// changes a recording comes through here.
//
// A recording is what Pocket calls a recording and Vocci a session: when it
// happened, how long, where it came from, and what we made of it (title,
// sections, summary). The transcript lives in its own surface so the list of
// recordings stays light to sync.

import { db } from '../core/db.js';
import { newId } from '../core/ids.js';
import { localDate } from '../core/dates.js';
import { deleteTranscriptFor } from './transcripts.js';
import { actionsFor, deleteAction } from './actions.js';
import { audioFilesFor, forgetAudio } from '../core/files.js';
import { mergeFixes } from './corrections.js';

export const SOURCES = {
  device: 'This device',
  watch: 'Watch',
};

export async function createRecording(fields) {
  const recordedAt = fields.recorded_at ?? new Date().toISOString();
  const row = {
    id: newId(),
    title: fields.title ?? 'Untitled',
    title_edited: false,
    source: fields.source ?? 'device',
    external_id: fields.external_id ?? null,
    recorded_at: recordedAt,
    local_date: localDate(new Date(recordedAt)),
    duration_ms: fields.duration_ms ?? null,
    language: fields.language ?? null,
    template: fields.template ?? 'general',
    status: fields.status ?? 'processing',
    folder_id: fields.folder_id ?? null,
    summary: fields.summary ?? null,
    sections: fields.sections ?? [],
    audio_file_id: fields.audio_file_id ?? null,
    ...(fields.watch_battery ? { watch_battery: fields.watch_battery } : {}),
  };
  const res = await db.put('recordings', row);
  return res.row;
}

export async function getRecording(id) {
  return db.get('recordings', id);
}

export async function listRecordings() {
  const rows = await db.list('recordings');
  return rows.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
}

// `expected` = the updated_at the caller read. Leave it out for writes that
// must land regardless (pipeline results on a row this device just created).
export async function updateRecording(id, patch, { expected, reason } = {}) {
  return db.put('recordings', { id, ...patch }, { expected, reason });
}

// Updates (owner, 2026-10-18): dated lines added under a note after it was recorded, like a
// follow-up written in a notebook ("Told Tina: by the end of next week"). Typed on the note or
// suggested by Ask and added on a tap. The summary, sections and transcript stay as recorded.
// Stored on the recording (`updates`, synced in `extra`); each add/remove is audited, undo in Activity.
export const MAX_UPDATE_CHARS = 1000;

export async function addNoteUpdate(id, text, { by = 'me' } = {}) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_UPDATE_CHARS);
  if (!clean) return { ok: false, error: 'Write the update first.' };
  const update = { id: newId(), at: new Date().toISOString(), date: localDate(), text: clean, by };
  // Read fresh and write against what was read; one more try if a sync landed in between.
  for (let tries = 0; tries < 2; tries++) {
    const rec = await getRecording(id);
    if (!rec) return { ok: false, error: 'That note is gone.' };
    const res = await db.put('recordings', { id, updates: [...(rec.updates ?? []), update] }, {
      expected: rec.updated_at, reason: by === 'ask' ? 'added an update from Ask' : 'added an update',
    });
    if (res.ok || !res.conflict) return res.ok ? { ok: true, update } : { ok: false, error: res.error ?? 'Could not add the update.' };
  }
  return { ok: false, error: 'The note changed meanwhile - try again.' };
}

export async function removeNoteUpdate(rec, updateId) {
  const updates = (rec.updates ?? []).filter((u) => u.id !== updateId);
  if (updates.length === (rec.updates ?? []).length) return { ok: true };
  const res = await db.put('recordings', { id: rec.id, updates }, { expected: rec.updated_at, reason: 'removed an update' });
  return res.ok ? { ok: true } : { ok: false, error: res.conflict ? 'The note changed meanwhile - try again.' : (res.error ?? 'Could not remove it.') };
}

// A label edit: one field on one row, nothing else rewritten.
export async function renameRecording(rec, title) {
  const clean = String(title ?? '').trim();
  if (!clean) return { ok: false, error: 'A recording needs a title' };
  return db.put('recordings', { id: rec.id, title: clean, title_edited: true }, {
    expected: rec.updated_at, reason: 'renamed',
  });
}

// Speaker labels ("Speaker 1") are per-recording diarization, not people.
// A person names them here; the transcript keeps its labels, and the names
// are applied on display and when summarising. Empty name = forget it.
export async function nameSpeaker(rec, label, name) {
  const speakers = { ...(rec.speakers ?? {}) };
  const clean = String(name ?? '').trim().slice(0, 40);
  if (clean) speakers[label] = clean; else delete speakers[label];
  return db.put('recordings', { id: rec.id, speakers }, { expected: rec.updated_at, reason: `named ${label}` });
}

// Hand fixes of the transcript (corrections.js lineFixes), kept so Re-transcribe
// can't undo them. The newest fix of the same words wins.
export async function keepTranscriptFixes(rec, fixes) {
  if (!fixes?.length) return null;
  return db.put('recordings', { id: rec.id, transcript_fixes: mergeFixes(rec.transcript_fixes, fixes) },
    { expected: rec.updated_at, reason: 'transcript fix kept' });
}

export function speakerName(rec, label) {
  return (label && rec?.speakers?.[label]) || label;
}

export async function moveToFolder(rec, folderId) {
  return db.put('recordings', { id: rec.id, folder_id: folderId }, { expected: rec.updated_at, reason: 'moved' });
}

export async function findByExternal(source, externalId) {
  const rows = await db.list('recordings', (r) => r.source === source && r.external_id === externalId);
  return rows[0] ?? null;
}

// Intent-based delete of a recording and everything that hangs off it, as one
// batch, so the activity log can restore all of it in one step.
// Several at once (the Library's select mode): ONE batch, so Activity
// restores them all together. Each is checked against what's stored now.
export async function deleteRecordings(ids, { reason } = {}) {
  const batch = newId();
  let deleted = 0;
  let failed = 0;
  for (const id of ids) {
    const rec = await getRecording(id);
    if (!rec) continue;
    const res = await deleteRecording(rec, { reason, batch });
    if (res?.ok) deleted += 1; else failed += 1;
  }
  return { deleted, failed };
}

export async function deleteRecording(rec, { reason, batch = newId() } = {}) {
  const intent = 'deleted a recording';
  for (const action of await actionsFor(rec.id)) await deleteAction(action, { intent, batch, reason });
  await deleteTranscriptFor(rec.id, { intent, batch, reason });
  for (const file of await audioFilesFor(rec.id)) await forgetAudio(file.id, { intent, batch });
  return db.remove('recordings', rec.id, { intent, expected: rec.updated_at, reason, batch });
}
