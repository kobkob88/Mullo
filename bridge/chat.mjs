// Ask as a chat (S10). The app sends the conversation so far, the new message and the
// few recordings it picked (or the ONE the person pointed at with "Ask about this").
// The model answers from those only, names its sources by short ref (r1, r2...), and when
// asked to write something puts it in a draft (draft.mjs rules) the app can copy or share.
// Follow-ups keep context because the earlier turns ride along ("make it shorter").
// Asked to move a task or mark it done, it SUGGESTS (task_changes): the app shows a button and
// changes nothing until the person taps it, so the model must never say it did something.
// Asked to add to a note ("add that I told her"), it suggests a dated update line
// (note_updates); the app adds it under the note on a tap. The recording itself never changes.
// Nothing is stored: the thread lives on the device.

import { DEFAULT_MODEL, withThinking } from './gemini.mjs';
import { DRAFT_KINDS, KIND_RULES, DRAFT_RULES, sanitizeDraft, tidyText } from './draft.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const MAX_RECORDINGS = 15;
export const MAX_TURNS = 10;
const MAX_TRANSCRIPT_CHARS = 6000;
const FOCUS_TRANSCRIPT_CHARS = 24_000; // one recording: room for all of it
const MAX_MESSAGE_CHARS = 1000;
const MAX_EARLIER_CHARS = 6000;

