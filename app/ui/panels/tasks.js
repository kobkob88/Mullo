// Actions: every action item across every recording and source, by when it
// is due (Pocket's action list, unified with Vocci/Plaud/device ones).

import { h } from '../dom.js';
import { pageHeader, actionRow, emptyState } from '../components.js';
import { ctx } from '../context.js';
import { listActions, getAction, setActionStatus, setActionType, setActionDue, setActionTime } from '../../domain/actions.js';
import { addToCalendar, remindersOnPhone, exactRemindersAllowed, askExactReminders } from '../../core/native.js';
import { canWrite } from '../../core/auth.js';
import { listRecordings } from '../../domain/recordings.js';
import { localDate, localTime, formatTime } from '../../core/dates.js';
import { getSettings } from '../../core/settings.js';
import { disk } from '../../core/disk.js';
import { buildIcs, icsFilename, reminderDate } from '../../domain/one-tap.js';
import { sendDraft } from '../task-draft.js';
import { mark, take } from '../motion.js';

export const screen = 'actions';

let filter = 'open';
// The one task whose tools are open (a tap on it); shared with a recording's Actions tab.
let openTask = null;

// What a row needs besides the task: open or not, and the one-shot motion marks.
export function rowState(a, extra = {}) {
  return {
    ...extra,
    open: openTask === a.id || Boolean(extra.focused),
    opening: take(`task-open:${a.id}`),
    flash: ['type', 'due', 'time'].find((what) => take(`task-flash:${a.id}:${what}`)) ?? null,
  };
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function groupByDue(items, today) {
  const groups = { overdue: [], today: [], upcoming: [], someday: [], done: [] };
  for (const a of items) {
    if (a.status === 'done' || a.status === 'cancelled') groups.done.push(a);
    else if (!a.due_date) groups.someday.push(a);
    else if (a.due_date < today) groups.overdue.push(a);
    else if (a.due_date === today) groups.today.push(a);
    else groups.upcoming.push(a);
  }
  groups.upcoming.sort((a, b) => a.due_date.localeCompare(b.due_date));
  groups.overdue.sort((a, b) => a.due_date.localeCompare(b.due_date));
  return groups;
}

const GROUP_LABEL = { overdue: 'Overdue', today: 'Today', upcoming: 'Coming up', someday: 'No date', done: 'Done' };

// Ringing on the minute needs Android's "Alarms & reminders" permission (S47). Asked once,
// when the first time is set; refused = alarms within ~10 minutes, and this note says so
// while a timed task is waiting, until the person says OK.
const EXACT_ASKED = 'echo:reminders:exact-asked';
const LATE_SEEN = 'echo:reminders:late-ok';

function lateNote(items) {
  if (!remindersOnPhone() || exactRemindersAllowed() !== false || disk.get(LATE_SEEN, false) || !getSettings().reminders) return null;
  if (!items.some((a) => a.due_date && a.due_time && (a.status === 'open' || a.status === 'in_progress'))) return null;
  return h('div', { class: 'notice reminder-note' },
    h('span', null, 'Reminders may ring up to 10 minutes late: Mullo isn\'t allowed to set exact alarms.'),
    h('span', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'reminders-exact' } }, 'Ring on time'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'reminders-late-ok' } }, 'OK')));
}

export async function render({ focus = null } = {}) {
  const today = localDate();
  const [all, recordings] = await Promise.all([listActions(), listRecordings()]);
  const titles = new Map(recordings.map((r) => [r.id, r.title]));
  // A reminder's notification opened this task: it comes first, highlighted.
  const focused = focus ? all.find((a) => a.id === focus) ?? null : null;
  const items = focused ? all.filter((a) => a !== focused) : all;
  const groups = groupByDue(items, today);
  const order = filter === 'done' ? ['done'] : filter === 'open' ? ['overdue', 'today', 'upcoming', 'someday'] : Object.keys(groups);

  const switcher = h('div', { class: 'filters', role: 'group', 'aria-label': 'Show' },
    [['open', 'To do'], ['done', 'Done'], ['all', 'All']].map(([value, label]) =>
      h('button', {
        type: 'button', class: ['pill', filter === value && 'is-active'], 'aria-pressed': String(filter === value),
        data: { action: 'tasks-filter', filter: value },
      },
      // The light behind the chosen one slides to the next choice (motion.js).
      filter === value ? h('span', { class: 'pill__thumb', 'aria-hidden': 'true', data: { flip: 'tasks-filter', flipMode: 'slide' } }) : null,
      label)));

  // Lists grow and shrink and headings slide as tasks open, close and leave (motion.js).
  const sections = order.filter((g) => groups[g].length).map((g) =>
    h('section', { class: 'day' },
      h('h2', { class: ['day-head', g === 'overdue' && 'is-alert'], data: { flip: `head-${g}` } }, `${GROUP_LABEL[g]} · ${groups[g].length}`),
      h('ul', { class: 'action-list card', data: { flip: `list-${g}`, flipMode: 'size' } },
        groups[g].map((a) => actionRow(a, rowState(a, { recordingTitle: titles.get(a.recording_id), today }))))));

  return h('div', null,
    pageHeader('Actions'),
    focused
      ? h('section', { class: 'day' },
        h('h2', { class: 'day-head' }, 'Reminder'),
        h('ul', { class: 'action-list card', data: { flip: 'list-focus', flipMode: 'size' } }, actionRow(focused, rowState(focused, { recordingTitle: titles.get(focused.recording_id), today, focused: true }))))
      : null,
    lateNote(all),
    switcher,
    sections.length ? sections : emptyState(filter === 'done' ? 'Nothing done yet' : 'All clear', 'Action items from your recordings show up here.'));
}

