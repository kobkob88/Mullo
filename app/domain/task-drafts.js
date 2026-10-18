// Mullo drafts it for you (S50). When a note's tasks come in, every email or message task
// gets a draft written from that note, kept on the task (payload.draft, through the tasks
// funnel), so it syncs and the computer sees it too. The person reads it, edits it, and
// sends it from the task: the mail app (mailto:), the share sheet, or Copy. Mullo can't see
// the send, so it asks "Sent? Mark done".
//
// Same route, gate and metering as Ask (chat.js draftForTask → /api/chat, the `ask` job): no
// new Worker route. Only the device that made the summary drafts, and it reads the task again
// before keeping a draft (compare-and-swap), so a draft that landed meanwhile wins and two
// devices never pay twice. "To" is filled only when the note itself holds exactly one
// address (addressIn); the AI never writes one. A Settings switch turns it off.

import { getAction, actionsFor, setActionDraft } from './actions.js';
import { getRecording } from './recordings.js';
import { draftForTask, canChat, newChat, getThread } from './chat.js';
import { aiEngineOn } from './pipeline.js';
import { DRAFT_KIND, draftOf, addressIn } from './one-tap.js';
import { getSettings } from '../core/settings.js';
import { canSeePrivate } from '../core/auth.js';
import { emit } from '../core/bus.js';

const OPEN = new Set(['open', 'in_progress']);
// At most this many drafts made by themselves per note (a long meeting can name many emails;
// the rest get a "Draft it" tap).
export const MAX_AUTO = 5;

const making = new Set();
export const isDrafting = (id) => making.has(id);
export const canDraft = () => canChat() && aiEngineOn();
export const wantsDraft = (a) => Boolean(a && OPEN.has(a.status) && DRAFT_KIND[a.type] && !draftOf(a));

const now = () => new Date().toISOString();
const clean = (s, n) => String(s ?? '').replace(/\r\n?/g, '\n').trim().slice(0, n);

// One task's draft → { ok } or { ok: false, error }. redo: write it again (the person asked).
export async function makeDraft(id, { redo = false } = {}) {
  if (making.has(id)) return { ok: false, error: 'Already writing it.' };
  if (!canDraft()) return { ok: false, error: 'Drafting needs the AI: sign in to Mullo.' };
  const task = await getAction(id);
  if (!task) return { ok: false, error: 'That task is gone.' };
  if (!DRAFT_KIND[task.type]) return { ok: false, error: 'Only email and message tasks get a draft.' };
  if (!redo && draftOf(task)) return { ok: true };
  const rec = task.recording_id ? await getRecording(task.recording_id) : null;
  if (!rec) return { ok: false, error: 'The note this task came from is gone.' };
  making.add(id);
  emit('drafting', { id });
  try {
    const { draft, noteText } = await draftForTask(rec, task, { includeTranscripts: canSeePrivate('search') });
    const fresh = await getAction(id);
    if (!fresh || !OPEN.has(fresh.status)) return { ok: false, error: 'That task changed meanwhile.' };
    const old = draftOf(fresh);
    if (old && !redo) return { ok: true };
    const kind = DRAFT_KIND[fresh.type] ?? draft.kind;
    const res = await setActionDraft(fresh, {
      kind,
      to: kind === 'email' ? (old?.to || addressIn(noteText, fresh.context, fresh.label)) : '',
      subject: kind === 'message' ? null : draft.subject,
      body: draft.body,
      made_at: now(),
      edited_at: null,
    }, { reason: redo ? 'draft written again' : 'draft written' });
    return res.ok === false ? { ok: false, error: 'That task changed meanwhile - try again.' } : { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't write the draft: ${err?.message ?? err}` };
  } finally {
    making.delete(id);
    emit('drafting', { id });
  }
}

// After a note's summary landed (pipeline afterSummary): its email and message tasks, one by
// one. → how many drafts were made.
export async function autoDraft(recordingId) {
  if (!getSettings().autoDrafts || !canDraft()) return 0;
  const tasks = (await actionsFor(recordingId)).filter((a) => a.origin === 'extracted' && wantsDraft(a)).slice(0, MAX_AUTO);
  let made = 0;
  for (const t of tasks) if ((await makeDraft(t.id)).ok) made += 1;
  return made;
}

// The person changed the draft on the task (fields: to, subject, body).
export async function editDraft(id, fields) {
  const task = await getAction(id);
  const d = draftOf(task);
  if (!d) return { ok: false, error: 'That draft is gone.' };
  // From the stored draft, so a message's edit keeps the address and subject it had as an email.
  const stored = task.payload.draft;
  const next = { ...stored, kind: d.kind, edited_at: now() };
  if ('to' in fields && d.kind === 'email') next.to = clean(fields.to, 320).replace(/\s+/g, '');
  if ('subject' in fields && d.kind === 'email') next.subject = clean(fields.subject, 200).replace(/\n+/g, ' ') || null;
  if ('body' in fields) next.body = clean(fields.body, 12_000);
  if (!next.body) return { ok: false, error: 'A draft needs some text.' };
  if ((next.to ?? '') === (stored.to ?? '') && (next.subject ?? null) === (stored.subject ?? null) && next.body === stored.body) return { ok: true };
  const res = await setActionDraft(task, next, { reason: 'draft edited', edited: true });
  return res.ok === false ? { ok: false, error: 'It changed meanwhile - your text is still in the box, save again.' } : { ok: true };
}

// "Change in Ask": a chat about the task's note that starts with its draft, so "make it
// shorter" works; a draft the chat writes can then go back on the task (useChatDraft).
export async function draftToAsk(id) {
  const task = await getAction(id);
  const d = draftOf(task);
  if (!d || !task.recording_id) return { ok: false, error: 'That draft is gone.' };
  newChat({
    focus: task.recording_id,
    task: task.id,
    messages: [{
      role: 'assistant',
      text: `The ${d.kind} for "${task.label}". Tell me what to change: "shorter", "more formal", "in Hebrew".`,
      found: true, sources: [task.recording_id], draft: { kind: d.kind, subject: d.subject, body: d.body }, at: now(),
    }],
  });
  return { ok: true, recordingId: task.recording_id };
}

// "Use this" under a draft in a chat started from a task: it replaces the task's draft (the
// address the person typed stays).
export async function useChatDraft(index) {
  const thread = getThread();
  const d = thread.messages[index]?.draft;
  if (!thread.task || !d) return { ok: false, error: 'That draft is gone.' };
  const task = await getAction(thread.task);
  if (!task) return { ok: false, error: 'That task is gone.' };
  const old = draftOf(task);
  const stored = task.payload?.draft ?? {};
  const kind = old?.kind ?? DRAFT_KIND[task.type] ?? 'email';
  const res = await setActionDraft(task, {
    kind,
    to: typeof stored.to === 'string' ? stored.to : '',
    subject: kind === 'message' ? (stored.subject ?? null) : (d.subject ?? stored.subject ?? null),
    body: String(d.body),
    made_at: old?.made_at ?? now(),
    edited_at: now(),
  }, { reason: 'draft changed in Ask', edited: true });
  return res.ok === false ? { ok: false, error: 'The task changed meanwhile - try again.' } : { ok: true, task };
}
