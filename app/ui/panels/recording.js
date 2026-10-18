// One recording: title (editable label), audio, and the four things made from
// it - summary, action items, sections, transcript. Raw audio and the full
// transcript are "private" (core/auth.js): roles without it see the summary.

import { h, userText, options } from '../dom.js';
import { pageHeader, sourceBadge, statusChip, summaryView, sectionsView, transcriptView, teachCard, speakerNamer, actionRow, emptyState, languageSelect } from '../components.js';
import { phraseChanges, newTeachings, teachEntry, lineFixes } from '../../domain/corrections.js';
import { getSettings, addVocabulary } from '../../core/settings.js';
import { ctx } from '../context.js';
import { getRecording, renameRecording, deleteRecording, nameSpeaker, speakerName, keepTranscriptFixes, addNoteUpdate, removeNoteUpdate, MAX_UPDATE_CHARS } from '../../domain/recordings.js';
import { transcriptFor, saveTranscript, segmentsFromText } from '../../domain/transcripts.js';
import { actionsFor, addAction } from '../../domain/actions.js';
import { processRecording, canTranscribe, aiEngineOn } from '../../domain/pipeline.js';
import { loadModels, pickerRows } from '../../core/models.js';
import { mulloAccount } from '../../core/account.js';
import { ownAi } from '../../core/own-ai.js';
import { isRunning, retranscribeInBackground } from '../../domain/jobs.js';
import { allFormats, formatFor } from '../../domain/formats.js';
import { recordingAsText } from '../../domain/export.js';
import { reportAbout } from '../../domain/report.js';
import { audioUrl, audioInAccount, audioBlob } from '../../core/files.js';
import { shareText, copyText } from '../../core/native.js';
import { canChat, askAbout, getThread, newChat } from '../../domain/chat.js';
import { chatBubbles, sendMessage, isThinking, chatError, retryText, clearChatError } from '../chat-view.js';
import { rowState } from './tasks.js';
import { mark, take, shrinkInto } from '../motion.js';
import { canSeePrivate, canWrite } from '../../core/auth.js';
import { formatDuration, relativeDay, timeOfDay } from '../../core/dates.js';
import { backLink } from '../router.js';

export const screen = 'recording';

const TABS = [['summary', 'Summary'], ['actions', 'Actions'], ['sections', 'Sections'], ['transcript', 'Transcript']];
let tab = 'summary';
let shownId = null;
let confirmingDelete = false;
// The two icons top right open a small sheet under them: 'share' (transcript
// tick, Share, Copy) or 'more' (re-transcribe, summarise again, delete).
let sheet = null;
let editingTitle = false;
// The audio as playable pieces: one, or one per note for joined notes, each
// with where it starts on the transcript's clock.
let audioParts = [];
let partIndex = 0;
// One blob URL per audio file, kept across re-renders: revoking it at the start
// of each render pulled the source from under a player that was playing.
const audioUrls = new Map(); // audio_file_id → blob URL
// Audio that came down from the account without its bytes downloads by itself
// when its recording opens. One try per file per session (a file the recording
// phone hasn't uploaded yet isn't asked for on every render); offline tries again.
const audioFetching = new Set();
const audioMissing = new Set();
const audioOffline = new Map(); // id → when a try found no connection (waits a minute)
function fetchAudioInBackground(ids) {
  const now = Date.now();
  const todo = ids.filter((id) => !audioFetching.has(id) && !audioMissing.has(id) && !(now - (audioOffline.get(id) ?? 0) < 60_000));
  if (!todo.length) return;
  for (const id of todo) audioFetching.add(id);
  (async () => {
    for (const id of todo) {
      try {
        if (!(await audioBlob(id))) audioMissing.add(id);
      } catch (err) {
        if (err.offline) audioOffline.set(id, Date.now());
        else audioMissing.add(id);
      } finally {
        audioFetching.delete(id);
      }
    }
    ctx.refresh();
  })();
}

function audioNote(ids) {
  if (!ids.length) return null;
  const say = (text) => h('p', { class: 'muted small' }, text);
  if (ids.some((id) => audioFetching.has(id))) return say('Getting the audio from your account…');
  if (ids.every((id) => audioMissing.has(id))) return say('The audio isn\'t in your account yet. The phone that recorded it uploads it when it\'s online.');
  return say('The audio is in your account. It downloads when you\'re online.');
}

// Transcript fixing: which line is open, what Mullo could learn from the last
// fix, and whether the summary/tasks were made from words since changed.
let editingLine = null;
let teachOffers = [];
let summaryStale = false;
// The chat about this recording opens as a sheet over the page (owner, 2026-10-15, like
// Pocket's): under the tabs it read as part of the summary. chatToEnd: the next render
// scrolls the sheet to its newest message (on opening, and after sending).
let chatOpen = false;
let chatToEnd = false;

