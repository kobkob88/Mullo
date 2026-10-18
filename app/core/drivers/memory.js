// In-memory driver: tests, and the fallback when IndexedDB is unavailable.
// Same interface as local-idb.js and supabase.js.

import { applyPut, applyDelete } from './cas.js';

export function createMemoryDriver() {
  const tables = new Map();
  const blobs = new Map();
  const t = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const copy = (v) => (v == null ? v : structuredClone(v));

  return {
    kind: 'memory',
    async get(table, id) { return copy(t(table).get(id)); },
    async list(table) { return [...t(table).values()].map(copy); },
    async put(table, row, expected) {
      const res = applyPut(t(table).get(row.id), copy(row), expected);
      if (res.ok) t(table).set(row.id, copy(res.row));
      return res;
    },
    async remove(table, id, expected) {
      const res = applyDelete(t(table).get(id), expected);
      if (res.ok) t(table).delete(id);
      return res;
    },
    // Sync (core/cloud-sync.js): the account's copy of a row, kept as it is (its
    // updated_at too), only while the row here is still the one sync last saw
    // (`current` = its updated_at, or null for "not here").
    async adopt(table, row, current) {
      if ((t(table).get(row.id)?.updated_at ?? null) !== current) return { ok: false, stale: true };
      t(table).set(row.id, copy(row));
      return { ok: true };
    },
    async drop(table, id, current) {
      if ((t(table).get(id)?.updated_at ?? null) !== current) return { ok: false, stale: true };
      t(table).delete(id);
      return { ok: true };
    },
    // Append-only, idempotent by id: a retried entry is free.
    async append(table, entry) {
      if (!t(table).has(entry.id)) t(table).set(entry.id, copy(entry));
      return { ok: true };
    },
    async putBlob(id, blob) {
      if (blobs.has(id)) throw new Error('Blobs are immutable - store a new one instead');
      blobs.set(id, blob);
    },
    async getBlob(id) { return blobs.get(id) ?? null; },
    async listBlobs() { return [...blobs].map(([id, b]) => ({ id, bytes: b?.size ?? 0 })); },
    async removeBlob(id) { blobs.delete(id); },
  };
}
