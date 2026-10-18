// The greeting at the start of Library on a computer (desktop layout, 2026-10-17): numbers
// only, from the device's own tables. No DOM here, so it is tested on its own.
import { localDate } from '../core/dates.js';

const OPEN = new Set(['open', 'in_progress']);

export function greetingWord(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// Overdue first (oldest first), then today and later (nearest first, the time breaks a tie),
// then the ones with no date.
function byDue(today) {
  const rank = (a) => (!a.due_date ? 2 : a.due_date < today ? 0 : 1);
  return (a, b) => rank(a) - rank(b)
    || (a.due_date ?? '').localeCompare(b.due_date ?? '')
    || (a.due_time ?? '').localeCompare(b.due_time ?? '');
}

export function todayNumbers({ recordings, actions, now = new Date(), limit = 12 }) {
  const today = localDate(now);
  const todays = recordings.filter((r) => r.local_date === today);
  const open = actions.filter((a) => OPEN.has(a.status)).sort(byDue(today));
  return {
    greeting: greetingWord(now.getHours()),
    today,
    openCount: open.length,
    recordingsToday: todays.length,
    minutesToday: Math.round(todays.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / 60000),
    tasks: open.slice(0, limit),
  };
}
