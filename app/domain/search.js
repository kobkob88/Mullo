// Search across everything captured - titles, summaries, sections, action
// items and transcripts (lexical, on the device). The connectors' own search
// (Pocket hybrid, Vocci semantic) is reachable through the bridge later;
// this is the offline floor. Hebrew-aware: niqqud and punctuation are ignored.

const NIQQUD = /[֑-ׇ]/g;

export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(NIQQUD, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function snippet(text, terms, radius = 60) {
  const raw = String(text ?? '').replace(/\s+/g, ' ');
  const low = raw.toLocaleLowerCase();
  let at = -1;
  for (const t of terms) {
    at = low.indexOf(t);
    if (at >= 0) break;
  }
  if (at < 0) return raw.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  return `${start ? '…' : ''}${raw.slice(start, at + radius)}${at + radius < raw.length ? '…' : ''}`;
}

const WEIGHTS = { title: 5, summary: 3, section: 3, action: 3, transcript: 1 };

// data: { recordings, transcripts, actions } (plain arrays)
export function search(query, { recordings, transcripts, actions }) {
  const terms = normalize(query).split(' ').filter((t) => t.length > 1);
  if (!terms.length) return [];
  const byRec = new Map();
  const hit = (recId, kind, text) => {
    const n = normalize(text);
    const matched = terms.filter((t) => n.includes(t)).length;
    if (!matched) return;
    const entry = byRec.get(recId) ?? { recordingId: recId, score: 0, matches: [] };
    entry.score += matched * WEIGHTS[kind];
    entry.matches.push({ kind, text: snippet(text, terms) });
    byRec.set(recId, entry);
  };

  for (const r of recordings) {
    hit(r.id, 'title', r.title);
    for (const block of r.summary?.blocks ?? []) hit(r.id, 'summary', block.items.join(' · '));
    for (const u of r.updates ?? []) hit(r.id, 'update', u.text);
    for (const s of r.sections ?? []) hit(r.id, 'section', `${s.title} ${s.summary ?? ''}`);
  }
  for (const a of actions) hit(a.recording_id, 'action', a.label);
  for (const t of transcripts) hit(t.recording_id, 'transcript', t.segments.map((s) => s.text).join(' '));

  const recById = new Map(recordings.map((r) => [r.id, r]));
  return [...byRec.values()]
    .filter((e) => recById.has(e.recordingId))
    .map((e) => ({ ...e, recording: recById.get(e.recordingId), matches: e.matches.slice(0, 3) }))
    .sort((a, b) => b.score - a.score || (a.recording.recorded_at < b.recording.recorded_at ? 1 : -1));
}
