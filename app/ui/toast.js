// One polite live region for short messages. It drops down from under the top bar (owner,
// 2026-10-15: floating mid-screen it looked stuck there) and gets out of the way: it hides
// on its own, on a tap (data-action="toast-dismiss"), or as soon as the person drags or
// scrolls - a message over moving content reads as stuck.
// A scroll right after it appears is ignored (a route change scrolls to the top by itself);
// a drag never is: that is always the person's own finger, and on a page too short to
// scroll it is the only sign they're moving it.
// Only for what the screen can't show: an error, something done out of sight. A change the
// person can see where they tapped needs no message.

import { h, userText } from './dom.js';

let timer = null;
let outTimer = null;
let shownAt = 0;
const SCROLL_GRACE_MS = 800; // a route change scrolls to the top right after a toast
const OUT_MS = 180; // the slide back up (app.css toastOut)

export function toast(message, { error = false } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(outTimer);
  el.replaceChildren(
    h('span', { class: 'toast__icon', 'aria-hidden': 'true' }, error ? '!' : '✓'),
    userText('span', message, { class: 'toast__text' }));
  el.classList.toggle('is-error', error);
  el.classList.remove('is-out', 'is-in');
  el.hidden = false;
  void el.offsetWidth; // restarts the slide-in when a message replaces another
  el.classList.add('is-in');
  shownAt = Date.now();
  clearTimeout(timer);
  timer = setTimeout(hideToast, error ? 6000 : 3500);
}

export function hideToast() {
  const el = document.getElementById('toast');
  clearTimeout(timer);
  if (!el || el.hidden) return;
  el.classList.remove('is-in');
  el.classList.add('is-out');
  clearTimeout(outTimer);
  outTimer = setTimeout(() => { el.hidden = true; el.classList.remove('is-out'); }, OUT_MS);
}

export function hideToastOnScroll() {
  if (Date.now() - shownAt > SCROLL_GRACE_MS) hideToast();
}

export function hideToastOnDrag() {
  const el = document.getElementById('toast');
  if (el && !el.hidden) hideToast();
}

export const actions = { 'toast-dismiss': hideToast };
