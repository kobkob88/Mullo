// The activity log is the floor (spec §04) - the recovery mechanism, not a
// compliance feature.
// - Every delete stores the complete row, so a restore is one insert.
// - Every edit stores the previous value and the new one.
// - Entries are queued to disk BEFORE delivery and retried idempotently by
//   their client-generated id. A failed delivery is never dropped.
// - core/db.js only calls the sink next to a confirmed write.

import { db, setAuditSink } from './db.js';
import { disk } from './disk.js';
import { newId } from './ids.js';
import { nextStamp } from './clock.js';
import { getSession } from './auth.js';
import { emit } from './bus.js';

const QUEUE_KEY = 'echo:audit-queue';
let flushing = null;

export function installAudit() {
  setAuditSink(logWrite);
}

async function logWrite({ action, table, recordId, before, after, reason, batch }) {
  const entry = {
    id: newId(),
    at: new Date().toISOString(),
    seq: nextStamp(), // orders entries written in the same millisecond
    actor: getSession()?.userId ?? 'unknown',
    action, table,
    record_id: recordId,
    before: before ?? null,
    after: after ?? null,
    reason: reason ?? null,
    batch: batch ?? null,
  };
  disk.set(QUEUE_KEY, [...disk.get(QUEUE_KEY, []), entry]);
  await flushAudit();
}

export function pendingAudit() {
  return disk.get(QUEUE_KEY, []);
}

export function flushAudit() {
  if (!flushing) {
    flushing = (async () => {
      const delivered = new Set();
      for (const entry of disk.get(QUEUE_KEY, [])) {
        try {
          await db.append('activity', entry);
          delivered.add(entry.id);
        } catch (err) {
          console.warn('activity entry kept for retry', entry.id, err);
        }
      }
      // Re-read: entries queued while we were delivering must survive.
      disk.set(QUEUE_KEY, disk.get(QUEUE_KEY, []).filter((e) => !delivered.has(e.id)));
      emit('pending', null);
    })().finally(() => { flushing = null; });
  }
  return flushing;
}

export async function listActivity() {
  const rows = await db.list('activity');
  const key = (e) => e.seq ?? e.at;
  return rows.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

// Restore a deleted record - and everything deleted with it in the same batch
// (a recording takes its transcript and action items along).
// Restores are written unconditionally: the row is gone, nothing to compare.
export async function restoreDeleted(entryId) {
  const all = await db.list('activity');
  const entry = all.find((e) => e.id === entryId);
  if (!entry || entry.action !== 'delete' || !entry.before) throw new Error('Nothing to restore');
  const group = entry.batch ? all.filter((e) => e.batch === entry.batch && e.action === 'delete') : [entry];
  const batch = newId();
  for (const e of group) {
    // Generic by design: the audit log restores any surface. Allow-listed in
    // tests/architecture.test.mjs (NON_LITERAL_WRITES).
    await db.put(e.table, e.before, { reason: `restored (activity ${e.id})`, batch });
  }
  return group.length;
}

// Undo an edit - only onto a record nobody has changed since.
export async function revertEdit(entryId) {
  const all = await db.list('activity');
  const entry = all.find((e) => e.id === entryId);
  if (!entry || entry.action !== 'update' || !entry.before) throw new Error('Nothing to revert');
  const res = await db.put(entry.table, entry.before, {
    expected: entry.after?.updated_at,
    reason: `reverted (activity ${entry.id})`,
  });
  if (!res.ok) throw new Error('It was changed again since - open it and fix it by hand.');
  return res;
}
