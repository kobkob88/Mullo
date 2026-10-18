// Shared render helpers. Pure functions of their arguments → DOM nodes.

import { h, userText, textDir } from './dom.js';
import { SOURCES } from '../domain/recordings.js';
import { ACTION_TYPES } from '../domain/actions.js';
import { ONE_TAP_LABEL, DRAFT_KIND, draftOf } from '../domain/one-tap.js';
import { isDrafting } from '../domain/task-drafts.js';
import { draftBlock } from './task-draft.js';
import { languageGroups, baseCode, DEFAULT_LANGUAGE } from '../core/languages.js';
import { formatClock, formatDuration, relativeDay, timeOfDay, localDate, formatTime } from '../core/dates.js';

const STATUS_LABEL = {
  transcribing: 'Transcribing…',
  processing: 'Summarising…',
  ready: null,
  needs_transcript: 'No transcript',
  failed: 'Failed',
  stub: 'Actions only',
};

export function sourceBadge(source) {
  return h('span', { class: ['badge', `badge--${source}`] }, SOURCES[source] ?? source);
}

export function statusChip(status) {
  const label = STATUS_LABEL[status];
  return label ? h('span', { class: ['chip', `chip--${status}`] }, label) : null;
}

export function emptyState(title, body, cta) {
  return h('div', { class: 'empty' },
    h('p', { class: 'empty__title' }, title),
    body ? h('p', { class: 'empty__body' }, body) : null,
    cta ?? null);
}

export function pageHeader(title, ...extra) {
  return h('header', { class: 'page-head' }, h('h1', { class: 'page-head__title' }, title), ...extra);
}

// select: { checked } while the Library is picking notes (to join or delete);
// the card is then a tick box instead of a link.
// holdAction: a long-press (contextmenu) on the card fires it - the Library
// starts selecting from there.
export function recordingCard(rec, { openActions = 0, select = null, holdAction = null, current = false } = {}) {
  const body = [
    h('div', { class: 'rec-card__top' },
      userText('span', rec.title, { class: 'rec-card__title' }),
      statusChip(rec.status)),
    h('div', { class: 'rec-card__meta' },
      h('span', null, timeOfDay(rec.recorded_at)),
      rec.duration_ms ? h('span', null, formatDuration(rec.duration_ms)) : null,
      sourceBadge(rec.source),
      openActions ? h('span', { class: 'chip chip--actions' }, `${openActions} to do`) : null),
  ];
  if (!select) {
    return h('a', {
      class: ['card', 'rec-card', current && 'is-current'], href: `#/rec/${rec.id}`,
      'aria-current': current ? 'page' : null,
      data: holdAction ? { action: holdAction, on: 'contextmenu', id: rec.id } : undefined,
    }, body);
  }
  return h('label', { class: ['card', 'rec-card', 'rec-card--pick', select.checked && 'is-picked'] },
    h('input', {
      type: 'checkbox', class: 'rec-card__pick', checked: select.checked,
      'aria-label': `Select ${rec.title}`, data: { action: 'library-pick', id: rec.id },
    }),
    h('span', { class: 'rec-card__body' }, body));
}

export function dayHeading(dateStr) {
  return h('h2', { class: 'day-head' }, relativeDay(dateStr));
}

const TYPE_ICON = { create_reminder: '⏰', send_message: '💬', draft_email: '✉️' };

