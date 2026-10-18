// Mullo Pro bought through the App Store (iPhone, S22c). StoreKit says what was bought; Mullo's
// server checks each transaction with Apple and puts it on the signed-in account
// (worker/src/appstore.mjs). Claiming is idempotent, so the app claims after a purchase, after
// Restore, and once per start (a renewal, or a purchase whose claim was cut off by no signal).

import { mulloAccount } from '../core/account.js';
import { storeAvailable, storeBuy, storeCurrent, storeRestore } from '../core/native.js';

let server = null; // Mullo's server (config.bridgeUrl, or this site)
export function useStore(url) { server = url || null; }
export const storeReady = () => Boolean(server) && storeAvailable() && Boolean(mulloAccount().user());

async function claim(ids) {
  let claimed = 0;
  let problem = null;
  for (const id of ids ?? []) {
    try {
      await mulloAccount().server(server, '/api/billing/apple', { transaction_id: String(id) });
      claimed += 1;
    } catch (err) {
      problem ??= err;
    }
  }
  if (problem && !claimed) throw problem;
  return claimed;
}

// The purchase sheet. → 'bought' | 'cancelled' | 'pending' (Ask to Buy, or a bank check).
export async function buyPro() {
  if (!storeReady()) throw new Error('Sign in first.');
  const res = await storeBuy(mulloAccount().user().id);
  if (res.error) throw new Error(res.error);
  if (res.cancelled) return 'cancelled';
  if (res.pending) return 'pending';
  await claim([res.transactionId]);
  return 'bought';
}

// "Restore Purchases" (App Store rule 3.1.1). → how many were put on this account.
export async function restorePro() {
  if (!storeReady()) throw new Error('Sign in first.');
  const res = await storeRestore();
  if (res.error) throw new Error(res.error);
  return claim(res.ids);
}

// Quietly, once per start: what StoreKit says is paid up goes to the server again.
export async function claimQuietly() {
  if (!storeReady()) return 0;
  const res = await storeCurrent();
  return res.ids?.length ? claim(res.ids).catch(() => 0) : 0;
}
