// What the AI may read when someone asks their recordings (the Ask chat, domain/chat.js).
// The device chooses: the recordings the conversation already used, the best local search
// matches, topped up with the most recent ones - never the whole library.

import { search } from './search.js';

export const MAX_CONTEXT = 12;
const MIN_MATCHES = 4;

function summaryText(rec) {
  return (rec.summary?.blocks ?? []).map((b) => `${b.heading}: ${b.items.join('; ')}`).join(' / ');
}

// Pure: picks and shapes the context. includeTranscripts follows the role's
// "private" permission - no transcripts for roles that can't see them.
// first: recording ids to keep at the top (the ones earlier answers came from).
export function pickContext(question, { recordings, actions, transcripts }, { includeTranscripts = true, max = MAX_CONTEXT, first = [] } = {}) {
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const chosen = [];
  const add = (r) => { if (r && chosen.length < max && !chosen.includes(r)) chosen.push(r); };
  for (const id of first) add(byId.get(id));
  const hits = search(question, { recordings, actions, transcripts: includeTranscripts ? transcripts : [] });
  for (const h of hits) add(h.recording);
  if (chosen.length < MIN_MATCHES) {
    const recent = [...recordings].sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
    for (const r of recent) add(r);
  }
  const tById = new Map(transcripts.map((t) => [t.recording_id, t]));
  return chosen.map((r) => recordingForAI(r, { actions, transcript: tById.get(r.id), includeTranscripts }));
}

// One recording as the AI reads it: speaker names applied. Tasks keep their id so the chat
// can suggest a change to one (the server swaps ids for short refs; Gemini never sees them).
export function recordingForAI(r, { actions = [], transcript = null, includeTranscripts = true } = {}) {
  return {
    id: r.id,
    title: r.title,
    date: r.local_date,
    summary: summaryText(r),
    tasks: actions.filter((a) => a.recording_id === r.id && a.status !== 'cancelled')
      .map((a) => ({ id: a.id, label: a.label, status: a.status, due_date: a.due_date ?? null })),
    updates: (r.updates ?? []).map((u) => ({ date: u.date, text: u.text })),
    transcript: includeTranscripts
      ? (transcript?.segments ?? []).map((s) => (s.speaker ? `${r.speakers?.[s.speaker] ?? s.speaker}: ${s.text}` : s.text)).join(' ')
      : '',
  };
}
