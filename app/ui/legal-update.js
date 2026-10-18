// "We updated our Privacy Policy and Terms" (S23, 2026-10-11): shown above every screen while
// Mullo's server says a newer version than the one this account accepted (core/legal.js).
// What changed, both ticks again (each page opens on Mullo's website, settings.js 'open-legal'),
// and Accept. Until then Mullo's AI waits; recording and the notes on the device carry on.

import { h } from './dom.js';
import { ctx } from './context.js';

const agreed = { privacy: false, terms: false };
const both = () => agreed.privacy && agreed.terms;

function tick(page, text, title, server) {
  const id = `legal-update-${page}`;
  return h('div', { class: 'legal-tick' },
    h('input', { type: 'checkbox', id, checked: agreed[page], data: { action: 'legal-update-tick', page } }),
    h('label', { for: id }, text, h('a', { href: `${server}/${page}`, data: { action: 'open-legal', page } }, title)));
}

export function legalUpdateCard(legal, server) {
  return h('section', { class: 'card stack legal-update', 'aria-label': 'Privacy Policy and Terms updated' },
    h('h2', { class: 'legal-update__title' }, 'We updated our Privacy Policy and Terms'),
    legal.changes ? h('p', { class: 'small' }, legal.changes) : null,
    h('p', { class: 'muted small' }, 'Mullo\'s AI waits until you accept. Recording and your notes on this device carry on.'),
    tick('privacy', 'I have read the ', 'Privacy Policy', server),
    tick('terms', 'I have read and agree to the ', 'Terms of Service', server),
    h('button', {
      type: 'button', class: 'btn btn--primary', disabled: !both(),
      data: { action: 'legal-update-accept', version: legal.current, gate: 'legal-update' },
    }, 'Accept'));
}

export const actions = {
  'legal-update-tick'(el) {
    agreed[el.dataset.page] = el.checked;
    for (const button of document.querySelectorAll('[data-gate="legal-update"]')) button.disabled = !both();
  },
  async 'legal-update-accept'(el) {
    if (!both()) return;
    el.disabled = true;
    try {
      await ctx.acceptLegal(el.dataset.version);
      agreed.privacy = false;
      agreed.terms = false;
      ctx.toast('Thanks. Mullo\'s AI is on again.');
    } catch (err) {
      ctx.toast(err.message, { error: true });
      el.disabled = false;
    }
  },
};
