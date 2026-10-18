// The languages a person can speak and get a transcript in. One list, shared
// by the app (pickers, live preview) and the bridge (transcription prompt).
// Source: the Gemini API language list on ai.google.dev (checked 2026-10-04,
// ~110 languages). That list is for text; audio quality for the rarer ones is
// not measured - Hebrew and English are.
//
// Codes are ISO 639 base codes. Older recordings stored regional codes
// ('he-IL'); baseCode() reads both.

export const AUTO = 'auto';

export const LANGUAGES = {
  af: 'Afrikaans', sq: 'Albanian', am: 'Amharic', ar: 'Arabic', hy: 'Armenian', as: 'Assamese',
  az: 'Azerbaijani', eu: 'Basque', be: 'Belarusian', bn: 'Bengali', bs: 'Bosnian', bg: 'Bulgarian',
  ca: 'Catalan', ceb: 'Cebuano', 'zh-Hans': 'Chinese (Simplified)', 'zh-Hant': 'Chinese (Traditional)',
  co: 'Corsican', hr: 'Croatian', cs: 'Czech', da: 'Danish', dv: 'Dhivehi', nl: 'Dutch', en: 'English',
  eo: 'Esperanto', et: 'Estonian', fil: 'Filipino', fi: 'Finnish', fr: 'French', fy: 'Frisian',
  gl: 'Galician', ka: 'Georgian', de: 'German', el: 'Greek', gu: 'Gujarati', ht: 'Haitian Creole',
  ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi', hmn: 'Hmong', hu: 'Hungarian', is: 'Icelandic',
  ig: 'Igbo', id: 'Indonesian', ga: 'Irish', it: 'Italian', ja: 'Japanese', jv: 'Javanese', kn: 'Kannada',
  kk: 'Kazakh', km: 'Khmer', ko: 'Korean', kri: 'Krio', ku: 'Kurdish', ky: 'Kyrgyz', lo: 'Lao', la: 'Latin',
  lv: 'Latvian', lt: 'Lithuanian', lb: 'Luxembourgish', mk: 'Macedonian', mg: 'Malagasy', ms: 'Malay',
  ml: 'Malayalam', mt: 'Maltese', mi: 'Maori', mr: 'Marathi', mni: 'Meiteilon (Manipuri)', mn: 'Mongolian',
  my: 'Burmese', ne: 'Nepali', no: 'Norwegian', ny: 'Nyanja (Chichewa)', or: 'Odia', ps: 'Pashto',
  fa: 'Persian', pl: 'Polish', pt: 'Portuguese', pa: 'Punjabi', ro: 'Romanian', ru: 'Russian', sm: 'Samoan',
  gd: 'Scots Gaelic', sr: 'Serbian', st: 'Sesotho', sn: 'Shona', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak',
  sl: 'Slovenian', so: 'Somali', es: 'Spanish', su: 'Sundanese', sw: 'Swahili', sv: 'Swedish', tg: 'Tajik',
  ta: 'Tamil', te: 'Telugu', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu', ug: 'Uyghur', uz: 'Uzbek',
  vi: 'Vietnamese', cy: 'Welsh', xh: 'Xhosa', yi: 'Yiddish', yo: 'Yoruba', zu: 'Zulu',
};

// A new person starts on English (owner, 2026-10-10; was Hebrew). The Common group is
// wider since 2026-10-13 (owner: keep Hebrew, add more): the big languages people
// mix with English, then Auto for a conversation in more than one.
export const COMMON = ['en', 'he', 'ru', 'ar', 'es', 'fr', 'de', 'pt', 'zh-Hans', AUTO];
export const DEFAULT_LANGUAGE = 'en';

// Regions the browser's live recognizer understands best (preview only).
const SPEECH_REGION = { he: 'he-IL', en: 'en-US', ar: 'ar-SA', ru: 'ru-RU', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };

export function baseCode(code) {
  if (!code) return null;
  if (code === AUTO) return AUTO;
  if (Object.hasOwn(LANGUAGES, code)) return code;
  const base = String(code).split(/[-_]/)[0].toLowerCase();
  if (base === 'iw') return 'he';
  if (base === 'zh') return /TW|HK|Hant/i.test(code) ? 'zh-Hant' : 'zh-Hans';
  return Object.hasOwn(LANGUAGES, base) ? base : null;
}

export function isKnownLanguage(code) {
  const b = baseCode(code);
  return b === AUTO || Boolean(b && LANGUAGES[b]);
}

export function englishName(code) {
  const b = baseCode(code);
  if (b === AUTO) return null;
  return b ? LANGUAGES[b] : null;
}

// The language's own name ("עברית"), when the runtime knows it.
export function nativeName(code) {
  const b = baseCode(code);
  if (!b || b === AUTO) return null;
  try {
    const name = new Intl.DisplayNames([b], { type: 'language' }).of(b);
    return name && name.toLowerCase() !== b.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

export function languageLabel(code) {
  if (baseCode(code) === AUTO) return 'Detect automatically (mixed languages)';
  const en = englishName(code);
  const native = nativeName(code);
  if (!en) return code;
  return native && native.toLocaleLowerCase() !== en.toLocaleLowerCase() ? `${native} - ${en}` : en;
}

// [[code, label]] - common first, then everything else by English name.
export function languageGroups() {
  const rest = Object.keys(LANGUAGES)
    .filter((c) => !COMMON.includes(c))
    .sort((a, b) => LANGUAGES[a].localeCompare(LANGUAGES[b]));
  return {
    common: COMMON.map((c) => [c, languageLabel(c)]),
    all: rest.map((c) => [c, languageLabel(c)]),
  };
}

// For the browser's SpeechRecognition (a preview; may be ignored by the phone).
export function speechLang(code) {
  const b = baseCode(code);
  if (!b || b === AUTO) return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  return SPEECH_REGION[b] ?? b;
}