export async function render({ id, inReader = false }) {
  if (shownId !== id) {
    tab = 'summary'; confirmingDelete = false; sheet = null; editingTitle = false; shownId = id;
    editingLine = null; teachOffers = []; summaryStale = false; partIndex = 0; chatOpen = false;
  }
  const rec = await getRecording(id);
  if (!rec) return emptyState('This recording is gone', 'It may have been deleted. Deleted recordings can be restored from Activity.', h('a', { class: 'btn', href: '#/activity' }, 'Open Activity'));

  const [transcript, items] = await Promise.all([transcriptFor(id), actionsFor(id)]);
  const segments = transcript?.segments ?? [];
  const privateOk = canSeePrivate('recording');
  const editable = canWrite('recordings');

  audioParts = [];
  let audioGone = false;
  const audioToFetch = [];
  const pieces = !privateOk ? []
    : rec.parts?.length ? rec.parts
      : rec.audio_file_id ? [{ audio_file_id: rec.audio_file_id, offset_ms: 0 }] : [];
  const keep = new Set(pieces.map((p) => p.audio_file_id));
  for (const [id, url] of audioUrls) if (!keep.has(id)) { URL.revokeObjectURL(url); audioUrls.delete(id); }
  if (privateOk) {
    for (const p of pieces) {
      if (!audioUrls.has(p.audio_file_id)) {
        const url = await audioUrl(p.audio_file_id);
        if (url) audioUrls.set(p.audio_file_id, url);
      }
      const url = audioUrls.get(p.audio_file_id);
      if (url) audioParts.push({ url, offset_ms: p.offset_ms ?? 0 });
    }
    audioGone = pieces.length > 0 && !audioParts.length;
    // Came down from the account without its bytes: they download now, by themselves.
    if (audioGone) {
      for (const p of pieces) if (await audioInAccount(p.audio_file_id)) audioToFetch.push(p.audio_file_id);
      fetchAudioInBackground(audioToFetch);
      if (audioToFetch.length) audioGone = false;
    }
  }
  if (partIndex >= audioParts.length) partIndex = 0;
  const joined = rec.parts?.length > 1;

  const openCount = items.filter((a) => a.status === 'open' || a.status === 'in_progress').length;
  // A short note has no sections: no empty tab for them.
  const shownTabs = TABS.filter(([value]) => value !== 'sections' || rec.sections?.length);
  if (!shownTabs.some(([value]) => value === tab)) tab = 'summary';
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, shownTabs.map(([value, label]) =>
    h('button', {
      type: 'button', role: 'tab', class: ['tab', tab === value && 'is-active'],
      'aria-selected': String(tab === value), data: { action: 'rec-tab', tab: value },
    }, label, value === 'actions' && openCount ? h('span', { class: 'tab__count' }, String(openCount)) : null,
    // The line under the chosen tab slides to the next one (motion.js).
    tab === value ? h('span', { class: 'tab__bar', 'aria-hidden': 'true', data: { flip: 'rec-tab-bar', flipMode: 'slide' } }) : null)));

  const hasTranscript = segments.length > 0;
  if (audioParts.length) nowPlaying(rec);
  // Re-transcribing a joined note would hear only its first part.
  const canRetranscribe = audioParts.length > 0 && !joined && editable && canTranscribe();
  const canResummarise = editable && hasTranscript;
  const hasMore = !working(rec) && editable; // Delete at least
  if (working(rec) || (sheet === 'more' && !hasMore)) sheet = null;
  const chatHere = canChat() && (Boolean(rec.summary?.blocks?.length) || (privateOk && hasTranscript));
  return h('div', { class: ['rec-detail', chatHere && 'has-chat-bar'] },
    h('div', { class: 'rec-detail__top' },
      // Beside the Library list (a computer, 1200px+) the list is the way back.
      inReader ? h('span', { 'aria-hidden': 'true' }) : backTo(),
      working(rec) ? null : h('div', { class: 'rec-detail__tools' },
        iconButton('share', 'Share', shareIcon()),
        hasMore ? iconButton('more', 'More', moreIcon()) : null)),
    sheet === 'share' ? shareSheet(rec, { privateOk, hasTranscript }) : null,
    sheet === 'more' ? moreSheet(rec, { canRetranscribe, canResummarise, editable }) : null,
    // The title wraps as a heading; tapping it turns it into a field (one line can't wrap).
    editable && editingTitle
      ? h('input', {
        id: 'rec-title', class: 'title-input', value: rec.title, dir: 'auto', 'aria-label': 'Title',
        data: { action: 'rec-rename', on: 'change', id: rec.id, stamp: rec.updated_at },
      })
      : editable
        ? h('h1', { class: 'rec-title' },
          userText('button', rec.title, { type: 'button', class: 'rec-title__edit', 'aria-label': `${rec.title}, rename`, data: { action: 'rec-title-edit' } }))
        : pageHeader(rec.title),
    h('div', { class: 'rec-detail__meta' },
      h('span', null, `${relativeDay(rec.local_date)} · ${timeOfDay(rec.recorded_at)}`),
      rec.duration_ms ? h('span', null, formatDuration(rec.duration_ms)) : null,
      sourceBadge(rec.source),
      rec.joined_count > 1 ? h('span', { class: 'chip' }, `Joined from ${rec.joined_count} notes`) : null,
      statusChip(rec.status)),
    working(rec)
      ? h('p', { class: 'notice notice--info' }, rec.status === 'transcribing'
        ? 'Gemini is writing the transcript in the background - this page fills in when it’s done. You can leave it.'
        : 'Summarising in the background - this page fills in when it’s done.')
      : null,
    rec.transcribe_error && !working(rec)
      ? h('p', { class: 'notice' }, transcribeErrorText(rec))
      : null,
    rec.no_speech && !working(rec)
      ? h('p', { class: 'notice' }, 'No speech was heard in this recording, so it wasn’t sent to the AI. If you did speak, tap Re-transcribe.')
      : null,
    rec.flags?.includes('transliterated')
      ? h('p', { class: 'notice' }, 'This transcript looks like Hebrew written in Latin letters - the source app likely guessed the wrong language.')
      : null,
    !hasTranscript && audioParts.length && !working(rec) && !canTranscribe() ? noAiNotice() : null,
    audioParts.length ? h('audio', { class: 'player', controls: true, preload: 'metadata', src: audioParts[partIndex].url }) : null,
    audioParts.length > 1
      ? h('div', { class: 'parts', role: 'group', 'aria-label': 'Play a part' },
        h('span', { class: 'muted small' }, 'Part'),
        audioParts.map((p, i) => h('button', {
          type: 'button', class: ['pill', i === partIndex && 'is-active'], 'aria-pressed': String(i === partIndex),
          data: { action: 'play-part', index: i },
        }, String(i + 1))))
      : null,
    audioGone ? h('p', { class: 'muted small' }, 'The audio is no longer on this phone - the words stay.') : null,
    audioNote(audioToFetch),
    tabs,
    // The new tab's page comes in from the side its tab is on.
    h('div', { class: ['tab-panel', take('rec-tab-next') && 'enter-next', take('rec-tab-prev') && 'enter-prev'], role: 'tabpanel' }, renderTab(rec, segments, items, { privateOk, editable })),
    chatHere ? (chatOpen ? chatSheet(rec) : chatBar(rec)) : null);
}

