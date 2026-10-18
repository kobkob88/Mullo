// Personal settings, kept on this device (moves to the person's Supabase
// profile when that is switched on). One place for what used to be the
// record screen's private preferences.
//
//   listen      - the language you speak (what to listen for); 'auto' = detect
//   transcript  - the language the transcript is written in; 'same' = as spoken,
//                 anything else = Gemini translates faithfully
//   template    - default summary template
//   vocabulary  - names and words to spell right ("נועה (Noa)"), sent to
//                 Gemini with every transcription and summary

import { disk } from './disk.js';
import { emit } from './bus.js';
import { baseCode, isKnownLanguage, DEFAULT_LANGUAGE, AUTO } from './languages.js';

const KEY = 'echo:settings';
const LEGACY_KEY = 'echo:record-prefs';
export const SAME = 'same';
export const MAX_VOCABULARY = 60;

//   livePreview - show the phone's own live transcription while recording
//                 (off = audio never goes to the browser's speech service)
//   appearance  - 'system' | 'dark' | 'light'
//   reminders       - a task with a day and a time rings then (S47, the phone app)
//   remindersHidden - the lock screen shows no task text (it still rings)
//   autoDrafts      - email and message tasks get a draft by themselves (S50; on by default,
//                     owner 2026-10-15; it uses the AI like Ask)
//   keepAudio   - S44: how long a recording's audio is kept once its notes are made:
//                 'keep' | 'notes' (as soon as they are) | '7' | '30' (days after recording)
//   serverKeep  - S45: how long Mullo's server keeps a finished transcript for this phone to
//                 collect: 'collected' (until this phone has it) | '1h' | '6h' | '24h'.
//                 The Worker accepts only that list (worker/src/jobs.mjs KEEP_CHOICES).
export const APPEARANCES = ['system', 'dark', 'light'];
export const KEEP_AUDIO = ['keep', 'notes', '7', '30'];
export const SERVER_KEEP = ['collected', '1h', '6h', '24h'];

const DEFAULTS = {
  listen: DEFAULT_LANGUAGE, transcript: SAME, template: 'voice_note', vocabulary: [],
  livePreview: true, appearance: 'system', templates: [], reminders: true, remindersHidden: false,
  autoDrafts: true, keepAudio: 'keep', serverKeep: '24h',
};

// One entry per line or comma; trimmed, de-duplicated, capped.
export function parseVocabulary(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split(/[\n,;]+/)) {
    const v = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
    const key = v.toLocaleLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_VOCABULARY) break;
  }
  return out;
}

export function normalizeSettings(raw = {}) {
  const listen = baseCode(raw.listen ?? raw.lang) ?? DEFAULT_LANGUAGE;
  const transcript = raw.transcript === SAME || !raw.transcript ? SAME : (baseCode(raw.transcript) ?? SAME);
  return {
    listen: isKnownLanguage(listen) ? listen : DEFAULT_LANGUAGE,
    transcript: transcript === AUTO ? SAME : transcript,
    template: typeof raw.template === 'string' ? raw.template : DEFAULTS.template,
    vocabulary: Array.isArray(raw.vocabulary) ? parseVocabulary(raw.vocabulary.join('\n')) : [],
    livePreview: raw.livePreview !== false,
    appearance: APPEARANCES.includes(raw.appearance) ? raw.appearance : 'system',
    reminders: raw.reminders !== false,
    remindersHidden: raw.remindersHidden === true,
    autoDrafts: raw.autoDrafts !== false,
    keepAudio: KEEP_AUDIO.includes(raw.keepAudio) ? raw.keepAudio : 'keep',
    serverKeep: SERVER_KEEP.includes(raw.serverKeep) ? raw.serverKeep : '24h',
    // The person's own summary formats; checked properly in domain/formats.js.
    templates: Array.isArray(raw.templates) ? raw.templates.filter((t) => t && typeof t === 'object').slice(0, 10) : [],
  };
}

export function getSettings() {
  let saved = disk.get(KEY, null);
  if (!saved) {
    // Older builds kept record prefs separately, with the language as `lang`.
    const legacy = disk.get(LEGACY_KEY, {});
    saved = { ...(legacy.lang ? { listen: legacy.lang } : {}), ...(legacy.template ? { template: legacy.template } : {}) };
  }
  return normalizeSettings({ ...DEFAULTS, ...saved });
}

export function updateSettings(patch) {
  const next = normalizeSettings({ ...getSettings(), ...patch });
  disk.set(KEY, next);
  emit('settings', next);
  return next;
}

// Adds one Names & words entry (e.g. a word taught from a transcript fix).
// → 'added' | 'already' | 'full'
export function addVocabulary(entry) {
  const { vocabulary } = getSettings();
  const clean = String(entry ?? '').trim().replace(/\s+/g, ' ');
  if (vocabulary.some((v) => v.toLocaleLowerCase() === clean.toLocaleLowerCase())) return 'already';
  if (vocabulary.length >= MAX_VOCABULARY) return 'full';
  updateSettings({ vocabulary: [...vocabulary, clean] });
  return 'added';
}

// The transcript's language for a recording spoken in `listen`.
export function transcriptTarget(settings, listen) {
  return settings.transcript === SAME ? null : (settings.transcript === baseCode(listen) ? null : settings.transcript);
}
