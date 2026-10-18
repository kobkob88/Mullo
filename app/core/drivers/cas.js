// The "server side" of a conditional write (spec §03), shared by the local
// drivers. In Supabase this is the updated_at trigger in sql/001_core.sql plus
// `.eq('updated_at', expected)` on the update. Locally the driver plays both
// parts with these functions so the client code path is the same.
//
// Rules that look like bugs and are not:
// - No expected stamp means write unconditionally (a row nobody touched for
//   days legitimately has none locally).
// - A refused write is a conflict, not an error. The caller counts it and
//   keeps its local edit.
// - Stamps are raw strings. Never parse them into a Date and back: Postgres
//   keeps microseconds that a JS Date drops, and the row can never equal
//   itself again.

import { nextStamp } from '../clock.js';

export { nextStamp };

// Patch semantics: fields this client does not know about survive the write,
// so an older build never deletes a newer build's data (spec §10).
export function applyPut(existing, incoming, expected) {
  if (expected != null) {
    if (!existing) return { ok: false, conflict: true, reason: 'gone', current: null };
    if (existing.updated_at !== expected) return { ok: false, conflict: true, reason: 'stale', current: existing };
  }
  // The client never sets updated_at; whatever it sent is overwritten here.
  const stamp = nextStamp();
  const row = {
    ...(existing ?? {}),
    ...incoming,
    // A restore from the activity log brings its original created_at along.
    created_at: existing?.created_at ?? incoming.created_at ?? stamp,
    updated_at: stamp,
  };
  return { ok: true, row, previous: existing ?? null };
}

export function applyDelete(existing, expected) {
  if (!existing) return { ok: false, missing: true };
  if (expected != null && existing.updated_at !== expected) {
    return { ok: false, conflict: true, reason: 'stale', current: existing };
  }
  return { ok: true, deleted: true, previous: existing };
}
