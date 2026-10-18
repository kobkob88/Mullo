// Re-transcribe: the recording's audio → Gemini → speaker-labelled segments.
// The person chooses the language (Pocket transliterated Hebrew when it
// guessed), and Hebrew must come back in Hebrew letters.
// Up to INLINE_MAX_BYTES the audio goes inline (Gemini's inline limit is 20 MB per
// request). Bigger recordings are uploaded once through the Files API (REST, no SDK),
// every round points at that one upload, and it's deleted when the transcript is done.
// MAX_AUDIO_BYTES is set by the Worker's 128 MB of memory: a job holds the audio about
// three times over while it's handed to its Durable Object. At 32 kbps (phone and watch)
// it's over 2 hours, about what MAX_ROUNDS can write out.

import { DEFAULT_MODEL, vocabularyLine, clock, clockToMs, sendRetryingBusy } from './gemini.mjs';

export { clockToMs };
import { englishName } from '../app/core/languages.js';

const BASE = 'https://generativelanguage.googleapis.com';
const API = `${BASE}/v1beta/models`;
export const INLINE_MAX_BYTES = 19 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
// Room for the form wrapping and the options around the audio.
export const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 256 * 1024;
export const TOO_LARGE = 'Recording too large to transcribe (over 32 MB, about 2 hours)';

const tooLong = () => Object.assign(new Error(TOO_LARGE), { status: 413 });
const badRequest = (why) => Object.assign(new Error(why), { status: 400 });

// /api/transcribe, read the same way by the Worker and the bridge.
// multipart/form-data: "options" (JSON: lang, out, vocabulary, duration_ms, mime, speech) + "audio".
// The names list stays in the body: a URL ends up in request logs.
// An app from before 2026-10-06 sends the raw audio with the options in the query; still read.
export async function readTranscribeRequest(request) {
  const url = new URL(request.url);
  if (/^multipart\/form-data/i.test(request.headers.get('Content-Type') ?? '')) {
    let form;
    try { form = await request.formData(); } catch { throw badRequest('Could not read the recording'); }
    const file = form.get('audio');
    if (!file || typeof file === 'string') throw badRequest('No audio in the request');
    if (file.size > MAX_AUDIO_BYTES) throw tooLong();
    let o;
    try { o = JSON.parse(form.get('options') ?? '{}'); } catch { throw badRequest('Bad options'); }
    if (!o || typeof o !== 'object') o = {};
    const text = (v) => (typeof v === 'string' && v ? v : null);
    return {
      audio: new Uint8Array(await file.arrayBuffer()),
      mime: text(o.mime) ?? (file.type || null),
      language: text(o.lang),
      target: text(o.out),
      vocabulary: Array.isArray(o.vocabulary) ? o.vocabulary.filter((v) => typeof v === 'string').slice(0, 60) : [],
      durationMs: Number(o.duration_ms) || null,
      speech: cleanSpeechMap(o.speech),
      // S45: how long Mullo's server may keep the result. Passed on as sent; the Worker's
      // KEEP_CHOICES decides what it means and refuses anything else. The bridge ignores it.
      ...(o.keep !== undefined ? { keep: o.keep } : {}),
    };
  }
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_AUDIO_BYTES) throw tooLong();
  return {
    audio,
    mime: request.headers.get('Content-Type'),
    language: url.searchParams.get('lang'),
    target: url.searchParams.get('out') || null,
    vocabulary: url.searchParams.getAll('vocab').slice(0, 60),
    durationMs: Number(url.searchParams.get('duration_ms')) || null,
    speech: null,
  };
}

// The speech map: where the phone heard sound ({ ranges: [[start_ms, end_ms], ...],
// duration_ms }, from capture/silence.js or Silence in WatchAi.kt). Gemini invents
// words for silence; the map lets us refuse a silent note before calling it, and
// drop lines it wrote over a long quiet stretch. Only long stretches count, with a
// wide margin: Gemini's clock can be a few seconds off, and dropping real words is
// worse than keeping a made-up line. No map (or a broken one) = nothing is dropped.
const QUIET_GAP_MS = 10_000;
const QUIET_MARGIN_MS = 3_000;
const MAX_RANGES = 5_000;

export function cleanSpeechMap(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.ranges) || raw.ranges.length > MAX_RANGES) return null;
  const durationMs = Number(raw.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const ranges = [];
  let last = 0;
  for (const r of raw.ranges) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [s, e] = r.map(Number);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < last || e < s) return null;
    ranges.push([s, e]);
    last = e;
  }
  return { ranges, durationMs };
}

