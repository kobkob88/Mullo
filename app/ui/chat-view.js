// The Ask chat's pieces (S10, domain/chat.js), shared by the Ask tab and the chat bar on
// a recording: sending (one message on its way at a time), and drawing the messages -
// answers, drafts with Copy/Share, and suggested task changes and note updates that wait for a tap.

import { h, userText } from './dom.js';
import { sendChat, applyChange, applyUpdate, getThread, draftAsText } from '../domain/chat.js';
import { canSeePrivate } from '../core/auth.js';
import { shareText, copyText } from '../core/native.js';
import { relativeDay } from '../core/dates.js';
import { ctx } from './context.js';

const DRAFT_LABEL = { email: 'Email', message: 'Message', document: 'Document' };

let pending = null;    // the message on its way to the AI
let error = null;      // why the last one didn't go; its text goes back in the box
let retry = '';
let scrollToReply = false;

// Mulling while an answer is on its way (app.js keeps the face current between renders).
export const isThinking = () => pending != null;
export const chatError = () => error;
export const retryText = () => retry;
export function clearChatError() { error = null; retry = ''; }

// → false when it didn't go out (empty, or one already on its way).
export async function sendMessage(text) {
  const q = String(text ?? '').trim();
  if (!q || pending != null) return false;
  pending = q;
  error = null;
  retry = '';
  ctx.refresh({ force: true });
  const result = await sendChat(q, { includeTranscripts: canSeePrivate('search') });
  pending = null;
  if (result.ok) scrollToReply = !result.dropped;
  else { error = result.error; retry = q; }
  ctx.refresh({ force: true });
  return true;
}

function draftBox(d, index) {
  return h('div', { class: 'chat__draft stack' },
    h('span', { class: 'chat__draft-kind' }, DRAFT_LABEL[d.kind] ?? 'Draft'),
    d.subject ? userText('p', d.subject, { class: 'chat__draft-subject' }) : null,
    userText('p', d.body, { class: 'chat__draft-body' }),
    h('div', { class: 'row' },
      // A chat started from a task's draft (S50 "Change in Ask"): a later draft goes back on it.
      index > 0 && getThread().task
        ? h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'ask-draft-task', index } }, 'Use for the task')
        : null,
      h('button', { type: 'button', class: 'btn', data: { action: 'ask-draft-share', index } }, 'Share'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'ask-draft-copy', index } }, 'Copy')),
    // Ask can't edit a note (owner, 2026-10-16: "Here is the updated note" changed nothing), so a
    // document says so itself, whatever the AI's answer line claims.
    d.kind === 'document' ? h('p', { class: 'muted small' }, 'A copy to share or keep. The note itself is not changed.') : null,
    h('p', { class: 'muted small' }, 'Check names, dates and anything in [brackets] before sending. Ask for changes here: "shorter", "more formal".'));
}

// What a suggested change does, in words: "Move to Tue, Oct 13", "Mark done"...
export function changeWords(c) {
  const parts = [];
  if (c.due_date) parts.push(`${c.applied ? 'Moved' : 'Move'} to ${relativeDay(c.due_date)}`);
  if (c.remove_date) parts.push(c.applied ? 'Date removed' : 'Remove the date');
  if (c.status === 'done') parts.push(c.applied ? 'Marked done' : 'Mark done');
  if (c.status === 'cancelled') parts.push(c.applied ? 'Cancelled' : 'Cancel it');
  if (c.status === 'open') parts.push(c.applied ? 'Reopened' : 'Reopen');
  return parts.join(', ');
}

// Suggested task changes: nothing happens until the person taps (domain/chat.js applyChange).
function changesBox(m, index) {
  return h('div', { class: 'chat__changes stack' },
    m.changes.map((c, ci) => h('div', { class: 'chat__change' },
      h('div', { class: 'chat__change-text' },
        userText('span', c.label, { class: 'chat__change-label' }),
        h('span', { class: 'muted small' }, `${c.applied ? 'Was' : 'Now'}: ${c.from_due ? relativeDay(c.from_due) : 'no date'}`)),
      c.applied
        ? h('a', { class: 'chat__change-done small', href: '#/actions' }, `✓ ${changeWords(c)}`)
        : h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'ask-apply', index, change: ci } }, changeWords(c)))));
}

