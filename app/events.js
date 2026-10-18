// Every DOM listener in the app lives here, delegated from document/window.
// There are zero onclick= / style= attributes anywhere (tests enforce it):
// inline handlers would force 'unsafe-inline' into the CSP, and nonces cannot
// rescue attributes.
//
// Markup says WHAT, with data-action="<name>"; screens register the handler
// for that name. The event that fires it defaults by element type and can be
// overridden with data-on="click|change|input|submit|contextmenu".

const handlers = new Map();
let reportError = (err) => console.error(err);

export function registerActions(map) {
  for (const [name, fn] of Object.entries(map)) {
    if (handlers.has(name)) throw new Error(`Action "${name}" is registered twice`);
    handlers.set(name, fn);
  }
}

function defaultEvent(el) {
  const tag = el.tagName;
  if (tag === 'FORM') return 'submit';
  if (tag === 'SELECT') return 'change';
  if (tag === 'TEXTAREA') return 'input';
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (['checkbox', 'radio', 'file', 'date', 'time', 'range', 'color'].includes(type)) return 'change';
    if (['button', 'submit', 'reset'].includes(type)) return 'click';
    return 'input';
  }
  return 'click';
}

function dispatch(event) {
  const el = event.target?.closest?.('[data-action]');
  if (!el) return;
  const wanted = el.dataset.on || defaultEvent(el);
  if (wanted !== event.type) return;
  const fn = handlers.get(el.dataset.action);
  if (!fn) {
    console.warn(`No handler for data-action="${el.dataset.action}"`);
    return;
  }
  if (event.type === 'submit' || event.type === 'contextmenu' || (event.type === 'click' && el.tagName === 'A')) event.preventDefault();
  Promise.resolve()
    .then(() => fn(el, event))
    .catch((err) => reportError(err, el.dataset.action));
}

export function installEvents({ onRoute, onFocus, onConnectivity, onIdle, onWatch, onGoogle, onLeaveMullo, onReminderTap, onScroll, onDrag, isBusy, onError }) {
  if (onError) reportError = onError;
  // contextmenu = a long-press on a phone (opt-in per element with data-on).
  for (const type of ['click', 'change', 'input', 'submit', 'contextmenu']) document.addEventListener(type, dispatch);
  // Forms that are not data-action forms must never navigate the page.
  document.addEventListener('submit', (e) => { if (!e.target.closest('[data-action]')) e.preventDefault(); });
  document.addEventListener('focusout', () => onIdle?.());
  // A player that stops lets a held-back re-render through (media events don't bubble: capture).
  for (const type of ['pause', 'ended']) document.addEventListener(type, () => onIdle?.(), true);

  window.addEventListener('hashchange', () => onRoute?.());
  window.addEventListener('focus', () => onFocus?.());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onFocus?.(); });
  window.addEventListener('online', () => onConnectivity?.());
  window.addEventListener('offline', () => onConnectivity?.());
  // The Android app's native side fires this when a watch recording lands.
  window.addEventListener('mullo-watch', () => onWatch?.());
  // ...and this with Google's answer to "Continue with Google" (a JSON string).
  window.addEventListener('mullo-google', (e) => onGoogle?.(e.detail));
  // ...and this once the person said yes to leaving Mullo's server for their own.
  window.addEventListener('mullo-leave-server', () => onLeaveMullo?.());
  // ...and this when Done / Snooze was tapped on a task reminder while Mullo is open.
  window.addEventListener('mullo-reminder', () => onReminderTap?.());
  window.addEventListener('scroll', () => onScroll?.(), { passive: true });
  // A finger dragging or a mouse wheel: the person is moving the page, even one too
  // short to scroll (no scroll event ever comes then).
  document.addEventListener('touchmove', () => onDrag?.(), { passive: true });
  window.addEventListener('wheel', () => onDrag?.(), { passive: true });
  // Closing the tab mid-recording would lose the audio.
  window.addEventListener('beforeunload', (e) => { if (isBusy?.()) e.preventDefault(); });
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason));
}