// Where a line may not start: inside a long quiet stretch, minus the margin.
export function quietStretches({ ranges, durationMs }) {
  const out = [];
  let from = 0;
  for (const [s, e] of [...ranges, [durationMs, durationMs]]) {
    if (s - from >= QUIET_GAP_MS) out.push([from + QUIET_MARGIN_MS, s - QUIET_MARGIN_MS]);
    from = Math.max(from, e);
  }
  return out;
}

export function dropQuietSegments(segments, map, { durationMs = null } = {}) {
  const quiet = quietStretches(map);
  const kept = segments
    .filter((s) => s.start_ms == null || !quiet.some(([a, b]) => s.start_ms >= a && s.start_ms <= b))
    .map((s) => ({ ...s, end_ms: null }));
  return { segments: fillEnds(kept, durationMs), dropped: segments.length - kept.length };
}

// null = "detect automatically" (also for anything not on the list).
export function languageName(code) {
  return englishName(code);
}

// language: what was spoken (null = detect). target: the language to write
// the transcript in, when the person wants it different (a faithful translation).
// fromMs: a later round of a long meeting (see transcribeWithGemini) starts there.
// before: the lines earlier rounds wrote, so the same voice keeps the same speaker number.
// The audio is inline (audioBase64) or a Files API upload (fileUri).
export function buildTranscribeRequest({ audioBase64, fileUri = null, mime, language, target = null, vocabulary = [], fromMs = 0, before = [] }) {
  const lang = languageName(language);
  const out = target && languageName(target) !== lang ? languageName(target) : null;
  const system = [
    out
      ? `Transcribe the audio and write it in ${out}: a faithful, complete translation, segment by segment. Do not summarise or add anything that was not said. Keep names as they are.`
      : 'Transcribe the audio word for word. Do not summarise, translate, or add anything that was not said.',
    lang
      ? `The speech is mostly ${lang}.${out ? '' : " Write each part in the language it was spoken in, in that language's own script (Hebrew in Hebrew letters, Arabic in Arabic letters, Russian in Cyrillic…) - never transliterate into Latin letters, never translate."}`
      : `The language was not chosen and may be mixed: detect it.${out ? '' : " Write each part in the language it was spoken in, in that language's own script - never transliterate, never translate."}`,
    vocabularyLine(vocabulary),
    // Owner, 2026-10-15, with a cold: "Barina" for Marina, "Boland" for Roland.
    'Speakers may have an accent, a cold or a blocked nose, or be tired. With a blocked nose "m" and "n" sound like "b" and "d" ("Barina" is Marina). When a word or name heard slightly off is clearly one from the list above, or one said elsewhere in the recording, or the only word that makes sense there, write the word they meant ("Boland" in a talk about Roland is Roland). When it is not clear, write what you heard. This is only for real speech that sounds a little off, never for silence or noise.',
    'Label speakers "Speaker 1", "Speaker 2", … in order of first appearance. If only one person speaks, use "Speaker 1" throughout.',
    'Start a new segment at each change of speaker or each pause; keep segments under about 30 seconds.',
    'start is the time the segment begins, as M:SS (or H:MM:SS).',
    'If a part is unintelligible, write [unclear]. If there is no speech at all, return an empty list.',
    // Owner, 2026-10-14: a $2.35 unit price ("two thirty-five", made of 85 cents and $1.50)
    // came back as "235" on one run and "2.35" on another.
    'Write numbers as digits the way the speaker means them: a price said as "two thirty-five" is 2.35 when the talk is about a price per unit or cents ("85 and $1.50" adds up to 2.35). Keep the decimal point, and the currency sign when one is said.',
    // Measured 2026-10-06: recordings where nothing was said came back with words.
    'Silence, breathing, rustling, background noise and music are not speech: never turn them into words. Write a name from the list above only when you clearly hear it.',
    // Owner, 2026-10-14: 1-2 s clips with nothing clear came back as invented sentences.
    'A short or quiet recording often holds only a word or two, or nothing: write exactly what you hear and no more. If you are not sure anything was said, return an empty list.',
    fromMs > 0
      ? `Everything before ${clock(fromMs)} is already written. Transcribe only from ${clock(fromMs)} to the end of the audio. Times stay counted from the very start of the recording. Keep the speaker numbers you would have used for the whole recording.`
      : null,
    fromMs > 0 ? speakerContext(before) : null,
  ].filter(Boolean).join('\n');
  const audio = fileUri ? { file_data: { mime_type: mime, file_uri: fileUri } } : { inline_data: { mime_type: mime, data: audioBase64 } };

  // The instruction goes next to the audio as well as in the system prompt.
  // Measured 2026-10-04: with it in the system prompt only, 3.1-flash-lite
  // ignored both the names list and translation on audio (3.8-flash obeyed);
  // repeated in the user turn, 3.1-flash-lite obeyed both.
  return {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [audio, { text: system }] }],
    // No temperature: Google's advice for Gemini 3 models is to leave it at 1.0, since
    // lower values can make them loop - which a 28-minute meeting did at 0 (2026-10-07).
    generationConfig: {
      maxOutputTokens: ROUND_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          segments: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { speaker: { type: 'STRING' }, start: { type: 'STRING' }, text: { type: 'STRING' } },
              required: ['text'],
            },
          },
        },
        required: ['segments'],
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

