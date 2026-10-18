// Motion with a purpose (owner, 2026-10-15: "if I press a button it can move or expand, in a
// fluid way - think about system animations"). Things move from where they were to where
// they are: a task you open grows and pushes the ones under it down, a ticked task's gap
// closes, the chat grows out of its bar and shrinks back into it, a selected tab's line
// slides over. Nothing moves on its own.
//
// The app draws a whole screen again after every change, so this is FLIP: app.js measures
// every [data-flip] element before a redraw (measure) and, once the new screen is in, plays
// each one from its old box to its new one (play). data-flip is a stable key; data-flip-mode:
//   move  (default) slides from its old place
//   size  also grows or shrinks to its new height (its contents are clipped while it does)
//   slide a thumb or underline: slides and stretches sideways to its new spot
//   morph grows out of the old box of the same key (the chat bar → the chat sheet)
//
// One-shot marks (mark/take) are for what has no old box: the next draw takes a mark once,
// so a redraw never replays an animation. app.css and this file do nothing for "reduce motion".

import { h } from './dom.js';

const EASE = 'cubic-bezier(0.2, 0, 0, 1)'; // a quick start that settles softly, like the system's
const MOVE_MS = 340;

const marks = new Set();
export function mark(key) { marks.add(key); }
export function take(key) { return marks.delete(key); } // → true once per mark

export const calm = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;

// Where each key last was outside a morph (the chat bar while the sheet is open).
const lastSeen = new Map();
let skip = false;

// The next redraw jumps: the screen already animated itself (a sheet shrank into its bar).
export function skipNext() { skip = true; }

export function measure(root) {
  const out = new Map();
  if (skip || calm()) { skip = false; return out; }
  for (const el of root.querySelectorAll('[data-flip]')) {
    const box = el.getBoundingClientRect();
    out.set(el.dataset.flip, box);
    if (el.dataset.flipMode !== 'morph') lastSeen.set(el.dataset.flip, box);
  }
  return out;
}

export function play(root, before) {
  if (!before.size) return;
  const moved = new Map(); // element → the shift it was given, so its children don't move twice
  for (const el of root.querySelectorAll('[data-flip]')) {
    const was = before.get(el.dataset.flip);
    if (!was) {
      // Newly here on the same screen (a filter switched, a task added): it fades up into place.
      if (el.dataset.flipMode === 'size') el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
      continue;
    }
    const now = el.getBoundingClientRect();
    const parent = el.parentElement?.closest('[data-flip]');
    const [px, py] = moved.get(parent) ?? [0, 0];
    const dx = was.left - now.left - px;
    const dy = was.top - now.top - py;
    moved.set(el, [dx + px, dy + py]);
    const mode = el.dataset.flipMode ?? 'move';
    const timing = { duration: MOVE_MS, easing: EASE };
    if (mode === 'morph') {
      if (Math.abs(was.height - now.height) < 2) continue;
      el.animate([
        { clipPath: inset(was, now, 26), opacity: 0.6 },
        { clipPath: 'inset(0 round 24px 24px 0 0)', opacity: 1 },
      ], { duration: 380, easing: EASE });
    } else if (mode === 'slide') {
      if (Math.abs(dx) < 1 && Math.abs(was.width - now.width) < 1) continue;
      el.animate([
        { transformOrigin: 'left center', transform: `translateX(${was.left - now.left}px) scaleX(${was.width / now.width})` },
        { transformOrigin: 'left center', transform: 'none' },
      ], timing);
    } else if (mode === 'size' && Math.abs(was.height - now.height) > 1) {
      el.animate([
        { height: `${was.height}px`, transform: `translate(${dx}px, ${dy}px)` },
        { height: `${now.height}px`, transform: 'none' },
      ], timing);
    } else if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], timing);
    }
  }
}

// The reverse of a morph: el shrinks into where its key last was, then the caller closes it.
export async function shrinkInto(el, key, fade = null) {
  const target = lastSeen.get(key);
  if (!el || !target || calm()) return;
  const now = el.getBoundingClientRect();
  const out = { duration: 260, easing: 'cubic-bezier(0.3, 0, 0.8, 0.15)', fill: 'forwards' };
  fade?.animate([{ opacity: 1 }, { opacity: 0 }], out);
  await el.animate([
    { clipPath: 'inset(0 round 24px 24px 0 0)', opacity: 1 },
    { clipPath: inset(target, now, 26), opacity: 0.4 },
  ], out).finished.catch(() => {});
  skipNext();
}

// A clip-path that shows only the part of box `now` where box `was` sits.
function inset(was, now, radius) {
  const top = Math.max(0, was.top - now.top);
  const left = Math.max(0, was.left - now.left);
  const right = Math.max(0, now.right - was.right);
  const bottom = Math.max(0, now.bottom - was.bottom);
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
}

// The record button flies into its place on the Record screen (owner, 2026-10-16; build 62's
// full-screen red flashed): the floating red circle travels on a soft arc and settles as the
// red dot of "Start recording" while the screen fades in around it. One red thing, moving.
// flyHome leaves a stand-in on the button's spot and opens the screen (go); land(), called by
// app.js once the new screen is in, flies it to [data-landing="record"] (or lets it melt away
// when the screen has no dot, e.g. a recording already running).
let flyer = null;

export function flyHome(button, go) {
  if (calm() || !button) { go(); return; }
  flyer?.remove();
  flyer = h('div', { class: 'fab fab--flyer', 'aria-hidden': 'true' }, h('span', { class: 'fab__dot' }));
  document.body.append(flyer);
  go();
}

export const flying = () => flyer !== null;

export function land(root) {
  if (!flyer || !location.hash.startsWith('#/record')) return; // a redraw of the old screen first
  const me = flyer;
  flyer = null;
  const from = me.getBoundingClientRect();
  const target = root.querySelector('[data-landing="record"]');
  const to = target?.getBoundingClientRect();
  const done = () => { me.remove(); target?.classList.remove('is-awaiting'); };
  if (!to || !to.width) {
    me.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 220, easing: EASE, fill: 'forwards' }).finished.finally(done);
    return;
  }
  target.classList.add('is-awaiting'); // the real dot waits under the flying one
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = to.width / from.width;
  // An arc, not a straight line: across first, then up, the way things move on the phone.
  me.animate([
    { transform: 'none' },
    { offset: 0.55, transform: `translate(${dx * 0.8}px, ${dy * 0.45}px) scale(${(1 + s) / 2})` },
    { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
  ], { duration: 460, easing: 'cubic-bezier(0.3, 0, 0, 1)', fill: 'forwards' }).finished.finally(done);
  me.firstChild?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: 'forwards' });
}

// How deep a screen is: the Library is 1, a recording or a settings page 2. Deeper slides in
// from the side like the system's push; back slides the other way; between tabs it fades.
export function depth(hash) {
  const parts = String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'actions') return 1; // #/actions/<task> is a notification, not deeper
  return Math.max(1, parts.length);
}
