// How Mullo writes a draft (an email, a message or a document) for the person. Drafts
// happen in the Ask chat (S10, bridge/chat.mjs): "write an email to Daniel about the call".
// The rules come from S11's Draft card: only what the notes say, [brackets] for missing
// facts, written as the person, no long dashes. Nothing is stored anywhere: the draft goes
// back to the app, which copies or shares it.

export const DRAFT_KINDS = ['email', 'message', 'document'];

export const KIND_RULES = {
  email: 'An email: draft_subject = a short subject line; draft_body = greeting, the email, sign-off (sign as [Your name]).',
  message: 'A chat or text message (WhatsApp, Slack, SMS): a few short lines, no subject, no sign-off.',
  document: 'A document (notes, a brief, a memo): draft_subject = its title; draft_body uses short headings and lists where they help, as plain text (no Markdown symbols except "- " for list items). Every heading and every list item starts on its own line: a line break before each "- ", never two items on one line.',
};

export const DRAFT_RULES = [
  'Use ONLY what the notes say. Never invent names, dates, times, amounts, prices or promises. Where the draft needs a fact the notes do not give, write a short placeholder in square brackets, like [date] or [price].',
  'Write as the person who made the recordings, to the reader. Do not mention the recording, the transcript or an AI.',
  'Tone: clear and plain unless the person asks for another (friendly, formal, brief...).',
  'Write in the language of the request, unless the person asks for another one.',
];

const fail = (status, message) => Object.assign(new Error(message), { status });

// Long dashes become short ones (house rule); line breaks kept, runs of blank lines squeezed.
export const tidyText = (s, n) => String(s ?? '').replace(/\s*—\s*/g, ' - ').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);

// The model's draft → { kind, subject, body }. A message has no subject.
export function sanitizeDraft(raw, { kind } = {}) {
  const body = tidyText(raw?.body, 12_000);
  if (!body) throw fail(502, 'The AI wrote an empty draft - try again');
  const subject = kind === 'message' ? null : (tidyText(raw?.subject, 200).replace(/\n+/g, ' ') || null);
  return { kind, subject, body };
}
