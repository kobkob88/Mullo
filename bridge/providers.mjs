// The three AI jobs on a person's own key (worker/src/ownkey.mjs): Gemini, OpenAI or Claude.
// One entry point per job; Gemini keeps its own modules (gemini.mjs, ask.mjs, chat.mjs, transcribe.mjs),
// the other two reuse Mullo's prompts from them and the same checks on the answer
// (sanitize, sanitizeAnswer, sanitizeChat), so a summary reads the same whoever wrote it.
//
// Claude doesn't take audio: transcription on a Claude key goes to the person's Mullo plan
// (the Worker decides, `CAN`). OpenAI transcribes with its diarize model, which labels
// speakers but takes no names list and doesn't translate.

import { buildRequest, sanitize, processWithGemini, DEFAULT_MODEL } from './gemini.mjs';
import { buildAskRequest, sanitizeAnswer, askWithGemini } from './ask.mjs';
import { buildChatRequest, sanitizeChat, chatWithGemini, retryMissingDraft } from './chat.mjs';
import { transcribeWithGemini, dropQuietSegments, checkAudio, languageName, tooManyWords } from './transcribe.mjs';

export const OPENAI_MODEL = 'gpt-6-luna';
export const OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-transcribe-diarize';
export const CLAUDE_MODEL = 'claude-opus-5-5';
// What each provider can do. The Worker checks this before using a person's key.
export const CAN = {
  gemini: ['transcribe', 'process', 'ask'],
  openai: ['transcribe', 'process', 'ask'],
  anthropic: ['process', 'ask'],
};
export const LABEL = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Claude' };
// OpenAI's transcription limit (25 MB): at Mullo's 32 kbps, about 1 h 45 min.
export const OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const OPENAI_TOO_LARGE = 'OpenAI takes recordings up to 25 MB (about 1 hour 45 minutes). Use Gemini or Mullo\'s plan for this one.';
export const OPENAI_NO_TRANSLATION = 'OpenAI can\'t write the transcript in another language. Set the transcript language to the spoken one, or use Gemini or Mullo\'s plan.';

const fail = (status, message) => Object.assign(new Error(message), { status });

// The model for this provider: the Worker's setting if it has one, else the default.
export function modelFor(provider, env = {}) {
  if (provider === 'openai') return env.OPENAI_MODEL || OPENAI_MODEL;
  if (provider === 'anthropic') return env.CLAUDE_MODEL || CLAUDE_MODEL;
  return env.GEMINI_MODEL || DEFAULT_MODEL;
}

// ── The jobs ──────────────────────────────────────────────────────────
// opts: { provider = 'gemini', apiKey, model, fetch, timeoutMs }

export async function processNotes(input, opts) {
  const { provider = 'gemini' } = opts;
  if (provider === 'gemini') return processWithGemini(input, opts);
  if (!Array.isArray(input.segments) || !input.segments.length) throw fail(400, 'No transcript');
  const raw = await jsonCall(fromGemini(buildRequest(input), 'notes'), opts);
  return sanitize(raw, { template: input.template, segments: input.segments, model: opts.model });
}

export async function askNotes(input, opts) {
  const { provider = 'gemini' } = opts;
  if (provider === 'gemini') return askWithGemini(input, opts);
  if (!String(input.question ?? '').trim()) throw fail(400, 'Ask a question first');
  if (!Array.isArray(input.recordings)) throw fail(400, 'No recordings sent');
  const { refs, body } = buildAskRequest(input);
  const raw = await jsonCall(fromGemini(body, 'answer'), opts);
  return { ...sanitizeAnswer(raw, refs), engine: opts.model };
}

// Ask as a chat (chat.mjs, S10): follow-ups, and drafts inside it. The 'ask' job, like /api/ask.
export async function chatNotes(input, opts) {
  const { provider = 'gemini' } = opts;
  if (provider === 'gemini') return chatWithGemini(input, opts);
  const { refs, tasks, body } = buildChatRequest(input);
  const spec = fromGemini(body, 'chat');
  return retryMissingDraft(async () => ({ ...sanitizeChat(await jsonCall(spec, opts), refs, tasks), engine: opts.model }));
}

export async function transcribeAudio(request, opts) {
  const { provider = 'gemini' } = opts;
  if (provider === 'gemini') return transcribeWithGemini(request, opts);
  if (provider === 'openai') return transcribeWithOpenAI(request, opts);
  throw fail(400, `${LABEL[provider] ?? 'This AI'} can't turn audio into text.`);
}

// ── Text jobs on OpenAI or Claude ────────────────────────────────────

// A Gemini request → { system, user, schema, name }: one copy of each prompt.
export function fromGemini(req, name) {
  return {
    name,
    system: (req.system_instruction?.parts ?? []).map((p) => p.text ?? '').join('\n'),
    user: (req.contents ?? []).flatMap((c) => c.parts ?? []).map((p) => p.text).filter(Boolean).join('\n\n'),
    schema: jsonSchema(req.generationConfig?.responseSchema),
  };
}

// Gemini's schema (OBJECT, STRING, nullable) → JSON Schema in the strict form both OpenAI and
// Claude accept: every object closed, every property required, an optional one nullable
// (the checks on the answer already treat null as "not given").
export function jsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const type = String(s.type ?? '').toLowerCase();
  const optional = s.nullable === true;
  const out = {};
  if (type === 'object') {
    const props = s.properties ?? {};
    const required = new Set(s.required ?? []);
    out.type = 'object';
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, jsonSchema(required.has(k) ? v : { ...v, nullable: true })]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (type === 'array') {
    out.type = 'array';
    out.items = jsonSchema(s.items);
  } else {
    out.type = type;
    if (Array.isArray(s.enum)) out.enum = optional ? [...s.enum, null] : [...s.enum];
  }
  if (optional) out.type = [out.type, 'null'];
  return out;
}

