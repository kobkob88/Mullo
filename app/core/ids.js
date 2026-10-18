// Identity (spec §02). The key is an opaque ID; the label is editable text.
// They are never the same field, and a rename rewrites zero records.

export function newId() {
  return crypto.randomUUID();
}

export function normalizeLabel(label) {
  return String(label ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

// Refuse a label that collides with another label or another key,
// case-insensitively and trimmed. `others` = [{ id, label }].
// Returns null when the label is free, else 'empty' | 'label' | 'key'.
export function labelCollision(label, others, selfId = null) {
  const want = normalizeLabel(label);
  if (!want) return 'empty';
  for (const o of others) {
    if (o.id === selfId) continue;
    if (normalizeLabel(o.label) === want) return 'label';
    if (normalizeLabel(o.id) === want) return 'key';
  }
  return null;
}
