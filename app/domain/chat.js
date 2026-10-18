// Ask as a chat (S10). One thread at a time, kept on this device only (no table, nothing
// synced): follow-ups keep context ("make it shorter", "now in Hebrew") because the last
// few messages ride along with each new one. Asking to write something ("an email to
// Daniel about the call") comes back as a draft inside the answer, to copy or share.
// A thread can point at ONE recording ("Ask about this"); then only that one is sent.
// Otherwise the device picks what the AI reads (ask.js pickContext), starting with the
// recordings earlier answers came from.
// "Move it to next week": the AI only suggests (reply.changes); applyChange does it when the
// person taps the button, through the tasks funnel (logged in Activity, undo there).
// "Add to this note that I told her": same shape (reply.updates); applyUpdate adds the dated
// line under the note (recordings.js addNoteUpdate) on the tap.

import { pickContext, recordingForAI } from './ask.js';
import { getRecording, listRecordings, addNoteUpdate } from './recordings.js';
import { actionsFor, listActions, getAction, setActionDue, setActionStatus } from './actions.js';
import { transcriptFor, listTranscripts } from './transcripts.js';
import { localDate } from '../core/dates.js';
import { countQuestion } from '../core/usage.js';
import { disk } from '../core/disk.js';
import { newId } from '../core/ids.js';
import { draftRequest } from './one-tap.js';

const KEY = 'echo:chat';
export const MAX_KEPT = 60; // messages kept on the device
export const HISTORY = 10;  // earlier messages sent with each new one
const KINDS = ['email', 'message', 'document'];

let engine = null;
export function useChat(e) { engine = e?.chat ? e : null; }
export const canChat = () => Boolean(engine);

// task: the task whose kept draft this thread is changing (S50 "Change in Ask"); its drafts
// get a "Use this" button that puts them back on the task.
const fresh = (focus = null, task = null, messages = []) => ({ id: newId(), focus, task, messages });

// → { id, focus: recording id | null, task: task id | null, messages: [{ role, text, sources?, found?, draft?, considered?, at }] }
export function getThread() {
  const t = disk.get(KEY, null);
  if (t && typeof t.id === 'string' && Array.isArray(t.messages)) return { id: t.id, focus: t.focus ?? null, task: t.task ?? null, messages: t.messages };
  return newChat();
}

function save(t) { disk.set(KEY, { id: t.id, focus: t.focus, task: t.task ?? null, messages: t.messages.slice(-MAX_KEPT) }); }

export function newChat({ focus = null, task = null, messages = [] } = {}) {
  const t = fresh(focus, task, messages);
  save(t);
  return t;
}

// "Ask about this" on a recording: a thread about that one. A thread already about it stays.
export function askAbout(id) {
  const t = getThread();
  return t.focus === id ? t : newChat({ focus: id });
}

// One draft for a task (S50), outside the thread: the task's own recording only, one message
// asking for it. Same route, gate and metering as Ask.
// → { draft: { kind, subject, body }, noteText } (noteText: what was sent, to look for an address), or throws.
export async function draftForTask(recording, task, { includeTranscripts = true } = {}) {
  if (!engine) throw new Error('Drafting needs the AI engine.');
  const [actions, transcript] = await Promise.all([actionsFor(recording.id), includeTranscripts ? transcriptFor(recording.id) : null]);
  const one = recordingForAI(recording, { actions, transcript, includeTranscripts });
  if (!one.summary && !one.transcript) throw new Error('The note has nothing to write from yet.');
  const out = await engine.chat({ messages: [{ role: 'user', text: draftRequest(task) }], today: localDate(), recordings: [one], focus: true });
  const draft = cleanDraft(out?.draft);
  if (!draft) throw new Error('The AI wrote no draft - try again.');
  return { draft, noteText: [one.summary, one.transcript].filter(Boolean).join('\n') };
}

// A draft as one piece of text, for Copy and Share.
export const draftAsText = (d) => (d.subject ? `${d.subject}\n\n${d.body}` : d.body);

const cleanDraft = (d) => (d && KINDS.includes(d.kind) && String(d.body ?? '').trim()
  ? { kind: d.kind, subject: d.subject ? String(d.subject) : null, body: String(d.body) }
  : null);

async function contextFor(thread, text, includeTranscripts) {
  if (thread.focus) {
    const rec = await getRecording(thread.focus);
    if (!rec) return { error: 'That recording is gone - start a new chat.' };
    const [actions, transcript] = await Promise.all([actionsFor(rec.id), includeTranscripts ? transcriptFor(rec.id) : null]);
    const one = recordingForAI(rec, { actions, transcript, includeTranscripts });
    if (!one.summary && !one.transcript) return { error: 'There is nothing in this recording to ask about yet - wait for the transcript.' };
    return { recordings: [one] };
  }
  const [recordings, actions, transcripts] = await Promise.all([listRecordings(), listActions(), listTranscripts()]);
  if (!recordings.length) return { error: 'There are no recordings to ask about yet.' };
  const first = [...new Set(thread.messages.filter((m) => m.role === 'assistant').reverse().flatMap((m) => m.sources ?? []))].slice(0, 6);
  return { recordings: pickContext(text, { recordings, actions, transcripts }, { includeTranscripts, first }) };
}