async function jsonCall(spec, opts) {
  const { provider, apiKey, fetch: doFetch = globalThis.fetch, timeoutMs = 120_000 } = opts;
  if (!apiKey) throw fail(503, 'No AI key for this call');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const text = provider === 'openai'
      ? await openaiText(spec, { ...opts, doFetch, signal: ctrl.signal })
      : await claudeText(spec, { ...opts, doFetch, signal: ctrl.signal });
    try { return JSON.parse(text); } catch { throw fail(502, `${LABEL[provider]} returned no JSON`); }
  } catch (err) {
    if (err?.name === 'AbortError') throw fail(504, `${LABEL[provider]} took longer than ${Math.round(timeoutMs / 1000)} seconds`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const reason = (body) => body?.error?.message ?? 'error';

// OpenAI Responses API. store: false, so OpenAI doesn't keep the conversation as a stored response.
async function openaiText({ system, user, schema, name }, { apiKey, model, doFetch, signal }) {
  const res = await doFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, store: false, instructions: system, input: user,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
    }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(502, `OpenAI ${res.status}: ${reason(body)}`);
  if (body.status === 'incomplete') throw fail(502, `OpenAI's answer broke off (${body.incomplete_details?.reason ?? 'incomplete'}) - try again`);
  const parts = (body.output ?? []).filter((o) => o?.type === 'message').flatMap((o) => o.content ?? []);
  const refusal = parts.find((p) => p?.type === 'refusal');
  if (refusal) throw fail(502, `OpenAI declined: ${String(refusal.refusal ?? '').slice(0, 200)}`);
  return parts.filter((p) => p?.type === 'output_text').map((p) => p.text ?? '').join('');
}

// Claude Messages API: structured output (output_config.format), low effort (notes and
// answers don't need deep thought), and Anthropic's own fallback if a safety check declines.
async function claudeText({ system, user, schema }, { apiKey, model, doFetch, signal }) {
  const res = await doFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model, max_tokens: 16_000, system, messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      fallbacks: 'default',
    }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(502, `Claude ${res.status}: ${reason(body)}`);
  if (body.stop_reason === 'refusal') throw fail(502, 'Claude declined this one.');
  if (body.stop_reason === 'max_tokens') throw fail(502, 'Claude\'s answer broke off - try again');
  return (body.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
}

// ── Transcription on OpenAI ──────────────────────────────────────────

const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'video/mp4': 'mp4', 'video/webm': 'webm' };

// OpenAI's labels ("A", "B", or names) → "Speaker 1", "Speaker 2" in order of first appearance,
// like Gemini's. Times come in seconds; anything going backwards or past the end is dropped.
export function openaiSegments(raw, { durationMs = null } = {}) {
  const limit = Number.isFinite(durationMs) && durationMs > 0 ? durationMs + 5_000 : Infinity;
  const names = new Map();
  let last = 0;
  return (Array.isArray(raw?.segments) ? raw.segments : [])
    .map((s) => {
      const text = String(s?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (!text) return null;
      const label = String(s?.speaker ?? '').trim();
      if (label && !names.has(label)) names.set(label, `Speaker ${names.size + 1}`);
      let start = Number.isFinite(s?.start) ? Math.round(s.start * 1000) : null;
      if (start == null || start < last || start > limit) start = null;
      else last = start;
      let end = Number.isFinite(s?.end) ? Math.round(s.end * 1000) : null;
      if (end == null || start == null || end < start || end > limit) end = null;
      return { speaker: label ? names.get(label) : 'Speaker 1', text, start_ms: start, end_ms: end };
    })
    .filter(Boolean);
}

export async function transcribeWithOpenAI({ audio, mime, language, target = null, durationMs, speech = null }, {
  apiKey, fetch: doFetch = globalThis.fetch, timeoutMs = 7 * 60_000,
}) {
  if (!apiKey) throw fail(503, 'No AI key for this call');
  checkAudio({ audio, mime });
  if (speech && !speech.ranges.length) return { segments: [], language: target ?? language ?? null, spoken: language ?? null, engine: 'silence', silent: true };
  if (target && languageName(target) !== languageName(language)) throw fail(400, OPENAI_NO_TRANSLATION);
  if (audio.length > OPENAI_MAX_AUDIO_BYTES) throw fail(413, OPENAI_TOO_LARGE);
  const baseMime = mime.split(';')[0];
  const form = new FormData();
  form.append('file', new Blob([audio], { type: baseMime }), `recording.${EXT[baseMime] ?? 'webm'}`);
  form.append('model', OPENAI_TRANSCRIBE_MODEL);
  form.append('response_format', 'diarized_json');
  form.append('chunking_strategy', 'auto');
  if (/^[a-z]{2}$/.test(language ?? '')) form.append('language', language);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await doFetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: ctrl.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw fail(504, `OpenAI took longer than ${Math.round(timeoutMs / 60_000)} minutes`);
      throw err;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(502, `OpenAI ${res.status}: ${reason(body)}`);
    let segments = openaiSegments(body, { durationMs });
    let dropped = 0;
    if (speech) ({ segments, dropped } = dropQuietSegments(segments, speech, { durationMs }));
    if (tooManyWords(segments, durationMs)) {
      return { segments: [], language: language ?? null, spoken: language ?? null, engine: OPENAI_TRANSCRIBE_MODEL, madeUp: true };
    }
    return {
      segments, language: language ?? null, spoken: language ?? null, engine: OPENAI_TRANSCRIBE_MODEL,
      ...(dropped ? { dropped } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
