// The Worker's own pages: landing (pricing + Subscribe), welcome (the key, once),
// manage (billing portal). No scripts at all: the CSP allows none.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Mullo's face next to the name (S20's mini drawing, app/ui/mascot.js, frozen in the idle mood:
// open eyes, smile). Plain SVG: the pages' CSP allows no scripts or inline styles, and none are used.
export const MARK = '<svg class="mark" width="32" height="32" viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
  + '<defs><radialGradient id="mullo-mark" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#FFE6EC"/><stop offset="1" stop-color="#E996AA"/></radialGradient></defs>'
  + '<path d="M50 36 C46 28 56 24 52 16" fill="none" stroke="#F4BCC8" stroke-width="4" stroke-linecap="round"/>'
  + '<circle cx="53" cy="12" r="5.5" fill="#9EDDCF"/>'
  + '<path d="M12 88 C8 58 24 34 50 34 C76 34 92 58 88 88 Q50 95 12 88 Z" fill="url(#mullo-mark)"/>'
  + '<circle cx="38" cy="62" r="7" fill="#221628"/><circle cx="36" cy="59" r="2.6" fill="#FFFFFF"/>'
  + '<circle cx="62" cy="62" r="7" fill="#221628"/><circle cx="60" cy="59" r="2.6" fill="#FFFFFF"/>'
  + '<ellipse cx="27" cy="72" rx="5" ry="3" fill="#EE8DA2" opacity="0.7"/><ellipse cx="73" cy="72" rx="5" ry="3" fill="#EE8DA2" opacity="0.7"/>'
  + '<path d="M43 73 Q50 83 57 73 Z" fill="#5A2338"/></svg>';

export const CSS = `
:root { --bg:#101418; --surface:#181d23; --line:#2a3139; --text:#e8edf2; --muted:#9aa6b2; --accent:#F4A3B6; --accent-ink:#3A1424; --rec:#ff4d5e; }
@media (prefers-color-scheme: light) { :root { --bg:#f5f7f9; --surface:#fff; --line:#dde3e9; --text:#14191f; --muted:#5b6672; --accent:#B8456A; --accent-ink:#fff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 2.4rem; line-height: 1.15; margin: 8px 0 12px; }
h2 { font-size: 1.3rem; margin: 40px 0 12px; }
p, li { color: var(--muted); }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--text); }
.mark { width: 32px; height: 32px; flex: none; }
.lead { font-size: 1.15rem; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 20px; }
.card h3 { margin: 0 0 6px; color: var(--text); }
.price { font-size: 1.8rem; font-weight: 700; color: var(--text); margin: 6px 0; }
.price small { font-size: 1rem; color: var(--muted); font-weight: 400; }
.pro { border-color: var(--accent); }
.btn { display: inline-block; border: 0; border-radius: 12px; padding: 12px 18px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; background: var(--accent); color: var(--accent-ink); }
.btn--ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
.soon { display: inline-block; font-size: .8rem; padding: 2px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
.key { width: 100%; font: 600 1rem ui-monospace, SFMono-Regular, Consolas, monospace; padding: 14px; border-radius: 12px; border: 1px solid var(--accent); background: var(--bg); color: var(--text); }
.notice { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--rec); border-radius: 12px; padding: 12px 16px; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; }
form.inline input { flex: 1 1 260px; padding: 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; }
footer { margin-top: 48px; font-size: .9rem; color: var(--muted); }
footer a { color: var(--muted); }
.sql { font: 400 .8rem/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; border-color: var(--line); white-space: pre; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
a { color: var(--accent); }
.brand { text-decoration: none; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.btn--small { padding: 6px 12px; font-size: .9rem; border-radius: 10px; }

/* Docs (/docs): a sidebar on a wide screen, a folding menu on a phone. */
.docs-top { display: flex; justify-content: space-between; align-items: center; max-width: 1120px; margin: 0 auto; padding: 16px; border-bottom: 1px solid var(--line); }
.docs-top__tag { color: var(--muted); font-weight: 400; }
.docs-top__links { display: flex; align-items: center; gap: 14px; }
.docs-top__home { color: var(--muted); font-size: .9rem; text-decoration: none; }
@media (max-width: 420px) { .docs-top__home { display: none; } }
.docs { max-width: 1120px; margin: 0 auto; padding: 0 16px 64px; }
.docs-side { display: none; }
.docs-menu { margin: 16px 0 0; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
.docs-menu summary { padding: 12px 16px; cursor: pointer; font-weight: 600; }
.docs-menu nav { padding: 0 16px 12px; }
.docs nav ul { list-style: none; margin: 0 0 12px; padding: 0; }
.docs nav li a { display: block; padding: 6px 10px; border-radius: 8px; color: var(--muted); text-decoration: none; }
.docs nav li a:hover { color: var(--text); background: var(--line); }
.docs nav li a[aria-current="page"] { color: var(--text); background: var(--line); font-weight: 600; }
.docs-nav__group { margin: 16px 0 4px; font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.docs-main { min-width: 0; padding-top: 24px; }
.docs-main h1 { font-size: 2rem; }
.docs-main h3 { margin: 0 0 4px; }
.docs-main li { margin: 4px 0; }
.docs-crumb { margin: 0; font-size: .85rem; font-weight: 600; color: var(--accent); }
.docs-steps li { margin: 8px 0; }
.docs-paths { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.docs-path { text-decoration: none; }
.docs-path:hover { border-color: var(--accent); }
.docs-path p { margin: 0; }
.docs-note { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 12px; padding: 12px 16px; }
.docs-code { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; overflow-x: auto; font-size: .85rem; line-height: 1.5; color: var(--text); }
.docs-table { overflow-x: auto; }
.docs-table table { width: 100%; border-collapse: collapse; font-size: .95rem; }
.docs-table th, .docs-table td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.docs-table th { color: var(--text); }
.docs-table td { color: var(--muted); }
.docs-faq dt { margin-top: 18px; font-weight: 600; color: var(--text); }
.docs-faq dd { margin: 4px 0 0; color: var(--muted); }
.docs-pager { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 48px; }
.docs-pager a { text-decoration: none; color: var(--text); padding: 14px 16px; }
.docs-pager small { display: block; color: var(--muted); }
.docs-pager__next { text-align: right; }
@media (min-width: 900px) {
  .docs { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 48px; }
  .docs-menu { display: none; }
  .docs-side { display: block; position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto; padding: 8px 0 24px; }
  .docs-main { max-width: 760px; }
}
`;

