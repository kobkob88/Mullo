// The write-surface registry (spec §03). A surface is any place the app
// writes. Every client-written table is listed here with the ONE file allowed
// to write it (its funnel). tests/architecture.test.mjs reads the source and
// fails the build when a write targets a table that is missing here, or is
// issued from any file other than the table's funnel. Keep this in step with
// docs/ops/surface-registry.md (also enforced by the test).

export const SURFACES = {
  recordings:      { funnel: 'domain/recordings.js' },
  transcripts:     { funnel: 'domain/transcripts.js' },
  action_items:    { funnel: 'domain/actions.js' },
  folders:         { funnel: 'domain/folders.js' },
  audio_files:     { funnel: 'core/files.js' },
  activity:        { funnel: 'core/audit.js', appendOnly: true },
};

export const TABLES = Object.keys(SURFACES);

export function assertSurface(table) {
  if (!Object.hasOwn(SURFACES, table)) {
    throw new Error(`Unregistered write surface "${table}" - add it to core/surfaces.js and docs/ops/surface-registry.md`);
  }
  return SURFACES[table];
}