// A new message → { ok, reply } (the thread on the device gains both) or { ok: false, error }
// (the thread is left as it was, so the person can send it again).
export async function sendChat(text, { includeTranscripts = true } = {}) {
  if (!engine) return { ok: false, error: 'Asking needs the AI engine (the bridge is off).' };
  const q = String(text ?? '').trim();
  if (!q) return { ok: false, error: 'Type a question first.' };
  const thread = getThread();
  const ctx = await contextFor(thread, q, includeTranscripts);
  if (ctx.error) return { ok: false, error: ctx.error };
  const history = thread.messages.slice(-HISTORY).map((m) => ({
    role: m.role, text: m.text,
    ...(m.draft ? { draft: m.draft } : {}),
    ...(m.changes?.length ? { changes: m.changes.map(({ label, due_date, remove_date, status, applied }) => ({ label, due_date, remove_date, status, applied: Boolean(applied) })) } : {}),
    ...(m.updates?.length ? { updates: m.updates.map(({ title, text, applied }) => ({ title, text, applied: Boolean(applied) })) } : {}),
  }));
  let out;
  try {
    out = await engine.chat({ messages: [...history, { role: 'user', text: q }], today: localDate(), recordings: ctx.recordings, focus: Boolean(thread.focus) });
  } catch (err) {
    return { ok: false, error: `Could not answer: ${err.message}` };
  }
  countQuestion();
  const sent = new Set(ctx.recordings.map((r) => r.id));
  const at = new Date().toISOString();
  const reply = {
    role: 'assistant',
    text: String(out?.answer ?? '').trim() || 'No answer.',
    found: out?.found === true,
    sources: (Array.isArray(out?.sources) ? out.sources : []).filter((id) => sent.has(id)),
    draft: cleanDraft(out?.draft),
    changes: cleanChanges(out?.changes, ctx.recordings),
    updates: cleanUpdates(out?.updates, ctx.recordings),
    considered: ctx.recordings.length,
    at,
  };
  // A new chat started while this one was answering: the answer belongs to the old thread.
  if (getThread().id !== thread.id) return { ok: true, reply, dropped: true };
  thread.messages.push({ role: 'user', text: q, at }, reply);
  save(thread);
  return { ok: true, reply };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHANGE_STATUSES = ['open', 'done', 'cancelled'];

// Suggested task changes → only tasks this turn sent, each with what the person will see on the
// button (label, date before) so the thread still reads right if the task changes later.
function cleanChanges(raw, recordings) {
  const tasks = new Map(recordings.flatMap((r) => r.tasks ?? []).map((t) => [t.id, t]));
  return (Array.isArray(raw) ? raw : []).flatMap((c) => {
    const t = tasks.get(c?.id);
    if (!t) return [];
    const due = DATE.test(c.due_date ?? '') && c.due_date !== t.due_date ? c.due_date : null;
    const removeDate = c.remove_date === true && !due && t.due_date != null;
    const status = CHANGE_STATUSES.includes(c.status) && c.status !== t.status ? c.status : 'same';
    if (!due && !removeDate && status === 'same') return [];
    return [{ id: t.id, label: t.label, from_due: t.due_date ?? null, due_date: due, remove_date: removeDate, status, applied: false }];
  });
}

// Suggested note updates → only notes this turn sent, one per note, with the note's title for the
// thread (an older app's server sends none: an empty list).
function cleanUpdates(raw, recordings) {
  const byId = new Map(recordings.map((r) => [r.id, r]));
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).flatMap((u) => {
    const rec = byId.get(u?.id);
    const text = String(u?.text ?? '').trim();
    if (!rec || !text || seen.has(rec.id)) return [];
    seen.add(rec.id);
    return [{ id: rec.id, title: rec.title, text, applied: false }];
  }).slice(0, 3);
}

// The person tapped "Add to note" (message <m>, update <u>) → { ok, update } or { ok: false, error }.
export async function applyUpdate(m, u) {
  const thread = getThread();
  const update = thread.messages[m]?.updates?.[u];
  if (!update) return { ok: false, error: 'That suggestion is gone.' };
  if (update.applied) return { ok: true, update };
  const res = await addNoteUpdate(update.id, update.text, { by: 'ask' });
  if (!res.ok) return res;
  const now = getThread();
  if (now.id === thread.id && now.messages[m]?.updates?.[u]) {
    now.messages[m].updates[u].applied = true;
    save(now);
  }
  return { ok: true, update: { ...update, applied: true } };
}

// The person tapped a suggested change (message <m>, change <c>) → { ok, change } or { ok: false, error }.
// Applied to the task as it is now (read fresh), through the tasks funnel; marked done in the thread.
export async function applyChange(m, c) {
  const thread = getThread();
  const change = thread.messages[m]?.changes?.[c];
  if (!change) return { ok: false, error: 'That suggestion is gone.' };
  if (change.applied) return { ok: true, change };
  let task = await getAction(change.id);
  if (!task) return { ok: false, error: 'That task is gone.' };
  if (change.due_date || change.remove_date) {
    const res = await setActionDue(task, change.due_date ?? null);
    if (!res.ok) return { ok: false, error: res.error ?? 'The task changed meanwhile - try again.' };
    task = await getAction(change.id);
  }
  if (change.status !== 'same' && task.status !== change.status) {
    const res = await setActionStatus(task, change.status);
    if (!res.ok) return { ok: false, error: 'The task changed meanwhile - try again.' };
  }
  const now = getThread();
  if (now.id === thread.id && now.messages[m]?.changes?.[c]) {
    now.messages[m].changes[c].applied = true;
    save(now);
  }
  return { ok: true, change: { ...change, applied: true } };
}