// A later round hears the whole recording but writes only its own part, and numbered the
// voices by who spoke first in THAT part, so its "Speaker 1" could be someone else. So it
// gets every label used so far and the last lines written, each with its speaker.
const CONTEXT_LINES = 8;
export function speakerContext(before) {
  const lines = (Array.isArray(before) ? before : []).filter((s) => s?.text);
  if (!lines.length) return null;
  const used = [...new Set(lines.map((s) => s.speaker).filter(Boolean))];
  return [
    used.length ? `Speakers so far: ${used.join(', ')}. Give the same voice the same label; a voice not heard before gets the next number.` : null,
    'The last lines already written, only so you can match the voices (do not write them again):',
    ...lines.slice(-CONTEXT_LINES).map((s) => `[${s.start_ms != null ? clock(s.start_ms) : '?'}] ${s.speaker ?? 'Speaker ?'}: ${s.text.slice(0, 160)}`),
  ].filter(Boolean).join('\n');
}

// Times must move forward and stay inside the recording; anything else is
// dropped to null rather than trusted.
export function sanitizeTranscript(raw, { durationMs = null } = {}) {
  const limit = Number.isFinite(durationMs) && durationMs > 0 ? durationMs + 5_000 : Infinity;
  let last = 0;
  const segments = (Array.isArray(raw?.segments) ? raw.segments : [])
    .map((s) => {
      const text = String(s?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      let start = clockToMs(s?.start);
      if (start == null || start < last || start > limit) start = null;
      else last = start;
      const speaker = s?.speaker ? String(s.speaker).trim().slice(0, 30) : null;
      return { speaker, text, start_ms: start, end_ms: null };
    })
    .filter((s) => s.text);
  return fillEnds(segments, durationMs);
}

// More words than the audio could hold = the AI wrote them, nobody said them. Owner,
// 2026-10-14: 1.6 s watch clips with no clear speech came back as 14-word Hebrew sentences
// built from the Names & words list ("להוציא מחר את הקייסים… acetone"). People talk at about
// 2.5-3.5 words a second; 4 (6 for a translation, which runs longer) with a floor of 6 words
// leaves room for a fast short note. Any length is checked; long recordings never get near it.
const WORDS_PER_SECOND = 4;
const WORDS_PER_SECOND_TRANSLATED = 6;
const MIN_WORDS_ALLOWED = 6;
export function tooManyWords(segments, durationMs, { translated = false } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  const words = (segments ?? []).reduce((n, s) => n + String(s.text ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length, 0);
  const rate = translated ? WORDS_PER_SECOND_TRANSLATED : WORDS_PER_SECOND;
  return words > Math.max(MIN_WORDS_ALLOWED, (durationMs / 1000) * rate);
}

// Each line ends where the next timed one starts (the last one at the end of the recording).
function fillEnds(segments, durationMs) {
  const known = Number.isFinite(durationMs) && durationMs > 0;
  for (let i = 0; i < segments.length; i += 1) {
    const next = segments.slice(i + 1).find((x) => x.start_ms != null)?.start_ms;
    if (segments[i].start_ms != null) {
      segments[i].end_ms = next ?? (known ? Math.max(segments[i].start_ms, durationMs) : null);
    }
  }
  return segments;
}

// Gemini's reply, streamed (server-sent events: each "data:" line is a piece of the
// answer) or as one JSON body. → { text, finish }. A stream that breaks off says so.
export async function readGeminiReply(res) {
  const type = res.headers.get('Content-Type') ?? '';
  const raw = await res.text();
  const fail = (why) => Object.assign(new Error(`Gemini ${res.status}: ${why}`), { status: 502 });
  if (!type.includes('text/event-stream')) {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    if (!res.ok) throw fail(body?.error?.message ?? 'error');
    return { text: body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '', finish: body?.candidates?.[0]?.finishReason ?? null };
  }
  let text = '';
  let finish = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    let chunk;
    try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
    if (chunk?.error) throw fail(chunk.error.message ?? 'error');
    const cand = chunk?.candidates?.[0];
    text += cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    finish = cand?.finishReason ?? finish;
  }
  if (!res.ok) throw fail('error');
  return { text, finish };
}

// Refused before any AI work (also before a background job is queued, worker/src/jobs.mjs).
export function checkAudio({ audio, mime }) {
  if (!audio?.length) throw Object.assign(new Error('No audio'), { status: 400 });
  if (audio.length > MAX_AUDIO_BYTES) throw tooLong();
  if (!/^audio\//.test(mime ?? '')) throw Object.assign(new Error('Not an audio file'), { status: 415 });
}

const geminiFail = (message) => Object.assign(new Error(message), { status: 502 });

// Files API, resumable upload in one go → { name, uri } once Gemini can read it.
// Ported from the Mac's long-recordings branch (2026-10-04).
export async function uploadAudio(audio, mime, { apiKey, doFetch, signal, sleep }) {
  const start = await doFetch(`${BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(audio.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'mullo-recording' } }),
    signal,
  });
  if (!start.ok) {
    const body = await start.json().catch(() => ({}));
    throw geminiFail(`Gemini upload ${start.status}: ${body?.error?.message ?? 'error'}`);
  }
  const uploadUrl = start.headers.get('x-goog-upload-url');
  // The key goes only to Google's own host.
  if (!uploadUrl?.startsWith(`${BASE}/`)) throw geminiFail('Gemini upload: no upload address');
  const done = await doFetch(uploadUrl, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: audio,
    signal,
  });
  const body = await done.json().catch(() => ({}));
  if (!done.ok || !body?.file?.name) throw geminiFail(`Gemini upload ${done.status}: ${body?.error?.message ?? 'no file returned'}`);
  let file = body.file;
  // Audio is usually ACTIVE at once; wait a little when it isn't.
  for (let i = 0; file.state === 'PROCESSING' && i < 60; i += 1) {
    await sleep(1000);
    const res = await doFetch(`${BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': apiKey }, signal });
    file = await res.json().catch(() => ({ ...file, state: 'FAILED' }));
  }
  if (file.state && file.state !== 'ACTIVE') throw geminiFail(`Gemini could not read the audio file (${file.state})`);
  return { name: body.file.name, uri: file.uri ?? body.file.uri };
}

// Best effort: the file holds a conversation, and Gemini would keep it 48 hours otherwise.
async function deleteAudio(name, { apiKey, doFetch }) {
  try { await doFetch(`${BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': apiKey } }); } catch { /* expires on its own */ }
}

// Streamed: a long meeting takes Gemini minutes to write out, and a request that sends
// nothing back for ~2 minutes is cut off on the way (a 28-minute meeting got a 524 on
// 2026-10-07). With the answer coming in pieces, the line is never idle that long.
// timeoutMs covers the whole answer; the phone's background job must finish in 10 minutes.
export async function transcribeWithGemini({ audio, mime, language, target = null, vocabulary = [], durationMs, speech = null }, {
  apiKey, model = DEFAULT_MODEL, fetch: doFetch = globalThis.fetch, timeoutMs = 7 * 60_000,
  inlineMaxBytes = INLINE_MAX_BYTES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY is not set on the bridge'), { status: 503 });
  checkAudio({ audio, mime });
  // The phone heard no sound at all: nothing to send.
  if (speech && !speech.ranges.length) return { segments: [], language: target ?? language ?? null, spoken: language ?? null, engine: 'silence', silent: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Gemini wants the base type; drop codec parameters ("audio/webm;codecs=opus").
  const baseMime = mime.split(';')[0];
  const upload = audio.length > inlineMaxBytes;
  let file = null;
  try {
    if (upload) {
      try { file = await uploadAudio(audio, baseMime, { apiKey, doFetch, signal: ctrl.signal, sleep }); } catch (err) {
        if (err?.name === 'AbortError') throw Object.assign(new Error('Sending the recording to Gemini took too long - try again'), { status: 504 });
        throw err;
      }
    }
    const source = file ? { fileUri: file.uri } : { audioBase64: Buffer.from(audio).toString('base64') };
    let all = [];
    let from = 0;
    let complete = false;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      let text;
      let finish;
      try {
        const body = JSON.stringify(buildTranscribeRequest({ ...source, mime: baseMime, language, target, vocabulary, fromMs: from, before: all }));
        const res = await sendRetryingBusy(() => doFetch(`${API}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body,
          signal: ctrl.signal,
        }), { sleep });
        ({ text, finish } = await readGeminiReply(res));
      } catch (err) {
        if (err?.name === 'AbortError' && all.length) break; // out of time: keep what came back
        if (err?.name === 'AbortError') throw Object.assign(new Error(`Gemini took longer than ${Math.round(timeoutMs / 60_000)} minutes`), { status: 504 });
        throw err;
      }
      const cutOff = finish === 'MAX_TOKENS';
      let raw;
      try { raw = JSON.parse(text)?.segments; } catch { raw = null; }
      if (!Array.isArray(raw)) {
        if (!cutOff) throw Object.assign(new Error('Gemini returned no JSON'), { status: 502 });
        raw = finishedSegments(text);
      }
      const { kept, repeating } = trimRepeats(raw);
      // A later round's lines start where the last one stopped (a little overlap is cut).
      const fresh = sanitizeTranscript({ segments: kept }, { durationMs })
        .filter((s) => !from || s.start_ms == null || s.start_ms >= from);
      all = all.concat(fresh);
      if (!cutOff && !repeating) { complete = true; break; }
      const last = fresh.findLast((s) => s.start_ms != null)?.start_ms;
      if (last == null || last + RESUME_AFTER_MS <= from) break; // no progress: stop with what we have
      from = last + RESUME_AFTER_MS;
      if (durationMs && from >= durationMs - RESUME_AFTER_MS) { complete = true; break; }
    }
    if (!all.length && !complete) throw Object.assign(new Error('Gemini’s answer broke off before any usable lines - try again'), { status: 502 });
    let segments = fillEnds(all.map((s) => ({ ...s, end_ms: null })), durationMs);
    let dropped = 0;
    if (speech) ({ segments, dropped } = dropQuietSegments(segments, speech, { durationMs }));
    if (tooManyWords(segments, durationMs, { translated: Boolean(target) })) {
      return { segments: [], language: target ?? language ?? null, spoken: language ?? null, engine: model, madeUp: true };
    }
    return {
      segments, language: target ?? language ?? null, spoken: language ?? null, engine: model,
      ...(dropped ? { dropped } : {}), ...(complete ? {} : { incomplete: true }),
    };
  } finally {
    clearTimeout(timer);
    if (file) await deleteAudio(file.name, { apiKey, doFetch });
  }
}

