// Recordings from the watch. Only inside the phone apps: the native side
// receives them from the watch into a private inbox and exposes it as
// `MulloWatch`. Android (Wear OS) answers list() at once and serves each file at
// /watch-inbox/<id>; the iPhone app (Apple Watch, ios/) answers list() with a
// promise and hands each file over with audio(id) → Response, because its
// WebView can't serve files on Mullo's own address. Each one goes through the
// same save path as the Record button; only then may the native side drop its
// copy. In a browser this is a no-op.
//
// Idempotent by the watch's id (source 'watch', external_id): a crash between
// saving and done() never makes a duplicate - the next drain just confirms it.
//
// With Mullo closed, the native side may already be making a note ready
// (transcript + summary, android WatchAi): such an entry carries
// ai_state 'working' and is left for the next drain (the native side fires
// mullo-watch when it's done), and a finished one carries the result as `ai`.
//
// The iPhone app also puts a recording here that Mullo was killed in the middle
// of (ios NativeRecorder, 2026-10-17): `from: 'phone'`, saved as this device's own
// recording (source 'device'), titled "Recovered".

// A recording made on this phone, recovered after Mullo was killed mid-way.
export const fromPhone = (entry) => entry?.from === 'phone';

const nativeInbox = () => globalThis.MulloWatch ?? null;

// The watch's battery (%) when the note started and when it was sent, kept on the
// recording so real use can answer "how much battery does an hour of recording
// cost?". Not shown anywhere. null when the watch didn't send both.
export function watchBattery(entry) {
  const ok = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
  return ok(entry?.battery_start) && ok(entry?.battery_end) ? { start: entry.battery_start, end: entry.battery_end } : null;
}

export const watchInboxAvailable = () => typeof nativeInbox()?.list === 'function';

let running = null;

// Notes the native side was still making ready at the last drain ({id, duration_ms}):
// the library shows Mullo mulling over them (owner, 2026-10-12: watch notes went
// by with no sign of work once WatchAi took them).
let working = [];
export const watchNotesWorking = () => working;

// deps: { save(entry, blob), findExisting(id, entry), fetchAudio(id) → Response, inbox? }
// → number of new recordings saved. Concurrent calls share one run.
export function drainWatchInbox(deps) {
  const inbox = deps.inbox ?? nativeInbox();
  if (typeof inbox?.list !== 'function') return Promise.resolve(0);
  running ??= drain(inbox, deps).finally(() => { running = null; });
  return running;
}

async function drain(inbox, { save, findExisting, fetchAudio }) {
  let saved = 0;
  const entries = JSON.parse((await inbox.list()) || '[]');
  working = entries
    .filter((e) => typeof e?.id === 'string' && e.ai_state === 'working')
    .map((e) => ({ id: e.id, duration_ms: Number.isFinite(e.duration_ms) ? e.duration_ms : null }));
  for (const entry of entries) {
    if (typeof entry?.id !== 'string') continue;
    if (entry.ai_state === 'working') continue; // the background job is on it
    if (!(await findExisting(entry.id, entry))) {
      const res = typeof inbox.audio === 'function' ? await inbox.audio(entry.id) : await fetchAudio(entry.id);
      if (!res.ok) continue; // left in the inbox; tried again next time
      await save(entry, await res.blob());
      saved += 1;
    }
    inbox.done(entry.id);
  }
  return saved;
}