const fail = (status, message) => Object.assign(new Error(message), { status });

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};
const clipLines = (s, n) => {
  const t = String(s ?? '').replace(/[ \t]+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_STATUSES = ['open', 'in_progress', 'done'];
export const CHANGE_STATUSES = ['same', 'open', 'done', 'cancelled'];
const MAX_TASKS = 80;
const MAX_CHANGES = 20;
const MAX_UPDATES = 3;
const MAX_UPDATE_CHARS = 500;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (d) => WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()];

// A suggested task change as the app sends it back in the history (by label, since refs are
// handed out afresh each turn), and whether the person applied it.
const cleanChange = (c) => ({
  label: clip(c?.label, 200),
  due_date: DATE.test(c?.due_date ?? '') ? c.due_date : null,
  remove_date: c?.remove_date === true,
  status: CHANGE_STATUSES.includes(c?.status) ? c.status : 'same',
  applied: c?.applied === true,
});

// A suggested note update as the app sends it back in the history, and whether it was added.
const cleanUpdate = (u) => ({ title: clip(u?.title, 200), text: clip(u?.text, MAX_UPDATE_CHARS), applied: u?.applied === true });

// The one check on what the app sends; the same on the Worker and the bridge.
// → { turns: [{ role, text, draft, changes }], message, today, recordings, tasks, focus }
// Tasks get refs t1, t2... across all recordings; their ids stay on the server side.
export function cleanChatInput(input = {}) {
  const all = (Array.isArray(input.messages) ? input.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => {
      const d = m.draft && DRAFT_KINDS.includes(m.draft.kind) && String(m.draft.body ?? '').trim()
        ? { kind: m.draft.kind, subject: clip(m.draft.subject, 200) || null, body: clipLines(m.draft.body, MAX_EARLIER_CHARS) }
        : null;
      const changes = (Array.isArray(m.changes) ? m.changes : []).slice(0, MAX_CHANGES).map(cleanChange).filter((c) => c.label);
      const updates = (Array.isArray(m.updates) ? m.updates : []).slice(0, MAX_UPDATES).map(cleanUpdate).filter((u) => u.text);
      return { role: m.role, text: clipLines(m.text, MAX_EARLIER_CHARS), draft: d, changes, updates };
    })
    .filter((m) => m.text || m.draft);
  const last = all.at(-1);
  if (!last || last.role !== 'user' || !last.text) throw fail(400, 'Ask a question first');
  if (!Array.isArray(input.recordings)) throw fail(400, 'No recordings sent');
  const focus = input.focus === true && input.recordings.length === 1;
  const tasks = [];
  const recordings = input.recordings.slice(0, MAX_RECORDINGS).map((r, i) => {
    const own = (Array.isArray(r?.tasks) ? r.tasks : [])
      .filter((t) => t && typeof t.id === 'string' && String(t.label ?? '').trim() && tasks.length < MAX_TASKS)
      .map((t) => {
        const task = {
          ref: `t${tasks.length + 1}`, id: t.id, label: clip(t.label, 200),
          status: TASK_STATUSES.includes(t.status) ? t.status : 'open', due_date: DATE.test(t.due_date ?? '') ? t.due_date : null,
        };
        tasks.push(task);
        return task;
      });
    return { ref: `r${i + 1}`, ...r, tasks: own };
  });
  return {
    turns: all.slice(0, -1).slice(-MAX_TURNS),
    message: clipLines(last.text, MAX_MESSAGE_CHARS),
    today: DATE.test(input.today ?? '') ? input.today : null,
    focus,
    recordings,
    tasks,
  };
}

export function buildChatRequest(input) {
  const { turns, message, today, focus, recordings: refs, tasks } = cleanChatInput(input);
  const limit = focus ? FOCUS_TRANSCRIPT_CHARS : MAX_TRANSCRIPT_CHARS;
  const notes = refs.map((r) => [
    `### ${r.ref} - "${clip(r.title, 120)}" (${r.date})`,
    r.summary ? `Summary: ${clip(r.summary, focus ? 4000 : 1500)}` : null,
    r.tasks.length
      ? `Tasks: ${r.tasks.map((t) => `[${t.ref}] ${t.label}${t.status === 'done' ? ' (done)' : ''}${t.due_date ? ` (due ${t.due_date}, ${weekday(t.due_date)})` : ' (no date)'}`).join(' | ')}`
      // Apps before build 33 send tasks as plain text: readable, but no refs, so no changes.
      : Array.isArray(r.actions) && r.actions.length ? `Tasks (cannot be changed from here): ${r.actions.slice(0, 40).map((a) => clip(a, 200)).join(' | ')}` : null,
    Array.isArray(r.updates) && r.updates.length
      ? `Updates added later: ${r.updates.slice(-20).map((u) => `${DATE.test(u?.date ?? '') ? `(${u.date}) ` : ''}${clip(u?.text, MAX_UPDATE_CHARS)}`).join(' | ')}`
      : null,
    r.transcript ? `Transcript: ${clip(r.transcript, limit)}` : null,
  ].filter(Boolean).join('\n')).join('\n\n');

  const earlier = turns.map((t) => {
    const who = t.role === 'user' ? 'Person' : 'You';
    const draft = t.draft ? `\n[Draft ${t.draft.kind}${t.draft.subject ? `, subject "${t.draft.subject}"` : ''}]\n${t.draft.body}` : '';
    const changes = t.changes.map((c) => {
      const what = [c.due_date ? `due ${c.due_date}` : null, c.remove_date ? 'no date' : null, c.status !== 'same' ? c.status : null].filter(Boolean).join(', ');
      return `\n[Suggested: "${c.label}" -> ${what}; ${c.applied ? 'the person applied it' : 'not applied yet'}]`;
    }).join('');
    const updates = t.updates.map((u) => `\n[Suggested update to "${u.title}": ${u.text}; ${u.applied ? 'the person added it' : 'not added yet'}]`).join('');
    return `${who}: ${t.text}${draft}${changes}${updates}`;
  }).join('\n\n');

  const system = [
    "You talk with the person about their own recorded conversations and voice notes.",
    focus
      ? 'They are asking about ONE recording, given below.'
      : 'Below are the notes their device picked for this conversation.',
    'Use ONLY the notes below and this conversation. If the notes do not hold the answer, say so plainly and set found to false - never guess or fill in from general knowledge.',
    'Follow-ups refer to the conversation so far: "make it shorter" or "now in Hebrew" means the last answer or draft.',
    'Answer in the language of the latest message, briefly (a few sentences or a short list), as plain text.',
    today ? `Today is ${today} (${weekday(today)}). Mention dates when they help ("on Oct 3").` : null,
    'sources: the refs (r1, r2...) of the notes your answer or draft actually uses.',
    '',
    'You cannot change, send, save or schedule anything yourself. Never say you did ("I updated", "I moved", "done", "sent").',
    // Owner, 2026-10-16: asked to update a note, it answered "Here is the updated note" and the note never changed.
    'You cannot rewrite the recordings themselves: their titles, summaries, transcripts and task wording stay exactly as they are.',
    // Owner, 2026-10-18: a note works like a notebook page - "I told her", "it moved to Wednesday" goes under it.
    'But you can suggest adding an update to a note: a short dated line under it, like writing a follow-up in a notebook ("Told Tina the delivery is by the end of next week."). When the person tells you something new about a note (what happened since, a follow-up, a correction, "add to this note that..."), put it in note_updates:',
    'note = the note\'s ref (r1, r2...), text = the update in one or two short sentences, written in the language of that note\'s summary, close to the person\'s own words, with the real date instead of "next week" when the day is clear. Only what the person said - add nothing.',
    // Owner, 2026-10-18: "לעדכן אותה מחר שזה יהיה מוכן ביום רביעי" (to update her tomorrow) came out as "I updated Tina on Oct 19".
    'Keep the person\'s tense and meaning exactly. Something still to do (Hebrew infinitive like "לעדכן אותה מחר", "need to", "will", "tomorrow") stays a plan in the update ("To update Tina tomorrow (Oct 19) that the delivery will be ready on Wednesday (Oct 21)."), never written as done. Write "told", "updated", "sent" only when the person says it already happened. Never write "I" for the person unless they did.',
    'The app shows an "Add to note" button; nothing is added until they tap it. So answer with what you suggest and ask them to tap it, naming the button exactly "Add to note" in any language. A note update is not a draft: draft_kind none. If it also means a task is done or moves (a plan for tomorrow = a matching open task moved to tomorrow), suggest that in task_changes too.',
    'When asked to rewrite a whole note, write the new version as a document draft and say plainly that the note itself is not changed. Never call a draft "the updated note" or "the note". When nothing is to be added, note_updates is an empty list.',
    'When the person wants a task moved to another date, its date removed, or marked done or cancelled, put it in task_changes:',
    'task = the task\'s ref ([t1], [t2]... in the notes; only tasks listed there), due_date = the new date as YYYY-MM-DD or null, remove_date = true only to take the date away, status = done, cancelled, open, or same.',
    today ? `Work dates out from today: "tomorrow" = the day after ${today}; "next week" with no day named = the task's current weekday in the week after this one (Monday of that week if it has no date); "next Monday" = the first Monday after today. Never suggest a date before today.` : null,
    'The app shows the person a button for each change; nothing changes until they tap it. So answer with what you suggest, naming the task and the new day and date, and ask them to tap to confirm, e.g. "I can move \'Return the pocket\' to Tuesday, Oct 13 - tap Move to confirm."',
    'If it is unclear which task or which date, ask instead of guessing, and leave task_changes empty. A change request is not a draft: draft_kind none.',
    'When nothing is to change, task_changes is an empty list.',
    '',
    'When the person asks you to write something to send or keep (an email, a message, a reply, a document, notes), write it as a draft:',
    `draft_kind: email, message or document (else none). ${Object.values(KIND_RULES).join(' ')}`,
    'draft_body MUST hold the whole text of the draft; never say you wrote a draft without it.',
    'Then answer is one short line saying what the draft is (e.g. "Here is an email to Daniel about the delivery."); the text itself goes only in draft_body.',
    'A list asked for as an email or message (a to-do list, a summary) is a draft too: put the items in draft_body.',
    ...DRAFT_RULES,
    'When not writing a draft: draft_kind none, draft_subject and draft_body null.',
    'No long dashes (—) anywhere; use a short dash, a comma or a new sentence.',
  ].filter((x) => x !== null).join('\n');

  const user = [
    `Notes:\n\n${notes || '(none)'}`,
    earlier ? `Conversation so far:\n\n${earlier}` : null,
    `Person (now): ${message}`,
  ].filter(Boolean).join('\n\n');

  return {
    refs,
    tasks,
    body: {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        // Every field required (null when not used): flash-lite skips optional ones, and on the
        // owner's first try it announced "Here is a draft email" with no draft_body (2026-10-11).
        // The draft comes first, so the one-line answer is written after the text it describes.
        responseSchema: {
          type: 'OBJECT',
          properties: {
            draft_kind: { type: 'STRING', enum: ['none', ...DRAFT_KINDS] },
            draft_subject: { type: 'STRING', nullable: true },
            draft_body: { type: 'STRING', nullable: true },
            answer: { type: 'STRING' },
            found: { type: 'BOOLEAN' },
            sources: { type: 'ARRAY', items: { type: 'STRING' } },
            // Suggestions only: the app applies one when the person taps its button.
            task_changes: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  task: { type: 'STRING' },
                  due_date: { type: 'STRING', nullable: true },
                  remove_date: { type: 'BOOLEAN' },
                  status: { type: 'STRING', enum: CHANGE_STATUSES },
                },
                required: ['task', 'due_date', 'remove_date', 'status'],
                propertyOrdering: ['task', 'due_date', 'remove_date', 'status'],
              },
            },
            // Suggestions only: the app adds one under its note when the person taps "Add to note".
            note_updates: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: { note: { type: 'STRING' }, text: { type: 'STRING' } },
                required: ['note', 'text'],
                propertyOrdering: ['note', 'text'],
              },
            },
          },
          required: ['draft_kind', 'draft_subject', 'draft_body', 'task_changes', 'note_updates', 'answer', 'found', 'sources'],
          propertyOrdering: ['draft_kind', 'draft_subject', 'draft_body', 'task_changes', 'note_updates', 'answer', 'found', 'sources'],
        },
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  };
}

