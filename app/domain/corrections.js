// Learning from a person's transcript fixes. When a line is edited, find the
// short phrases that were replaced ("שרמן דרך" → "Charmander") and offer to
// teach them. A taught pair becomes a Names & words entry
// "Charmander (heard as שרמן דרך)", which the transcription prompt reads as
// "when you hear this, write that" (bridge/gemini.mjs vocabularyLine).
// Pure: no storage here.

const MAX_MEANT_WORDS = 4;
const MAX_HEARD_WORDS = 6;
const MAX_ENTRY = 60; // core/settings.js caps each Names & words entry

const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean);
// Compare words without punctuation or case, so "שלום," = "שלום".
const norm = (w) => w.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();

// Word-level diff (LCS) → runs where old words were replaced by new ones.
// key: what makes two words the same (teaching ignores punctuation and case).
function replacedRuns(before, after, key) {
  const a = words(before);
  const b = words(after);
  const na = a.map(key);
  const nb = b.map(key);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let del = [];
  let ins = [];
  const flush = () => {
    if (del.length && ins.length) out.push({ heard: del.join(' '), meant: ins.join(' ') });
    del = [];
    ins = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && na[i] === nb[j]) { flush(); i += 1; j += 1; } else if (j < b.length && (i >= a.length || L[i][j + 1] >= L[i + 1][j])) { ins.push(b[j]); j += 1; } else { del.push(a[i]); i += 1; }
  }
  flush();
  return out;
}

export function phraseChanges(before, after) {
  const seen = new Set();
  return replacedRuns(before, after, norm)
    .map(({ heard, meant }) => ({ heard: strip(heard), meant: strip(meant) }))
    .filter(({ heard, meant }) => heard && meant
      && words(meant).length <= MAX_MEANT_WORDS && words(heard).length <= MAX_HEARD_WORDS
      && norm(heard.replace(/\s/g, '')) !== norm(meant.replace(/\s/g, ''))
      && teachEntry(meant, heard).length <= MAX_ENTRY)
    .filter(({ heard, meant }) => {
      const k = `${norm(heard)}→${norm(meant)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// Leading/trailing punctuation isn't part of what was misheard.
const strip = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export const teachEntry = (meant, heard) => `${meant} (heard as ${heard})`;

// "Charmander (heard as שרמן דרך)" → { word, heardAs }; any other entry → null.
export function parseTeachEntry(entry) {
  const m = /^(.+?) \(heard as (.+)\)$/.exec(String(entry ?? '').trim());
  return m ? { word: m[1].trim(), heardAs: m[2].trim() } : null;
}

// Offers not already taught.
export function newTeachings(changes, vocabulary) {
  const have = new Set((vocabulary ?? []).map((v) => String(v).toLocaleLowerCase()));
  return changes.filter(({ heard, meant }) => !have.has(teachEntry(meant, heard).toLocaleLowerCase()));
}

// ── Fixes kept with one recording ──────────────────────────────────────
// Owner, 2026-10-14: "235" fixed by hand to "2.35", then Re-transcribe wrote "235" again.
// Every hand fix of a line is kept on the recording (`transcript_fixes`, heard → meant,
// exact: "235" → "2.35" counts, unlike teaching). Re-transcribe sends them as this
// recording's names-and-words list AND puts them back into the new transcript, so a fix
// holds even when the AI doesn't follow it. A word only added or only removed has nothing
// to anchor on in a new transcript, so it isn't kept.
const MAX_FIX_WORDS = 8;
export const MAX_FIXES = 40;

export function lineFixes(before, after) {
  return replacedRuns(before, after, strip)
    .map(({ heard, meant }) => ({ heard: strip(heard), meant: strip(meant) }))
    .filter(({ heard, meant }) => heard && meant && heard !== meant
      && words(heard).length <= MAX_FIX_WORDS && words(meant).length <= MAX_FIX_WORDS);
}

// The newest fix of the same words wins; a fix put back by hand ("2.35" back to "235")
// drops both. Newest first, capped.
export function mergeFixes(kept, added) {
  const fresh = (added ?? []).filter((f) => f?.heard && f?.meant);
  const old = (Array.isArray(kept) ? kept : []).filter((f) => f?.heard && f?.meant);
  const undoes = (a, f) => a.heard === f.meant && a.meant === f.heard;
  const out = [];
  for (const f of [
    ...fresh.filter((a) => !old.some((f) => undoes(a, f))),
    ...old.filter((f) => !fresh.some((a) => undoes(a, f))),
  ]) {
    if (f.heard === f.meant || out.some((o) => o.heard === f.heard)) continue;
    out.push({ heard: String(f.heard), meant: String(f.meant) });
  }
  return out.slice(0, MAX_FIXES);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words only, and never inside a number: "35" doesn't touch "2.35" or "1,350".
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[.,])${escape(w)}(?![\\p{L}\\p{N}]|[.,]\\p{N})`, 'gu');

export function applyFixes(segments, fixes) {
  const list = mergeFixes(fixes, []);
  if (!list.length) return segments;
  return segments.map((s) => {
    let text = String(s.text ?? '');
    for (const { heard, meant } of list) {
      // What already reads as meant stays as it is ("David" → "David Cohen" never doubles).
      text = text.split(meant).map((part) => part.replace(wordRe(heard), meant)).join(meant);
    }
    return text === s.text ? s : { ...s, text };
  });
}

// For the transcription prompt: "2.35 (heard as 235)", the same shape as a taught word.
export const fixesAsVocabulary = (fixes) => mergeFixes(fixes, [])
  .map((f) => teachEntry(f.meant, f.heard))
  .filter((e) => e.length <= MAX_ENTRY);