// What to try in a fresh chat; a tap sends it.
const CHAT_STARTERS = ['What did we agree on?', 'Write an email about this', 'Move these tasks to tomorrow'];

// The whole chat about this recording, over the page. Only in the page while open, so
// nothing hidden stays tappable.
function chatSheet(rec) {
  const thread = getThread();
  const mine = thread.focus === rec.id;
  const bubbles = mine ? chatBubbles(thread, new Map([[rec.id, rec]]), { sources: false }) : [];
  const error = chatError();
  const busy = isThinking();
  const toEnd = chatToEnd;
  chatToEnd = false;
  const entering = take('chat-sheet');
  return [
    h('button', { type: 'button', class: ['chat-sheet-backdrop', entering && 'is-entering'], 'aria-label': 'Close the chat', data: { action: 'rec-chat-close' } }),
    // Grows out of the chat bar it replaces, and shrinks back into it (motion.js).
    h('div', {
      class: ['chat-sheet', entering && 'is-entering'], role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Chat about this recording',
      data: { flip: 'rec-chat', flipMode: 'morph' },
    },
      h('div', { class: 'chat-sheet__head' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the chat', data: { action: 'rec-chat-close' } }, chevronDownIcon()),
        h('div', { class: 'chat-sheet__title' },
          h('span', { class: 'muted small' }, 'Asking about'),
          userText('span', rec.title, { class: 'chat-sheet__rec' })),
        bubbles.length ? h('button', { type: 'button', class: 'btn btn--ghost btn--small', disabled: busy, data: { action: 'rec-chat-new', id: rec.id } }, 'New chat') : null),
      h('div', { class: 'chat-sheet__body stack' },
        bubbles.length
          ? h('div', { class: 'chat__thread', role: 'log', 'aria-live': 'polite' }, bubbles)
          : h('div', { class: 'chat-sheet__starters stack' },
            h('p', { class: 'muted small' }, 'Ask about this note, have Mullo write from it, or move and tick off its tasks.'),
            CHAT_STARTERS.map((text) => h('button', { type: 'button', class: 'pill chat-sheet__starter', data: { action: 'rec-chat-starter', id: rec.id, text } }, text))),
        error ? h('p', { class: 'notice notice--alert' }, error) : null,
        toEnd ? h('span', { class: 'chat-sheet__end', data: { scrollHere: '' } }) : null),
      chatBar(rec, { inSheet: true })),
  ];
}

// The message box: a bar above the tab bar, beside the record button, while the sheet is
// closed (with a button back into an earlier chat about this recording); the sheet's foot
// while open. Ask about it, or ask Mullo to move or tick off its tasks (suggested, applied
// on a tap) or write from it.
function chatBar(rec, { inSheet = false } = {}) {
  const busy = isThinking();
  const thread = getThread();
  const mine = thread.focus === rec.id;
  const earlier = mine ? thread.messages.length : 0;
  return h('form', {
    class: inSheet ? 'chat-bar chat-bar--sheet' : 'chat-bar',
    data: { action: 'rec-chat', id: rec.id, flip: inSheet ? null : 'rec-chat' },
  },
    !inSheet && (earlier || (mine && busy))
      ? h('button', { type: 'button', class: 'chat-bar__open', 'aria-label': `Open the chat (${earlier} messages)`, data: { action: 'rec-chat-open' } }, chatIcon())
      : null,
    h('input', {
      name: 'message', class: 'chat-bar__field', dir: 'auto', autocomplete: 'off', enterkeyhint: 'send',
      value: mine ? retryText() : '', 'aria-label': 'Message to Mullo about this recording',
      placeholder: busy ? 'Thinking…' : inSheet && earlier ? 'Ask a follow-up…' : 'Ask, or tell Mullo what to do',
      data: { draft: `rec-chat-${rec.id}` },
    }),
    h('button', { type: 'submit', class: 'chat-bar__send', 'aria-label': 'Send', disabled: busy }, sendIcon()));
}

// An arrow pointing up, like other chat apps' send.
const sendIcon = () => icon([['path', { d: 'M12 19V5M5.5 11.5L12 5l6.5 6.5', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }]]);
// A chevron pointing down: the sheet goes back down.
const chevronDownIcon = () => icon([['path', { d: 'M6 9.5l6 6 6-6', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }]]);
// A speech bubble: the chat so far.
const chatIcon = () => icon([['path', { d: 'M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linejoin': 'round', fill: 'none' }]]);

// Icons drawn as SVG: h() makes HTML elements only.
const SVG = 'http://www.w3.org/2000/svg';
function icon(shapes) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}
// Three joined dots.
const shareIcon = () => icon([
  ['path', { d: 'M8.6 10.7l6.8-3.9M8.6 13.3l6.8 3.9', stroke: 'currentColor', 'stroke-width': 1.8, fill: 'none' }],
  ...[[6, 12], [18, 5.5], [18, 18.5]].map(([cx, cy]) => ['circle', { cx, cy, r: 2.6, fill: 'currentColor' }])]);
