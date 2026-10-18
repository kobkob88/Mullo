// Folders - the ONE funnel for the folders surface (Pocket has folders and
// spaces; Plaud has folders). The key is opaque; the label is editable and
// must not collide with another folder's label or key.

import { db } from '../core/db.js';
import { newId, labelCollision } from '../core/ids.js';

const COLLISION = {
  empty: 'A folder needs a name',
  label: 'Another folder already has that name',
  key: 'That name is reserved',
};

export async function listFolders() {
  const rows = await db.list('folders');
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

export async function createFolder(label) {
  const clash = labelCollision(label, await db.list('folders'));
  if (clash) return { ok: false, error: COLLISION[clash] };
  return db.put('folders', { id: newId(), label: label.trim() });
}

export async function renameFolder(folder, label) {
  const clash = labelCollision(label, await db.list('folders'), folder.id);
  if (clash) return { ok: false, error: COLLISION[clash] };
  return db.put('folders', { id: folder.id, label: label.trim() }, { expected: folder.updated_at, reason: 'renamed' });
}

// Recordings in the folder keep their folder_id; the library shows them as
// unfiled, and restoring the folder brings them back into it.
export async function deleteFolder(folder) {
  return db.remove('folders', folder.id, { intent: 'deleted a folder', expected: folder.updated_at });
}
