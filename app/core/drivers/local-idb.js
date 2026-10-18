// IndexedDB driver: the device is the server until Supabase is switched on.
// Every compare-and-swap runs inside ONE readwrite transaction, so the read
// and the write cannot interleave with another tab.

import { applyPut, applyDelete } from './cas.js';

const DB_NAME = 'echo';
const BLOBS = 'blobs';

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Opens the database and creates any store that is missing. A new surface
// in core/surfaces.js gets its store on the next load without a manual
// version bump.
async function openDb(storeNames) {
  const first = await promisify(indexedDB.open(DB_NAME));
  const missing = storeNames.filter((s) => !first.objectStoreNames.contains(s));
  if (!missing.length) return first;
  const version = first.version + 1;
  first.close();
  const req = indexedDB.open(DB_NAME, version);
  req.onupgradeneeded = () => {
    for (const s of missing) req.result.createObjectStore(s, { keyPath: 'id' });
  };
  return promisify(req);
}

function casTx(idb, table, id, decide) {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    let result;
    const read = store.get(id);
    read.onsuccess = () => {
      result = decide(read.result);
      if (result.ok && result.deleted) store.delete(id);
      else if (result.ok && result.row) store.put(result.row);
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function openLocalDriver(tables) {
  const idb = await openDb([...tables, BLOBS]);
  const ro = (table) => idb.transaction(table).objectStore(table);

  return {
    kind: 'local',
    get: (table, id) => promisify(ro(table).get(id)),
    list: (table) => promisify(ro(table).getAll()),
    put: (table, row, expected) => casTx(idb, table, row.id, (existing) => applyPut(existing, row, expected)),
    remove: (table, id, expected) => casTx(idb, table, id, (existing) => applyDelete(existing, expected)),
    // Sync (core/cloud-sync.js): see memory.js.
    adopt: (table, row, current) => casTx(idb, table, row.id, (existing) =>
      ((existing?.updated_at ?? null) === current ? { ok: true, row } : { ok: false, stale: true })),
    drop: (table, id, current) => casTx(idb, table, id, (existing) =>
      ((existing?.updated_at ?? null) === current ? { ok: true, deleted: true } : { ok: false, stale: true })),
    append: (table, entry) => casTx(idb, table, entry.id, (existing) =>
      (existing ? { ok: true } : { ok: true, row: entry })),
    async putBlob(id, blob) {
      const res = await casTx(idb, BLOBS, id, (existing) =>
        (existing ? { ok: false, exists: true } : { ok: true, row: { id, blob } }));
      if (res.exists) throw new Error('Blobs are immutable - store a new one instead');
    },
    async getBlob(id) {
      const rec = await promisify(ro(BLOBS).get(id));
      return rec?.blob ?? null;
    },
    // Blob records hold handles, not the bytes, so listing them is cheap.
    async listBlobs() {
      const all = await promisify(ro(BLOBS).getAll());
      return all.map((r) => ({ id: r.id, bytes: r.blob?.size ?? 0 }));
    },
    async removeBlob(id) {
      const tx = idb.transaction(BLOBS, 'readwrite');
      tx.objectStore(BLOBS).delete(id);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
      });
    },
    async estimate() {
      return navigator.storage?.estimate ? navigator.storage.estimate() : null;
    },
  };
}