// The stylesheet's address changes with its contents, so a browser never keeps last hour's
// layout after a deploy (/style.css is cached for an hour).
let h = 5381;
for (let i = 0; i < CSS.length; i++) h = ((h * 33) ^ CSS.charCodeAt(i)) >>> 0;
export const STYLE_HREF = `/style.css?v=${h.toString(36)}`;

export function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="${STYLE_HREF}">
</head><body><main>
<header class="top"><a class="brand" href="/">${MARK}Mullo</a><a class="btn btn--ghost btn--small" href="/app/">Open Mullo</a></header>
${body}
<footer><a href="/">Mullo</a> · <a href="/app/">Open Mullo</a> · <a href="/docs">Docs</a> · <a href="/manage">Manage subscription</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer>
</main></body></html>`;
}

export function landingPage({ priceLabel, minutesLabel, trialMinutes = 0, checkoutReady = true }) {
  return page('Mullo: your conversations, written down', `
<h1>Talk. Mullo writes it down.</h1>
<p class="lead">Record on your phone or with one press on your watch. Mullo gives you a transcript, a short title, a summary and the tasks you mentioned, in English, Hebrew and about 110 other languages.</p>

<h2>What you get</h2>
<div class="grid">
  <div class="card"><h3>Phone and watch</h3><p>iPhone or Android, Apple Watch or Wear OS. Start from your watch face (or a double press on Wear OS); the recording moves to your phone on its own.</p></div>
  <div class="card"><h3>Tasks, not just text</h3><p>"Remind me to call Dana tomorrow" becomes a task with a date. One tap turns it into an email or a calendar invite.</p></div>
  <div class="card"><h3>Ask your recordings</h3><p>"What did we decide about the Montreal delivery?" Mullo answers from your own notes, with links to where it heard it.</p></div>
</div>

<h2>Pricing</h2>
<div class="grid">
  ${trialMinutes > 0 ? `<div class="card">
    <h3>Free trial</h3>
    <div class="price">${esc(trialMinutes.toLocaleString('en-US'))} <small>minutes</small></div>
    <p>Sign in and the AI is included for your first ${esc(trialMinutes.toLocaleString('en-US'))} minutes of recordings. Once per account, not every month, and no card needed. Then use your own key or Mullo Pro.</p>
  </div>` : ''}
  <div class="card">
    <h3>Bring your own AI</h3>
    <div class="price">Free</div>
    <p>Use your own Gemini, OpenAI or Claude key: in Mullo, Settings, Developers. It's locked so only Mullo can use it and kept on your device; that company bills you directly. (Claude doesn't take audio, so transcripts then use your Mullo plan.)</p>
  </div>
  <div class="card pro">
    <h3>Mullo Pro</h3>
    <div class="price">${esc(priceLabel)} <small>/ month</small></div>
    <p>The AI is included: ${esc(minutesLabel)} of recordings a month. No key, no setup. Cancel any time.</p>
    ${checkoutReady
    ? '<p>Get it in Mullo: Settings, Subscription.</p>'
    : '<span class="soon">Coming soon</span>'}
  </div>
</div>

<h2>Your recordings stay yours</h2>
<ul>
  <li>Recordings live on your phone. Sign in and a copy goes to your account (stored in Canada), readable only by you.</li>
  <li>To transcribe, the audio passes through Mullo to Google Gemini (paid tier, not used to train models); Mullo deletes it once the transcript is made.</li>
  <li>Mullo's server keeps only your plan and subscription (with the email you paid with), fingerprints of keys, and how much AI you used this month.</li>
</ul>