export const actions = {
  'tasks-filter'(el) {
    filter = el.dataset.filter;
    ctx.refresh({ force: true });
  },

  // A tap on a task opens its tools; a tap on the open one closes them. The box is separate.
  'action-open'(el) {
    const id = el.dataset.id;
    openTask = openTask === id ? null : id;
    if (openTask) mark(`task-open:${id}`);
    ctx.refresh({ force: true });
  },

  // A change the row shows by itself gets no message (owner, 2026-10-15: "Now a email" sat
  // in the middle of the screen with no purpose); the chip that changed glows once instead.
  async 'action-type'(el) {
    const action = await getAction(el.dataset.id);
    if (!action) return;
    const res = await setActionType(action, el.value);
    if (res.ok === false) ctx.toast(res.error ?? 'It changed meanwhile - try again.', { error: true });
    else mark(`task-flash:${action.id}:type`);
    ctx.refresh({ force: true });
  },

  // The date chip: the hidden date field beside it opens the phone's picker.
  'action-due-pick'(el) {
    const input = el.nextElementSibling;
    try { input.showPicker(); } catch { input.focus(); input.click(); }
  },

  async 'action-due'(el) {
    const action = await getAction(el.dataset.id);
    if (!action) return;
    const due = el.value || null;
    const res = await setActionDue(action, due);
    if (res.ok === false) ctx.toast(res.error ?? 'It changed meanwhile - try again.', { error: true });
    else mark(`task-flash:${action.id}:due`);
    ctx.refresh({ force: true });
  },

  async 'action-time'(el) {
    const action = await getAction(el.dataset.id);
    if (!action) return;
    const time = el.value || null;
    const res = await setActionTime(action, time);
    if (res.ok !== false) mark(`task-flash:${action.id}:time`);
    ctx.refresh({ force: true });
    if (res.ok === false) { ctx.toast(res.error ?? 'It changed meanwhile - try again.', { error: true }); return; }
    // Only what the row can't show gets a message: it won't ring, or why not.
    if (!time) return;
    if (`${action.due_date}T${time}` < `${localDate()}T${localTime()}`) ctx.toast(`At ${formatTime(time)}. That time has passed, so it won't ring.`);
    else if (!remindersOnPhone()) ctx.toast(`At ${formatTime(time)}. Reminders ring in the Android app.`);
    else if (!getSettings().reminders) ctx.toast(`At ${formatTime(time)}. Task reminders are off in Settings.`);
    else if (exactRemindersAllowed() === false && !disk.get(EXACT_ASKED, false)) {
      // The first time: Android's own page, where the person allows exact alarms (or not).
      disk.set(EXACT_ASKED, true);
      ctx.toast('Allow "Alarms & reminders" so Mullo rings on time');
      askExactReminders();
    }
  },

  'reminders-exact'() { askExactReminders(); },
  'reminders-late-ok'() {
    disk.set(LATE_SEEN, true);
    ctx.refresh({ force: true });
  },

  // One tap: the action becomes the email / message / calendar event.
  async 'action-do'(el) {
    const action = await getAction(el.dataset.id);
    if (!action) return;
    if (action.type === 'draft_email' || action.type === 'send_message') {
      // The mail app, or the phone's share sheet: the person picks the app (WhatsApp,
      // Business, SMS, Telegram…). WhatsApp only where there is no share sheet at all.
      // With a draft kept on the task (S50) it goes out with the draft's text.
      await sendDraft(action);
      ctx.refresh({ force: true });
    } else if (addToCalendar({ title: action.label, description: action.context ?? '', date: reminderDate(action) })) {
      // Android: the phone's calendar app opens with the event filled in.
      if (!action.due_date) ctx.toast('No date was said - the event is set for tomorrow');
    } else {
      const url = URL.createObjectURL(new Blob([buildIcs(action)], { type: 'text/calendar' }));
      const link = h('a', { href: url, download: icsFilename(action) });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      ctx.toast(action.due_date ? 'Calendar event created - open it to add it' : 'No date was said - the event is set for tomorrow');
    }
  },

  // Shared by every screen that shows an action row.
  // Ticked on To do: the task strikes through and slides away before the list closes up.
  async 'action-toggle'(el) {
    const action = await getAction(el.dataset.id);
    if (!action) return;
    const row = el.closest('.action-row');
    if (el.checked && row && !reducedMotion()) {
      row.classList.add('is-leaving');
      await sleep(380);
    }
    if (openTask === action.id && el.checked) openTask = null;
    const res = await setActionStatus(action, el.checked ? 'done' : 'open');
    if (!res.ok) ctx.toast('That changed meanwhile - refreshed.', { error: true });
    ctx.refresh({ force: true });
  },
};
