// The last few errors this session, for Report a problem (S56). In memory only: nothing is
// written to storage, and a reload starts empty. Fed by the action dispatcher (app.js onError)
// and the window's error events. Messages are cut short; an error message never holds note text
// in Mullo, but the cut keeps a stray long one from riding along whole.

export const MAX_ERRORS = 20;
export const MAX_MESSAGE = 300;

let list = [];

export function logError(err, where = '') {
  const message = String(err?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
  list.push({ at: new Date().toISOString(), message, where: String(where ?? '').slice(0, 80) });
  if (list.length > MAX_ERRORS) list = list.slice(-MAX_ERRORS);
}

export const recentErrors = () => list.map((e) => ({ ...e }));
export function clearErrors() { list = []; }

// Uncaught errors and promise rejections anywhere in the app.
export function installErrorLog(target = globalThis) {
  target.addEventListener?.('error', (e) => {
    const file = String(e?.filename ?? '').split('/').pop();
    logError(e?.error ?? e?.message, file ? `${file}:${e.lineno ?? ''}` : 'window');
  });
  target.addEventListener?.('unhandledrejection', (e) => logError(e?.reason, 'promise'));
}
