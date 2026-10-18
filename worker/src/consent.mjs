// The page where a person lets an app (Claude, ChatGPT...) read their Mullo notes.
// Supabase's OAuth server sends them here with ?authorization_id=...; they sign in with an
// email code (as in the app), see WHO is asking and WHERE they'll be sent back, and approve or
// deny. Supabase does all the OAuth itself; this page only shows and forwards the choice.
//
// Its own short sign-in session lives in this tab only (sessionStorage) and is signed out as
// soon as the choice is made. The page's CSP allows exactly one script (this one, same origin)
// and connections to Mullo's Supabase, nothing else.

import { esc, MARK, STYLE_HREF } from './pages.mjs';

export function consentPage({ supabaseUrl, publishableKey }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Mullo</title><link rel="stylesheet" href="${STYLE_HREF}">
<script src="/oauth/consent.js" defer></script>
</head><body><main id="consent" data-server="${esc(supabaseUrl)}" data-key="${esc(publishableKey)}">
<a class="brand" href="/">${MARK}Mullo</a>

<section id="step-email" hidden>
  <h1>Sign in to Mullo</h1>
  <p class="lead">An app wants to read your Mullo notes. Sign in first, then you decide.</p>
  <form id="email-form" class="inline">
    <input id="email" type="email" autocomplete="email" placeholder="you@example.com" required>
    <button class="btn" type="submit">Send code</button>
  </form>
</section>

<section id="step-code" hidden>
  <h1>Check your email</h1>
  <p class="lead">We sent a sign-in code to <strong id="code-to"></strong>.</p>
  <form id="code-form" class="inline">
    <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" placeholder="Code" required>
    <button class="btn" type="submit">Continue</button>
  </form>
  <p><button id="other-email" class="btn btn--ghost" type="button">Use another email</button></p>
</section>

<section id="step-ask" hidden>
  <h1><span id="app-name"></span> wants to read your Mullo notes</h1>
  <div class="card">
    <h3>It will be able to</h3>
    <ul>
      <li>search your recordings</li>
      <li>read their titles, summaries, sections, tasks and transcripts</li>
    </ul>
    <h3>It won't be able to</h3>
    <ul>
      <li>change, add or delete anything</li>
      <li>hear your audio</li>
    </ul>
  </div>
  <p>Only notes you copied into your Mullo account are there to read.</p>
  <p>After you answer, you go back to <strong id="app-host"></strong>. If you don't recognise that address, choose Don't allow.</p>
  <p>Signed in as <strong id="who"></strong>. You can disconnect it any time in Mullo: Settings, Developers.</p>
  <p class="inline"><button id="allow" class="btn" type="button">Allow</button>
  <button id="deny" class="btn btn--ghost" type="button">Don't allow</button></p>
</section>

<section id="step-wait" hidden><p class="lead" id="wait-text">One moment…</p></section>

<p id="problem" class="notice" hidden></p>
</main></body></html>`;
}

// Plain browser JS, no libraries. Everything shown is set with textContent.
export const CONSENT_JS = `'use strict';
(() => {
  const main = document.getElementById('consent');
  const SERVER = main.dataset.server.replace(/\\/+$/, '');
  const KEY = main.dataset.key;
  const SESSION = 'mullo-consent-session';
  const id = new URLSearchParams(location.search).get('authorization_id') || '';
  const $ = (x) => document.getElementById(x);
  const steps = ['step-email', 'step-code', 'step-ask', 'step-wait'];
  const show = (step) => steps.forEach((s) => { $(s).hidden = s !== step; });
  const problem = (msg) => { $('problem').textContent = msg || ''; $('problem').hidden = !msg; };
  const wait = (msg) => { $('wait-text').textContent = msg; show('step-wait'); };

  async function call(path, { method = 'GET', body, token } = {}) {
    const res = await fetch(SERVER + '/auth/v1/' + path, {
      method,
      headers: Object.assign({ apikey: KEY }, body ? { 'Content-Type': 'application/json' } : {}, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.msg || data.message || data.error_description || data.error || ('Error ' + res.status)), { status: res.status });
    return data;
  }
  const saved = () => { try { const s = JSON.parse(sessionStorage.getItem(SESSION) || 'null'); return s && s.expires_at * 1000 > Date.now() + 30000 ? s : null; } catch (e) { return null; } };
  const keep = (s) => { try { sessionStorage.setItem(SESSION, JSON.stringify(s)); } catch (e) { /* this tab only */ } };
  const forget = async (s) => {
    try { sessionStorage.removeItem(SESSION); } catch (e) { /* nothing kept */ }
    if (s) await call('logout?scope=local', { method: 'POST', token: s.access_token }).catch(() => {});
  };
  const go = (url) => {
    // Web addresses, and an app's own scheme (cursor://, vscode://); never script or data.
    const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(url || '') || [])[1] || '';
    if (!scheme || /^(javascript|data|vbscript|blob|file)$/i.test(scheme)) throw new Error('The app gave an address Mullo won\\'t open.');
    location.assign(url);
  };

  async function ask(session) {
    wait('Checking who is asking…');
    const details = await call('oauth/authorizations/' + encodeURIComponent(id), { token: session.access_token });
    if (details.redirect_url && !details.authorization_id) { await forget(session); go(details.redirect_url); return; }
    const name = (details.client && (details.client.name || details.client.client_name)) || 'An app';
    let host = details.redirect_uri || '';
    try { host = new URL(details.redirect_uri).host || details.redirect_uri; } catch (e) { /* show as given */ }
    $('app-name').textContent = name;
    $('app-host').textContent = host;
    $('who').textContent = (details.user && details.user.email) || '';
    show('step-ask');
    const answer = async (action) => {
      $('allow').disabled = true; $('deny').disabled = true;
      problem('');
      try {
        wait(action === 'approve' ? 'Connecting…' : 'Going back…');
        const done = await call('oauth/authorizations/' + encodeURIComponent(id) + '/consent', { method: 'POST', body: { action }, token: session.access_token });
        await forget(session);
        go(done.redirect_url);
      } catch (err) {
        show('step-ask'); $('allow').disabled = false; $('deny').disabled = false;
        problem(err.message);
      }
    };
    $('allow').onclick = () => answer('approve');
    $('deny').onclick = () => answer('deny');
  }

  async function start() {
    if (!/^[\\w-]{8,200}$/.test(id)) { problem('This link is missing its sign-in request. Start again from the app you were connecting.'); return; }
    const s = saved();
    if (s) { try { await ask(s); return; } catch (err) { await forget(null); if (err.status !== 401 && err.status !== 403) { problem(err.message); return; } } }
    show('step-email');
  }

  let email = '';
  $('email-form').onsubmit = async (e) => {
    e.preventDefault(); problem('');
    email = $('email').value.trim().toLowerCase();
    try {
      await call('otp', { method: 'POST', body: { email, create_user: false } });
      $('code-to').textContent = email; show('step-code'); $('code').focus();
    } catch (err) {
      problem(/signups? not allowed|not found|otp_disabled/i.test(err.message) ? 'There\\'s no Mullo account with that email. Sign up in the Mullo app first.' : err.message);
    }
  };
  $('code-form').onsubmit = async (e) => {
    e.preventDefault(); problem('');
    try {
      const s = await call('verify', { method: 'POST', body: { type: 'email', email, token: $('code').value.trim() } });
      const session = { access_token: s.access_token, expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600) };
      keep(session);
      await ask(session);
    } catch (err) {
      problem(/expired|invalid/i.test(err.message) ? 'That code didn\\'t work. Check it, or send a new one.' : err.message);
    }
  };
  $('other-email').onclick = () => { problem(''); show('step-email'); };
  start().catch((err) => problem(err.message));
})();
`;
