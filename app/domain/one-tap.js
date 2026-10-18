// One-tap actions (the Pocket idea): an action item becomes the thing it
// describes. Pure builders - the screen opens what they return.
//   draft_email     → a mailto: link with subject and body
//   send_message    → text for the share sheet (or WhatsApp)
//   create_reminder → an .ics calendar event on its due date (all day,
//                     alert at 9:00), or tomorrow when it has none

import { addDays, localDate } from '../core/dates.js';

// ── Drafts kept on a task (S50) ─────────────────────────────────────────
// An email or message task gets a draft written from its note (task-drafts.js), kept in
// payload.draft: { kind, to, subject, body, made_at, edited_at }. It travels with the task
// (sync), so the computer sees the phone's draft.
export const DRAFT_KIND = { draft_email: 'email', send_message: 'message' };

// The task's kind wins over the kind the draft was written as: a task changed from Email to
// Message after its draft was made shows and sends as a message (no To, no subject), and back.
// The stored address and subject stay underneath, so switching back brings them back.
export function draftOf(action) {
  const d = action?.payload?.draft;
  if (!d || typeof d !== 'object' || !String(d.body ?? '').trim()) return null;
  const kind = DRAFT_KIND[action.type] ?? (d.kind === 'message' ? 'message' : 'email');
  return {
    kind,
    to: kind === 'email' && typeof d.to === 'string' ? d.to : '',
    subject: kind === 'email' && d.subject ? String(d.subject) : null,
    body: String(d.body),
    made_at: d.made_at ?? null,
    edited_at: d.edited_at ?? null,
  };
}

// "To" only when the note itself says the address: exactly one address in it, else none.
// The AI never fills it, so it can't invent one.
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
export function addressIn(...texts) {
  const found = new Set(texts.flatMap((t) => String(t ?? '').match(EMAIL) ?? []).map((a) => a.toLocaleLowerCase()));
  return found.size === 1 ? [...found][0] : '';
}

// What the AI is asked for a task's draft (through the Ask chat route).
export function draftRequest(action) {
  const kind = DRAFT_KIND[action.type] ?? 'email';
  return [
    `Write the ${kind} this task needs, from this note: "${action.label}".`,
    action.context ? `About it: ${action.context}` : null,
    'Write it in the language the note is in.',
    kind === 'email' ? 'Do not put an email address anywhere in it.' : null,
  ].filter(Boolean).join(' ');
}

// A kept draft first, then Pocket's own payload, then the task's words.
export function emailParts(action) {
  const d = draftOf(action);
  if (d) return { to: d.to, subject: d.subject ?? action.label, body: d.body };
  const e = action.payload?.email ?? {};
  return {
    to: e.to ?? '',
    subject: e.subject ?? action.label,
    body: e.body ?? action.context ?? '',
  };
}

export function emailLink(action) {
  const { to, subject, body } = emailParts(action);
  const q = new URLSearchParams();
  if (subject) q.set('subject', subject);
  if (body) q.set('body', body);
  // URLSearchParams writes spaces as '+', which mail apps show literally.
  return `mailto:${encodeURIComponent(to)}?${q.toString().replace(/\+/g, '%20')}`;
}

export function messageText(action) {
  const d = draftOf(action);
  if (d) return d.body;
  return action.payload?.message?.body ?? action.payload?.message?.text ?? action.label;
}

export function whatsappLink(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// RFC 5545 text escaping.
export function icsEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Lines longer than 75 octets are folded; count bytes, not characters
// (a Hebrew letter is two bytes in UTF-8).
export function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const compactDate = (d) => d.replace(/-/g, '');

export function reminderDate(action, today = localDate()) {
  return action.due_date ?? addDays(today, 1);
}

export function buildIcs(action, { today = localDate(), now = new Date() } = {}) {
  const day = reminderDate(action, today);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mullo//Action items//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${action.id}@mullo`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDate(day)}`,
    `DTEND;VALUE=DATE:${compactDate(addDays(day, 1))}`,
    `SUMMARY:${icsEscape(action.label)}`,
    action.context ? `DESCRIPTION:${icsEscape(action.context)}` : null,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(action.label)}`,
    'TRIGGER;RELATED=START:PT9H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

export function icsFilename(action) {
  const safe = action.label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${safe || 'reminder'}.ics`;
}

export const ONE_TAP_LABEL = {
  draft_email: '✉️ Email',
  send_message: '💬 Send',
  create_reminder: '📅 Calendar',
};
