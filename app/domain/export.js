// A recording as plain text, for the share sheet or the clipboard: to paste
// into a message, an email, notes, or a chat with an AI. Pure.
//
// The transcript goes in only when asked for (and only for someone allowed to
// see it - the screen decides that).

import { formatClock, formatDuration } from '../core/dates.js';

export function recordingAsText(rec, { segments = [], actions = [], withTranscript = false, nameOf = (x) => x, when = '' } = {}) {
  const out = [rec.title];
  const meta = [when, rec.duration_ms ? formatDuration(rec.duration_ms) : null].filter(Boolean).join(' · ');
  if (meta) out.push(meta);

  for (const b of rec.summary?.blocks ?? []) {
    if (!b.items?.length) continue;
    // The task block is written from the live task list below instead.
    if (actions.length && b.items.every((i) => actions.some((a) => a.label === i))) continue;
    out.push('', b.heading, ...b.items.map((i) => `- ${i}`));
  }

  if (rec.updates?.length) out.push('', 'Updates', ...rec.updates.map((u) => `- ${u.date}: ${u.text}`));

  const open = actions.filter((a) => a.status !== 'cancelled');
  if (open.length) {
    out.push('', 'To do', ...open.map((a) => `${a.status === 'done' ? '[x]' : '[ ]'} ${a.label}${a.due_date ? ` (${a.due_date})` : ''}`));
  }

  if (withTranscript && segments.length) {
    out.push('', 'Transcript');
    for (const s of segments) {
      const at = Number.isFinite(s.start_ms) ? `[${formatClock(s.start_ms)}] ` : '';
      const who = s.speaker ? `${nameOf(s.speaker)}: ` : '';
      out.push(`${at}${who}${s.text}`);
    }
  }
  return out.join('\n');
}
