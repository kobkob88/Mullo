// The AI engine on the bridge: transcript → title, sections, summary (by
// template), action items - the same shapes as app/domain/engines/local.js,
// so the app does not care which engine answered.
//
// Gemini returns JSON against a schema; everything it returns is then
// checked here (types, enums, dates, time ranges, lengths). Anything that
// doesn't pass is dropped, not repaired into something it didn't say.

import { resolveTemplate } from '../app/domain/templates.js';
import { parseTeachEntry } from '../app/domain/corrections.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// One default for every AI call (process, transcribe, ask); GEMINI_MODEL
// overrides it. Benchmarked 2026-10-04 on the same mixed Hebrew/English note
// and a Hebrew voice clip (Gemini TTS):
//   3.1-flash-lite  transcribe 1.4 s, process 2.3 s - all 5 tasks, Hebrew correct
//   3.8-flash       transcribe 2.0 s, process 2.7 s - identical tasks
//   2.5-flash       heard "Dana" as "Donna"; left the day inside Hebrew labels
//   3.1-pro-preview refuses thinkingBudget 0 (thinking-only), ~8× the price
//   3.5-transcribe  refuses system instructions
// Paid prices per 1M tokens (ai.google.dev pricing, 2026-10-04):
//   3.1-flash-lite  in $0.25 text / $0.50 audio, out $1.50 (free tier: yes)
//   3.8-flash       in $0.75, out $3.75 (doubles 2027-01-01)
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

// How long a model thinks before answering, per model (S54). 'none' = thinkingBudget 0: the
// Flash-Lite models, fastest and cheapest. 'minimal' / 'low' = thinkingLevel, for models that
// refuse a budget (3.1-pro-preview did, see above; 3.5 Flash-Lite answered 400 "invalid
// argument" to budget 0 on 2026-10-17). undefined = keep what the request was built with.
export function thinkingConfig(thinking = 'none') {
  return thinking === 'low' || thinking === 'minimal' ? { thinkingLevel: thinking } : { thinkingBudget: 0 };
}
export function withThinking(body, thinking) {
  if (!thinking) return body;
  return { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: thinkingConfig(thinking) } };
}
const TYPES = ['create_reminder', 'send_message', 'draft_email'];
const PRIORITIES = ['high', 'medium', 'low'];
const TASK_LANGUAGE = 'Action items: list every task from the whole transcript, each one once, in the language its own words were spoken in (said in English → an English task, said in Hebrew → a Hebrew task, said in Russian → a Russian task, and so on for any language). Never translate a task and never list the same task twice in two languages.';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Names and words the person told us about ("נועה (Noa)"), for both
// transcription and summaries. Without them a name can come out as ordinary
// words - measured: a name was heard as ordinary Hebrew words.
// Entries taught from the person's own fixes ("Charmander (heard as שרמן דרך)",
// app/domain/corrections.js) become explicit "heard X → write Y" pairs.
export function vocabularyLine(vocabulary) {
  const list = (Array.isArray(vocabulary) ? vocabulary : [])
    .map((v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 60);
  if (!list.length) return null;
  const taught = list.map(parseTeachEntry).filter(Boolean);
  const names = [...new Set(list.map((v) => parseTeachEntry(v)?.word ?? v))];
  const fixes = taught.map((t) => `"${t.heardAs}" → write "${t.word}"`);
  // Owner, 2026-10-14: near-silent watch clips came back as sentences made of these very
  // words. The list is a spelling guide, never a hint of what was said.
  return [
    `Names and words this person uses - when you hear something that sounds like one of them, write it exactly as given: ${names.join('; ')}.`,
    fixes.length ? `Mistakes the person corrected before - when you hear these, write the word they meant: ${fixes.join('; ')}.` : null,
    'These lists are only for spelling words you actually hear. They say nothing about what this recording contains: never write a word from them that was not clearly said.',
  ].filter(Boolean).join(' ');
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

export function clock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "6:12", "[6:12]", "1:02:03" → ms. Gemini writes "0:2" as often as "0:02" (measured
// 2026-10-04): accept both.
export function clockToMs(s) {
  const m = /^\s*\[?\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*\]?\s*$/.exec(String(s ?? ''));
  if (!m || Number(m[3]) > 59) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] ?? '0').padEnd(3, '0'));
}

