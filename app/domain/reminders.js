// Task reminders (S47): an open task with a day AND a time rings on the phone at that
// time, like Google Tasks: its text, "from <recording title>", Done and Snooze.
//
// Scheduled ON THE PHONE from the tasks it already has (sync brings the other devices'
// ones); no server ever reads tasks for this. The web code hands Android the whole list
// after every change (reminderPlan → native pushReminders); Android keeps it, sets the
// alarms, and sets them again after a reboot or a time-zone change. Done / Snooze tapped
// on a notification wait natively and come back here, so they are written through
// actions.js like any tap in the app (activity log, sync, undo in Activity).
// A date with no time never rings.

import { listActions, getAction, setActionStatus, setActionWhen, validTime } from './actions.js';
import { listRecordings } from './recordings.js';
import { draftOf } from './one-tap.js';
import { getSettings } from '../core/settings.js';
import { localDate, localTime } from '../core/dates.js';
import { pushReminders, takeReminderTaps, reminderTapsDone, remindersOnPhone } from '../core/native.js';

// Android allows an app 500 alarms; iOS keeps 64 notifications (S22d). The nearest win.
export const MAX_REMINDERS = 64;
const OPEN = new Set(['open', 'in_progress']);

// Pure. → [{ id, at: 'YYYY-MM-DDTHH:MM' local, text, from }], nearest first; only times
// still ahead (this minute counts). `titleOf(recordingId)` names the note it came from.
export function reminderPlan(actions, titleOf = () => null, now = new Date()) {
  const nowKey = `${localDate(now)}T${localTime(now)}`;
  return actions
    .filter((a) => OPEN.has(a.status) && a.due_date && validTime(a.due_time))
    .map((a) => ({
      id: a.id,
      at: `${a.due_date}T${a.due_time}`,
      // A task with a draft waiting (S50) says so; the tap opens the task with it.
      text: `${draftOf(a) ? 'Draft ready: ' : ''}${String(a.label ?? '')}`.slice(0, 300),
      from: a.recording_id ? (titleOf(a.recording_id) || null) : null,
    }))
    .filter((r) => r.at >= nowKey)
    .sort((x, y) => x.at.localeCompare(y.at))
    .slice(0, MAX_REMINDERS);
}

// The phone's list, again. Called on start, after any task or settings change, and after
// sync brings tasks down. Off in Settings = an empty list (every alarm goes).
export async function syncReminders() {
  if (!remindersOnPhone()) return;
  const s = getSettings();
  let items = [];
  if (s.reminders) {
    const [actions, recordings] = await Promise.all([listActions(), listRecordings()]);
    const titles = new Map(recordings.map((r) => [r.id, r.title]));
    items = reminderPlan(actions, (id) => titles.get(id));
  }
  pushReminders({ on: s.reminders, hideOnLock: s.remindersHidden, items });
}

// Done / Snooze tapped on a notification while Mullo was closed (or open). Android already
// took the notification away and, for Snooze, set the new alarm; this writes the change.
// A tap whose task is gone, done or cancelled meanwhile is dropped. → how many were written.
export async function applyReminderTaps() {
  const taps = takeReminderTaps();
  if (!taps.length) return 0;
  let written = 0;
  const handled = [];
  for (const tap of taps) {
    handled.push(tap.key);
    const action = tap.id ? await getAction(tap.id) : null;
    if (!action || !OPEN.has(action.status)) continue;
    const res = tap.act === 'done'
      ? await setActionStatus(action, 'done', { reason: 'done from the reminder' })
      : tap.act === 'snooze'
        ? await setActionWhen(action, tap.date, tap.time, { reason: `snoozed to ${tap.date} ${tap.time}` })
        : { ok: false };
    if (res.ok !== false) written += 1;
  }
  reminderTapsDone(handled);
  return written;
}
