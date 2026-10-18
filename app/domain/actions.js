// Action items - the ONE funnel for the action_items surface.
// Shape follows Pocket's one-tap actions: a label, a type (reminder, message,
// email draft), a priority, a status and an optional due date - always linked
// to the recording it came from.

import { db } from '../core/db.js';
import { newId } from '../core/ids.js';
import { isPlausibleTask } from './task-rules.js';

export const ACTION_TYPES = {
  create_reminder: 'Reminder',
  send_message: 'Message',
  draft_email: 'Email',
};

export const STATUSES = ['open', 'in_progress', 'done', 'cancelled'];

export async function actionsFor(recordingId) {
  return db.list('action_items', (a) => a.recording_id === recordingId);
}

export async function getAction(id) {
  return db.get('action_items', id);
}

export async function listActions() {
  return db.list('action_items');
}

// A time of day on a task (S47): local "HH:MM", 24-hour. Only with a date: a date and a
// time ring as a reminder (Android); a date alone never rings. Kept in the row's `extra`
// on the server (no column), so any server step syncs it.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const validTime = (t) => typeof t === 'string' && TIME.test(t);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function addAction(recordingId, fields, { reason } = {}) {
  const label = String(fields.label ?? '').trim();
  if (!label) return { ok: false, error: 'An action needs a label' };
  const dueDate = fields.due_date ?? null;
  return db.put('action_items', {
    id: newId(),
    recording_id: recordingId,
    label,
    type: ACTION_TYPES[fields.type] ? fields.type : 'create_reminder',
    priority: fields.priority ?? 'medium',
    status: STATUSES.includes(fields.status) ? fields.status : 'open',
    due_date: dueDate,
    due_time: dueDate && validTime(fields.due_time) ? fields.due_time : null,
    context: fields.context ?? null,
    origin: fields.origin ?? 'manual',
    source: fields.source ?? 'device',
    external_id: fields.external_id ?? null,
    payload: fields.payload ?? null,
  }, { reason });
}

export async function setActionStatus(action, status, { reason } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
  return db.put('action_items', {
    id: action.id,
    status,
    edited: true,
    completed_at: status === 'done' ? new Date().toISOString() : null,
  }, { expected: action.updated_at, reason: reason ?? `marked ${status}` });
}

export async function renameAction(action, label) {
  const clean = String(label ?? '').trim();
  if (!clean) return { ok: false, error: 'An action needs a label' };
  return db.put('action_items', { id: action.id, label: clean, edited: true }, { expected: action.updated_at, reason: 'renamed' });
}

// Reminder / message / email: the engine guesses, the person corrects it.
// Marked edited, so summarising again doesn't put the guess back.
export async function setActionType(action, type) {
  if (!ACTION_TYPES[type]) return { ok: false, error: 'Unknown kind of task' };
  if (type === action.type) return { ok: true };
  const kind = ACTION_TYPES[type].toLowerCase();
  return db.put('action_items', { id: action.id, type, edited: true }, { expected: action.updated_at, reason: `now ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}` });
}

// A new due date (local YYYY-MM-DD), or null for no date. Marked edited, so summarising
// again doesn't put the old date back. The Ask chat's "Move" button lands here too.
// A task's time stays with it when only the day moves; removing the date removes the time.
export async function setActionDue(action, dueDate) {
  const due = dueDate ?? null;
  if (due !== null && !DATE.test(due)) return { ok: false, error: 'Not a date' };
  if (due === (action.due_date ?? null)) return { ok: true };
  const row = { id: action.id, due_date: due, edited: true };
  if (!due && action.due_time) row.due_time = null;
  return db.put('action_items', row, { expected: action.updated_at, reason: due ? `moved to ${due}` : 'date removed' });
}