// What goes in one summary block. A person's own format says it in their words,
// quoted, so it reads as a description of the block rather than as orders.
// alone: the overview is the format's only text block (Voice note, the watch's default), so it
// carries every fact. Owner, 2026-10-14: a 3-minute supplier call came back as two lines with
// no price, no "they supply the labels and boxes", no "send the PO".
function blockShape(b, { alone = false } = {}) {
  if (b.kind === 'actions') return 'the action item labels';
  const shape = b.kind !== 'overview' ? 'short bullet points'
    : alone ? 'short bullet points: one line for a short note, more for a conversation, until every specific from the rule above is in' : '1–2 sentences';
  return b.hint ? `${shape}; what goes here: ${JSON.stringify(b.hint)}` : shape;
}

export function transcriptText(segments) {
  return segments.map((s) => {
    const at = Number.isFinite(s.start_ms) ? `[${clock(s.start_ms)}] ` : '';
    const who = s.speaker ? `${s.speaker}: ` : '';
    return `${at}${who}${s.text}`;
  }).join('\n');
}

export function buildRequest({ segments, template, today, vocabulary = [] }) {
  const t = resolveTemplate(template);
  const [y, m, d] = String(today).split('-').map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  const alone = t.blocks.filter((b) => b.kind !== 'actions').length === 1;
  const blocks = t.blocks.map((b, i) => `${i + 1}. ${JSON.stringify(b.heading)} (${blockShape(b, { alone })})`).join('\n');

  const system = [
    'You turn the transcript of a conversation or voice note into structured notes.',
    'Rules:',
    '- Cover the WHOLE transcript, every line, in every language it contains. People often mix two or more languages (Hebrew and English, Russian and English, Arabic and Hebrew…); nothing is skipped because of its language.',
    '- Keep each action item in the language it was said. Write the title and summary in the language most of the transcript is in. Keep names as said.',
    '- Use only what is in the transcript. Never invent people, numbers, amounts, dates or decisions.',
    '- The transcript comes from speech recognition and may have mis-heard words; fix one only when the meaning is certain.',
    // Owner, 2026-10-15, with a cold: "Barina" for Marina, "Boland" for Roland.
    '  The speaker may have an accent or a cold (a blocked nose turns "m"/"n" into "b"/"d"), so a name may come out slightly off: "Barina" when the talk is about Marina, "Boland" for Roland on the Names & words list. Use the right name in titles, summaries and tasks when it is clear from the list or the rest of the talk.',
    // Owner, 2026-10-14: "235 ... 85 and $1.50" was a $2.35 unit price (0.85 + 1.50).
    '  That includes amounts: a price written without its decimal point is fixed when the talk shows it ("235" a unit, made of "85" cents and "$1.50" → $2.35 a unit). Unsure → keep the number as written.',
    // Owner, 2026-10-14 (same call): the summary had the quantity but not the price.
    '- The summary keeps the specifics that were agreed or stated: every price or amount (with its currency and what it is per: a unit, a case, an hour, in total), quantity, date, deadline or lead time, who supplies, pays for or does what, and any condition or requirement ("labels on rolls, direction 4"). A detail said in passing still goes in. Leave out only small talk.',
    vocabularyLine(vocabulary) ? `- ${vocabularyLine(vocabulary)} A word in the transcript that sounds like one of these is probably it.` : null,
    '- Action items: only concrete things someone said they or someone else must do. The label starts with a verb and is short: said in English → English ("Buy milk", "Call Dana"); said in Hebrew → the Hebrew infinitive ("לקנות…", "להתקשר…"); said in Russian → the Russian infinitive ("Купить…", "Позвонить…"); any other language → its own usual short to-do form.',
    '  Never an action item: a single word, filler ("בסדר", "okay", "ладно"), an aside ("למרות ש…"), an item that is only part of a list, or something already done ("שכבר קנינו").',
    // Owner, 2026-10-09: "to charge Guy, sorry mistake, to refund Guy for 6117.62$" became
    // "Charge Guy". A self-correction replaces what came before it.
    '  When the speaker corrects themselves ("sorry", "mistake", "I mean", "no wait", "not X, Y", "סליחה", "טעות", "התכוונתי", "לא, …", "извини", "то есть", "нет, …", or the same in any language), only the corrected version counts: the words they took back are never an action item, and the details said with the correction (amount, person, date) belong to it. "Charge Guy, sorry, mistake, refund Guy 6117.62$" → one action: "Refund Guy $6,117.62".',
    // Owner, 2026-10-06: "send X to Dana" spoken as a to-do became a WhatsApp
    // share; it was meant as a reminder. Reminder is the default.
    '  type = "create_reminder" for anything to remember or do later, including sending something later ("remind me to send…", "תזכיר לי לשלוח…", "I need to text Dana tomorrow").',
    '  Only when the person dictates the message or email itself, to go out as it is ("send Dana: I\'ll be late", "email the supplier saying…"), use "send_message" (text/WhatsApp) or "draft_email". When unsure, "create_reminder".',
    '  priority = "high" only if said to be urgent or important, otherwise "medium".',
    `  due_date = YYYY-MM-DD only when a day is said, resolved from today (${today}, a ${weekday}); a weekday means the next one after today; otherwise null.`,
    // S47 (2026-10-15): a task with a day and a time rings on the phone then.
    '  due_time = "HH:MM" (24-hour) only when a clock time is said for the task ("call Dana Tuesday at 3" → 15:00; "at 9 in the morning", "בתשע בבוקר", "в девять утра" → 09:00; "at half past four" → 16:30). A bare hour means the daytime one, between 08:00 and 19:59 ("at 3" → 15:00, "at 8" → 08:00). A time with no day said means today. Vague times ("in the morning", "tonight", "later", "soon") → null. Otherwise null.',
    // Owner, 2026-10-12: "צריך לשלוח מחר 6 קייסים… וצריך לשלוח לגיא proof of
    // delivery…" (one breath) gave the first task tomorrow and the second none.
    // A day said once covers the tasks said with it.
    '  A day said for one task also covers the tasks said with it in the same sentence or breath ("tomorrow I need to send the cases, and send Guy the invoice" = both tomorrow), unless another day is named for them or they are said to be for some other time ("later", "next week", "sometime", "בהמשך", "מתישהו", "потом").',
    '  Items that share ONE verb are one action listing them ("Buy milk, eggs and bread"; "Call Dana and the broker"). Different verbs are different actions, even in one sentence ("call the supplier, and check the order" = two actions).',
    '  Something already decided or already done is not an action item (it belongs in the summary).',
    '- Sections: the chapters of the conversation in time order. start = the [m:ss] mark of the section\'s first line, copied exactly as it is written there (for example "12:40"); null if the transcript has no marks. A short note is one section.',
    `- Summary blocks, exactly these, in this order:\n${blocks}`,
    '- title: a short gist of what this is about, 2 to 5 words, like a subject line ("Groceries and laundry", "קניות לבית", "Покупки для дома"). In the transcript language. No dates, no "voice note", no full sentence.',
  ].filter(Boolean).join('\n');

  return {
    system_instruction: { parts: [{ text: system }] },
    // The language rule again next to the transcript: in the system prompt
    // alone, an English note ("Need to transfer Andre his payment") came back
    // with a Hebrew task (2026-10-06) - the same fix as names in transcribe.mjs.
    contents: [{ role: 'user', parts: [{ text: `Transcript:\n${transcriptText(segments)}\n\n${TASK_LANGUAGE}` }] }],
    generationConfig: {
      // 0: the same note should give the same tasks every time (at 0.2 the
      // a real grocery note varied between runs, once listing shoes "already bought").
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          sections: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                summary: { type: 'STRING' },
                start: { type: 'STRING', nullable: true },
              },
              required: ['title', 'summary'],
            },
          },
          blocks: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { heading: { type: 'STRING' }, items: { type: 'ARRAY', items: { type: 'STRING' } } },
              required: ['heading', 'items'],
            },
          },
          actions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                label: { type: 'STRING' },
                type: { type: 'STRING', enum: TYPES },
                priority: { type: 'STRING', enum: PRIORITIES },
                due_date: { type: 'STRING', nullable: true },
                due_time: { type: 'STRING', nullable: true },
                context: { type: 'STRING', nullable: true },
              },
              required: ['label', 'type'],
            },
          },
        },
        required: ['title', 'sections', 'blocks', 'actions'],
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

