// Library: every recording, newest first, grouped by local day (Pocket's
// timeline). Filter by source. Select (or long-press a card) → tick → Join
// puts several notes into one, or Delete removes them together. Only ever
// when the person asks (owner, 2026-10-06: no offer card).

import { h } from '../dom.js';
import { listRecordings, deleteRecordings, SOURCES } from '../../domain/recordings.js';
import { listActions } from '../../domain/actions.js';
import { joinRecordings, canJoin } from '../../domain/join.js';
import { canWrite } from '../../core/auth.js';
import { pageHeader, recordingCard, dayHeading, emptyState } from '../components.js';
import { ctx } from '../context.js';
import { mascot } from '../mascot.js';
import { appMood } from '../mood.js';
import { formatDuration } from '../../core/dates.js';
import * as recording from './recording.js';
import * as today from '../today.js';

export const screen = 'library';

let sourceFilter = 'all';
let selecting = false;
const selected = new Set();
let busy = false;
let confirmingDelete = false;

export async function render({ open: openId = null, wide = false } = {}) {
  const [recordings, actions] = await Promise.all([listRecordings(), listActions()]);
  const open = new Map();
  for (const a of actions) {
    if (a.status === 'open' || a.status === 'in_progress') open.set(a.recording_id, (open.get(a.recording_id) ?? 0) + 1);
  }
  const shown = recordings.filter((r) => sourceFilter === 'all' || r.source === sourceFilter);
  const present = new Set(recordings.map((r) => r.source));
  // A selection only ever holds notes that are still here.
  for (const id of selected) if (!recordings.some((r) => r.id === id)) selected.delete(id);

  const filters = present.size > 1
    ? h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by source' },
      [['all', 'All'], ...Object.entries(SOURCES).filter(([k]) => present.has(k))].map(([value, label]) =>
        h('button', {
          type: 'button', class: ['pill', sourceFilter === value && 'is-active'],
          'aria-pressed': String(sourceFilter === value),
          data: { action: 'library-source', source: value },
        }, label)))
    : null;

  if (!recordings.length) {
    return h('div', null,
      pageHeader('Library'),
      h('div', { class: 'mullo-stage mullo-stage--empty' }, mascot('idle', { size: 'empty' })),
      emptyState('Nothing to mull yet',
        'Tap the red button below to record a meeting or a thought, or use your watch.'));
  }

  const groups = new Map();
  for (const r of shown) {
    if (!groups.has(r.local_date)) groups.set(r.local_date, []);
    groups.get(r.local_date).push(r);
  }

  const maySelect = canWrite('recordings');
  if (!maySelect) selecting = false;
  const picked = recordings.filter((r) => selected.has(r.id));

  const list = h('div', null,
    pageHeader('Library',
      h('span', { class: 'muted' }, `${recordings.length} recordings`),
      maySelect && !selecting
        ? h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'library-select' } }, 'Select')
        : null),
    selecting ? null : moodCard(recordings, open),
    selecting ? selectBar(picked) : null,
    filters,
    [...groups].map(([day, recs]) => h('section', { class: 'day' },
      dayHeading(day),
      h('div', { class: 'stack' }, recs.map((r) => recordingCard(r, {
        openActions: open.get(r.id) ?? 0,
        select: selecting ? { checked: selected.has(r.id) } : null,
        // Long-press a card: start selecting with it ticked.
        holdAction: maySelect && !selecting ? 'library-hold' : null,
        current: wide && r.id === openId,
      }))))));
  if (!wide) return list;
  // A computer, 1200px+ (desktop layout, 2026-10-17): the list and a reader side by side, each
  // scrolling on its own. The reader starts on the greeting ("Today").
  return h('div', { class: 'lib-split' },
    h('div', { class: 'lib-split__list', data: { keepScroll: 'library-list' } },
      h('a', { class: ['card', 'today-row', !openId && 'is-current'], href: '#/library', 'aria-current': openId ? null : 'page' },
        h('span', { class: 'today-row__title' }, 'Today'),
        h('span', { class: 'today-row__line' }, 'Your day and open actions')),
      list),
    h('div', { class: 'lib-split__reader', data: { keepScroll: `reader:${openId ?? 'today'}` } },
      openId ? await recording.render({ id: openId, inReader: true }) : await today.render()));
}

