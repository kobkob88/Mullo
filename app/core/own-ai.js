// The person's own AI key (Settings → Developers; spec docs/specs/2026-10-08-connections-design.md §4):
// Gemini, OpenAI or Claude, told apart by the server from the key's shape.
//
// The plain key is typed once and sent to Mullo's server, which checks it with its company and
// SEALS it (worker/src/ownkey.mjs): only that server can open it again. What is kept here is
// the sealed text: in the Android app natively (Keystore, and config.json hands it back as
// `aiOwnKey`), in a browser in this site's storage. Each AI call carries it; with it, the AI
// company bills the person and no Mullo minutes are counted.

import { disk } from './disk.js';
import { inAndroidApp } from './native.js';

const KEY = 'echo:own-ai'; // { provider, hint, sealed? (browser only) }
const native = () => globalThis.MulloNative ?? null;

// → { sealed, provider, hint } or null.
export function ownAi(config) {
  const saved = disk.get(KEY, null);
  const sealed = inAndroidApp() ? (config?.aiOwnKey ?? null) : (saved?.sealed ?? null);
  return sealed ? { sealed, provider: saved?.provider ?? 'gemini', hint: saved?.hint ?? '' } : null;
}

// What the server sealed → null when kept, or why not.
export function keepOwnAi({ sealed, provider = 'gemini', hint = '' }) {
  if (!/^mk1\.[\w-]+\.[\w-]+$/.test(sealed ?? '')) return 'Mullo\'s server sent back something unexpected.';
  if (inAndroidApp()) {
    if (typeof native()?.setOwnKey !== 'function') return 'Update the Mullo app to use your own key.';
    const result = native().setOwnKey(sealed);
    if (result !== 'ok') return result;
    disk.set(KEY, { provider, hint });
  } else {
    disk.set(KEY, { provider, hint, sealed });
  }
  return null;
}

export function dropOwnAi() {
  if (typeof native()?.clearOwnKey === 'function') native().clearOwnKey();
  disk.remove(KEY);
}

export const PROVIDER_LABEL = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Claude' };
// Who bills the person for it.
export const PROVIDER_BILLER = { gemini: 'Google', openai: 'OpenAI', anthropic: 'Anthropic' };
// Claude takes no audio: transcripts go to the Mullo plan (bridge/providers.mjs, CAN).
export const transcribesWith = (provider) => provider !== 'anthropic';

// Anything through Mullo's server needs a Mullo sign-in (S25). A key on this device (their own
// AI key, or a Mullo Pro key) still pays, but waits for one. → true while it waits.
export function keyWaitsForSignIn(config, signedInToMullo) {
  const mullo = config?.aiPlan === 'pro' || config?.aiPlan === 'account';
  return Boolean(mullo && !signedInToMullo && (config.aiPlan === 'pro' || ownAi(config)));
}

// Where to sign in to Mullo: Settings, Account; on their own server, its second sign-in there.
export const mulloSignInHref = (config) => (config?.ownServer ? '#/settings/mullo-account' : '#/settings/account');
