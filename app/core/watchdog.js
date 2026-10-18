// Watchdogs with executable stop conditions (spec §11), read from the
// activity log. Anything that doesn't write to the log is invisible here -
// which is why every surface goes through core/db.js.

// Fires when one table loses `threshold` or more rows inside `windowMs`.
// Deliberately counts rows, not intents: the incident this guards against
// (a stale device deleting dozens of records) arrives as one "batch" too.
// A person deleting one recording removes a handful of rows, far below this.
export function massDeleteAlerts(entries, { windowMs = 10 * 60_000, threshold = 25, now = Date.now() } = {}) {
  const counts = new Map();
  for (const e of entries) {
    if (e.action !== 'delete' || now - Date.parse(e.at) > windowMs) continue;
    counts.set(e.table, (counts.get(e.table) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, rows]) => rows >= threshold)
    .map(([table, rows]) => ({
      table, rows,
      message: `${rows} ${table} rows deleted in the last ${Math.round(windowMs / 60_000)} min`,
    }));
}

// Pending work ages and escalates (spec §07): a queue nobody sees is a
// queue nobody empties.
export function pendingLevel(oldestAtIso, now = Date.now()) {
  if (!oldestAtIso) return 'none';
  const age = now - Date.parse(oldestAtIso);
  if (age > 30 * 60_000) return 'alert';
  if (age > 5 * 60_000) return 'warn';
  return 'ok';
}
