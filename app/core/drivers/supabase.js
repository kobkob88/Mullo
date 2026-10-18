// Supabase driver: NOT switched on yet. This file fixes the contract the
// remote driver must keep, so turning Supabase on is one file, not a rewrite.
//
// Contract (same as memory.js / local-idb.js):
//   get(table, id) · list(table) · put(table, row, expected)
//   remove(table, id, expected) · append(table, entry)
//   putBlob(id, blob) · getBlob(id) · listBlobs() → [{id, bytes}] · removeBlob(id)
//
// put(table, row, expected):
//   expected == null → upsert (no stamp means write unconditionally)
//   expected != null → update(row).eq('id', row.id).eq('updated_at', expected).select()
//                      zero rows back → { ok:false, conflict:true } (not an error)
//   Never send updated_at - the trigger in sql/001_core.sql owns it. Check the
//   trigger exists on the live table BEFORE relying on this (spec §03 trap).
//   Keep updated_at as the raw string Postgres returns.
// remove(): delete().eq('id').eq('updated_at', expected) - only ever called
//   for an intent the person expressed; never for a row that merely went missing.
// append('activity', entry): insert … on conflict (id) do nothing.
// putBlob/getBlob: Storage bucket "audio" (private). Reads go through
//   short-lived signed URLs; the metadata row is the audio_files surface.
//
// Load supabase-js pinned to an exact version with an integrity hash, or
// vendor it into app/vendor/ (and the deploy manifest). Never a floating CDN tag.
// Add the project host to connect-src via CONNECT_SRC at build time.

export function openSupabaseDriver(config) {
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    throw new Error('Supabase is not configured - set supabaseUrl and supabaseAnonKey in config.json');
  }
  throw new Error('Supabase driver not implemented yet - see the contract in core/drivers/supabase.js');
}
