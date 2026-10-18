// Hash routes → screen IDs (the same IDs core/auth.js grants).

const ROUTES = [
  [/^#?\/?$/, 'library'],
  [/^#\/library$/, 'library'],
  [/^#\/record$/, 'record'],
  [/^#\/rec\/([\w-]+)$/, 'recording', (m) => ({ id: m[1] })],
  // #/actions/<task id>: a reminder's notification was tapped (S47); that task is shown first.
  [/^#\/actions(?:\/([\w-]+))?$/, 'actions', (m) => ({ focus: m[1] ?? null })],
  [/^#\/search$/, 'search'],
  [/^#\/activity$/, 'activity'],
  [/^#\/settings(?:\/(account|mullo-account|subscription|languages|names|summaries|appearance|keep-audio|server-keep|developers|ai|storage|connections|google|admin-trials|admin-free|admin-models|admin-reports|admin-dashboard|admin-stats-[a-z]+|report))?$/, 'settings', (m) => ({ section: m[1] ?? null })],
  [/^#\/more$/, 'settings'], // the old More tab is now Settings
];

// wide: a computer's window, 1200px+ (desktop layout, 2026-10-17). A recording then opens
// beside the Library list instead of on its own page; its address stays #/rec/<id>.
export function parseRoute(hash, { wide = false } = {}) {
  for (const [pattern, screen, params] of ROUTES) {
    const m = pattern.exec(hash ?? '');
    if (!m) continue;
    if (wide && screen === 'recording') return { screen: 'library', params: { open: m[1] } };
    return { screen, params: params ? params(m) : {} };
  }
  return { screen: null, params: {} };
}

// Bottom-bar tab that stays lit for each screen.
export const NAV_FOR = {
  library: 'library', recording: 'library', record: null, actions: 'actions',
  search: 'search', activity: 'settings', settings: 'settings',
};

// Where the person came from (inside the app), so a recording opened from Actions or
// Search leads back there, and going back lands where they were on that list.
const trail = { current: null, previous: null, scroll: new Map(), restore: null };

// Called on every route change, before the new screen renders: scrollY is still the
// old screen's. Going back to the screen just left brings back its scroll position.
export function noteRoute(hash, scrollY = 0) {
  if (hash === trail.current) return;
  if (trail.current != null) trail.scroll.set(trail.current, scrollY);
  // Record always opens at the top, its button in view (owner, 2026-10-16).
  const back = trail.previous != null && hash === trail.previous && parseRoute(hash).screen !== 'record';
  trail.restore = back ? (trail.scroll.get(hash) ?? null) : null;
  trail.previous = trail.current;
  trail.current = hash;
}

// The scroll position to put back once the screen has rendered (once).
export function takeScrollRestore() {
  const y = trail.restore;
  trail.restore = null;
  return y;
}

const BACK_TO = { actions: 'Actions', search: 'Search' };
const cameFrom = () => (trail.previous == null ? null : parseRoute(trail.previous).screen);

// The screen before this one (its hash), or null.
export const previousHash = () => trail.previous;

// A recording's back link → { hash, label, isPrevious }. isPrevious: going back is a
// step back in history (so the phone's back gesture afterwards doesn't return here).
export function backLink() {
  const from = cameFrom();
  if (BACK_TO[from]) return { hash: trail.previous, label: BACK_TO[from], isPrevious: true };
  return { hash: '#/library', label: 'Library', isPrevious: from === 'library' };
}

// The lit tab: a recording opened from Actions or Search keeps that tab lit.
export function navTab(screen) {
  return screen === 'recording' && BACK_TO[cameFrom()] ? NAV_FOR[cameFrom()] : NAV_FOR[screen];
}

export function resetTrail() {
  Object.assign(trail, { current: null, previous: null, restore: null });
  trail.scroll.clear();
}
