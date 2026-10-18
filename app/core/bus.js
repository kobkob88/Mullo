// Tiny pub/sub so core and domain can announce changes without importing UI.

const subs = new Map();

export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}

export function emit(topic, payload) {
  for (const fn of subs.get(topic) ?? []) {
    try { fn(payload); } catch (err) { console.error(`bus "${topic}" subscriber failed`, err); }
  }
}
