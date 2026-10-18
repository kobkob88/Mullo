// The greeting in Library's reader on a computer (desktop layout, 2026-10-17): hello, the
// day, three numbers and the open actions. The same rows as Actions, so a tap opens a task's
// tools and the box marks it done there too (tasks.js handles both).
import { h } from './dom.js';
import { actionRow } from './components.js';
import { rowState } from './panels/tasks.js';
import { listRecordings } from '../domain/recordings.js';
import { listActions } from '../domain/actions.js';
import { todayNumbers } from '../domain/today.js';
import { account } from '../core/account.js';
import { parseLocalDate } from '../core/dates.js';

const plural = (n, one, many) => (n === 1 ? one : many);

export async function render({ now = new Date() } = {}) {
  const [recordings, actions] = await Promise.all([listRecordings(), listActions()]);
  const n = todayNumbers({ recordings, actions, now });
  const name = account().on ? account().user()?.name ?? null : null;
  const titles = new Map(recordings.map((r) => [r.id, r.title]));
  const stat = (value, label) => h('div', { class: 'today__stat' }, h('b', null, value), h('span', null, label));
  return h('div', { class: 'today' },
    h('header', { class: 'page-head today__head' },
      h('h1', { class: 'page-head__title', dir: 'auto' }, name ? `${n.greeting}, ${name}` : n.greeting),
      h('span', { class: 'muted' }, parseLocalDate(n.today).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))),
    h('div', { class: 'today__stats' },
      stat(String(n.openCount), plural(n.openCount, 'open action', 'open actions')),
      stat(String(n.recordingsToday), plural(n.recordingsToday, 'recording today', 'recordings today')),
      stat(`${n.minutesToday} min`, 'recorded today')),
    h('section', { class: 'day' },
      h('h2', { class: 'day-head today__list-head' }, 'Open actions', h('a', { class: 'today__all', href: '#/actions' }, 'All actions ›')),
      n.tasks.length
        ? h('ul', { class: 'action-list card', data: { flip: 'today-list', flipMode: 'size' } },
          n.tasks.map((a) => actionRow(a, rowState(a, { recordingTitle: titles.get(a.recording_id), today: n.today }))))
        : h('p', { class: 'muted' }, 'All clear. Actions from your recordings show up here.')));
}