// Gemini "overloaded" (503) or an internal error (500) usually passes in seconds. Owner,
// 2026-10-14: a Re-transcribe failed on one 503. Asked again twice before giving up; a 429
// (out of quota) is not retried. send() makes a fresh request each time.
export const BUSY_WAITS_MS = [2_000, 5_000];
export async function sendRetryingBusy(send, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waits = BUSY_WAITS_MS } = {}) {
  let res = await send();
  for (const wait of waits) {
    if (res.status !== 503 && res.status !== 500) break;
    await res.text().catch(() => {});
    await sleep(wait);
    res = await send();
  }
  return res;
}

const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
// "9:00" is read as "09:00"; anything else that isn't a clock time is dropped.
const validTime = (s) => {
  const m = typeof s === 'string' ? /^(\d{1,2}):([0-5]\d)$/.exec(s.trim()) : null;
  return m && Number(m[1]) < 24 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

// Everything the model said, checked. Headings come from the template, not the model.
export function sanitize(raw, { template, segments, model }) {
  const t = resolveTemplate(template);
  const lastMs = Math.max(0, ...segments.map((s) => s.end_ms ?? s.start_ms ?? 0));
  const ms = (v) => (Number.isInteger(v) && v >= 0 && v <= lastMs + 60_000 ? v : null);

  // Section times: Gemini copies a line's [m:ss] mark and the code turns it into ms.
  // Asked for ms itself, flash-lite wrote minutes as seconds (6:12 → 0:06, a 28-minute
  // meeting, 2026-10-07). The mark is snapped to the line that starts there; a start
  // earlier than the one above it isn't trusted; each section ends where the next begins.
  const starts = segments.map((s) => s.start_ms).filter(Number.isFinite);
  const snap = (v) => (v == null || !starts.length ? null
    : starts.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best)));
  const startOf = (s) => snap(ms(typeof s?.start === 'string' ? clockToMs(s.start) : s?.start_ms));
  const sections = (Array.isArray(raw?.sections) ? raw.sections : [])
    .map((s) => ({ title: clip(s?.title, 80), summary: clip(s?.summary, 300), start_ms: startOf(s) }))
    .filter((s) => s.title)
    .slice(0, 30);
  let previous = -1;
  for (const s of sections) {
    if (s.start_ms == null) continue;
    if (s.start_ms < previous) s.start_ms = null;
    else previous = s.start_ms;
  }
  sections.forEach((s, i) => {
    s.end_ms = s.start_ms == null ? null : (sections.slice(i + 1).find((x) => x.start_ms != null)?.start_ms ?? lastMs);
  });

  const seen = new Set();
  const actions = (Array.isArray(raw?.actions) ? raw.actions : [])
    .map((a) => ({
      label: clip(a?.label, 120),
      type: TYPES.includes(a?.type) ? a.type : 'create_reminder',
      priority: PRIORITIES.includes(a?.priority) ? a.priority : 'medium',
      due_date: validDate(a?.due_date) ? a.due_date : null,
      // Only with a day: a time alone rings nowhere.
      due_time: validDate(a?.due_date) ? validTime(a?.due_time) : null,
      context: a?.context ? clip(a.context, 300) : null,
    }))
    .filter((a) => {
      const key = a.label.toLocaleLowerCase();
      if (!a.label || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);

  const rawBlocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
  const blocks = t.blocks.map((b, i) => {
    if (b.kind === 'actions') return { heading: b.heading, items: actions.map((a) => a.label) };
    const items = Array.isArray(rawBlocks[i]?.items) ? rawBlocks[i].items : [];
    return { heading: b.heading, items: items.map((x) => clip(x, 400)).filter(Boolean).slice(0, 12) };
  });

  return {
    title: clip(String(raw?.title ?? '').replace(/[.!?]+$/, ''), 48) || null,
    sections,
    actions,
    summary: { template: t.id, engine: model, blocks },
  };
}

export async function processWithGemini({ segments, template, today, vocabulary = [] }, { apiKey, model = DEFAULT_MODEL, thinking, fetch: doFetch = globalThis.fetch, timeoutMs = 45_000, sleep }) {
  if (!apiKey) throw Object.assign(new Error('GEMINI_API_KEY is not set on the bridge'), { status: 503 });
  if (!Array.isArray(segments) || !segments.length) throw Object.assign(new Error('No transcript'), { status: 400 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body0 = JSON.stringify(withThinking(buildRequest({ segments, template, today, vocabulary }), thinking));
    const res = await sendRetryingBusy(() => doFetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: body0,
      signal: ctrl.signal,
    }), { sleep });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Gemini ${res.status}: ${body?.error?.message ?? 'error'}`), { status: 502 });
    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    let raw;
    try { raw = JSON.parse(text); } catch { throw Object.assign(new Error('Gemini returned no JSON'), { status: 502 }); }
    return sanitize(raw, { template, segments, model });
  } finally {
    clearTimeout(timer);
  }
}
