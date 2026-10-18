# Write-surface registry

Every place the app writes is listed here. `tests/architecture.test.mjs` fails the build when:
- a `db.put/remove/append('<table>'…)` in `app/` targets a table missing from this file or from `app/core/surfaces.js`;
- a write is issued from any file other than that table's funnel;
- a `create table` in `sql/` is missing from this file.

The seven protections (founding spec §03):
1. **CAS**: conditional write (compare-and-swap on the server `updated_at`).
2. **Intent**: intent-based delete (never inferred from absence).
3. **Held-set**: persisted held-set (`core/sync.js`).
4. **Audit**: audit entry with the previous value / full snapshot.
5. **Backup**: backed up nightly.
6. **Verify**: the backup verifies its own row count (empty, or shrank by more than half, both fail).
7. **Mass-delete**: covered by the mass-delete detector (`core/watchdog.js`).

Status today: ✅ in place · 🟡 device-only stand-in · ⬜ not yet (needs Supabase).

| Table | Funnel (only writer) | CAS | Intent | Held-set | Audit | Backup | Verify | Mass-delete |
|---|---|---|---|---|---|---|---|---|
| recordings | `domain/recordings.js` | 🟡 | ✅ | 🟡 | ✅ | ⬜ | ⬜ | ✅ |
| transcripts | `domain/transcripts.js` | 🟡 | ✅ | 🟡 | ✅ | ⬜ | ⬜ | ✅ |
| action_items | `domain/actions.js` | 🟡 | ✅ | 🟡 | ✅ | ⬜ | ⬜ | ✅ |
| folders | `domain/folders.js` | 🟡 | ✅ | 🟡 | ✅ | ⬜ | ⬜ | ✅ |
| audio_files | `core/files.js` | 🟡 | ✅ | 🟡 | ✅ | ⬜ | ⬜ | ✅ |
| activity | `core/audit.js` (append-only) | n/a | n/a (no deletes) | 🟡 | itself | ⬜ | ⬜ | n/a |

Every row belongs to one person (`owner_id`, filled in from the sign-in; RLS refuses any other
value). Spaces, the tables for sharing with a partner, come in `sql/002` and will be listed here.

**Allowed non-literal writes** (generic by design, listed in the test's `NON_LITERAL_WRITES`):
- `core/audit.js` `restoreDeleted` / `revertEdit`: put back a row from the activity log, any surface.

**Before switching Supabase on:** confirm the `*_stamp` triggers exist on the live tables
(`sql/001_core.sql`, bottom). A CAS against a stamp that never advances protects nothing and
shows no symptom.