// One task. At rest it is the box, its words and one quiet line (day, kind, draft, note);
// a tap on it opens its tools in place (owner, 2026-10-15: every chip on every row felt
// packed). Only the box marks it done.
// open: its tools show. opening: it was just tapped open (slides in once, motion.js).
// flash: 'type' | 'due' | 'time', the chip a tap just changed glows once (no message).
// focused: the task a reminder's notification opened (S47).
export function actionRow(action, { recordingTitle = null, today = localDate(), focused = false, open = false, opening = false, flash = null } = {}) {
  const done = action.status === 'done';
  const overdue = !done && action.due_date && action.due_date < today;
  const time = action.due_date && action.due_time ? formatTime(action.due_time) : null;
  const dot = () => h('span', { class: 'action-row__sep', 'aria-hidden': 'true' }, '·');
  const line = [
    action.due_date
      ? h('span', { class: overdue ? 'action-row__late' : null }, [relativeDay(action.due_date, today), time && `⏰ ${time}`].filter(Boolean).join(' · '))
      : null,
    action.type !== 'create_reminder' ? h('span', null, `${TYPE_ICON[action.type] ?? ''} ${ACTION_TYPES[action.type] ?? ''}`.trim()) : null,
    !done && isDrafting(action.id) ? h('span', null, 'Writing the draft…')
      : !done && DRAFT_KIND[action.type] && draftOf(action) ? h('span', { class: 'action-row__tag' }, '✨ Draft ready') : null,
    recordingTitle ? userText('span', recordingTitle, { class: 'action-row__from' }) : null,
  ].filter(Boolean).flatMap((part, i) => (i ? [dot(), part] : [part]));
  // The whole row reads the way its text does: a Hebrew task puts the
  // checkbox on the right and aligns everything to the right edge.
  return h('li', {
    class: ['action-row', done && 'is-done', overdue && 'is-overdue', focused && 'is-focused', open && 'is-open'], dir: textDir(action.label),
    data: { flip: `task-${action.id}`, flipMode: 'size' }, // opens by growing; the rest make room (motion.js)
  },
    h('label', { class: 'action-row__check' },
      h('input', {
        type: 'checkbox', checked: done,
        'aria-label': done ? 'Mark as not done' : 'Mark as done',
        data: { action: 'action-toggle', id: action.id },
      })),
    h('div', { class: 'action-row__body' },
      h('button', {
        type: 'button', class: 'action-row__main', 'aria-expanded': String(open),
        data: { action: 'action-open', id: action.id },
      },
      action.priority === 'high' ? h('span', { class: 'action-row__high' }, h('span', { class: 'visually-hidden' }, 'High priority. ')) : null,
      h('span', { class: 'action-row__label' }, action.label),
      // Open, the tools say the same things, so the quiet line steps aside.
      line.length && !open ? h('span', { class: 'action-row__line' }, line) : null),
      open ? actionTools(action, { recordingTitle, today, focused, opening, flash, done, overdue, time }) : null));
}

function actionTools(action, { recordingTitle, today, focused, opening, flash, done, overdue, time }) {
  const hasDraft = Boolean(DRAFT_KIND[action.type] && draftOf(action));
  return h('div', { class: ['action-row__tools', opening && 'is-entering'] },
      h('div', { class: 'action-row__meta' },
        // What it is (reminder / message / email) - the AI's guess, so one tap changes it.
        done
          ? h('span', { title: ACTION_TYPES[action.type] }, TYPE_ICON[action.type] ?? '•')
          : h('select', {
            class: ['action-row__type', flash === 'type' && 'is-flash'], 'aria-label': 'What kind of task',
            data: { action: 'action-type', id: action.id },
          }, Object.entries(ACTION_TYPES).map(([value, label]) =>
            h('option', { value, selected: value === action.type }, `${TYPE_ICON[value]} ${label}`))),
        // The day, changeable in place (owner, 2026-10-12): a task with no
        // date says "Add date". The chip opens the phone's own date picker.
        done
          ? (action.due_date ? h('span', { class: 'action-row__due' }, [relativeDay(action.due_date, today), time].filter(Boolean).join(' · ')) : null)
          : h('span', { class: 'action-row__date' },
            h('button', {
              type: 'button', class: ['action-row__due', !action.due_date && 'is-empty', overdue && 'is-late', flash === 'due' && 'is-flash'],
              'aria-label': action.due_date ? `Due ${relativeDay(action.due_date, today)}, change the date` : 'Add a date',
              data: { action: 'action-due-pick' },
            }, action.due_date ? relativeDay(action.due_date, today) : '+ Date'),
            h('input', {
              type: 'date', class: 'action-row__date-input', tabindex: '-1', 'aria-hidden': 'true',
              value: action.due_date ?? '',
              data: { action: 'action-due', id: action.id },
            })),
        // The time (S47): only once there is a day. A day and a time ring on the phone.
        !done && action.due_date
          ? h('span', { class: 'action-row__date' },
            h('button', {
              type: 'button', class: ['action-row__due', !time && 'is-empty', flash === 'time' && 'is-flash'],
              'aria-label': time ? `Reminder at ${time}, change the time` : 'Add a time to be reminded',
              data: { action: 'action-due-pick' },
            }, time ? `⏰ ${time}` : '+ Time'),
            h('input', {
              type: 'time', class: 'action-row__date-input', tabindex: '-1', 'aria-hidden': 'true',
              value: action.due_time ?? '',
              data: { action: 'action-time', id: action.id },
            }))
          : null,
        action.priority === 'high' ? h('span', { class: 'chip chip--high' }, 'High') : null,
        action.source !== 'device' ? sourceBadge(action.source) : null,
        // With a draft, its own Open in mail / Send does this (no second Email button).
        done || hasDraft ? null : h('button', {
          type: 'button', class: 'action-row__do',
          data: { action: 'action-do', id: action.id },
        }, ONE_TAP_LABEL[action.type] ?? 'Open')),
      // An email or message task's draft (S50): ready to read, edit and send.
      draftBlock(action, { focused }),
      recordingTitle && action.recording_id
        ? h('a', { href: `#/rec/${action.recording_id}`, class: 'action-row__rec' }, 'From: ', userText('span', recordingTitle))
        : null);
}