// The model's suggested task changes → [{ id, due_date, remove_date, status }]: only tasks
// that were sent (refs mapped back to ids), real dates, and something that actually changes.
export function sanitizeChanges(raw, tasks = []) {
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const task = byRef.get(String(c?.task ?? '').replace(/[[\]\s]/g, ''));
    if (!task || seen.has(task.id)) continue;
    const removeDate = c.remove_date === true && task.due_date !== null;
    const due = !removeDate && DATE.test(c.due_date ?? '') && c.due_date !== task.due_date ? c.due_date : null;
    const status = CHANGE_STATUSES.includes(c.status) && c.status !== 'same' && c.status !== task.status ? c.status : 'same';
    if (!due && !removeDate && status === 'same') continue;
    seen.add(task.id);
    out.push({ id: task.id, due_date: due, remove_date: removeDate, status });
    if (out.length >= MAX_CHANGES) break;
  }
  return out;
}

// The model's suggested note updates → [{ id, text }]: only notes that were sent, real text,
// one per note.
export function sanitizeUpdates(raw, refs = []) {
  const byRef = new Map(refs.map((r) => [r.ref, r.id]));
  const seen = new Set();
  const out = [];
  for (const u of Array.isArray(raw) ? raw : []) {
    const id = byRef.get(String(u?.note ?? '').replace(/[[\]\s]/g, ''));
    const text = tidyText(u?.text, MAX_UPDATE_CHARS);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text });
    if (out.length >= MAX_UPDATES) break;
  }
  return out;
}

