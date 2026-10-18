// Ask your recordings (the Vocci/Pocket "ask your memory" idea).
// The app sends the question plus the few recordings it picked; the model
// answers from those only and names its sources by short ref (r1, r2…).
// Refs are mapped back to ids here, and any ref that wasn't sent is dropped,
// so the app never links to a recording the model made up.

import { DEFAULT_MODEL, withThinking } from './gemini.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_RECORDINGS = 15;
const MAX_TRANSCRIPT_CHARS = 6000;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

export function buildAskRequest({ question, today, recordings }) {
  const refs = recordings.slice(0, MAX_RECORDINGS).map((r, i) => ({ ref: `r${i + 1}`, ...r }));
  const notes = refs.map((r) => [
    `### ${r.ref} - "${clip(r.title, 120)}" (${r.date})`,
    r.summary ? `Summary: ${clip(r.summary, 1500)}` : null,
    r.actions?.length ? `Action items: ${r.actions.map((a) => clip(a, 200)).join(' | ')}` : null,
    r.transcript ? `Transcript: ${clip(r.transcript, MAX_TRANSCRIPT_CHARS)}` : null,
  ].filter(Boolean).join('\n')).join('\n\n');

  const system = [
    "You answer questions about the person's own recorded conversations and voice notes.",
    'Use ONLY the notes below. If they do not contain the answer, say so plainly and set found to false - never guess or fill in from general knowledge.',
    'Answer in the language of the question, briefly (a few sentences or a short list).',
    `Today is ${today}. Mention dates when they help ("on Oct 3").`,
    'sources: the refs (r1, r2…) of the notes your answer actually uses.',
  ].join('\n');

  return {
    refs,
    body: {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: `Notes:\n\n${notes || '(none)'}\n\nQuestion: ${clip(question, 500)}` }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            answer: { type: 'STRING' },
            found: { type: 'BOOLEAN' },
            sources: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['answer', 'found', 'sources'],
        },
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  };
}

export function sanitizeAnswer(raw, refs) {
  const byRef = new Map(refs.map((r) => [r.ref, r.id]));
  const sources = [...new Set((Array.isArray(raw?.sources) ? raw.sources : [])
    .map((s) => byRef.get(String(s).trim()))
    .filter(Boolean))];
  return {
    answer: clip(raw?.answer, 3000) || 'No answer.',
    found: raw?.found === true && sources.length > 0,
    sources,
  };
}

export async function askWithGemini({ question, today, recordings }, { apiKey, model = DEFAULT_MODEL, thinking, fetch: doFetch = globalThis.fetch, timeoutMs = 45_000 }) {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY is not set on the bridge'), { status: 503 });
  if (!String(question ?? '').trim()) throw Object.assign(new Error('Ask a question first'), { status: 400 });
  if (!Array.isArray(recordings)) throw Object.assign(new Error('No recordings sent'), { status: 400 });
  const { refs, body } = buildAskRequest({ question, today, recordings });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(withThinking(body, thinking)),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Gemini ${res.status}: ${json?.error?.message ?? 'error'}`), { status: 502 });
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    let raw;
    try { raw = JSON.parse(text); } catch { throw Object.assign(new Error('Gemini returned no JSON'), { status: 502 }); }
    return { ...sanitizeAnswer(raw, refs), engine: model };
  } finally {
    clearTimeout(timer);
  }
}
