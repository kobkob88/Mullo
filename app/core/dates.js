// Local dates, never UTC (spec §13). A note recorded at 8pm belongs to today,
// not tomorrow. Date-only values are 'YYYY-MM-DD' strings in local time.

const pad = (n) => String(n).padStart(2, '0');

export function localDate(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// 0 = Sunday … 6 = Saturday
export function weekdayOf(dateStr) {
  return parseLocalDate(dateStr).getDay();
}

// The next date strictly after `today` that falls on `weekday`.
export function nextWeekday(today, weekday) {
  const diff = ((weekday - weekdayOf(today) + 7) % 7) || 7;
  return addDays(today, diff);
}

export function formatClock(ms) {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function formatDuration(ms) {
  const min = Math.round((ms ?? 0) / 60000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function relativeDay(dateStr, today = localDate()) {
  if (dateStr === today) return 'Today';
  if (dateStr === addDays(today, -1)) return 'Yesterday';
  if (dateStr === addDays(today, 1)) return 'Tomorrow';
  return parseLocalDate(dateStr).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

// A task's time of day: local "HH:MM" (24-hour), like dates never UTC.
export function localTime(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

// "15:00" → "3:00 PM" or "15:00", as the phone writes times.
export function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function timeOfDay(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
