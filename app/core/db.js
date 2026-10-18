// The ONLY module that talks to the database (spec §01). Domain modules call
// this; they never reach a driver themselves. Changing the write posture later
// (Supabase, offline outbox) happens here and in core/drivers/.
//
// Writes refuse to run until an audit sink is installed (core/audit.js), so a
// write can never land unlogged. The sink is only called next to a confirmed
// response - a log claiming a write that never landed is worse than none.

import { assertSurface, TABLES } from './surfaces.js';
import { canWrite, PermissionError } from './auth.js';
import { emit } from './bus.js';
import { createMemoryDriver } from './drivers/memory.js';
import { openLocalDriver } from './drivers/local-idb.js';
import { openSupabaseDriver } from './drivers/supabase.js';

let driver = null;
let auditSink = null;
// Told about every confirmed write, so sync (core/cloud-sync.js) can copy it to
// the account. Never told about a refused one.
let writeHook = null;
const counters = { conflicts: 0 };

export async function connect(config = {}) {
  if (config.backend === 'supabase') {
    driver = await openSupabaseDriver(config);
  } else if (typeof indexedDB !== 'undefined') {
    try {
      driver = await openLocalDriver(TABLES);
    } catch (err) {
      console.warn('IndexedDB unavailable - data will not survive a reload', err);
      driver = createMemoryDriver();
    }
  } else {
    driver = createMemoryDriver();
  }
  return driver.kind;
}

// Tests and tools inject a driver directly.
export function useDriver(d) { driver = d; }
export function setAuditSink(fn) { auditSink = fn; }
export function setWriteHook(fn) { writeHook = fn; }
function told(op, table, id, previous = null) {
  try { writeHook?.({ op, table, id, previous }); } catch (err) { console.warn('write hook failed', err); }
}
export function driverKind() { return driver?.kind ?? null; }
export function conflictCount() { return counters.conflicts; }

function needDriver() {
  if (!driver) throw new Error('db: not connected');
  return driver;
}

function writeGate(table) {
  const surface = assertSurface(table);
  needDriver();
  if (!auditSink) throw new Error('db: audit sink not installed - write refused');
  if (!canWrite(table)) throw new PermissionError(`write ${table}`);
  return surface;
}

export const db = {
  async get(table, id) {
    assertSurface(table);
    return (await needDriver().get(table, id)) ?? null;
  },

  async list(table, where) {
    assertSurface(table);
    const rows = await needDriver().list(table);
    return where ? rows.filter(where) : rows;
  },

  // expected: the row's updated_at as last read (raw string), or null/undefined
  // for an unconditional write. A conflict comes back as { ok:false, conflict:true }.
  async put(table, row, { expected, reason, batch } = {}) {
    if (writeGate(table).appendOnly) throw new Error(`${table} is append-only`);
    if (!row?.id) throw new Error('db.put: row.id is required (use newId())');
    const res = await driver.put(table, row, expected);
    if (!res.ok) {
      counters.conflicts += 1;
      emit('conflict', { table, id: row.id, reason: res.reason });
      return res;
    }
    await auditSink({
      action: res.previous ? 'update' : 'insert',
      table, recordId: res.row.id, before: res.previous, after: res.row, reason, batch,
    });
    told('put', table, res.row.id, res.previous);
    emit('changed', { table, id: res.row.id });
    return res;
  },

  // Deletes are intent-based (spec §03): the caller names the action a person
  // took. Nothing in this app infers a delete from a row's absence.
  async remove(table, id, { intent, expected, reason, batch } = {}) {
    if (writeGate(table).appendOnly) throw new Error(`${table} is append-only`);
    if (!intent) throw new Error('db.remove: deletes are intent-based - pass { intent }');
    const res = await driver.remove(table, id, expected);
    if (!res.ok) {
      if (res.conflict) {
        counters.conflicts += 1;
        emit('conflict', { table, id, reason: res.reason });
      }
      return res;
    }
    await auditSink({
      action: 'delete', table, recordId: id, before: res.previous, after: null,
      reason: reason || intent, batch,
    });
    told('delete', table, id);
    emit('changed', { table, id });
    return res;
  },

  // Append-only surfaces (the activity log). Idempotent by entry.id.
  async append(table, entry) {
    const surface = assertSurface(table);
    if (!surface.appendOnly) throw new Error(`${table} is not append-only - use put`);
    if (!canWrite(table)) throw new PermissionError(`write ${table}`);
    const res = await needDriver().append(table, entry);
    told('append', table, entry.id);
    return res;
  },

  // ── Sync down (core/cloud-sync.js only; tests/architecture.test.mjs) ──
  // The account's copy of rows a person already wrote, on another device: no
  // audit entry (the device that made the change logged it, and that entry
  // comes down too) and no write hook (it must not be copied back up). Each
  // lands only while the row here is the one sync read (`current` = its
  // updated_at, null for "not here"); a person's edit in between wins and
  // comes back as { ok:false }. The caller emits 'changed' once per batch.
  async adopt(table, row, { current = null } = {}) {
    assertSurface(table);
    return needDriver().adopt(table, row, current);
  },
  async forget(table, id, { current = null } = {}) {
    assertSurface(table);
    return needDriver().drop(table, id, current);
  },
  async adoptLog(entry) {
    assertSurface('activity');
    return needDriver().append('activity', entry);
  },

  async putBlob(id, blob) {
    if (!canWrite('audio_files')) throw new PermissionError('store audio');
    return needDriver().putBlob(id, blob);
  },

  async getBlob(id) {
    return needDriver().getBlob(id);
  },

  async listBlobs() {
    return needDriver().listBlobs?.() ?? [];
  },

  // Audio bytes stay when their recording is deleted (a restore brings the
  // audio back). Dropping them is the one way to free that space, and only
  // ever for something a person asked for.
  async dropBlob(id, { intent } = {}) {
    if (!intent) throw new Error('db.dropBlob: pass { intent }');
    if (!canWrite('audio_files')) throw new PermissionError('delete audio');
    return needDriver().removeBlob(id);
  },

  async estimate() {
    return needDriver().estimate?.() ?? null;
  },
};
