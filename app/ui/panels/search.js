// Search across titles, summaries, sections, action items and transcripts.
// Ask (needs the AI engine) is a chat about the recordings (S10, domain/chat.js):
// follow-ups keep context, and asking for an email, a message or a document gives a
// draft inside the answer, with Copy and Share on it.

import { h, userText } from '../dom.js';
import { pageHeader, emptyState, sourceBadge } from '../components.js';
import { search } from '../../domain/search.js';
import { listRecordings } from '../../domain/recordings.js';
import { listActions } from '../../domain/actions.js';
import { listTranscripts } from '../../domain/transcripts.js';
import { canSeePrivate } from '../../core/auth.js';
import { canChat, getThread, newChat } from '../../domain/chat.js';
import { chatBubbles, sendMessage, isThinking, chatError, retryText, clearChatError, actions as chatActions } from '../chat-view.js';
import { ctx } from '../context.js';
import { relativeDay } from '../../core/dates.js';
import { mascot } from '../mascot.js';
import { appMood } from '../mood.js';

export const screen = 'search';

let query = '';
let resultsEl = null;
let timer = null;

const KIND_LABEL = { title: 'Title', summary: 'Summary', update: 'Update', section: 'Section', action: 'Action', transcript: 'Transcript' };

async function results() {
  if (!query.trim()) return emptyState('Search everything you captured', 'Names, places, decisions - in any language.');
  const [recordings, actions, transcripts] = await Promise.all([
    listRecordings(),
    listActions(),
    canSeePrivate('search') ? listTranscripts() : Promise.resolve([]),
  ]);
  const hits = search(query, { recordings, actions, transcripts });
  if (!hits.length) return emptyState('No matches', 'Try fewer words.');
  return h('div', { class: 'stack' }, hits.map((hit) =>
    h('a', { class: 'card search-hit', href: `#/rec/${hit.recording.id}` },
      h('div', { class: 'rec-card__top' },
        userText('span', hit.recording.title, { class: 'rec-card__title' }),
        sourceBadge(hit.recording.source)),
      h('span', { class: 'muted small' }, relativeDay(hit.recording.local_date)),
      hit.matches.map((m) => h('p', { class: 'search-hit__match' },
        h('span', { class: 'search-hit__kind' }, KIND_LABEL[m.kind]),
        userText('span', m.text))))));
}

let mode = 'search';

// Mulling while an answer is on its way (the chat bar on a recording sends too).
export { isThinking };

// "Ask about this" on a recording lands here, in Ask.
export function openAsk() { mode = 'ask'; clearChatError(); }

// Mullo on top of this tab, the same size as while recording (owner, 2026-10-10).
async function stage() {
  const { mood } = appMood(await listRecordings());
  return h('div', { class: 'mullo-stage mullo-stage--ask' }, mascot(isThinking() ? 'mulling' : mood, { size: 'live' }));
}

async function askView() {
  const thread = getThread();
  const recs = new Map((await listRecordings()).map((r) => [r.id, r]));
  const about = thread.focus ? recs.get(thread.focus) : null;
  const msgs = thread.messages;
  const bubbles = chatBubbles(thread, recs);
  const busy = isThinking();
  const askError = chatError();
  return h('div', { class: 'stack chat' },
    thread.focus
      ? h('p', { class: 'chat__about small' }, 'About ',
        about ? h('a', { href: `#/rec/${about.id}` }, userText('span', about.title)) : h('span', { class: 'muted' }, 'a recording that is gone'))
      : null,
    bubbles.length
      ? h('div', { class: 'chat__thread', role: 'log', 'aria-live': 'polite' }, bubbles)
      : h('p', { class: 'muted small' }, thread.focus
        ? 'Ask anything about this recording, or ask for an email, a message or a document from it. Only this recording is sent to the AI.'
        : 'Ask about your recordings, or ask for an email, a message or a document. Only the recordings that match (or your latest ones) are sent to the AI.'),
    askError ? h('p', { class: 'notice notice--alert' }, askError) : null,
    h('form', { class: 'stack chat__form', data: { action: 'ask-submit' } },
      h('textarea', {
        name: 'question', rows: '2', dir: 'auto', value: retryText(), data: { draft: 'ask-question' },
        placeholder: msgs.length ? 'Ask a follow-up…' : thread.focus ? 'What did we agree on?' : 'What did I promise the supplier?',
        'aria-label': 'Message',
      }),
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'btn btn--primary', disabled: busy }, busy ? 'Thinking…' : 'Send'),
        msgs.length || thread.focus ? h('button', { type: 'button', class: 'btn btn--ghost', disabled: busy, data: { action: 'ask-new' } }, 'New chat') : null)),
    msgs.length ? h('p', { class: 'muted small' }, 'Answers come from the AI - open the source to check. This chat stays on this device.') : null);
}

export async function render() {
  const switcher = canChat()
    ? h('div', { class: 'filters', role: 'group', 'aria-label': 'Mode' },
      [['search', 'Search'], ['ask', 'Ask']].map(([value, label]) => h('button', {
        type: 'button', class: ['pill', mode === value && 'is-active'], 'aria-pressed': String(mode === value),
        data: { action: 'search-mode', mode: value },
      }, label)))
    : null;

  if (mode === 'ask' && canChat()) {
    return h('div', null, pageHeader('Ask'), await stage(), switcher, await askView());
  }

  resultsEl = h('div', { class: 'search-results' }, await results());
  return h('div', null,
    pageHeader('Search'),
    await stage(),
    switcher,
    h('input', {
      type: 'search', class: 'search-input', value: query, dir: 'auto',
      // No autofocus: opening the tab must not pop the keyboard (owner, 2026-10-10).
      placeholder: 'Search recordings…', 'aria-label': 'Search',
      data: { action: 'search-input' },
    }),
    resultsEl);
}

export const actions = {
  ...chatActions,

  'search-mode'(el) {
    mode = el.dataset.mode;
    ctx.refresh({ force: true });
  },

  async 'ask-submit'(form) {
    const field = form.elements.question;
    const text = field.value;
    field.value = '';
    if (!(await sendMessage(text))) field.value = text;
  },

  'ask-new'() {
    if (isThinking()) return;
    newChat();
    clearChatError();
    ctx.refresh({ force: true });
  },

  // Only the results re-render, so the field keeps focus while typing.
  'search-input'(el) {
    query = el.value;
    clearTimeout(timer);
    timer = setTimeout(async () => { resultsEl?.replaceChildren(await results()); }, 150);
  },
};
