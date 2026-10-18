// Usage this month, for the Settings header (the Vocci "plan" card idea):
// minutes recorded on this device, questions asked, and an estimated Gemini
// cost. Counted on the device; resets on the 1st (local calendar).
//
// Cost estimate (gemini-3.1-flash-lite, paid tier, 2026-10-04 prices): audio
// in 32 tok/s × $0.50/1M + transcript and summary ≈ $0.10 per recorded hour;
// a question ≈ $0.001. Shown as an estimate, never as a bill.

import { disk } from './disk.js';
import { localDate } from './dates.js';

export const COST_PER_HOUR = 0.10;
export const COST_PER_QUESTION = 0.001;

export const monthKey = (date = localDate()) => date.slice(0, 7);
const key = (month) => `echo:usage:${month}`;

export function countQuestion(today = localDate()) {
  const k = key(monthKey(today));
  const cur = disk.get(k, { questions: 0 });
  disk.set(k, { ...cur, questions: (cur.questions ?? 0) + 1 });
}

// recordings: the library (plain rows). Everything recorded here counts: the
// phone and the watch (owner, 2026-10-06: watch minutes were missing).
export const COUNTED_SOURCES = ['device', 'watch'];

export function monthUsage(recordings, today = localDate()) {
  const month = monthKey(today);
  const minutes = recordings
    .filter((r) => COUNTED_SOURCES.includes(r.source) && r.local_date?.startsWith(month))
    .reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / 60_000;
  const questions = disk.get(key(month), { questions: 0 }).questions ?? 0;
  const [y, m] = month.split('-').map(Number);
  const resets = new Date(y, m, 1); // 1st of next month, local
  return {
    minutes,
    questions,
    cost: (minutes / 60) * COST_PER_HOUR + questions * COST_PER_QUESTION,
    resets,
  };
}
