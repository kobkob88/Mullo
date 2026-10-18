// The draft under an email or message task (S50, domain/task-drafts.js): "Draft ready" opens
// it to read and edit (saved when a field is left), then Send (the mail app or the share
// sheet), Copy, Change in Ask, Write again. Mullo can't see the send, so after it the task
// asks "Sent? Mark done". Shown on the Actions screen and a recording's Actions tab.

import { h } from './dom.js';
import { ctx } from './context.js';
import { getAction, setActionStatus } from '../domain/actions.js';
import { DRAFT_KIND, draftOf, emailLink, messageText, whatsappLink } from '../domain/one-tap.js';
import { isDrafting, canDraft, makeDraft, editDraft, draftToAsk, useChatDraft } from '../domain/task-drafts.js';
import { draftAsText } from '../domain/chat.js';
import { shareText, copyText } from '../core/native.js';

const opened = new Set(); // drafts open on screen (task ids)
const closed = new Set(); // a reminder's task, closed by the person
const sent = new Set();   // Send was tapped: ask "Sent? Mark done"

const OPEN = new Set(['open', 'in_progress']);

// The person sent it from a task's one-tap button (tasks.js action-do).
export function noteSent(id) { sent.add(id); }

// focused: the task a reminder opened; its draft starts open.
export function draftBlock(action, { focused = false } = {}) {
  if (!OPEN.has(action.status) || !DRAFT_KIND[action.type]) return null;
  if (isDrafting(action.id)) return h('p', { class: 'task-draft__state muted small' }, 'Writing the draft…');
  const d = draftOf(action);
  if (!d) {
    return canDraft()
      ? h('button', { type: 'button', class: 'task-draft__toggle', data: { action: 'task-draft-make', id: action.id } }, '✨ Draft it')
      : null;
  }
  const open = opened.has(action.id) || (focused && !closed.has(action.id));
  const toggle = h('button', {
    type: 'button', class: ['task-draft__toggle', open && 'is-open'], 'aria-expanded': String(open),
    data: { action: 'task-draft-toggle', id: action.id, focused: focused ? '1' : '' },
  }, open ? 'Hide the draft' : '✨ Draft ready');
  if (!open) return h('div', { class: 'task-draft' }, toggle, sent.has(action.id) ? sentAsk(action) : null);

  const ai = canDraft();
  const field = (name, attrs) => ({ ...attrs, dir: 'auto', data: { action: 'task-draft-edit', on: 'change', id: action.id, field: name } });
  return h('div', { class: 'task-draft is-open' },
    toggle,
    h('div', { class: 'task-draft__box stack' },
      d.kind === 'email'
        ? h('label', { class: 'task-draft__line' }, h('span', { class: 'muted small' }, 'To'),
          h('input', field('to', { type: 'email', class: 'task-draft__to', value: d.to, placeholder: 'Address (not in the note)', autocomplete: 'off' })))
        : null,
      d.kind === 'email'
        ? h('label', { class: 'task-draft__line' }, h('span', { class: 'muted small' }, 'Subject'),
          h('input', field('subject', { type: 'text', class: 'task-draft__subject', value: d.subject ?? '' })))
        : null,
      h('textarea', field('body', { class: 'task-draft__body', rows: 8, 'aria-label': 'The draft' }), d.body),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'task-draft-send', id: action.id } }, d.kind === 'email' ? '✉️ Open in mail' : '💬 Send'),
        h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'task-draft-copy', id: action.id } }, 'Copy'),
        // Both need the AI; without it (signed out, the plan ran out) the draft can still be edited and sent.
        ai ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'task-draft-ask', id: action.id } }, 'Change in Ask') : null,
        ai ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'task-draft-make', id: action.id, redo: '1' } }, 'Write again') : null),
      sent.has(action.id) ? sentAsk(action) : null,
      h('p', { class: 'muted small' }, 'Written by Mullo from the note. Check names, dates and anything in [brackets] before sending.')));
}

function sentAsk(action) {
  return h('div', { class: 'task-draft__sent row' },
    h('span', { class: 'small' }, 'Sent?'),
    h('button', { type: 'button', class: 'btn btn--small btn--primary', data: { action: 'task-draft-done', id: action.id } }, 'Mark done'),
    h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'task-draft-not-yet', id: action.id } }, 'Not yet'));
}

// Opens the mail app or the share sheet with the task's draft (also the row's one-tap button).
export async function sendDraft(action) {
  if (action.type === 'draft_email') {
    location.href = emailLink(action);
  } else {
    const text = messageText(action);
    const result = await shareText(action.label, text);
    if (result === 'failed') window.open(whatsappLink(text), '_blank', 'noopener');
    else if (result === 'copied') ctx.toast('Copied - paste it into any app');
  }
  if (draftOf(action)) sent.add(action.id);
}

export const actions = {
  'task-draft-toggle'(el) {
    const id = el.dataset.id;
    const isOpen = el.getAttribute('aria-expanded') === 'true';
    if (isOpen) { opened.delete(id); if (el.dataset.focused) closed.add(id); } else { opened.add(id); closed.delete(id); }
    ctx.refresh({ force: true });
  },

  async 'task-draft-make'(el) {
    const id = el.dataset.id;
    const redo = Boolean(el.dataset.redo);
    el.disabled = true;
    const res = await makeDraft(id, { redo });
    if (res.ok) { opened.add(id); sent.delete(id); }
    else ctx.toast(res.error, { error: true });
    ctx.refresh({ force: true });
  },

  async 'task-draft-edit'(el) {
    const res = await editDraft(el.dataset.id, { [el.dataset.field]: el.value });
    if (!res.ok) ctx.toast(res.error, { error: true });
    ctx.refresh();
  },

  async 'task-draft-send'(el) {
    const action = await getAction(el.dataset.id);
    if (!action) return;
    await sendDraft(action);
    ctx.refresh({ force: true });
  },

  async 'task-draft-copy'(el) {
    const d = draftOf(await getAction(el.dataset.id));
    if (!d) return;
    const copied = await copyText(draftAsText(d));
    ctx.toast(copied ? 'Copied - paste it anywhere' : 'Couldn’t copy here', { error: !copied });
  },

  async 'task-draft-ask'(el) {
    const res = await draftToAsk(el.dataset.id);
    if (!res.ok) { ctx.toast(res.error, { error: true }); return; }
    ctx.toast('Say what to change in the box at the bottom');
    ctx.go(`#/rec/${res.recordingId}`);
  },

  async 'task-draft-done'(el) {
    const action = await getAction(el.dataset.id);
    sent.delete(el.dataset.id);
    if (action && OPEN.has(action.status)) {
      const res = await setActionStatus(action, 'done', { reason: 'sent from its draft' });
      if (res.ok === false) ctx.toast('That changed meanwhile - refreshed.', { error: true });
    }
    ctx.refresh({ force: true });
  },

  'task-draft-not-yet'(el) {
    sent.delete(el.dataset.id);
    ctx.refresh({ force: true });
  },

  // Under a draft in a chat started with "Change in Ask": it goes back on the task.
  async 'ask-draft-task'(el) {
    const res = await useChatDraft(Number(el.dataset.index));
    if (!res.ok) { ctx.toast(res.error, { error: true }); return; }
    opened.add(res.task.id);
    ctx.toast('The task has the new draft');
    ctx.go(`#/actions/${res.task.id}`);
  },
};
