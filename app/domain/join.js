// Joining notes: several recordings the person picked (a brain dump made in
// pieces) become one recording - one transcript, one summary, one task list.
// Only ever when the person asks: there is no automatic offer (owner,
// 2026-10-06).
//
// The earliest note becomes the joined one. The others' audio and any task a
// person touched move onto it; the rest of each later note is deleted in one
// batch, so Activity can bring them all back.

import { newId } from '../core/ids.js';
import { audioFilesFor, moveAudio } from '../core/files.js';
import { getRecording, updateRecording, deleteRecording } from './recordings.js';
import { transcriptFor, saveTranscript } from './transcripts.js';
import { actionsFor, moveAction } from './actions.js';
import { processRecording } from './pipeline.js';

const startOf = (r) => Date.parse(r.recorded_at);
// A joined note spans from its first piece to the end of its last.
const spanOf = (r) => r.span_ms ?? r.duration_ms ?? 0;
// Only finished notes: one still transcribing would lose what arrives next.
export const canJoin = (r) => r.status === 'ready' && Number.isFinite(Date.parse(r.recorded_at));

// Each note's lines, moved onto one clock that starts with the first note.
// A note without times gets its first line stamped where it began, so the
// player can still jump to it.
export function joinedSegments(parts) {
  const t0 = startOf(parts[0].rec);
  return parts.flatMap(({ rec, segments }) => {
    const offset = startOf(rec) - t0;
    return (segments ?? []).map((s, i) => ({
      ...s,
      start_ms: Number.isFinite(s.start_ms) ? s.start_ms + offset : (i === 0 ? offset : null),
      end_ms: Number.isFinite(s.end_ms) ? s.end_ms + offset : null,
    }));
  });
}

// The audio pieces, each with where it starts on the joined clock.
export function joinedAudioParts(recs) {
  const t0 = startOf(recs[0]);
  return recs.flatMap((r) => {
    const offset = startOf(r) - t0;
    const own = r.parts?.length
      ? r.parts
      : r.audio_file_id ? [{ audio_file_id: r.audio_file_id, offset_ms: 0, duration_ms: r.duration_ms ?? null }] : [];
    return own.map((p) => ({ ...p, offset_ms: (p.offset_ms ?? 0) + offset }));
  });
}

export async function joinRecordings(ids) {
  const recs = (await Promise.all(ids.map(getRecording))).filter(Boolean).sort((a, b) => startOf(a) - startOf(b));
  if (recs.length < 2 || recs.length !== ids.length || !recs.every(canJoin)) {
    return { ok: false, error: 'Those notes changed meanwhile - have another look.' };
  }
  const [first, ...rest] = recs;
  const last = recs[recs.length - 1];
  const transcripts = await Promise.all(recs.map((r) => transcriptFor(r.id)));
  const segments = joinedSegments(recs.map((rec, i) => ({ rec, segments: transcripts[i]?.segments })));
  const batch = newId();
  const reason = `joined ${recs.length} notes`;

  const saved = await saveTranscript(first.id, segments, {
    language: transcripts[0]?.language ?? first.language, origin: 'joined', reason,
  });
  if (saved?.ok === false) return { ok: false, error: 'That note changed meanwhile - try again.' };

  for (const r of rest) {
    for (const f of await audioFilesFor(r.id)) await moveAudio(f, first.id, { reason, batch });
    for (const a of await actionsFor(r.id)) {
      const engineMade = a.origin === 'extracted' && a.status === 'open' && !a.edited;
      if (!engineMade) await moveAction(a, first.id, { reason, batch });
    }
  }

  await updateRecording(first.id, {
    parts: joinedAudioParts(recs),
    duration_ms: recs.reduce((n, r) => n + (r.duration_ms ?? 0), 0),
    span_ms: startOf(last) + spanOf(last) - startOf(first),
    joined_count: recs.reduce((n, r) => n + (r.joined_count ?? 1), 0),
    speakers: Object.assign({}, ...rest.map((r) => r.speakers ?? {}).reverse(), first.speakers ?? {}),
  }, { reason });

  for (const r of rest) {
    const fresh = await getRecording(r.id);
    if (fresh) await deleteRecording(fresh, { reason: 'joined into one note', batch });
  }

  const processed = await processRecording(first.id);
  return { ok: true, id: first.id, count: recs.length, aiError: processed.aiError ?? (processed.ok ? null : processed.error) };
}