// A slim card on top while Mullo has something to say about one recording:
// mulling it, just made it ready, heard no speech, or waiting for a connection.
// Tapping it opens that recording (which also clears ready / no speech).
function moodCard(recordings, open) {
  const { mood, recording: rec, watchNote } = appMood(recordings);
  // A watch note the phone is making ready in the background: no recording to
  // open yet, so the card is not a link. It becomes "Ready" once it lands.
  if (watchNote) {
    return h('div', { class: ['card', 'mood-card', 'mood-card--mulling'] },
      mascot('mulling', { size: 'card' }),
      h('span', { class: 'mood-card__text' },
        h('span', { class: 'mood-card__title' }, 'Mulling it over'),
        h('span', { class: 'mood-card__line' },
          ['From your watch', watchNote.duration_ms ? formatDuration(watchNote.duration_ms) : null].filter(Boolean).join(' · '))));
  }
  if (!rec || mood === 'idle' || mood === 'listening') return null;
  const n = open.get(rec.id) ?? 0;
  const [title, line] = {
    mulling: ['Mulling it over', [rec.title, rec.duration_ms ? formatDuration(rec.duration_ms) : null].filter(Boolean).join(' · ')],
    ready: [`Ready: ${rec.title}`, `${n ? `${n} action${n === 1 ? '' : 's'} · ` : ''}tap to open`],
    silent: ['No speech heard', 'Nothing was sent to the AI'],
    offline: ['Connection dropped · will retry', 'Your recording is safe on this phone'],
  }[mood];
  return h('a', { class: ['card', 'mood-card', `mood-card--${mood}`], href: `#/rec/${rec.id}` },
    mascot(mood, { size: 'card' }),
    h('span', { class: 'mood-card__text' },
      h('span', { class: 'mood-card__title', dir: 'auto' }, title),
      h('span', { class: 'mood-card__line', dir: 'auto' }, line)));
}

// Join needs 2+ finished notes; Delete takes anything, after a second tap.
function selectBar(picked) {
  const n = picked.length;
  const joinable = n >= 2 && picked.every(canJoin);
  if (confirmingDelete && n) {
    return h('div', { class: 'card select-bar select-bar--danger' },
      h('span', null, `Delete ${n} recording${n === 1 ? '' : 's'}, with their transcripts and tasks? You can restore them from Activity, all at once.`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--danger', disabled: busy, data: { action: 'library-delete' } }, busy ? 'Deleting…' : `Delete ${n}`),
        h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'library-delete-cancel' } }, 'Keep them')));
  }
  return h('div', { class: 'card select-bar' },
    h('span', null, n ? `${n} selected` : 'Tick recordings'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary', disabled: !joinable || busy, title: 'Join needs two or more finished notes', data: { action: 'library-join' } }, busy ? 'Working…' : 'Join'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--danger', disabled: !n || busy, data: { action: 'library-delete-ask' } }, 'Delete'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'library-select-cancel' } }, 'Cancel')));
}

export const actions = {
  'library-source'(el) {
    sourceFilter = el.dataset.source;
    ctx.refresh();
  },

  'library-select'() { selecting = true; confirmingDelete = false; selected.clear(); ctx.refresh({ force: true }); },
  'library-select-cancel'() { selecting = false; confirmingDelete = false; selected.clear(); ctx.refresh({ force: true }); },

  'library-hold'(el) {
    selecting = true;
    confirmingDelete = false;
    selected.clear();
    selected.add(el.dataset.id);
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(15);
    ctx.refresh({ force: true });
  },

  'library-delete-ask'() { if (selected.size) { confirmingDelete = true; ctx.refresh({ force: true }); } },
  'library-delete-cancel'() { confirmingDelete = false; ctx.refresh({ force: true }); },

  async 'library-delete'() {
    if (!selected.size || busy) return;
    busy = true;
    ctx.refresh({ force: true });
    try {
      const res = await deleteRecordings([...selected], { reason: 'deleted together from the Library' });
      selecting = false;
      confirmingDelete = false;
      selected.clear();
      ctx.toast(res.failed
        ? `Deleted ${res.deleted}; ${res.failed} changed meanwhile and were kept`
        : `Deleted ${res.deleted} - restore them from Activity, all at once`, { error: Boolean(res.failed) });
    } finally {
      busy = false;
      ctx.refresh({ force: true });
    }
  },

  'library-pick'(el) {
    if (el.checked) selected.add(el.dataset.id); else selected.delete(el.dataset.id);
    ctx.refresh({ force: true });
  },

  async 'library-join'() {
    if (selected.size < 2 || busy) return;
    busy = true;
    ctx.refresh({ force: true });
    try {
      const res = await joinRecordings([...selected]);
      if (!res.ok) { ctx.toast(res.error, { error: true }); return; }
      selecting = false;
      selected.clear();
      ctx.toast(res.aiError
        ? `Joined ${res.count} notes - the summary is the rough offline one (${res.aiError})`
        : `Joined ${res.count} notes into one - the originals can be restored from Activity`, { error: Boolean(res.aiError) });
      ctx.go(`#/rec/${res.id}`);
    } finally {
      busy = false;
      ctx.refresh({ force: true });
    }
  },
};