// One section alone needs no heading over it (a voice note's "Note"); one line
// reads as a sentence, not a one-bullet list.
export function summaryView(summary) {
  if (!summary?.blocks?.length) return emptyState('No summary yet');
  const solo = summary.blocks.length === 1;
  return h('div', { class: ['summary', solo && 'summary--solo'] }, summary.blocks.map((b) =>
    h('section', { class: 'summary__block' },
      solo ? null : h('h3', { class: 'summary__heading' }, b.heading),
      b.items.length
        ? (b.items.length === 1
          ? userText('p', b.items[0], { class: 'summary__text' })
          : h('ul', null, b.items.map((item) => userText('li', item))))
        : h('p', { class: 'muted' }, 'Nothing here.'))));
}

export function sectionsView(sections) {
  if (!sections?.length) return emptyState('No sections yet');
  return h('ol', { class: 'sections' }, sections.map((s) =>
    h('li', { class: 'sections__item' },
      Number.isFinite(s.start_ms) ? h('span', { class: 'sections__time' }, formatClock(s.start_ms)) : null,
      h('div', null,
        userText('p', s.title, { class: 'sections__title' }),
        s.summary && s.summary !== s.title ? userText('p', s.summary, { class: 'sections__summary' }) : null))));
}

// The ~110-language picker: common ones first, then all by English name.
export function languageSelect(attrs, value) {
  const { common, all } = languageGroups();
  const chosen = baseCode(value) ?? DEFAULT_LANGUAGE;
  const opt = ([code, label]) => h('option', { value: code, selected: code === chosen }, label);
  return h('select', attrs,
    h('optgroup', { label: 'Common' }, common.map(opt)),
    h('optgroup', { label: 'All languages' }, all.map(opt)));
}

// nameOf: label → the name a person gave it. seekable: the time is a button
// that plays the audio from that moment. editable: each line gets ✎;
// editing: the index of the line open for editing.
export function transcriptView(segments, { nameOf = (x) => x, seekable = false, editable = false, editing = null, recordingId = null } = {}) {
  return h('ol', { class: 'transcript' }, segments.map((s, i) => {
    const timed = Number.isFinite(s.start_ms);
    return h('li', { class: 'transcript__turn' },
      h('span', { class: 'transcript__who' },
        s.speaker ? userText('span', nameOf(s.speaker)) : null,
        timed && seekable
          ? h('button', {
            type: 'button', class: 'transcript__time transcript__seek',
            'aria-label': `Play from ${formatClock(s.start_ms)}`, data: { action: 'seek', ms: s.start_ms },
          }, `▶ ${formatClock(s.start_ms)}`)
          : timed ? h('span', { class: 'transcript__time' }, formatClock(s.start_ms)) : null,
        editable && editing !== i
          ? h('button', { type: 'button', class: 'transcript__edit', 'aria-label': 'Edit this line', data: { action: 'segment-edit', index: i } }, '✎')
          : null),
      editing === i
        ? h('form', { class: 'stack', data: { action: 'segment-save', id: recordingId, index: i } },
          h('textarea', { name: 'text', rows: '3', dir: 'auto', 'aria-label': 'Line text' }, s.text),
          h('div', { class: 'row' },
            h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save'),
            h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'segment-cancel' } }, 'Cancel')))
        : userText('p', s.text, { class: 'transcript__text' }));
  }));
}

// After a fix: "When it hears X, write Y?" - Teach / Not now.
export function teachCard(offers) {
  if (!offers?.length) return null;
  return h('div', { class: 'card stack teach' },
    h('h2', { class: 'card__title' }, 'Teach Mullo?'),
    offers.map((o) => h('div', { class: 'teach__row' },
      h('p', { class: 'teach__text' }, 'When it hears ', userText('b', o.heard), ', write ', userText('b', o.meant)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'teach-word', heard: o.heard, meant: o.meant } }, 'Teach'),
        h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'teach-dismiss', heard: o.heard, meant: o.meant } }, 'Not now')))),
    h('p', { class: 'muted small' }, 'It goes into Settings → Names & words, and every new transcript uses it.'));
}

// One field per speaker label; saving on change.
export function speakerNamer(rec, labels) {
  return h('details', { class: 'card speakers' },
    h('summary', null, 'Name the speakers'),
    h('div', { class: 'stack' },
      labels.map((label) => h('label', { class: 'field' },
        h('span', { class: 'field__label' }, label),
        h('input', {
          dir: 'auto', value: rec.speakers?.[label] ?? '', placeholder: 'Name',
          data: { action: 'speaker-name', on: 'change', id: rec.id, label },
        })))));
}