// The model's answer → { answer, found, sources: [ids], draft, changes, updates }. Refs that weren't
// sent are dropped, so the app never links to a recording (or touches a task) the model made up.
// A draft announced without its text throws (missingDraft) so the caller can ask once more.
export function sanitizeChat(raw, refs, tasks = []) {
  const byRef = new Map(refs.map((r) => [r.ref, r.id]));
  const sources = [...new Set((Array.isArray(raw?.sources) ? raw.sources : [])
    .map((s) => byRef.get(String(s).trim()))
    .filter(Boolean))];
  const hasBody = Boolean(String(raw?.draft_body ?? '').trim());
  const kind = DRAFT_KINDS.includes(raw?.draft_kind) ? raw.draft_kind : null;
  if (kind && !hasBody) throw Object.assign(fail(502, 'The AI said it wrote a draft but sent none - try again'), { missingDraft: true });
  const draft = kind ? sanitizeDraft({ subject: raw.draft_subject, body: raw.draft_body }, { kind }) : null;
  const changes = sanitizeChanges(raw?.task_changes, tasks);
  const updates = sanitizeUpdates(raw?.note_updates, refs);
  return {
    answer: tidyText(raw?.answer, 3000) || (draft ? 'Here is a draft.' : 'No answer.'),
    found: raw?.found === true && sources.length > 0,
    sources,
    draft,
    changes,
    updates,
  };
}

// One more try when the AI announced a draft but left its text out (sanitizeChat).
export async function retryMissingDraft(once) {
  try {
    return await once();
  } catch (err) {
    if (!err?.missingDraft) throw err;
    return once();
  }
}

export async function chatWithGemini(input, opts) {
  if (!opts?.apiKey) throw fail(503, 'GEMINI_API_KEY is not set on the bridge');
  const { refs, tasks, body } = buildChatRequest(input);
  return retryMissingDraft(() => geminiOnce(body, refs, tasks, opts));
}

async function geminiOnce(body, refs, tasks, { apiKey, model = DEFAULT_MODEL, thinking, fetch: doFetch = globalThis.fetch, timeoutMs = 60_000 }) {
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
    if (!res.ok) throw fail(502, `Gemini ${res.status}: ${json?.error?.message ?? 'error'}`);
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    let raw;
    try { raw = JSON.parse(text); } catch { throw fail(502, 'Gemini returned no JSON'); }
    return { ...sanitizeChat(raw, refs, tasks), engine: model };
  } catch (err) {
    if (err?.name === 'AbortError') throw fail(504, `Gemini took longer than ${Math.round(timeoutMs / 1000)} seconds`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