// Suggested note updates: the line that would go under the note, added on a tap (domain/chat.js applyUpdate).
function updatesBox(m, index) {
  return h('div', { class: 'chat__changes stack' },
    m.updates.map((u, ui) => h('div', { class: 'chat__change' },
      h('div', { class: 'chat__change-text' },
        userText('span', u.text, { class: 'chat__change-label' }),
        userText('span', `${u.applied ? 'Added to' : 'Update for'}: ${u.title}`, { class: 'muted small' })),
      u.applied
        ? h('a', { class: 'chat__change-done small', href: `#/rec/${u.id}` }, '✓ Added')
        : h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'ask-add-update', index, update: ui } }, 'Add to note'))));
}

// sources: false on a recording's own chat (the answer is about the page it's on).
function reply(m, index, recs, last, { sources: showSources = true } = {}) {
  const sources = showSources ? (m.sources ?? []).map((id) => recs.get(id)).filter(Boolean) : [];
  return h('div', {
    class: ['chat__msg', 'chat__msg--ai', !m.found && !m.draft && !m.changes?.length && !m.updates?.length && 'answer--notfound'],
    data: last && scrollToReply ? { scrollHere: '' } : {},
  },
  userText('p', m.text, { class: 'answer__text' }),
  m.draft ? draftBox(m.draft, index) : null,
  m.updates?.length ? updatesBox(m, index) : null,
  m.changes?.length ? changesBox(m, index) : null,
  sources.length
    ? h('div', { class: 'stack answer__sources' },
      h('span', { class: 'muted small' }, 'From'),
      sources.map((rec) => h('a', { class: 'answer__source', href: `#/rec/${rec.id}` },
        userText('span', rec.title), h('span', { class: 'muted small' }, ` · ${relativeDay(rec.local_date)}`))))
    : null);
}

// The thread's messages from <from> on, plus the one on its way. recs: id → recording.
export function chatBubbles(thread, recs, { from = 0, sources = true } = {}) {
  const msgs = thread.messages;
  const out = [];
  for (let i = Math.max(0, from); i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m.role === 'user'
      ? userText('p', m.text, { class: 'chat__msg chat__msg--me' })
      : reply(m, i, recs, i === msgs.length - 1, { sources }));
  }
  if (pending != null) {
    out.push(userText('p', pending, { class: 'chat__msg chat__msg--me' }), h('p', { class: 'chat__msg chat__msg--ai muted' }, 'Thinking…'));
  }
  scrollToReply = false;
  return out;
}

// The draft on message <index> of this thread.
const draftAt = (el) => getThread().messages[Number(el.dataset.index)]?.draft ?? null;

// Buttons inside answers, wherever the answer is shown.
export const actions = {
  async 'ask-apply'(el) {
    el.disabled = true;
    const res = await applyChange(Number(el.dataset.index), Number(el.dataset.change));
    ctx.toast(res.ok ? `${changeWords(res.change)} - ${res.change.label}. Undo from Activity.` : res.error, { error: !res.ok });
    ctx.refresh({ force: true });
  },

  async 'ask-add-update'(el) {
    el.disabled = true;
    const res = await applyUpdate(Number(el.dataset.index), Number(el.dataset.update));
    if (!res.ok) ctx.toast(res.error, { error: true });
    ctx.refresh({ force: true });
  },

  async 'ask-draft-share'(el) {
    const d = draftAt(el);
    if (!d) return;
    const result = await shareText(d.subject ?? 'Draft', draftAsText(d));
    if (result === 'copied') ctx.toast('Copied - paste it anywhere');
    else if (result === 'failed') ctx.toast('Sharing isn’t available here', { error: true });
  },

  async 'ask-draft-copy'(el) {
    const d = draftAt(el);
    if (!d) return;
    const copied = await copyText(draftAsText(d));
    ctx.toast(copied ? 'Copied - paste it anywhere' : 'Couldn’t copy here', { error: !copied });
  },
};
