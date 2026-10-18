// Small JSON values persisted on the device (queues, held-sets, cursors).
// Falls back to memory where localStorage is missing (Node tests, private mode).

const memory = new Map();

function store() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* access denied in some private modes */ }
  return null;
}

export const disk = {
  get(key, fallback) {
    const s = store();
    const raw = s ? s.getItem(key) : memory.get(key);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  },
  set(key, value) {
    const raw = JSON.stringify(value);
    const s = store();
    if (s) s.setItem(key, raw); else memory.set(key, raw);
  },
  remove(key) {
    const s = store();
    if (s) s.removeItem(key); else memory.delete(key);
  },
};