// Three dots in a row.
const moreIcon = () => icon([[5, 12], [12, 12], [19, 12]].map(([cx, cy]) => ['circle', { cx, cy, r: 2, fill: 'currentColor' }]));

function iconButton(which, label, svg) {
  const open = sheet === which;
  return h('button', {
    type: 'button', class: ['icon-btn', open && 'is-active'], 'aria-label': label, 'aria-expanded': String(open),
    data: { action: 'rec-sheet', sheet: which },
  }, svg);
}

// "Summarise again with": the models this plan allows (the server checks again on the call).
// Asked each time the sheet opens; their own OpenAI or Claude key has no list.
let modelsReport = null;
let modelsAsked = false;
function modelSelect() {
  if (!aiEngineOn() || !mulloAccount().user()) return null;
  const key = ownAi(ctx.config);
  if (key && key.provider !== 'gemini') return null;
  if (!modelsAsked) {
    modelsAsked = true;
    loadModels(ctx.config.bridgeUrl).then((r) => { modelsReport = r; ctx.refresh({ force: true }); }, () => { modelsAsked = false; });
  }
  const rows = pickerRows(modelsReport, { ownGemini: key?.provider === 'gemini' }).filter((m) => m.allowed);
  if (rows.length < 2) return null;
  return h('select', { id: 'rec-model', 'aria-label': 'AI model' },
    rows.map((m) => h('option', { value: m.id, selected: m.current }, m.label)));
}

// Saved while the AI couldn't run (no Mullo sign-in, or nothing left to pay with): say why,
// instead of a bare "No transcript" with Re-transcribe missing from More (owner, 2026-10-17:
// a recording recovered on a signed-out iPhone looked broken).
function noAiNotice() {
  return mulloAccount().user()
    ? h('p', { class: 'notice' }, 'Transcribing isn’t available on this account right now. ',
      h('a', { href: '#/settings/subscription' }, 'Check your plan'))
    : h('p', { class: 'notice' }, 'Sign in to have Mullo transcribe this recording. ',
      h('a', { href: '#/settings/account' }, 'Sign in'));
}

// The lock screen / Control Center player: this recording's title and Mullo's icon. Without it
// iOS drew its own tile, with white corners around the icon (owner, 2026-10-17).
function nowPlaying(rec) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata !== 'function') return;
  const icon = (file, size) => ({ src: new URL(`icons/${file}`, document.baseURI).href, sizes: size, type: 'image/png' });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: rec.title, artist: 'Mullo',
    artwork: [icon('icon-192.png', '192x192'), icon('icon-512.png', '512x512')],
  });
}

