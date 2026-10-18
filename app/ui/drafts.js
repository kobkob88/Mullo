// A forced update reload must never cost someone a half-typed form (spec §10).
// Any field with data-draft="<key>" is saved before the reload and put back
// the first time a field with that key is rendered afterwards.

const KEY = 'echo:drafts';

export function saveDrafts() {
  const drafts = {};
  for (const el of document.querySelectorAll('[data-draft]')) {
    if (el.value) drafts[el.dataset.draft] = el.value;
  }
  try { sessionStorage.setItem(KEY, JSON.stringify(drafts)); } catch { /* storage full or blocked */ }
}

export function restoreDrafts(root = document) {
  let drafts;
  try { drafts = JSON.parse(sessionStorage.getItem(KEY) ?? '{}'); } catch { drafts = {}; }
  let restored = 0;
  for (const el of root.querySelectorAll('[data-draft]')) {
    const value = drafts[el.dataset.draft];
    if (value && !el.value) {
      el.value = value;
      delete drafts[el.dataset.draft];
      restored += 1;
    }
  }
  try { sessionStorage.setItem(KEY, JSON.stringify(drafts)); } catch { /* ignore */ }
  return restored;
}
