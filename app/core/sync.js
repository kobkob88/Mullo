// Sync, offline, egress (spec §07) - GROUNDWORK. In local mode the device is
// the server, so the outbox stays empty. These are the pieces the Supabase
// driver will use; the pure ones are tested now so the rules are fixed before
// the network arrives.
//
// - Delta pull against a server watermark, with a cheap "anything changed?"
//   probe first. Never poll the full dataset.
// - Only a pull that was actually applied advances the cursor.
// - Persist a base snapshot; three-way merge on reconnect.
// - Persist the held-set: the ids this device believes it holds, so a reload
//   can't turn "not loaded yet" into "deleted".
// - Write receipts: ask the server ~90s later whether a write landed.

import { disk } from './disk.js';

const OUTBOX = 'echo:outbox';
const RECEIPTS = 'echo:receipts';
const cursorKey = (table) => `echo:cursor:${table}`;
const heldKey = (table) => `echo:held:${table}`;
export const RECEIPT_CHECK_MS = 90_000;

// ── Outbox ──────────────────────────────────────────────────────────────
export function outbox() { return disk.get(OUTBOX, []); }
export function enqueue(op) {
  const entry = { ...op, queuedAt: op.queuedAt ?? new Date().toISOString() };
  disk.set(OUTBOX, [...outbox(), entry]);
  return entry;
}
export function dequeue(ids) {
  const done = new Set(ids);
  disk.set(OUTBOX, outbox().filter((e) => !done.has(e.id)));
}

// ── Cursor ──────────────────────────────────────────────────────────────
export function cursor(table) { return disk.get(cursorKey(table), null); }
export function advanceCursor(table, next, { applied }) {
  if (!applied) return cursor(table); // a failed or partial pull never moves it
  disk.set(cursorKey(table), next);
  return next;
}

// ── Held-set ────────────────────────────────────────────────────────────
export function heldSet(table) { return new Set(disk.get(heldKey(table), [])); }
export function saveHeldSet(table, ids) { disk.set(heldKey(table), [...ids]); }

// ── Write receipts ──────────────────────────────────────────────────────
export function recordReceipt(table, id, stamp, now = Date.now()) {
  disk.set(RECEIPTS, [...disk.get(RECEIPTS, []), { table, id, stamp, sentAt: now }]);
}
export function dueReceipts(now = Date.now()) {
  return disk.get(RECEIPTS, []).filter((r) => now - r.sentAt >= RECEIPT_CHECK_MS);
}
export function clearReceipts(keys) {
  const done = new Set(keys.map((k) => `${k.table}:${k.id}`));
  disk.set(RECEIPTS, disk.get(RECEIPTS, []).filter((r) => !done.has(`${r.table}:${r.id}`)));
}

// ── Three-way merge ─────────────────────────────────────────────────────
// base:    { id → row } as last agreed with the server
// local:   { id → row } as the device has it now
// changed: rows the server returned in this delta
// deleted: ids the server reports as deleted by intent (tombstones / activity)
// dirty:   ids with unsent local edits (from the outbox)
//
// A row absent from `changed` is UNCHANGED, never deleted. A field the device
// edited (differs from base) wins over the server's value for that field and
// is reported as a conflict when the server changed it too; the local edit
// stays un-rebased so it survives the next merge.
export function mergeDelta({ base, local, changed = [], deleted = [], dirty = new Set() }) {
  const next = { ...local };
  const nextBase = { ...base };
  const conflicts = [];

  for (const remote of changed) {
    const id = remote.id;
    const b = base[id];
    const l = local[id];
    nextBase[id] = remote;
    if (!l || !dirty.has(id)) { next[id] = remote; continue; }
    const merged = { ...remote };
    for (const key of new Set([...Object.keys(l), ...Object.keys(remote)])) {
      if (key === 'updated_at') continue;
      const localChanged = !b || !same(l[key], b[key]);
      if (!localChanged) continue;
      merged[key] = l[key];
      if (b && !same(remote[key], b[key]) && !same(remote[key], l[key])) {
        conflicts.push({ id, key, local: l[key], remote: remote[key] });
      }
    }
    next[id] = merged;
  }

  for (const id of deleted) {
    delete nextBase[id];
    if (dirty.has(id)) {
      conflicts.push({ id, key: '*', local: local[id], remote: null });
      continue; // keep the unsent local edit; a person decides
    }
    delete next[id];
  }

  return { next, base: nextBase, conflicts };
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