// What a person does to a recording now and then: hear it again, summarise it
// again in another format, delete it. Kept out of the way of reading it.
function moreSheet(rec, { canRetranscribe, canResummarise, editable }) {
  return h('div', { class: ['card', 'stack', 'sheet', take('rec-sheet') && 'is-entering'] },
    canRetranscribe
      ? h('div', { class: 'stack sheet__group' },
        h('p', { class: 'sheet__label' }, 'Transcribe again, in'),
        retranscribeRow(rec),
        rec.transcript_fixes?.length
          ? h('p', { class: 'muted small' }, `Your ${rec.transcript_fixes.length === 1 ? 'fix' : `${rec.transcript_fixes.length} fixes`} to the transcript will be kept.`)
          : null)
      : null,
    canResummarise
      ? h('div', { class: 'stack sheet__group' },
        h('p', { class: 'sheet__label' }, 'Summarise again, as'),
        h('div', { class: 'retranscribe' },
          h('select', { id: 'rec-template', 'aria-label': 'Summary format' },
            options(allFormats().map((t) => [t.id, t.label]), rec.template)),
          modelSelect(),
          h('button', { type: 'button', class: 'btn', data: { action: 'rec-reprocess', id: rec.id } }, 'Summarise again')))
      : null,
    // S56: only the note's id travels with the report, never its words.
    h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'rec-report', id: rec.id } }, 'Report a problem with this note'),
    editable ? deleteZone(rec) : null);
}