// Long meetings come back in rounds. Each answer is capped (ROUND_TOKENS, roughly 25
// minutes of talk), so when Gemini gets stuck repeating a line - flash-lite did, on a
// 28-minute meeting, for 4.5 minutes until its 65k answer limit (2026-10-07) - only
// that round is lost: the finished lines are kept, the repeating tail is cut, and the
// next round starts after the last good line. Each round sends the audio again (or points at the one upload).
const MAX_ROUNDS = 6;
const ROUND_TOKENS = 16_384;
const RESUME_AFTER_MS = 1_000;

// The complete segment objects in an answer that was cut off mid-way.
export function finishedSegments(text) {
  const start = text.indexOf('[', text.indexOf('"segments"'));
  if (start < 0) return [];
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth === 0) objStart = i; depth += 1; }
    else if (c === '}') {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* skip a broken one */ }
        objStart = -1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  return out;
}

// Gemini stuck in a loop: the same line again and again, or one phrase repeated
// inside a line. → { kept: the lines before the loop, repeating }.
const REPEAT_LINES = 3;
const REPEAT_PHRASE = 6;
export function trimRepeats(segments) {
  const norm = (s) => String(s?.text ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (let i = 0; i < segments.length; i += 1) {
    if (loopsInside(norm(segments[i]))) return { kept: segments.slice(0, i), repeating: true };
    const t = norm(segments[i]);
    if (!t) continue;
    let same = 1;
    for (let j = i + 1; j < segments.length && norm(segments[j]) === t; j += 1) same += 1;
    if (same >= REPEAT_LINES) return { kept: segments.slice(0, i + 1), repeating: true };
  }
  return { kept: segments, repeating: false };
}

// A phrase of 1 to 6 words said REPEAT_PHRASE times in a row ("yes yes yes yes yes yes" is
// still a person, so it takes a long line: 40+ words).
function loopsInside(text) {
  const words = text.split(' ').filter(Boolean);
  if (words.length < 40) return false;
  for (let n = 1; n <= 6; n += 1) {
    let run = 1;
    for (let i = n; i + n <= words.length; i += n) {
      run = words.slice(i, i + n).join(' ') === words.slice(i - n, i).join(' ') ? run + 1 : 1;
      if (run >= REPEAT_PHRASE) return true;
    }
  }
  return false;
}
