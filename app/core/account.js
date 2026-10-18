// Your Mullo account: sign-in with an emailed code, 6 to 10 digits (Supabase Auth),
// spoken to directly over fetch, so the app still has no dependencies.
//
// - The server's address and public key come from config.json (never from
//   source): our hosted project, or a family's own (spec: accounts-and-spaces).
// - The session (access + refresh token) is kept by the Android app's native
//   side, sealed with the Keystore like the Pro key. In a browser it lives in
//   this site's storage; there is no better place for a web app.
// - Refresh tokens rotate: two refreshes at once would sign the person out,
//   so there is only ever one in flight.
// - Offline is not signed out: a refresh that can't reach the server keeps
//   the session and tries again later. Only the server saying the session is
//   no longer valid signs the person out.

import { disk } from './disk.js';
import { emit } from './bus.js';

const SESSION_KEY = 'echo:session';
const MULLO_SESSION_KEY = 'echo:session:mullo';
const PRO_LINK = 'echo:pro-link'; // the account a Mullo Pro key was linked to
const REFRESH_EARLY_S = 60; // refresh a minute before the token runs out
// A browser's Google / Apple sign-in on the provider's own page (Supabase's PKCE flow): what the
// return needs, kept across the trip there and back. Ten minutes, then it's a stale start.
const REDIRECT_KEY = 'echo:signin:redirect';
const REDIRECT_TTL_MS = 10 * 60_000;
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The sign-in on its way back from Google / Apple, or null: { provider, url, which, ticked, back }.
export function redirectPending() {
  return disk.get(REDIRECT_KEY, null);
}

// Where a session is kept: sealed by the Android app (its native save/load/clear), else
// this site's storage under `diskKey`.
function sessionStore(diskKey, [save, load, clear]) {
  const nativeBox = () => {
    const n = globalThis.MulloNative;
    return typeof n?.[save] === 'function' ? n : null;
  };
  return {
    load() {
      const n = nativeBox();
      if (n) {
        const raw = n[load]();
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
      }
      return disk.get(diskKey, null);
    },
    save(session) {
      const n = nativeBox();
      if (n) n[save](JSON.stringify(session)); else disk.set(diskKey, session);
    },
    clear() {
      const n = nativeBox();
      if (n) n[clear](); else disk.remove(diskKey);
    },
  };
}

// The sign-in to the server the notes sync with. Injected in tests.
export const deviceSessionStore = sessionStore(SESSION_KEY, ['saveSession', 'loadSession', 'clearSession']);
// On your own server, the second sign-in: to Mullo's account, for the AI and the Terms (S25).
export const mulloSessionStore = sessionStore(MULLO_SESSION_KEY, ['saveMulloSession', 'loadMulloSession', 'clearMulloSession']);

// A one-time value for a provider sign-in: the provider gets its SHA-256, the
// server gets the raw value and checks they match, so a token can't be replayed.
export async function signInNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const raw = hex(bytes);
  return { raw, hashed: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))) };
}

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE_SHAPE = /^\d{6,10}$/;

// What the server said, in words a person can act on.
function problem(status, body) {
  const msg = String(body?.msg ?? body?.error_description ?? body?.message ?? '');
  if (status === 429 || /only request this after/i.test(msg)) {
    const s = /after (\d+) seconds?/i.exec(msg)?.[1];
    return s ? `Wait ${s} seconds, then ask for a new code.` : 'Too many tries. Wait a minute and try again.';
  }
  if (/expired or is invalid|otp_expired|invalid.*token/i.test(msg + (body?.error_code ?? ''))) {
    return 'That code is wrong or has expired. Check the newest email, or ask for a new code.';
  }
  if (/sending.*email/i.test(msg)) return 'The email could not be sent. Try again in a minute.';
  if (/signups? not allowed/i.test(msg)) return 'New accounts are closed on this server.';
  return msg || `The sign-in server answered ${status}.`;
}

const OFFLINE = 'No connection. Try again when you have signal.';

// The first name for the greeting on a computer (desktop layout, 2026-10-17): Google and Apple
// put it in user_metadata. Only kept when there is one, so a user without it looks as before.
function firstName(meta) {
  const name = String(meta?.given_name ?? meta?.full_name ?? meta?.name ?? '').trim().split(/\s+/)[0];
  return name || null;
}

function toSession(body, now) {
  if (!body?.access_token || !body?.refresh_token || !body?.user?.id) throw new Error('The sign-in server sent back something unexpected.');
  const name = firstName(body.user.user_metadata);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Number(body.expires_at) || Math.floor(now() / 1000) + Number(body.expires_in || 3600),
    user: { id: body.user.id, email: body.user.email ?? null, ...(name ? { name } : {}) },
  };
}

