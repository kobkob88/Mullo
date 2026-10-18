// Permission before anything goes to an AI company (App Store rule 5.1.2(i), S22e, 2026-10-16):
// "clearly disclose where personal data will be shared with third parties, including with
// third-party AI, and obtain explicit permission before doing so". Asked once per Mullo account
// on each device, naming who actually gets it: Google's Gemini on Mullo's plan, or the company of
// the person's own key (a Claude key still sends audio to Gemini: Claude can't transcribe).
// Asked again when that changes. Until then the AI gate stays shut (app.js useAiGate); recording
// and the notes on the device carry on.

import { disk } from './disk.js';
import { emit } from './bus.js';

const KEY = 'echo:ai-consent'; // { "<user id>": { to: 'gemini' | 'gemini+openai' | ..., at } }

// Who gets recordings and notes for this provider ('gemini' = Mullo's plan).
export function recipients(provider = 'gemini') {
  if (provider === 'openai') return ['openai'];
  if (provider === 'anthropic') return ['gemini', 'anthropic'];
  return ['gemini'];
}
const tag = (provider) => recipients(provider).join('+');

export function aiConsented(userId, provider) {
  if (!userId) return false;
  return disk.get(KEY, {})?.[userId]?.to === tag(provider);
}

export function giveAiConsent(userId, provider) {
  if (!userId) return;
  disk.set(KEY, { ...disk.get(KEY, {}), [userId]: { to: tag(provider), at: new Date().toISOString() } });
  emit('ai-consent', true);
}

// "Not now": the card stays away until the next start; the AI stays off.
let later = false;
export const askLater = () => { later = true; emit('ai-consent', false); };
export const askingNow = () => !later;