// The time of day (local "HH:MM"), or null for none. Needs a date. Marked edited, like a date.
export async function setActionTime(action, dueTime) {
  const time = dueTime || null;
  if (time !== null && !validTime(time)) return { ok: false, error: 'Not a time' };
  if (time !== null && !action.due_date) return { ok: false, error: 'Pick a day first' };
  if (time === (action.due_time ?? null)) return { ok: true };
  return db.put('action_items', { id: action.id, due_time: time, edited: true }, { expected: action.updated_at, reason: time ? `reminder at ${time}` : 'time removed' });
}

// Day and time together: Snooze from a reminder (S47) lands here.
export async function setActionWhen(action, dueDate, dueTime, { reason } = {}) {
  if (!DATE.test(dueDate ?? '') || !validTime(dueTime)) return { ok: false, error: 'Not a date and time' };
  if (dueDate === action.due_date && dueTime === action.due_time) return { ok: true };
  return db.put('action_items', { id: action.id, due_date: dueDate, due_time: dueTime, edited: true },
    { expected: action.updated_at, reason: reason ?? `moved to ${dueDate} ${dueTime}` });
}

// The draft kept on an email or message task (S50, task-drafts.js), in payload.draft; null
// takes it away. edited: the person changed it, so summarising again keeps the task.
export async function setActionDraft(action, draft, { reason, edited = false } = {}) {
  const payload = { ...(action.payload ?? {}) };
  if (draft) payload.draft = draft;
  else delete payload.draft;
  return db.put('action_items', { id: action.id, payload, ...(edited ? { edited: true } : {}) },
    { expected: action.updated_at, reason: reason ?? (draft ? 'draft kept' : 'draft removed') });
}

// Joining notes: a task a person touched follows its note into the joined one.
export async function moveAction(action, recordingId, { reason, batch } = {}) {
  return db.put('action_items', { id: action.id, recording_id: recordingId }, { expected: action.updated_at, reason, batch });
}

export async function deleteAction(action, { intent = 'deleted an action', batch, reason } = {}) {
  return db.remove('action_items', action.id, { intent, expected: action.updated_at, batch, reason });
}

// No "combine these into one list" offer (owner, 2026-10-15): it glued tasks that share a
// first verb by cutting that verb off the rest, so "return the pocket" + "return or replace
// the rug" became "return the pocket, or replace the rug". The AI already lists one-verb
// lists as one task; tasks it kept apart are meant apart. Old rows may still carry
// merge_dismissed / origin 'combined' in extra; nothing reads them.

// The pipeline re-derives extracted actions. Only rows the engine made and
// nobody touched are replaced; anything a person added, ticked or renamed stays.
// A replaced task's draft (S50) moves to the new task with the same words and kind,
// so summarising again never pays for the same draft twice.
export async function replaceExtracted(recordingId, extracted, { engine }) {
  const current = await actionsFor(recordingId);
  const batch = newId();
  const draftKey = (type, label) => `${type}|${String(label).trim().toLocaleLowerCase()}`;
  const drafts = new Map();
  for (const a of current) {
    if (a.origin === 'extracted' && a.status === 'open' && !a.edited) {
      if (a.payload?.draft) drafts.set(draftKey(a.type, a.label), a.payload.draft);
      await deleteAction(a, { intent: 're-processed a recording', batch });
    }
  }
  const kept = new Set((await actionsFor(recordingId)).map((a) => a.label.toLocaleLowerCase()));
  // Whatever the engine proposed, filler, lone nouns, asides and things
  // already done never become tasks (task-rules.js).
  for (const a of extracted.filter((x) => isPlausibleTask(x.label))) {
    if (kept.has(a.label.toLocaleLowerCase())) continue;
    const draft = drafts.get(draftKey(ACTION_TYPES[a.type] ? a.type : 'create_reminder', a.label));
    await addAction(recordingId, { ...a, origin: 'extracted', ...(draft ? { payload: { ...(a.payload ?? {}), draft } } : {}) }, { reason: `extracted by ${engine}` });
  }
}