// event: what a sign-in or sign-out is announced as ('mullo-account' for the second sign-in on
// your own server, so it never starts syncing).
export function createAccount({ url, key, fetch = globalThis.fetch, store = deviceSessionStore, now = Date.now, event = 'account' } = {}) {
  const on = Boolean(url && key);
  let session = on ? store.load() : null;
  let refreshing = null;

  async function call(path, body, { token } = {}) {
    let res;
    try {
      res = await fetch(`${url}/auth/v1/${path}`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      const err = new Error(OFFLINE);
      err.offline = true;
      throw err;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(problem(res.status, data));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function keep(next) {
    session = next;
    if (next) store.save(next); else store.clear();
    emit(event, user());
  }

  function user() {
    return session ? { ...session.user } : null;
  }

  // The Android app's background side (WatchAi, Mullo closed) refreshes the session too and
  // saves it in the same store. A newer one there is taken as is: sending our older refresh
  // token again would be refused as already used.
  function newerStored() {
    const stored = store.load();
    const fresh = stored?.refresh_token && stored.refresh_token !== session?.refresh_token
      && stored.expires_at > now() / 1000 && stored.user?.id === session?.user?.id;
    if (!fresh) return false;
    session = stored;
    emit(event, user());
    return true;
  }

  async function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        if (newerStored()) return;
        const held = session;
        try {
          keep(toSession(await call('token?grant_type=refresh_token', { refresh_token: held.refresh_token }), now));
        } catch (err) {
          // Offline or the server is down: still signed in, try again later.
          if (err.offline || !err.status || err.status >= 500) return;
          // Refused because the background side used it a moment ago: its session wins.
          if (newerStored()) return;
          // The server no longer accepts this session (revoked, or used elsewhere).
          if (session === held) keep(null);
        }
      })().finally(() => { refreshing = null; });
    }
    await refreshing;
  }

  return {
    on,
    user,

    async sendCode(email) {
      const clean = String(email ?? '').trim().toLowerCase();
      if (!EMAIL_SHAPE.test(clean)) throw new Error('That doesn\'t look like an email address.');
      await call('otp', { email: clean, create_user: true });
      return clean;
    },

    async verifyCode(email, code) {
      const token = String(code ?? '').replace(/\s+/g, '');
      if (!CODE_SHAPE.test(token)) throw new Error('The code is the digits in the email.');
      keep(toSession(await call('verify', { type: 'email', email, token }), now));
      return user();
    },

    // "Continue with Google" (or Apple, later): the provider's ID token, from the
    // phone's own sign-in sheet, traded for a Mullo session. `nonce` is the raw
    // value whose SHA-256 the token carries: the server checks they match.
    async signInWithIdToken(provider, idToken, nonce) {
      keep(toSession(await call('token?grant_type=id_token', { provider, id_token: idToken, nonce }), now));
      return user();
    },

    // In a browser: Google / Apple on their own page (they refuse to sign in inside an app's web
    // view, so phone apps use their own sheet and signInWithIdToken). → the address to go to.
    // PKCE: only this browser, holding the verifier, can turn the code that comes back into a
    // session. `extra` (which sign-in, the legal ticks, where to go back) rides along.
    async redirectUrl(provider, returnTo, extra = {}) {
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      disk.set(REDIRECT_KEY, { ...extra, provider, url, verifier, at: now() });
      const q = new URLSearchParams({ provider, redirect_to: returnTo, code_challenge: challenge, code_challenge_method: 's256' });
      return `${url}/auth/v1/authorize?${q}`;
    },

    // Back from Google / Apple with `?code=`: → the user. The verifier is used once, by this
    // account only, and only within ten minutes of leaving.
    async finishRedirect(code) {
      const pending = disk.get(REDIRECT_KEY, null);
      disk.remove(REDIRECT_KEY);
      if (!pending?.verifier || pending.url !== url || now() - pending.at > REDIRECT_TTL_MS) {
        throw new Error('That sign-in took too long or was started elsewhere. Try again.');
      }
      keep(toSession(await call('token?grant_type=pkce', { auth_code: String(code), code_verifier: pending.verifier }), now));
      return user();
    },

    // Which providers this server has switched on (Supabase's public settings): { google, apple }.
    // Unknown (offline, an older server) = none, so no button leads to an error page.
    async providers() {
      try {
        const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
        const external = res.ok ? (await res.json())?.external ?? {} : {};
        return { google: external.google === true, apple: external.apple === true };
      } catch {
        return { google: false, apple: false };
      }
    },

    // A token that is good for at least another minute, or null (signed out,
    // or offline with an expired one).
    async accessToken() {
      if (!session) return null;
      if (session.expires_at - REFRESH_EARLY_S <= now() / 1000) await refresh();
      if (!session || session.expires_at <= now() / 1000) return null;
      return session.access_token;
    },

    // A call to the person's own data (`rest/v1/...`, `storage/v1/...`) as them.
    // → the Response. Throws { offline } with no connection, { signedOut } when
    // there is no usable session. A 401 is refreshed and tried once more.
    async request(path, { method = 'GET', headers = {}, body } = {}) {
      const send = async (token) => {
        try {
          return await fetch(`${url}/${path}`, { method, body, headers: { apikey: key, ...headers, Authorization: `Bearer ${token}` } });
        } catch {
          const err = new Error(OFFLINE);
          err.offline = true;
          throw err;
        }
      };
      const noSession = () => {
        const err = new Error(session ? OFFLINE : 'Signed out.');
        if (session) err.offline = true; else err.signedOut = true;
        return err;
      };
      let token = await this.accessToken();
      if (!token) throw noSession();
      let res = await send(token);
      if (res.status === 401) {
        await refresh();
        token = session && session.expires_at > now() / 1000 ? session.access_token : null;
        if (!token) throw noSession();
        res = await send(token);
      }
      return res;
    },

    // Mullo Pro: "this key is mine". The sign-in and the key go to Mullo Pro
    // together, once; from then on the sign-in reaches the same subscription.
    // Remembered per account, so another account signed in here isn't linked.
    async linkPro(workerUrl, proKey) {
      const token = await this.accessToken();
      if (!token || !proKey) return false;
      let res;
      try {
        res = await fetch(`${workerUrl}/api/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key: proKey }),
        });
      } catch {
        const err = new Error(OFFLINE);
        err.offline = true;
        throw err;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Mullo Pro answered ${res.status}`);
      disk.set(PRO_LINK, session?.user.id ?? null);
      return true;
    },

    // A signed-in call to Mullo's server (the Admin page: worker/src/plans.mjs).
    // → its JSON answer; throws with the server's own words.
    async server(workerUrl, path, body) {
      const token = await this.accessToken();
      if (!token) throw Object.assign(new Error(session ? OFFLINE : 'Sign in first.'), { offline: Boolean(session) });
      let res;
      try {
        res = await fetch(`${workerUrl}${path}`, body === undefined
          ? { headers: { Authorization: `Bearer ${token}` } }
          : { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      } catch {
        throw Object.assign(new Error(OFFLINE), { offline: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error ?? `Mullo's server answered ${res.status}`), { status: res.status, code: data.code ?? null });
      return data;
    },

    // Which numbered step of sql/ this server is at (its schema_version()). 0 = Mullo's tables
    // aren't there; null = couldn't tell (offline, or not a Supabase project).
    async schemaVersion() {
      try {
        const res = await fetch(`${url}/rest/v1/rpc/schema_version`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: '{}' });
        if (res.status === 404) return 0;
        if (!res.ok) return null;
        const v = Number(await res.json());
        return Number.isInteger(v) ? v : null;
      } catch { return null; }
    },

    // Supabase's OAuth server: approve an authorization this person asked for (a new API
    // key, started by Mullo's server for them). → where Supabase sends the approval.
    async approve(authorizationId) {
      const path = `auth/v1/oauth/authorizations/${encodeURIComponent(authorizationId)}`;
      const read = async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.msg ?? data.message ?? data.error_description ?? `The account server answered ${res.status}`);
        return data;
      };
      const details = await read(await this.request(path));
      if (details.redirect_url && !details.authorization_id) return details.redirect_url; // approved before
      const done = await read(await this.request(`${path}/consent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
      }));
      return done.redirect_url;
    },

    // Leaving Mullo's server for your own: no way into this account stays open here. Every API
    // key (Mullo's server holds them), every connected app's grant, then every session, this
    // device's and every other's (scope=global). Throws at the first step that fails, and the
    // caller keeps the server as it was. Signed out here = nothing this device can close.
    // keepThisDevice (S25): every OTHER session ends (scope=others) and this one is kept, to
    // carry on as the Mullo sign-in the AI goes through on their own server.
    async endAllAccess(workerUrl, { keepThisDevice = false } = {}) {
      if (!session) return { signedIn: false };
      if (workerUrl) {
        let keys = [];
        try { ({ keys = [] } = await this.server(workerUrl, '/api/keys')); } catch (err) { if (err.status !== 503) throw err; } // 503: keys switched off
        for (const k of keys) await this.server(workerUrl, '/api/keys/revoke', { id: k.id });
      }
      const res = await this.request('auth/v1/user/oauth/grants');
      if (res.ok) {
        const list = await res.json().catch(() => []);
        for (const g of Array.isArray(list) ? list : []) {
          const out = await this.request(`auth/v1/user/oauth/grants?client_id=${encodeURIComponent(g.client?.id ?? g.client_id)}`, { method: 'DELETE' });
          if (!out.ok) throw new Error(`The account server answered ${out.status} while disconnecting an app.`);
        }
      } else if (res.status !== 404) throw new Error(`The account server answered ${res.status}.`); // 404: no app sign-in on this server
      await call(`logout?scope=${keepThisDevice ? 'others' : 'global'}`, {}, { token: await this.accessToken() });
      if (!keepThisDevice) keep(null);
      return { signedIn: true };
    },

    // Delete account (Settings, Account). Mullo's server lets go first (workerUrl; it cancels a
    // linked Mullo Pro), then the audio files (Supabase can't remove storage from SQL), then the
    // account itself (sql/005), which takes every row of theirs with it. Every step can run
    // again, so a failure midway is fixed by trying again. The notes on this device stay.
    // How this session was signed in, from its token ('email', 'google', 'apple'); [] when unknown.
    signInMethods() {
      try {
        const claims = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const methods = claims?.app_metadata?.providers ?? [claims?.app_metadata?.provider];
        return methods.filter((m) => typeof m === 'string');
      } catch {
        return [];
      }
    },

    // appleCode: signed in with Apple on the iPhone, a fresh code from Apple (native.js
    // appleAuthCode), so Mullo's server revokes Apple's link with the delete.
    async deleteAccount(workerUrl, { appleCode = null } = {}) {
      const me = session?.user.id;
      if (!me) throw new Error('Sign in first.');
      // Before anything goes: a server without sql/005 would stop halfway (Pro cancelled, audio
      // gone, account still there).
      const step = await this.schemaVersion();
      if (step === null) throw Object.assign(new Error(OFFLINE), { offline: true });
      if (step < 5) throw new Error('This server can\'t delete accounts yet: it needs setup step 5 (Settings, Developers, Your own server).');
      if (workerUrl) await this.server(workerUrl, '/api/account/delete', appleCode ? { apple_code: appleCode } : {});
      const asJson = { 'Content-Type': 'application/json' };
      for (let round = 0; round < 200; round++) {
        const listed = await this.request('storage/v1/object/list/audio', { method: 'POST', headers: asJson, body: JSON.stringify({ prefix: me, limit: 100, offset: 0 }) });
        if (!listed.ok) throw new Error(`The account server answered ${listed.status} while listing your audio.`);
        const files = (await listed.json().catch(() => [])).filter((o) => o?.id && o.name);
        if (!files.length) break;
        const gone = await this.request('storage/v1/object/audio', { method: 'DELETE', headers: asJson, body: JSON.stringify({ prefixes: files.map((o) => `${me}/${o.name}`) }) });
        if (!gone.ok) throw new Error(`The account server answered ${gone.status} while deleting your audio.`);
      }
      const res = await this.request('rest/v1/rpc/delete_my_account', { method: 'POST', headers: asJson, body: '{}' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `The account server answered ${res.status}.`);
      }
      disk.remove(PRO_LINK);
      keep(null);
    },

    proLinked() {
      return Boolean(session && disk.get(PRO_LINK, null) === session.user.id);
    },

    // Signs out here even when the server can't be reached; the server-side
    // session then simply runs out. This device only (scope=local): Supabase's default
    // is global, which also ends every connected app's and API key's session.
    async signOut() {
      const token = session?.access_token;
      keep(null);
      if (token) await call('logout?scope=local', {}, { token }).catch(() => {});
    },
  };
}

// The one account for this app, set at boot from config.json.
let current = createAccount({});
export function useAccount(account) { current = account; }
export const account = () => current;

// The Mullo account the AI goes through (S25: anything through Mullo's server needs a Mullo
// sign-in). The same account as above, except on your own server: then a second sign-in, to
// Mullo's server, used for the AI, the plan and the Terms only; the notes sync with the first.
let mulloCurrent = null;
export function useMulloAccount(acct) { mulloCurrent = acct; }
export const mulloAccount = () => mulloCurrent ?? current;
export const twoAccounts = () => Boolean(mulloCurrent && mulloCurrent !== current);
