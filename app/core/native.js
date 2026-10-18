// The Android app's native side, when Mullo runs inside it (android/). In a
// browser none of this exists and every call is a no-op.
//
// Mullo Pro key: the person types it here once; native encrypts it with the
// Android Keystore and from then on hands it to the app in config.json.

const native = () => globalThis.MulloNative ?? null;

export const inAndroidApp = () => typeof native()?.setProKey === 'function';
// The Android or iPhone app (the iPhone's MulloNative has only the recording calls). Pages
// such as Google's sign-in open outside them, in the phone's browser.
export const inPhoneApp = () => typeof native()?.recordingStarted === 'function';

// → null when saved, or a message saying why not.
export function saveProKey(key) {
  if (!inAndroidApp()) return 'Mullo Pro is set in the Android app.';
  const result = native().setProKey(String(key ?? '').trim());
  return result === 'ok' ? null : result;
}

export function removeProKey() {
  if (inAndroidApp()) native().clearProKey();
}

// Last 4 characters of the saved key, or '' (never the key itself).
export const proKeyHint = () => (inAndroidApp() ? native().proKeyHint() : '');

// "Continue with Google": Android's own account sheet (GoogleSignIn.kt). Resolves
// with Google's ID token; the answer arrives as an `mullo-google` event, handed
// here by events.js → googleAnswer().
const google = () => globalThis.MulloGoogle ?? null;
let googleWaiting = null;

export const googleSignInAvailable = () => typeof google()?.signIn === 'function' && google().available() === true;

export function googleIdToken(nonceHash) {
  return new Promise((resolve, reject) => {
    googleWaiting?.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    googleWaiting = { resolve, reject };
    google().signIn(nonceHash);
  });
}

export function googleAnswer(detail) {
  const waiting = googleWaiting;
  googleWaiting = null;
  if (!waiting) return;
  let answer;
  try { answer = JSON.parse(detail); } catch { answer = { error: 'Google sign-in didn\'t work.' }; }
  if (answer.idToken) waiting.resolve(answer.idToken);
  else waiting.reject(Object.assign(new Error(answer.error ?? 'Google sign-in didn\'t work.'), { cancelled: Boolean(answer.cancelled) }));
}

// "Continue with Apple": the iPhone's own Apple sheet (ios/Mullo/SignIn.swift, S22b). → Apple's
// ID token; `nonceHash` as for Google. A cancel rejects with { cancelled: true }.
const apple = () => globalThis.MulloApple ?? null;

export const appleSignInAvailable = () => typeof apple()?.signIn === 'function';
// The code at "Delete account" came with iPhone build 9; build 8 has sign-in only.
export const appleCodeAvailable = () => typeof apple()?.code === 'function';

export async function appleIdToken(nonceHash) {
  let answer;
  try { answer = JSON.parse(await apple().signIn(nonceHash)); } catch { answer = { error: 'Apple sign-in didn\'t work.' }; }
  if (answer?.idToken) return answer.idToken;
  throw Object.assign(new Error(answer?.error ?? 'Apple sign-in didn\'t work.'), { cancelled: Boolean(answer?.cancelled) });
}

// At "Delete account", for someone signed in with Apple: Apple confirms once and gives a fresh
// one-time code, which Mullo's server trades and revokes (worker/src/apple.mjs). → the code.
export async function appleAuthCode() {
  let answer;
  try { answer = JSON.parse(await apple().code()); } catch { answer = { error: 'Apple didn\'t answer.' }; }
  if (answer?.code) return answer.code;
  throw Object.assign(new Error(answer?.error ?? 'Apple didn\'t answer.'), { cancelled: Boolean(answer?.cancelled) });
}

// Mullo Pro through the App Store (iPhone, S22c; ios/Mullo/Store.swift). Each answer is a JSON
// string from StoreKit 2. Stripe never shows where this exists (App Store rule 3.1.1).
const store = () => globalThis.MulloStore ?? null;
export const storeAvailable = () => typeof store()?.buy === 'function';
const storeAsk = async (op, ...args) => {
  try { return JSON.parse(await store()[op](...args)); } catch { return { error: 'The App Store didn\'t answer. Try again.' }; }
};
// → { price, name, description } (the price as Apple shows it in this country) or { error }.
export const storeProduct = () => storeAsk('product');
// The purchase sheet, for this Mullo account (StoreKit's appAccountToken = the user id).
// → { transactionId } | { cancelled } | { pending } | { error }.
export const storeBuy = (userId) => storeAsk('buy', String(userId));
// Transactions that are paid up now (also after Restore). → { ids: [...] } | { error }.
export const storeCurrent = () => storeAsk('current');
export const storeRestore = () => storeAsk('restore');
export const storeManage = () => { store()?.manage(); };

// Share sheet and clipboard. The Android WebView has neither navigator.share
// nor a dependable clipboard, so the native side does both there.
// → 'shared' | 'copied' | 'cancelled' | 'failed'
// caption: a shorter version (summary + tasks). When the text is longer than chat apps
// keep (Telegram cuts at 4,096 characters), the whole text goes as a .txt file and the
// caption as the message.
export const LONG_SHARE = 4000;
const CAPTION_MAX = 1000; // WhatsApp shows about 1,024 characters of a file's caption

export function shareCaption(caption) {
  return caption.length > CAPTION_MAX ? `${caption.slice(0, CAPTION_MAX - 30).trimEnd()}\n… (all of it is in the file)` : caption;
}

