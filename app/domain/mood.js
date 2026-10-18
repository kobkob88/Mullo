// The app's mood, one word the mascot shows (S20, owner picked 2026-10-09).
// Pure: the caller says what is going on; nothing here reads the page or storage.
//
//   listening  a recording is running on this phone (record panel state `recording`)
//   offline    work is waiting (a job runs here, or a server job id is kept) and there is no connection
//   mulling    a transcribe/summarise job runs in this app
//   ready      the last job finished well, until that recording is opened
//   silent     the last job found no speech, until that recording is opened
//   idle       nothing of the above

export const MOODS = ['idle', 'listening', 'mulling', 'ready', 'silent', 'offline'];

// last: { id, kind: 'ready' | 'silent' } from the latest finished job, or null.
// running: ids of recordings with a job running in this app.
// elsewhere: watch notes the phone's background side is making ready ({id, duration_ms});
// they have no recording yet, so the mood is about `watchNote` instead.
// Returns { mood, recording } - the recording the mood is about, when there is one.
export function moodOf({ listening = false, online = true, recordings = [], running = new Set(), last = null, elsewhere = [] } = {}) {
  if (listening) return { mood: 'listening', recording: null };
  const busy = recordings.filter((r) => running.has(r.id));
  const waiting = recordings.filter((r) => r.transcribe_job && !running.has(r.id));
  if (!online && (busy.length || waiting.length)) return { mood: 'offline', recording: busy[0] ?? waiting[0] };
  if (busy.length) return { mood: 'mulling', recording: busy[0] };
  if (online && elsewhere.length) return { mood: 'mulling', recording: null, watchNote: elsewhere[0] };
  const done = last && recordings.find((r) => r.id === last.id);
  if (done) return { mood: last.kind, recording: done };
  return { mood: 'idle', recording: null };
}

// What a finished job leaves behind (the bus 'job-done' payload): a happy or a
// "no speech" face until it's opened; a failure leaves none (its toast says why).
export function afterJob({ recordingId, ok, silent, offline, transcribeError, aiError }) {
  if (silent) return { id: recordingId, kind: 'silent' };
  if (ok && !offline && !transcribeError && !aiError) return { id: recordingId, kind: 'ready' };
  return null;
}
