// "Mullo uses AI on your recordings" (core/ai-consent.js): above every screen until the person
// says yes or "Not now". Says plainly who gets what, and why; links the Privacy Policy.

import { h } from './dom.js';
import { recipients, giveAiConsent, askLater } from '../core/ai-consent.js';

const WHO = {
  gemini: 'Google\'s Gemini AI, on Google\'s paid service (Google doesn\'t train its models on it)',
  openai: 'OpenAI, with your own OpenAI key',
  anthropic: 'Anthropic\'s Claude, with your own Claude key',
};

export function aiConsentCard({ userId, provider, server }) {
  const to = recipients(provider);
  return h('section', { class: 'card stack legal-update', 'aria-label': 'Permission to use AI' },
    h('h2', { class: 'legal-update__title' }, 'Mullo uses AI on your recordings'),
    h('p', { class: 'small' }, 'To write transcripts, summaries, tasks and drafts, and to answer your questions, Mullo sends your recordings and notes through Mullo\'s server to:'),
    h('ul', { class: 'small' }, to.map((who) => h('li', null, WHO[who]))),
    to.includes('gemini') ? h('p', { class: 'muted small' }, 'Mullo deletes the audio once it\'s transcribed.') : null,
    h('p', { class: 'muted small' }, 'Without it, recordings still save on this phone with a simple summary, and nothing is sent. ',
      h('a', { href: `${server}/privacy`, data: { action: 'open-legal', page: 'privacy' } }, 'Privacy Policy')),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'ai-consent-yes', user: userId, provider } }, 'Allow'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'ai-consent-later' } }, 'Not now')));
}

export const actions = {
  'ai-consent-yes'(el) { giveAiConsent(el.dataset.user, el.dataset.provider); },
  'ai-consent-later'() { askLater(); },
};