export async function shareText(title, text, { caption = null } = {}) {
  const asFile = caption != null && text.length > LONG_SHARE;
  if (asFile && typeof native()?.shareTextFile === 'function') {
    native().shareTextFile(title, shareCaption(caption), text);
    return 'shared';
  }
  if (typeof native()?.shareText === 'function') { native().shareText(title, text); return 'shared'; }
  if (asFile && navigator.canShare) {
    const file = new File([text], `${title.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 60) || 'Mullo note'}.txt`, { type: 'text/plain' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ title, text: shareCaption(caption), files: [file] }); return 'shared'; } catch { return 'cancelled'; }
    }
  }
  if (navigator.share) {
    try { await navigator.share({ title, text }); return 'shared'; } catch { return 'cancelled'; }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}

export async function copyText(text) {
  if (typeof native()?.copyText === 'function') { native().copyText(text); return true; }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// The account server (Settings → Developers → Your own server). Android checks it (a
// secret key is refused) and asks the person in its own dialog, then restarts Mullo.
// → null when the dialog is up, or why not.
export function askToUseServer(url, key) {
  if (typeof native()?.setServer !== 'function') return 'Changing the server is in the Android app for now.';
  const result = native().setServer(String(url ?? ''), String(key ?? ''));
  return result === 'asked' ? null : result;
}

// After the person said yes to leaving Mullo's server, Android waits (a `mullo-leave-server`
// event) until every way into the account there is closed. true = switch to the server they
// confirmed; false = keep the server as it was. Native applies only what they confirmed.
export function finishServerChange(ok) {
  if (typeof native()?.finishServerChange === 'function') native().finishServerChange(Boolean(ok));
}

export function askToUseMulloServer() {
  if (typeof native()?.useMulloServer !== 'function') return 'Changing the server is in the Android app for now.';
  const result = native().useMulloServer();
  return result === 'asked' ? null : result;
}

// A task → the phone's calendar app with the event filled in (Android). → true when it
// opened; false in a browser or with no calendar app (the caller offers an .ics instead).
export function addToCalendar({ title, description = '', date }) {
  if (typeof native()?.addToCalendar !== 'function') return false;
  return native().addToCalendar(String(title ?? ''), String(description ?? ''), String(date ?? '')) === true;
}

// What the Android app needs to make watch notes ready with Mullo closed:
// language, transcript language, Names & words, summary format. Not secret.
export function pushAiPrefs(prefs) {
  if (typeof native()?.setAiPrefs === 'function') native().setAiPrefs(JSON.stringify(prefs));
}

// Task reminders (S47, domain/reminders.js). Android keeps the list and sets the alarms
// (Reminders.kt); a browser has none of this.
export const remindersOnPhone = () => typeof native()?.setReminders === 'function';

// { on, hideOnLock, items: [{ id, at, text, from }] } - the whole list each time.
export function pushReminders(plan) {
  if (remindersOnPhone()) native().setReminders(JSON.stringify(plan));
}

// Done / Snooze tapped on a reminder: [{ key, id, act: 'done'|'snooze', date, time }].
// They stay on the native side until reminderTapsDone says they were written.
export function takeReminderTaps() {
  if (typeof native()?.reminderTaps !== 'function') return [];
  try {
    const taps = JSON.parse(native().reminderTaps());
    return Array.isArray(taps) ? taps.filter((t) => t && typeof t.key === 'string') : [];
  } catch { return []; }
}

export function reminderTapsDone(keys) {
  if (keys.length && typeof native()?.reminderTapsDone === 'function') native().reminderTapsDone(JSON.stringify(keys));
}

// Ringing on the minute needs Android's "Alarms & reminders" permission; without it a
// reminder can come up to ~10 minutes late. true / false, or null where there are none.
export const exactRemindersAllowed = () => (typeof native()?.exactAlarmsAllowed === 'function' ? native().exactAlarmsAllowed() === true : null);

// Opens Android's "Alarms & reminders" page for Mullo (the person decides there).
export function askExactReminders() {
  if (typeof native()?.askExactAlarms === 'function') native().askExactAlarms();
}

// While a recording runs, Android shows "Mullo is recording" and keeps the mic on with the
// screen locked (MicService.kt); without it a locked phone records silence. In a browser
// (iPhone), the screen is kept on instead: a web page can't record with the phone locked.
// → null, or why Android couldn't (the recording goes on while Mullo is open).
export function recordingInProgress(on) {
  if (typeof native()?.recordingStarted !== 'function') { keepScreenOn(on); return null; }
  if (!on) { native().recordingStopped(); return null; }
  const result = native().recordingStarted();
  return result === 'ok' ? null : result;
}

// Screen Wake Lock while a browser recording runs. The browser drops it whenever the
// page is hidden, so app.js asks again when Mullo comes back on screen (onFocus).
let wantAwake = false;
let wakeLock = null;
let asking = false;
export async function keepScreenOnAgain() {
  if (!wantAwake || wakeLock || asking || !globalThis.navigator?.wakeLock || document.visibilityState !== 'visible') return;
  asking = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.onrelease = () => { if (wakeLock === lock) wakeLock = null; };
    wakeLock = lock;
    if (!wantAwake) { lock.release().catch(() => {}); wakeLock = null; }
  } catch { wakeLock = null; } // refused (low battery, older browser): recording goes on
  finally { asking = false; }
}
function keepScreenOn(on) {
  if (!globalThis.navigator?.wakeLock) return;
  wantAwake = Boolean(on);
  if (on) {
    keepScreenOnAgain();
  } else if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
