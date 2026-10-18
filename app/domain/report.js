// Report a problem (S56, spec docs/specs/2026-10-17-report-a-problem-design.md). What the person
// writes, the details the app adds and one optional screenshot go to Mullo's server
// (worker/src/reports.mjs); "Email us instead" is the second way. Never in a report: note text,
// transcripts, summaries, task labels, audio, keys or tokens - only a reported note's id.

import { recentErrors } from '../core/error-log.js';

export const MAX_TEXT = 2000;
export const MAX_SHOT_BYTES = 400 * 1024;
export const MAX_SIDE = 1280;
export const EMAIL = 'hello@lizai.io';

// The note a report is about ("Report a problem with this note" on a note's ⋯ menu).
let about = null;
export function reportAbout(noteId) { about = typeof noteId === 'string' && noteId ? noteId : null; }
export const reportNote = () => about;

// The last screen outside Settings (where the problem happened; Report a problem itself is in
// Settings). app.js tells it every route change.
let lastHash = '';
export function rememberScreen(hash) { if (!/^#\/settings/.test(hash ?? '')) lastHash = hash ?? ''; }
export const lastScreen = () => lastHash;

// The screen's name, never an id in it (a reported note travels as noteId instead).
export function screenName(hash = '') {
  const parts = String(hash).replace(/^#\/?/, '').split(/[/?]/).filter(Boolean);
  if (!parts.length) return 'library';
  if (parts[0] === 'rec') return 'recording';
  if (parts[0] === 'settings') return parts[1] ? `settings/${parts[1]}` : 'settings';
  return parts[0].replace(/[^a-z-]/gi, '').slice(0, 30) || 'other';
}

// Pure: the details a report carries.
export function reportDetails({ version, platform, userAgent = '', hash = '', plan = null, language = '', noteId = null, errors = [] }) {
  return {
    version: String(version ?? ''),
    platform,
    userAgent: String(userAgent).slice(0, 300),
    screen: screenName(hash),
    plan: plan ?? 'none',
    language: String(language).slice(0, 20),
    ...(noteId ? { noteId } : {}),
    errors: errors.slice(-20),
  };
}

export const platformOf = ({ android = false, phoneApp = false } = {}) => (android ? 'android-app' : phoneApp ? 'ios-app' : 'browser');

// The details as the person sees them under "See what's sent".
export const detailsText = (d) => JSON.stringify(d, null, 2);

export function mailtoHref(text, details) {
  const body = `${String(text ?? '').trim()}\n\n---\n${detailsText(details)}`;
  return `mailto:${EMAIL}?subject=${encodeURIComponent('Mullo problem report')}&body=${encodeURIComponent(body.slice(0, 6000))}`;
}

// A picked image → base64 JPEG under 400 KB, at most 1280 px on the long side. The canvas
// re-encodes it, so EXIF (location) is gone. → { b64, url } or throws "That image is too big".
export async function shrinkImage(file, { maxSide = MAX_SIDE, maxBytes = MAX_SHOT_BYTES } = {}) {
  if (!file || !/^image\//.test(file.type ?? '')) throw new Error('Pick an image.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) {
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      return { b64: String(url).split(',')[1], url };
    }
  }
  throw new Error('That image is too big.');
}

// server = the signed-in Mullo account's server(workerUrl, path, body).
export async function sendReport(server, workerUrl, { text, details, screenshot = null }) {
  const clean = String(text ?? '').trim();
  if (!clean) return { ok: false, error: 'Write what happened first.' };
  if (clean.length > MAX_TEXT) return { ok: false, error: `Keep it under ${MAX_TEXT.toLocaleString('en')} characters.` };
  try {
    await server(workerUrl, '/api/reports', { text: clean, details, ...(screenshot ? { screenshot } : {}) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, offline: Boolean(err.offline) };
  }
}

export const detailsNow = (env) => reportDetails({ ...env, errors: recentErrors() });
