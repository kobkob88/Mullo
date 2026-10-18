// Transcripts - the ONE funnel for the transcripts surface.
// One row per recording: { recording_id, language, origin, segments[] } where
// a segment is { speaker, start_ms, end_ms, text }.
//
// Speaker labels ("Speaker 1", "SPEAKER_00") are per-recording diarization
// labels, not identities. Nothing here maps a label to a person; a person
// names speakers themselves, later.

import { db } from '../core/db.js';
import { newId } from '../core/ids.js';

export async function transcriptFor(recordingId) {
  const rows = await db.list('transcripts', (t) => t.recording_id === recordingId);
  return rows[0] ?? null;
}

export async function listTranscripts() {
  return db.list('transcripts');
}

export function cleanSegments(segments) {
  return (segments ?? [])
    .map((s) => ({
      speaker: s.speaker ?? null,
      start_ms: Number.isFinite(s.start_ms) ? s.start_ms : null,
      end_ms: Number.isFinite(s.end_ms) ? s.end_ms : null,
      text: String(s.text ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.text);
}

// Typed or pasted text becomes segments, one per non-empty line.
export function segmentsFromText(text) {
  return cleanSegments(String(text ?? '').split(/\n+/).map((line) => {
    const m = /^\s*([^:]{1,30}):\s+(.+)$/.exec(line);
    return m ? { speaker: m[1], text: m[2] } : { text: line };
  }));
}

export async function saveTranscript(recordingId, segments, { language = null, origin = 'device', reason } = {}) {
  const existing = await transcriptFor(recordingId);
  return db.put('transcripts', {
    id: existing?.id ?? newId(),
    recording_id: recordingId,
    language,
    origin,
    segments: cleanSegments(segments),
  }, { expected: existing?.updated_at, reason });
}

export async function deleteTranscriptFor(recordingId, { intent, batch, reason }) {
  const t = await transcriptFor(recordingId);
  if (!t) return null;
  return db.remove('transcripts', t.id, { intent, expected: t.updated_at, batch, reason });
}
