// The app's current mood for the mascot: domain/mood.js decides, this keeps the
// little state it needs (the last finished job, until that recording is opened).
// Page memory only: a fresh start begins idle.

import { moodOf, afterJob } from '../domain/mood.js';
import { isRunning } from '../domain/jobs.js';
import { watchNotesWorking } from '../capture/watch-inbox.js';

let last = null;

export function noteJobDone(payload) {
  const next = afterJob(payload);
  // A failed job takes away only its own face; a ready one stays put.
  if (next) last = next;
  else if (last?.id === payload.recordingId) last = null;
}

export function noteOpened(recordingId) {
  if (last?.id === recordingId) last = null;
}

// recordings: the library list; listening: the record panel is recording.
export function appMood(recordings, { listening = false } = {}) {
  const running = new Set(recordings.filter((r) => isRunning(r.id)).map((r) => r.id));
  return moodOf({ listening, online: navigator.onLine, recordings, running, last, elsewhere: watchNotesWorking() });
}