<h2>On your computer</h2>
<p><a href="/app/">Open Mullo in your browser</a> and sign in with the same email as on your phone: your notes come over by themselves, and changes follow both ways.</p>

<h2>Connect it to everything else</h2>
<p>Let Claude, ChatGPT or Cursor read your notes over MCP, pull them into scripts with the API, or keep them on your own server. <a href="/docs">Read the docs</a>.</p>`);
}

export function welcomePage({ key, email, linked = false }) {
  if (linked) {
    return page('Welcome to Mullo Pro', `
<h1>You're in.</h1>
<p class="lead">Mullo Pro is on your Mullo account${email ? ` (${esc(email)})` : ''}. Go back to Mullo: there is nothing to paste.</p>
<p>For a device that can't sign in, here is a key. It is shown <b>once</b>; opening this page again makes a new one and turns this one off.</p>
<input class="key" readonly value="${esc(key)}" aria-label="Your Mullo Pro key">
<p>Treat it like a password: anyone with it uses your monthly AI allowance.</p>`);
  }
  return page('Welcome to Mullo Pro', `
<h1>You're in.</h1>
<p class="lead">This is your Mullo Pro key${email ? ` for ${esc(email)}` : ''}. Sign in to Mullo, then copy it in: <b>Settings → Developers → Mullo Pro key</b>. It becomes part of your Mullo account.</p>
<input class="key" readonly value="${esc(key)}" aria-label="Your Mullo Pro key">
<p class="notice">This key is shown <b>once</b>. Mullo keeps only a fingerprint of it, so we can't show it again. Opening this page again makes a <b>new</b> key and turns the old one off.</p>
<p>Treat it like a password: anyone with it uses your monthly AI allowance.</p>`);
}

export function managePage({ error } = {}) {
  return page('Manage your Mullo subscription', `
<h1>Manage your subscription</h1>
<p>Paste your Mullo Pro key to change your card, see invoices or cancel. You'll go to Stripe, our payment provider.</p>
${error ? `<p class="notice">${esc(error)}</p>` : ''}
<form class="inline" method="post" action="/manage">
  <input name="key" autocomplete="off" placeholder="echo_..." aria-label="Mullo Pro key" required>
  <button class="btn" type="submit">Continue</button>
</form>`);
}

// Your own Supabase for Mullo: the steps, and the SQL to paste (from the step after `from`).
export function setupPage({ steps, from = 0 }) {
  const todo = steps.filter((s) => s.step > from);
  return page('Your own server for Mullo', `
<h1>Keep your notes on your own server</h1>
<p class="lead">Mullo can copy your notes to your own Supabase project instead of Mullo's. The notes stay on your phone either way.</p>
<h2>Once</h2>
<ol>
  <li>Make a project at supabase.com (the free plan is fine).</li>
  <li>Authentication, Sign In / Providers: Email on. Then Authentication, Emails: put <code>{{ .Token }}</code> in BOTH "Confirm signup" (your first sign-in) and "Magic link or OTP" (every sign-in after), so the email carries the code Mullo asks for. A dashboard setting: the SQL below can't change it.</li>
  <li>SQL editor: run each step below, in order${from ? ` (your server is at step ${from}, so only the newer ones)` : ''}. Step 4 adds an optional sign-in hook; you don't need to switch it on.</li>
  <li>Project Settings, API Keys: copy the project URL and the <b>publishable</b> key. Never the secret key: it must not be on a phone.</li>
  <li>In Mullo: Settings, Developers, Your own server. Paste them, then sign in (Settings, Account) with the code from your project's email; your notes then move there by themselves. Supabase's built-in mail sends only a few emails an hour, and only to your project's team: send one code and wait. For everyday use, set your own mail sender in Authentication, Emails, SMTP Settings (a Gmail app password works; the username is the Gmail address).</li>
</ol>
<p>AI on your own server: it still goes through Mullo's server, so you also stay signed in to your Mullo account for it (Settings, Account, Mullo account). Your plan, a Mullo Pro key or your own AI key (Settings, Developers) then works; your notes stay on your server.</p>
<h2>The SQL</h2>
${todo.length ? todo.map((s) => `
<h3>Step ${s.step}: ${esc(s.name)} <a class="btn btn--ghost" href="/setup/${esc(s.name)}">Download</a></h3>
<textarea class="key sql" readonly rows="12" aria-label="${esc(s.name)}">${esc(s.sql)}</textarea>`).join('') : '<p>Your server has every step already.</p>'}`);
}

// toApp: pages the phone apps open in the browser (Google's return page). "Back" there led to
// the website's home page (owner, 2026-10-14); instead "Back to Mullo" opens the Android app
// (mullo://open, BackToAppActivity). The text still says what to do where that link does nothing.
export function messagePage(title, text, { toApp = false } = {}) {
  const button = toApp
    ? '<p><a class="btn" href="mullo://open">Back to Mullo</a></p>'
    : '<p><a class="btn btn--ghost" href="/">Back</a></p>';
  return page(title, `<h1>${esc(title)}</h1><p class="lead">${esc(text)}</p>${button}`);
}