// To a message, an email, notes, or a chat with an AI.
function shareSheet(rec, { privateOk, hasTranscript }) {
  return h('div', { class: ['card', 'stack', 'sheet', take('rec-sheet') && 'is-entering'] },
    privateOk && hasTranscript
      ? h('label', { class: 'row format-tasks' },
        h('input', { type: 'checkbox', id: 'share-transcript', checked: true }),
        h('span', null, 'With the transcript'))
      : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', data: { action: 'rec-share', id: rec.id } }, 'Share'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'rec-copy', id: rec.id } }, 'Copy')));
}

async function shareableText(id) {
  const rec = await getRecording(id);
  if (!rec) return null;
  const [t, actions] = await Promise.all([transcriptFor(id), actionsFor(id)]);
  const withTranscript = canSeePrivate('recording') && Boolean(document.getElementById('share-transcript')?.checked);
  const asText = (withT) => recordingAsText(rec, {
    segments: t?.segments ?? [], actions, withTranscript: withT,
    nameOf: (l) => speakerName(rec, l), when: `${rec.local_date} ${timeOfDay(rec.recorded_at)}`,
  });
  // caption: the message that goes with a long share sent as a file (core/native.js).
  return { title: rec.title, text: asText(withTranscript), caption: asText(false) };
}

// Tasks live in the Actions tab and on the Actions screen, so the summary leaves
// its task block out. Found by the format's task heading, or by holding only this
// recording's task labels (a format changed since; export.js does the same).
function withoutTaskBlock(rec, items) {
  if (!rec.summary?.blocks?.length) return rec.summary;
  const heading = formatFor(rec.template).blocks.find((b) => b.kind === 'actions')?.heading;
  const labels = new Set(items.map((a) => a.label));
  const isTasks = (b) => b.heading === heading || (b.items.length > 0 && b.items.every((i) => labels.has(i)));
  return { ...rec.summary, blocks: rec.summary.blocks.filter((b) => !isTasks(b)) };
}

// Updates under the summary (domain/recordings.js addNoteUpdate): oldest first, like a notebook page.
function updatesView(rec, editable) {
  const updates = rec.updates ?? [];
  if (!updates.length && !editable) return null;
  return h('section', { class: 'stack note-updates' },
    updates.length ? h('h3', { class: 'summary__heading' }, 'Updates') : null,
    updates.length
      ? h('ul', { class: 'note-updates__list' }, updates.map((u) => h('li', { class: 'note-update' },
        h('span', { class: 'muted small note-update__date' }, relativeDay(u.date)),
        userText('p', u.text, { class: 'note-update__text' }),
        editable
          ? h('button', { type: 'button', class: 'icon-btn note-update__remove', 'aria-label': 'Remove this update', data: { action: 'update-remove', id: rec.id, update: u.id } }, '×')
          : null)))
      : null,
    editable
      ? h('form', { class: 'row', data: { action: 'update-add', id: rec.id } },
        h('input', { name: 'text', dir: 'auto', maxlength: String(MAX_UPDATE_CHARS), placeholder: 'Add an update…', 'aria-label': 'New update', data: { draft: `update-${rec.id}` } }),
        h('button', { type: 'submit', class: 'btn' }, 'Add'))
      : null);
}

function renderTab(rec, segments, items, { privateOk, editable }) {
  if (tab === 'summary') {
    return h('div', { class: 'stack' },
      summaryView(withoutTaskBlock(rec, items)),
      updatesView(rec, editable),
      rec.engine === 'local' && rec.ai_error
        ? h('p', { class: 'notice' }, `Gemini didn’t answer (${rec.ai_error}), so this is the rough offline version. Tap ⋯ at the top, then “Summarise again”.`)
        : rec.engine === 'local'
        ? h('p', { class: 'muted small' }, 'Made on this device by the offline engine (the AI engine is off).')
        : null);
  }
  if (tab === 'actions') {
    return h('div', { class: 'stack' },
      items.length
        ? h('ul', { class: 'action-list', data: { flip: 'list-rec', flipMode: 'size' } }, items
          .sort((a, b) => (a.status === 'done') - (b.status === 'done'))
          .map((a) => actionRow(a, rowState(a))))
        : emptyState('No action items', 'Nothing in this recording sounded like a task.'),
      canWrite('action_items')
        ? h('form', { class: 'row', data: { action: 'action-add', id: rec.id } },
          h('input', { name: 'label', dir: 'auto', placeholder: 'Add an action…', 'aria-label': 'New action', data: { draft: `action-${rec.id}` } }),
          h('button', { type: 'submit', class: 'btn' }, 'Add'))
        : null);
  }
  if (tab === 'sections') return sectionsView(rec.sections);

  if (!privateOk) return emptyState('Transcript hidden', 'Your role can see the summary and action items, not the full transcript.');
  if (segments.length) {
    const labels = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
    return h('div', { class: 'stack' },
      editable ? teachCard(teachOffers) : null,
      editable && summaryStale && !working(rec)
        ? h('div', { class: 'notice notice--info row' },
          h('span', null, 'The summary and tasks were made from the old words.'),
          h('button', { type: 'button', class: 'btn', data: { action: 'rec-resummarise', id: rec.id } }, 'Update them'))
        : null,
      editable && labels.length ? speakerNamer(rec, labels) : null,
      editable && !working(rec) ? h('p', { class: 'muted small' }, 'Tap ✎ to fix a line. Mullo can learn the words it got wrong.') : null,
      transcriptView(segments, {
        nameOf: (l) => speakerName(rec, l), seekable: audioParts.length > 0,
        editable: editable && !working(rec), editing: editingLine, recordingId: rec.id,
      }));
  }
  return editable
    ? h('form', { class: 'stack', data: { action: 'rec-save-transcript', id: rec.id } },
      h('p', { class: 'muted' }, 'No transcript yet. Paste or type it - one line per turn, "Name: text" marks the speaker.'),
      h('textarea', { name: 'text', rows: '8', dir: 'auto', data: { draft: `transcript-${rec.id}` } }),
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save and summarise'))
    : emptyState('No transcript');
}

// Why the last transcription didn't finish (jobs.js keeps it), and what tapping does now.
// With a job id kept, Re-transcribe collects the server's transcript instead of sending again.
function transcribeErrorText(rec) {
  const { message, offline, pending } = rec.transcribe_error;
  if (offline) return `${message} Tap Re-transcribe when you have signal${rec.transcribe_job ? ' to collect it' : ''}.`;
  if (pending) return message;
  return `The last transcription didn’t finish: ${message}. Tap Re-transcribe to try again.`;
}

const working = (rec) => isRunning(rec.id) || rec.status === 'transcribing' || rec.status === 'processing';

function retranscribeRow(rec) {
  const busy = working(rec);
  return h('div', { class: 'retranscribe' },
    languageSelect({ id: 'retranscribe-lang', 'aria-label': 'Language spoken', disabled: busy }, rec.language),
    h('button', {
      type: 'button', class: 'btn', disabled: busy,
      data: { action: 'rec-retranscribe', id: rec.id },
    }, busy ? 'Transcribing…' : 'Re-transcribe'),
    busy ? h('p', { class: 'muted small retranscribe__note' }, 'Sending the audio to Gemini - this can take a minute for long recordings.') : null);
}

// Switches the one player to part i and plays from atMs into it. Setting the
// time before the new source has loaded is fine: the player starts there.
function playPart(i, atMs) {
  const player = document.querySelector('audio.player');
  if (!player || !audioParts[i]) return;
  if (i !== partIndex) {
    partIndex = i;
    player.src = audioParts[i].url;
    for (const b of document.querySelectorAll('[data-action="play-part"]')) {
      const on = Number(b.dataset.index) === i;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  player.currentTime = Math.max(0, atMs) / 1000;
  player.play().catch(() => { /* the browser wants a direct tap on the player */ });
}

function deleteZone(rec) {
  if (!confirmingDelete) {
    return h('div', { class: 'danger-zone' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--danger', data: { action: 'rec-delete-ask' } }, 'Delete recording'));
  }
  return h('form', { class: 'danger-zone card stack', data: { action: 'rec-delete', id: rec.id, stamp: rec.updated_at } },
    h('p', null, 'Delete this recording, its transcript and its action items? You can restore it from Activity.'),
    h('input', { name: 'reason', dir: 'auto', placeholder: 'Why? (optional, kept in Activity)', 'aria-label': 'Reason' }),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn btn--danger' }, 'Delete'),
      h('button', { type: 'button', class: 'btn', data: { action: 'rec-delete-cancel' } }, 'Keep it')));
}

// Back to where the recording was opened from (Actions, Search), else the Library.
function backTo() {
  const back = backLink();
  return h('a', { class: 'back', href: back.hash, data: { action: 'rec-back', previous: back.isPrevious ? '1' : '' } }, `‹ ${back.label}`);
}

export const actions = {
  // A step back in history when that's where it leads, so the phone's back gesture
  // afterwards doesn't return to this recording.
  'rec-back'(el) {
    if (el.dataset.previous) history.back();
    else ctx.go(el.getAttribute('href'));
  },

  'rec-tab'(el) {
    const order = TABS.map(([value]) => value);
    if (tab !== el.dataset.tab) mark(order.indexOf(el.dataset.tab) > order.indexOf(tab) ? 'rec-tab-next' : 'rec-tab-prev');
    tab = el.dataset.tab;
    ctx.refresh({ force: true });
  },

  // The field appears on the next render; focus it once it's there.
  'rec-title-edit'() {
    editingTitle = true;
    ctx.refresh({ force: true });
    const focusWhenShown = (tries) => {
      const input = document.getElementById('rec-title');
      if (input) { input.focus(); input.select(); return; }
      if (tries) setTimeout(() => focusWhenShown(tries - 1), 25);
    };
    focusWhenShown(20);
  },

  async 'rec-rename'(el) {
    editingTitle = false;
    const res = await renameRecording({ id: el.dataset.id, updated_at: el.dataset.stamp }, el.value);
    if (res.error) ctx.toast(res.error, { error: true });
    else if (!res.ok) ctx.toast('Someone changed this recording meanwhile - your title was not saved. Try again.', { error: true });
    ctx.refresh({ force: true });
  },

  async 'rec-reprocess'(el) {
    const template = document.getElementById('rec-template')?.value;
    const model = document.getElementById('rec-model')?.value || null;
    el.disabled = true;
    const result = await processRecording(el.dataset.id, { template, model });
    sheet = null;
    ctx.toast(result.ok ? 'Summary updated' : result.error, { error: !result.ok });
    ctx.refresh({ force: true });
  },

  'rec-report'(el) {
    sheet = null;
    reportAbout(el.dataset.id);
    ctx.go('#/settings/report');
  },

  async 'update-add'(form) {
    const input = form.elements.text;
    const res = await addNoteUpdate(form.dataset.id, input.value);
    if (!res.ok) { ctx.toast(res.error, { error: true }); return; }
    input.value = '';
    ctx.refresh({ force: true });
  },

  async 'update-remove'(el) {
    const rec = await getRecording(el.dataset.id);
    if (!rec) return;
    const res = await removeNoteUpdate(rec, el.dataset.update);
    ctx.toast(res.ok ? 'Update removed. Undo from Activity.' : res.error, { error: !res.ok });
    ctx.refresh({ force: true });
  },

  async 'action-add'(form) {
    const input = form.elements.label;
    const res = await addAction(form.dataset.id, { label: input.value }, { reason: 'added by hand' });
    if (res.error) { ctx.toast(res.error, { error: true }); return; }
    input.value = '';
    ctx.refresh({ force: true });
  },

  async 'rec-save-transcript'(form) {
    const segments = segmentsFromText(form.elements.text.value);
    if (!segments.length) { ctx.toast('Paste the transcript first'); return; }
    await saveTranscript(form.dataset.id, segments, { origin: 'typed', reason: 'added by hand' });
    form.elements.text.value = '';
    const result = await processRecording(form.dataset.id);
    ctx.toast(result.ok ? 'Summarised' : result.error, { error: !result.ok });
    tab = 'summary';
    ctx.refresh({ force: true });
  },

  'segment-edit'(el) { editingLine = Number(el.dataset.index); ctx.refresh({ force: true }); },
  'segment-cancel'() { editingLine = null; ctx.refresh({ force: true }); },

  // Saves one fixed line (the old transcript stays in Activity), then offers to
  // teach the words that were swapped.
  async 'segment-save'(form) {
    const id = form.dataset.id;
    const index = Number(form.dataset.index);
    const t = await transcriptFor(id);
    const line = t?.segments?.[index];
    if (!line) { editingLine = null; ctx.refresh({ force: true }); return; }
    const text = form.elements.text.value.replace(/\s+/g, ' ').trim();
    editingLine = null;
    if (text === line.text) { ctx.refresh({ force: true }); return; }
    const segments = t.segments.map((s, i) => (i === index ? { ...s, text } : s));
    const res = await saveTranscript(id, segments, { language: t.language, origin: t.origin, reason: 'line fixed by hand' });
    if (res && res.ok === false) { ctx.toast('This transcript changed meanwhile - try again.', { error: true }); ctx.refresh({ force: true }); return; }
    // Kept with the recording, so Re-transcribe can't put the old words back.
    const rec = await getRecording(id);
    if (rec) await keepTranscriptFixes(rec, lineFixes(line.text, text));
    const offers = newTeachings(phraseChanges(line.text, text), getSettings().vocabulary);
    teachOffers = [...offers, ...teachOffers].slice(0, 5);
    summaryStale = true; // the line shows the change; "summary is out of date" says the rest
    ctx.refresh({ force: true });
  },

  'teach-word'(el) {
    const { heard, meant } = el.dataset;
    const result = addVocabulary(teachEntry(meant, heard));
    teachOffers = teachOffers.filter((o) => !(o.heard === heard && o.meant === meant));
    ctx.toast(result === 'full'
      ? 'Names & words is full - remove one in Settings first'
      : `Got it: Mullo will write "${meant}" from now on`, { error: result === 'full' });
    ctx.refresh({ force: true });
  },

  'teach-dismiss'(el) {
    const { heard, meant } = el.dataset;
    teachOffers = teachOffers.filter((o) => !(o.heard === heard && o.meant === meant));
    ctx.refresh({ force: true });
  },

  async 'rec-resummarise'(el) {
    summaryStale = false;
    const result = await processRecording(el.dataset.id);
    ctx.toast(result.ok ? 'Summary and tasks updated' : result.error, { error: !result.ok });
    tab = 'summary';
    ctx.refresh({ force: true });
  },

  // A time on the transcript: play the part it falls in, from that moment.
  seek(el) {
    const ms = Number(el.dataset.ms);
    let i = 0;
    audioParts.forEach((p, n) => { if (p.offset_ms <= ms) i = n; });
    playPart(i, ms - (audioParts[i]?.offset_ms ?? 0));
  },

  'play-part'(el) { playPart(Number(el.dataset.index), 0); },

  async 'speaker-name'(el) {
    const rec = await getRecording(el.dataset.id);
    if (!rec) return;
    const res = await nameSpeaker(rec, el.dataset.label, el.value);
    if (!res.ok) ctx.toast('This recording changed meanwhile - try again.', { error: true });
    else ctx.toast(el.value.trim() ? `${el.dataset.label} is now ${el.value.trim()} - tap “Summarise again” to use the name` : 'Name removed');
    ctx.refresh({ force: true });
  },

  // Runs in the background; the app tells the person when it's done (app.js).
  'rec-retranscribe'(el) {
    const id = el.dataset.id;
    if (isRunning(id)) return;
    const language = document.getElementById('retranscribe-lang')?.value;
    retranscribeInBackground(id, { language });
    ctx.toast('Re-transcribing in the background - the old transcript stays in Activity');
    ctx.refresh({ force: true });
  },

  async 'rec-share'(el) {
    const out = await shareableText(el.dataset.id);
    if (!out) return;
    const result = await shareText(out.title, out.text, { caption: out.caption });
    if (result === 'copied') ctx.toast('Copied - paste it anywhere');
    else if (result === 'failed') ctx.toast('Sharing isn’t available here', { error: true });
  },

  async 'rec-copy'(el) {
    const out = await shareableText(el.dataset.id);
    if (!out) return;
    const copied = await copyText(out.text);
    ctx.toast(copied ? 'Copied - paste it anywhere' : 'Couldn’t copy here', { error: !copied });
  },

  'rec-sheet'(el) {
    sheet = sheet === el.dataset.sheet ? null : el.dataset.sheet;
    if (sheet) mark('rec-sheet');
    if (sheet === 'more') modelsAsked = false; // the pick may have changed in Settings
    confirmingDelete = false;
    ctx.refresh({ force: true });
  },

  // Sent as a chat about this recording (a chat already about it carries on); the sheet
  // opens with it.
  async 'rec-chat'(form) {
    const field = form.elements.message;
    const text = field.value;
    if (!text.trim() || isThinking()) return;
    askAbout(form.dataset.id);
    field.value = '';
    field.blur(); // the keyboard goes; the answer appears in the sheet
    if (!chatOpen) mark('chat-sheet');
    chatOpen = true;
    chatToEnd = true;
    if (!(await sendMessage(text))) field.value = text;
  },

  async 'rec-chat-starter'(el) {
    if (isThinking()) return;
    askAbout(el.dataset.id);
    chatToEnd = true;
    await sendMessage(el.dataset.text);
  },

  'rec-chat-open'() {
    mark('chat-sheet');
    chatOpen = true;
    chatToEnd = true;
    ctx.refresh({ force: true });
  },

  async 'rec-chat-close'() {
    if (!chatOpen) return;
    await shrinkInto(document.querySelector('.chat-sheet'), 'rec-chat', document.querySelector('.chat-sheet-backdrop'));
    chatOpen = false;
    ctx.refresh({ force: true });
  },

  // A clean page for this recording; the old chat is gone from the device (it was never synced).
  'rec-chat-new'(el) {
    if (isThinking()) return;
    newChat({ focus: el.dataset.id });
    clearChatError();
    ctx.refresh({ force: true });
  },

  'rec-delete-ask'() { confirmingDelete = true; ctx.refresh({ force: true }); },
  'rec-delete-cancel'() { confirmingDelete = false; ctx.refresh({ force: true }); },

  async 'rec-delete'(form) {
    const rec = await getRecording(form.dataset.id);
    if (!rec) return;
    const res = await deleteRecording(rec, { reason: form.elements.reason.value.trim() || null });
    confirmingDelete = false;
    if (!res.ok) { ctx.toast('It changed meanwhile - have another look before deleting.', { error: true }); ctx.refresh({ force: true }); return; }
    ctx.toast('Recording deleted - restore it from Activity if needed');
    ctx.go('#/library');
  },
};
