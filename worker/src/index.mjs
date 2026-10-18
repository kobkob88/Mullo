// Mullo Pro: the hosted AI bridge, paid with Stripe.
//
// The same /api contract as bridge/server.mjs (the app's remote engine doesn't
// change), plus who is calling on every call:  Authorization: Bearer <echo_ key>
// or Bearer <Mullo sign-in token> (signin.mjs; once linked to a subscription
// with POST /api/link).
// The Gemini prompts are the bridge's own modules, imported, so there is one
// copy of them. Usage is metered from Gemini's own token counts, never from
// what the app says.
//
// Secrets (wrangler secret put, never a file): GEMINI_API_KEY, STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET. Settings (wrangler.toml [vars]): STRIPE_PRICE_ID,
// MONTHLY_MINUTES, MONTHLY_TOKENS, AI_PER_MINUTE, APP_ORIGINS, PRICE_LABEL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
// ADMIN_USER_IDS, TRIAL_TOKENS_PER_MINUTE. Optional: GEMINI_MODEL, and OPENAI_MODEL /
// CLAUDE_MODEL for people's own keys (bridge/providers.mjs). Trial size and pause: the
// settings table, changed by an admin from the app (plans.mjs).

import { DEFAULT_MODEL } from '../../bridge/gemini.mjs';
import { readTranscribeRequest, checkAudio, languageName, MAX_REQUEST_BYTES, TOO_LARGE } from '../../bridge/transcribe.mjs';
import {
  processNotes, askNotes, chatNotes, transcribeAudio, modelFor, CAN, LABEL, OPENAI_MAX_AUDIO_BYTES, OPENAI_TOO_LARGE, OPENAI_NO_TRANSLATION,
} from '../../bridge/providers.mjs';
import { stripe, verifyWebhook, periodEnd, hex } from './stripe.mjs';
import { monthOf, addUsage, meteredFetch, ready } from './usage.mjs';
import { verifySignIn, looksLikeToken } from './signin.mjs';
import { planFor, planProblem, planReport, readSettings, writeSettings, grantByEmail, isAdmin, monthlyProblem, monthlyReport, monthlyMinutes } from './plans.mjs';
import { sendReport, listReports, reportScreenshot, setReportStatus } from './reports.mjs';
import { collect, contextOf, reportOf, dashboardOf } from './admin-reports.mjs';

import { rpc, resourceMetadata, notesFor, restCall } from './mcp.mjs';
import { startKey, finishKey, listKeys, revokeKey, tokenForKey, KEY_PREFIX } from './apikeys.mjs';
import { consentPage, CONSENT_JS } from './consent.mjs';
import { sealRoute, openKey, OWN_KEY_HEADER, OWN_KEY_GONE, OWN_KEY_ELSEWHERE } from './ownkey.mjs';
import { googleStatus, startGoogle, finishGoogle, forgetGoogle, pushGoogle } from './google.mjs';
import { revokeApple } from './apple.mjs';
import { claimApple, appleNotification } from './appstore.mjs';

export { tokensIn } from './usage.mjs';
export { TranscribeJob } from './jobs.mjs';
import { keepFor } from './jobs.mjs';
import { CSS, landingPage, welcomePage, managePage, messagePage, setupPage } from './pages.mjs';
import { privacyPage, termsPage, LEGAL_UPDATED } from './legal.mjs';
import { legalState, acceptLegal, legalProblem } from './acceptance.mjs';
import { docsPage } from './docs.mjs';
import { THINKING, readModels, saveModels, cleanModels, tiersFor, resolveModel, defaultModel, pickOf, savePick, modelsReport } from './models.mjs';
import { SQL_STEPS } from './setup-sql.mjs';

const ACTIVE = new Set(['active', 'trialing']);
// Where "Open Claude" / "Open ChatGPT" lead: their pages for adding a connector.
export const GO_TO = {
  '/go/claude': 'https://claude.ai/settings/connectors',
  '/go/chatgpt': 'https://chatgpt.com/#settings/Connectors',
};

// ── Keys ────────────────────────────────────────────────────────────────
export function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `echo_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
export async function hashKey(key) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
}

// ── Responses ───────────────────────────────────────────────────────────
// The site's pages run no script at all (default-src 'none' leaves script-src empty).
const PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; "
  + "form-action 'self' https://checkout.stripe.com https://billing.stripe.com; require-trusted-types-for 'script'";
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

const html = (body, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store', ...SECURITY },
});

function cors(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = (env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}
const json = (req, env, body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY, ...cors(req, env) },
});
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Accounts and usage ──────────────────────────────────────────────────
async function accountForKey(env, key) {
  if (!key?.startsWith('echo_')) return null;
  return env.DB.prepare('select * from accounts where key_hash = ?').bind(await hashKey(key)).first();
}

const NOT_SIGNED_IN = 'Your Mullo sign-in has run out. Open Mullo and sign in again.';
const CONNECTED_APP = 'Connected apps can read notes only. Use the Mullo app for this.';

// Anything through Mullo's server needs a Mullo sign-in (S25, owner 2026-10-11): a Mullo Pro key
// or the person's own AI key still pays, the sign-in says who, and that they accepted the Privacy
// Policy and Terms. Apps from before S25 sent a key alone, so this waits for SIGNIN_GATE = "on"
// (wrangler.toml), turned on once the new app is installed. Those answers carry code 'signin'.
export const signinGateOn = (env) => env.SIGNIN_GATE === 'on';
const SIGN_IN_FOR = {
  pro: 'Sign in to Mullo to keep using your Mullo Pro key.',
  own: 'Sign in to Mullo to keep using your own AI key.',
  seal: 'Sign in to Mullo first, then add your own AI key.',
};

// The person themselves, signed in to the Mullo app: never a key, never a connected app.
async function appUser(req, env, deps, signedOut = NOT_SIGNED_IN, code = undefined) {
  const token = bearer(req);
  const user = looksLikeToken(token) && !token.startsWith('echo_') ? await verifySignIn(token, env, deps.fetch) : null;
  if (!user) throw fail(401, signedOut, code);
  if (user.clientId) throw fail(403, CONNECTED_APP);
  return user;
}

// The person behind a key (S25): their own sign-in, with the current Privacy Policy and Terms
// accepted. Nothing is checked while SIGNIN_GATE is off. what: 'own' | 'seal'.
async function keyHolder(req, env, deps, what) {
  if (!signinGateOn(env)) return null;
  const user = await appUser(req, env, deps, SIGN_IN_FOR[what], 'signin');
  const legal = await legalProblem(env, user.userId);
  if (legal) throw fail(...legal, 'legal');
  return user;
}

// Who is calling, and whose allowance pays: a Mullo Pro key (echo_...), or a Mullo
// sign-in (a Supabase token from OUR project, signin.mjs) with a linked subscription
// (Pro) or the account's own plan (plans.mjs: free, trial, none).
// → { payer, user, problem }: payer = { holder, plan, account?, trialSeconds? } where
// holder is whose usage it is; problem = [status, message] when nobody real is calling.
async function caller(req, env, deps) {
  const token = bearer(req);
  if (token.startsWith('echo_') || !looksLikeToken(token)) {
    const account = await accountForKey(env, token);
    if (!account) return { problem: [401, usable(null)] };
    // A Pro key alone is nobody (S25): the app sends the sign-in the key is linked to instead.
    return signinGateOn(env) ? { problem: [401, SIGN_IN_FOR.pro, 'signin'] } : { payer: proPayer(account), user: null };
  }
  const user = await verifySignIn(token, env, deps.fetch);
  if (!user) return { problem: [401, NOT_SIGNED_IN] };
  // A connected app's token (Claude through MCP, an API key) reads notes; it never spends the
  // person's AI minutes, pays, or links anything.
  if (user.clientId) return { problem: [403, CONNECTED_APP] };
  await ready(env);
  const account = await env.DB.prepare(`select a.* from account_users u join accounts a on a.subscription_id = u.subscription_id
    where u.user_id = ?`).bind(user.userId).first();
  return { payer: account ? proPayer(account) : await planFor(env, user), user };
}

const proPayer = (account) => ({ holder: account.subscription_id, plan: 'pro', account });

// Why this payer can't start AI work now: [status, message] or null.
async function payerProblem(env, payer) {
  if (payer.plan !== 'pro') return planProblem(env, payer);
  const why = usable(payer.account);
  if (why) return [402, why];
  return monthlyProblem(env, payer.holder);
}

// "This key is mine": the sign-in and the key together, once. Then either reaches
// the same subscription, allowance and usage.
async function linkRoute(req, env, deps) {
  const user = await appUser(req, env, deps);
  const { key } = await req.json().catch(() => ({}));
  const account = await accountForKey(env, String(key ?? '').trim());
  if (!account) throw fail(401, usable(null));
  await ready(env);
  const held = await env.DB.prepare('select user_id from account_users where subscription_id = ?').bind(account.subscription_id).first();
  if (held && held.user_id !== user.userId) throw fail(409, 'This Mullo Pro key is already tied to another Mullo account.');
  await env.DB.prepare(`insert into account_users (user_id, subscription_id, linked_at) values (?, ?, ?)
    on conflict(user_id) do update set subscription_id = excluded.subscription_id, linked_at = excluded.linked_at`)
    .bind(user.userId, account.subscription_id, nowSec()).run();
  return json(req, env, { linked: true, active: !usable(account) });
}

// A subscription bought from inside Mullo carries the buyer's account id
// (client_reference_id): it becomes that account's, with no key to paste. Never
// moves a subscription another account already holds.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function linkBuyer(env, userId, subId) {
  if (!USER_ID.test(userId ?? '') || !subId) return false;
  await ready(env);
  const held = await env.DB.prepare('select user_id from account_users where subscription_id = ?').bind(subId).first();
  if (held && held.user_id !== userId) return false;
  await env.DB.prepare(`insert into account_users (user_id, subscription_id, linked_at) values (?, ?, ?)
    on conflict(user_id) do update set subscription_id = excluded.subscription_id, linked_at = excluded.linked_at`)
    .bind(userId, subId, nowSec()).run();
  return true;
}

async function upsertSubscription(env, sub, { email } = {}) {
  await env.DB.prepare(`insert into accounts (subscription_id, customer_id, email, status, period_end, updated_at)
      values (?, ?, ?, ?, ?, ?)
    on conflict(subscription_id) do update set
      customer_id = excluded.customer_id, status = excluded.status, period_end = excluded.period_end,
      email = coalesce(excluded.email, accounts.email), updated_at = excluded.updated_at`)
    .bind(sub.id, typeof sub.customer === 'string' ? sub.customer : sub.customer?.id, email ?? null, sub.status, periodEnd(sub), nowSec())
    .run();
}

export function usable(account, now = nowSec()) {
  if (!account) return 'This key is not valid. Subscribe at the Mullo website, or paste the newest key.';
  if (!ACTIVE.has(account.status)) return 'Your Mullo Pro subscription is not active. Check your payment in Manage subscription.';
  if (account.period_end && account.period_end + 3 * 86400 < now) return 'Your Mullo Pro subscription has ended.';
  return null;
}

async function underRate(env, holder, perMinute = Number(env.AI_PER_MINUTE ?? 20)) {
  const minute = Math.floor(Date.now() / 60000);
  const row = await env.DB.prepare(`insert into rate (subscription_id, minute, n) values (?, ?, 1)
    on conflict(subscription_id, minute) do update set n = n + 1 returning n`).bind(holder, minute).first();
  if (minute % 30 === 0) await env.DB.prepare('delete from rate where minute < ?').bind(minute - 5).run();
  return (row?.n ?? 1) <= perMinute;
}

// ── AI routes (same contract as bridge/server.mjs) ──────────────────────
const bearer = (req) => (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

// The person's own AI key (ownkey.mjs), when the call carries one: it pays, the AI company
// bills them, no plan or minutes. The holder is a fingerprint of the sealed key (for the rate
// limit and the job's owner), never the key. → payer or null.
async function ownPayer(req, env) {
  const sealed = req.headers.get(OWN_KEY_HEADER);
  if (!sealed) return null;
  const opened = await openKey(env, sealed);
  if (!opened) throw fail(401, OWN_KEY_GONE);
  return { holder: `own:${(await hashKey(sealed)).slice(0, 32)}`, plan: 'own', provider: opened.provider, apiKey: opened.key, sealed, owner: opened.user };
}

// Only the Mullo account that added the key may use it. A key sealed before keys carried their
// account is claimed by the first account that uses it (fingerprint of the sealed text, never the
// key). No sign-in to compare with (SIGNIN_GATE off, a self-hosted Worker): nothing to check.
async function checkOwner(env, own, user) {
  if (!user) return;
  if (own.owner) {
    if (own.owner !== user.userId) throw fail(403, OWN_KEY_ELSEWHERE);
    return;
  }
  await ready(env);
  await env.DB.prepare('insert into own_key_claims (holder, user_id, claimed_at) values (?, ?, ?) on conflict(holder) do nothing')
    .bind(own.holder, user.userId, nowSec()).run();
  const claim = await env.DB.prepare('select user_id from own_key_claims where holder = ?').bind(own.holder).first();
  if (claim?.user_id !== user.userId) throw fail(403, OWN_KEY_ELSEWHERE);
}

// Their own key, when it can do this job (a Claude key can't transcribe). → payer or null.
async function ownPayerFor(req, env, job) {
  const own = await ownPayer(req, env);
  return own && CAN[own.provider]?.includes(job) ? own : null;
}

// Whoever may start AI work now: a real caller, a plan that allows it, allowance
// left, under the rate. → the payer (whose usage it is).
// job: 'transcribe' | 'process' | 'ask'. A job their own key can't do goes to their Mullo plan.
async function aiPayer(req, env, deps, job) {
  const own = await ownPayerFor(req, env, job);
  if (own) {
    const user = await keyHolder(req, env, deps, 'own');
    await checkOwner(env, own, user);
    if (!(await underRate(env, own.holder))) throw fail(429, 'Too many AI requests, try again in a minute.');
    return { ...own, userId: user?.userId ?? null };
  }
  const { payer, user, problem } = await caller(req, env, deps);
  if (problem) {
    const kept = req.headers.get(OWN_KEY_HEADER) ? await ownPayer(req, env) : null;
    if (kept) throw fail(400, `${LABEL[kept.provider]} can't turn audio into text. Transcripts need Mullo's plan (sign in), or a Gemini or OpenAI key.`);
    throw fail(...problem);
  }
  // A sign-in that hasn't accepted the current Privacy Policy and Terms (acceptance.mjs, S23).
  const legal = await legalProblem(env, user?.userId);
  if (legal) throw fail(...legal, 'legal');
  const why = await payerProblem(env, payer);
  if (why) throw fail(...why);
  if (!(await underRate(env, payer.holder))) throw fail(429, 'Too many AI requests, try again in a minute.');
  return { ...payer, userId: user?.userId ?? null };
}

// Which AI, with whose key: their own key's provider, or Gemini on Mullo's key.
const aiOptions = (payer, env, doFetch) => {
  const provider = payer.provider ?? 'gemini';
  return { provider, apiKey: payer.apiKey ?? env.GEMINI_API_KEY, model: modelFor(provider, env), fetch: doFetch };
};

// Summaries, tasks, Ask and drafts (S54): the model this payer may use, from their pick (or
// "Summarise again with", `wanted`) and the plan. Their own OpenAI or Claude key keeps its model.
async function textOptions(payer, env, doFetch, wanted) {
  const base = aiOptions(payer, env, doFetch);
  if (base.provider !== 'gemini') return base;
  const list = await readModels(env);
  const m = resolveModel(list, tiersFor(payer), wanted ?? await pickOf(env, payer.userId));
  const fallback = m.isDefault ? null : defaultModel(list);
  return { ...base, model: m.id, thinking: m.thinking, fallback };
}

// A model Google refuses (it changed, or it won't take the thinking setting) shouldn't cost the
// person their summary: once more on the default. Not for 429/5xx (busy is retried elsewhere).
async function withFallback(run, opts) {
  try {
    return await run(opts);
  } catch (err) {
    if (!opts.fallback || !/^Gemini 4\d\d/.test(String(err?.message))) throw err;
    console.log(`summary model ${opts.model} refused, using ${opts.fallback.id}`);
    return run({ ...opts, model: opts.fallback.id, thinking: opts.fallback.thinking, fallback: null });
  }
}

// /api/chat (S10) is Ask as a chat, drafts included: the same 'ask' job. /api/ask stays for
// apps from before it.
const JOB_OF = { '/api/process': 'process', '/api/ask': 'ask', '/api/chat': 'ask', '/api/transcribe': 'transcribe' };

async function aiRoute(req, env, deps, url) {
  const payer = await aiPayer(req, env, deps, JOB_OF[url.pathname]);
  const meter = { tokens: 0 };
  const opts = aiOptions(payer, env, meteredFetch(deps.fetch, meter));
  try {
    if (url.pathname !== '/api/transcribe') {
      const body = await req.json();
      const wanted = typeof body.model === 'string' ? body.model : null;
      const text = await textOptions(payer, env, meteredFetch(deps.fetch, meter), wanted);
      if (url.pathname === '/api/process') {
        const { segments, template, today, vocabulary } = body;
        return json(req, env, await withFallback((o) => processNotes({ segments, template, today, vocabulary: Array.isArray(vocabulary) ? vocabulary.slice(0, 60) : [] }, o), text));
      }
      if (url.pathname === '/api/ask') {
        const { question, today, recordings } = body;
        return json(req, env, await withFallback((o) => askNotes({ question, today, recordings }, o), text));
      }
      const { messages, today, recordings, focus } = body;
      return json(req, env, await withFallback((o) => chatNotes({ messages, today, recordings, focus }, o), text));
    }
    // /api/transcribe: the audio and its options as a form (readTranscribeRequest).
    const declared = Number(req.headers.get('Content-Length') ?? 0);
    if (declared > MAX_REQUEST_BYTES) throw fail(413, TOO_LARGE);
    return json(req, env, await transcribeAudio(await readTranscribeRequest(req), { ...opts }));
  } finally {
    // Paid for even when the answer failed to parse: Gemini still counted it.
    // Their own key: the AI company bills them; nothing counted here.
    if (meter.tokens && payer.plan !== 'own') await addUsage(env, payer.holder, meter.tokens, meter.seconds);
  }
}

// Send now, collect later (jobs.mjs). POST /api/transcribe/jobs takes the same form as
// /api/transcribe and answers at once with a job id; GET /api/transcribe/jobs/<id> answers
// { state } until it's { state: 'done', result } or { state: 'failed', error }.
const JOB_PATH = /^\/api\/transcribe\/jobs\/([0-9a-f-]{36})$/;
const jobStub = (env, id) => env.TRANSCRIBE_JOBS.get(env.TRANSCRIBE_JOBS.idFromName(id));

async function startJob(req, env, deps) {
  const payer = await aiPayer(req, env, deps, 'transcribe');
  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > MAX_REQUEST_BYTES) throw fail(413, TOO_LARGE);
  const { keep, ...request } = await readTranscribeRequest(req);
  // S45: how long the result may wait here. Only the fixed list; nothing is stored for anything else.
  const keepMs = keepFor(keep);
  if (keepMs === null) throw fail(400, 'Unknown choice for how long Mullo\'s server keeps the result');
  checkAudio(request);
  // Said now, not after a queue: OpenAI's own limits.
  if (payer.provider === 'openai') {
    if (request.audio.length > OPENAI_MAX_AUDIO_BYTES) throw fail(413, OPENAI_TOO_LARGE);
    if (request.target && languageName(request.target) !== languageName(request.language)) throw fail(400, OPENAI_NO_TRANSLATION);
  }
  const job = crypto.randomUUID();
  const { audio, ...options } = request;
  const form = new FormData();
  // Their own key rides along SEALED; the job opens it when it runs and drops it when done.
  form.append('job', JSON.stringify({ owner: payer.holder, model: env.GEMINI_MODEL || DEFAULT_MODEL, options, keepMs, ...(payer.sealed ? { ownKey: payer.sealed } : {}) }));
  form.append('audio', new Blob([audio]), 'audio');
  const started = await jobStub(env, job).fetch(new Request('https://job/start', { method: 'POST', body: form }));
  if (started.status !== 202) throw fail(502, 'Could not start the transcription - try again');
  return json(req, env, { job, poll_ms: 3000 }, 202);
}

// A lapsed subscription can still collect what it already paid for: only the key
// (or the sign-in) must be real. Sent with the key, collected with the sign-in: same owner.
async function jobStatus(req, env, id, deps) {
  const holder = await jobHolder(req, env, deps);
  const res = await jobStub(env, id).fetch(new Request(`https://job/status?owner=${encodeURIComponent(holder)}`));
  if (res.status === 404) throw fail(404, 'This transcription isn\'t here any more (results are kept a day at most) - send it again.');
  return json(req, env, await res.json());
}

// Who may read (or release) a job: whoever's allowance paid for it.
async function jobHolder(req, env, deps) {
  // A Claude key's transcription ran on the sign-in's plan: collected with the sign-in.
  const own = await ownPayerFor(req, env, 'transcribe');
  if (own) await checkOwner(env, own, await keyHolder(req, env, deps, 'own'));
  const { payer, problem } = own ? { payer: own } : await caller(req, env, deps);
  if (problem) throw fail(...problem);
  return payer.holder;
}

// S45 "got it": DELETE on the same job path, the same sign-in and owner check as reading it.
// The phone has saved the result, so the server forgets it now. Only ever shortens the wait.
async function releaseJob(req, env, id, deps) {
  const holder = await jobHolder(req, env, deps);
  const res = await jobStub(env, id).fetch(new Request(`https://job/release?owner=${encodeURIComponent(holder)}`, { method: 'POST' }));
  if (res.status === 404) throw fail(404, 'This transcription isn\'t here any more.');
  if (res.status === 409) throw fail(409, 'This transcription is still being written.');
  return new Response(null, { status: 204 });
}

// The plan behind the key or the sign-in, and what's been used. Always 200 for a
// real caller (a sign-in with no AI says plan 'none'), so the app can show it.
async function meRoute(req, env, deps) {
  const { payer, user, problem } = await caller(req, env, deps);
  if (problem) throw fail(...problem);
  const admin = isAdmin(env, user?.userId) || undefined;
  // Which Privacy Policy and Terms version is current, and which one this sign-in accepted
  // (a Pro key alone is nobody: no legal).
  const legal = user ? await legalState(env, user.userId) : undefined;
  if (payer.plan !== 'pro') return json(req, env, { ...(await planReport(env, payer)), month: monthOf(), admin, legal });
  return json(req, env, {
    plan: 'pro', status: payer.account.status, active: !(await payerProblem(env, payer)), periodEnd: payer.account.period_end,
    store: payer.account.customer_id === 'apple' ? 'apple' : 'stripe',
    month: monthOf(), ...(await monthlyReport(env, payer.holder)), admin, legal,
  });
}

// "I've read the Privacy Policy and agree to the Terms": at sign-in (both ticked), or on the
// app's "We updated" card. The person themselves, never a key or a connected app.
// Body { version? }: the version the app showed; a stale one is refused (409), so it asks again.
async function legalAcceptRoute(req, env, deps) {
  const user = await appUser(req, env, deps);
  const { version } = await req.json().catch(() => ({}));
  if (!(await acceptLegal(env, user.userId, typeof version === 'string' ? version : null))) {
    throw fail(409, 'The Privacy Policy and Terms changed again. Read the new version and accept it.');
  }
  return json(req, env, { legal: await legalState(env, user.userId) });
}

// ── Summary models (S54) ─────────────────────────────────────────────────
// The person's list (what their plan allows) and their pick. A Mullo sign-in, never a key.
async function modelsRoute(req, env, deps) {
  const user = await appUser(req, env, deps);
  const { payer } = await caller(req, env, deps);
  const list = await readModels(env);
  if (req.method === 'POST') {
    const { pick } = await req.json().catch(() => ({}));
    await savePick(env, user.userId, String(pick ?? ''), list);
  }
  return json(req, env, modelsReport(list, tiersFor(payer), await pickOf(env, user.userId)));
}

// Admin "Test": a two-line note through the model, so a model is proven before people get it.
const TEST_NOTE = [
  { speaker: 'Speaker 1', text: 'Remind me to buy milk tomorrow morning.', start_ms: 0, end_ms: 3000 },
  { speaker: 'Speaker 1', text: 'And email Dana the new price list.', start_ms: 3000, end_ms: 6000 },
];
// The chosen thinking setting first; if it fails, the others in turn, stopping at the first that
// works, so the admin sees which one this model takes (3.5 Flash-Lite refused budget 0).
async function testModel(env, deps, { id, thinking }) {
  const [m] = cleanModels([{ id, thinking, tier: 'standard', isDefault: true }]);
  const tried = [];
  for (const t of [m.thinking, ...THINKING.filter((x) => x !== m.thinking)]) {
    const started = Date.now();
    try {
      const out = await processNotes({ segments: TEST_NOTE, template: 'general', today: new Date().toISOString().slice(0, 10), vocabulary: [] },
        { provider: 'gemini', apiKey: env.GEMINI_API_KEY, model: m.id, thinking: t, fetch: deps.fetch });
      tried.push({ thinking: t, ok: true, ms: Date.now() - started, title: out.title ?? '', actions: out.actions?.length ?? 0 });
      return { ...tried.at(-1), tried };
    } catch (err) {
      tried.push({ thinking: t, ok: false, error: String(err?.message ?? err) });
    }
  }
  return { ok: false, error: tried[0].error, tried };
}

// ── Admin (accounts in ADMIN_USER_IDS, signed in; never a key) ─────────
async function adminUser(req, env, deps) {
  const user = await appUser(req, env, deps);
  if (!isAdmin(env, user.userId)) throw fail(403, 'Admins only.');
  return user;
}

const adminContext = (env) => contextOf(env, { usable, legalCurrent: LEGAL_UPDATED });

async function adminRoute(req, env, deps, path) {
  const admin = await adminUser(req, env, deps);
  if (path === '/api/admin/settings' && req.method === 'GET') return json(req, env, await readSettings(env));
  if (path === '/api/admin/models' && req.method === 'GET') return json(req, env, { models: await readModels(env) });
  // Reports (S59, admin-reports.mjs): the dashboard's windows, and the report each one opens.
  if (path === '/api/admin/dashboard' && req.method === 'GET') return json(req, env, dashboardOf(await collect(env), adminContext(env)));
  const stats = path.match(/^\/api\/admin\/stats\/([a-z]+)$/);
  if (stats && req.method === 'GET') {
    const report = reportOf(stats[1], await collect(env), adminContext(env));
    if (!report) throw fail(404, 'No such report.');
    return json(req, env, report);
  }
  // Problem reports (S56, reports.mjs).
  if (path === '/api/admin/reports' && req.method === 'GET') {
    return json(req, env, await listReports(env, new URL(req.url).searchParams.get('status') ?? 'open'));
  }
  const shot = path.match(/^\/api\/admin\/reports\/([^/]+)\/screenshot$/);
  if (shot && req.method === 'GET') return json(req, env, await reportScreenshot(env, shot[1]));
  const body = await req.json().catch(() => ({}));
  const report = path.match(/^\/api\/admin\/reports\/([^/]+)$/);
  if (report && req.method === 'POST') return json(req, env, await setReportStatus(env, admin.userId, report[1], body.status));
  if (path === '/api/admin/settings') return json(req, env, await writeSettings(env, admin.userId, body));
  if (path === '/api/admin/grant') return json(req, env, await grantByEmail(env, admin.userId, body.email, body.plan));
  if (path === '/api/admin/models') {
    const models = await saveModels(env, body.models);
    await env.DB.prepare('insert into admin_log (at, admin_id, action, detail) values (?, ?, ?, ?)')
      .bind(nowSec(), admin.userId, 'models', models.map((m) => `${m.id}=${m.tier}${m.isDefault ? '*' : ''}`).join(',')).run();
    return json(req, env, { models });
  }
  if (path === '/api/admin/models/test') return json(req, env, await testModel(env, deps, body));
  throw fail(404, 'not found');
}

// ── Stripe routes ───────────────────────────────────────────────────────
// Until Stripe is set up the landing says "Coming soon" and /checkout refuses.
export const stripeReady = (env) => Boolean(env.STRIPE_SECRET_KEY && /^price_/.test(env.STRIPE_PRICE_ID ?? ''));
// STRIPE_TAX "on": Stripe Tax adds the sales tax at checkout (GST/HST, LizAI Studios is
// registered; the price is before tax) and keeps adding it to each renewal.
const taxAtCheckout = (env) => (env.STRIPE_TAX === 'on' ? { automatic_tax: { enabled: 'true' } } : {});
// Currency: US visitors pay US$, everyone else CA$ (the price's own currency), like the App Store
// countries. Adaptive Pricing is off: it picked the money by where the card holder was browsing, so a
// Canadian Apple ID in Israel saw shekels. Stripe needs the price to have a `usd` currency option.
const visitorCountry = (req) => req.cf?.country ?? req.headers.get('CF-IPCountry') ?? '';
const checkoutCurrency = (req) => ({
  currency: visitorCountry(req) === 'US' ? 'usd' : 'cad',
  adaptive_pricing: { enabled: 'false' },
});

async function checkout(req, env, deps, url) {
  if (!stripeReady(env)) return html(messagePage('Coming soon', 'Mullo Pro subscriptions open soon.'), 503);
  const session = await stripe(env, deps.fetch, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${url.origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/`,
    allow_promotion_codes: 'true',
    ...checkoutCurrency(req),
    ...taxAtCheckout(env),
  });
  return Response.redirect(session.url, 303);
}

// Shows a NEW key every time it opens (the old one stops working): we keep only
// hashes, so a key can't be shown twice. The session id in the link is the proof.
async function welcome(env, deps, url) {
  const id = url.searchParams.get('session_id') ?? '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return html(messagePage('Link not valid', 'Open the link Stripe sent you back to after paying.'), 400);
  const session = await stripe(env, deps.fetch, 'GET', `/checkout/sessions/${id}?expand[]=subscription`);
  if (session.mode !== 'subscription' || session.status !== 'complete' || !session.subscription?.id) {
    return html(messagePage('Payment not finished', 'This checkout is not complete. If you paid, wait a minute and open the link again.'), 402);
  }
  if (!mulloSubscription(env, session.subscription)) return html(messagePage('Link not valid', 'This payment isn\'t for Mullo Pro.'), 400);
  const email = session.customer_details?.email ?? null;
  await upsertSubscription(env, session.subscription, { email });
  const key = newKey();
  await env.DB.prepare('update accounts set key_hash = ?, key_issued_at = ? where subscription_id = ?')
    .bind(await hashKey(key), nowSec(), session.subscription.id).run();
  const linked = await linkBuyer(env, session.client_reference_id, session.subscription.id);
  return html(welcomePage({ key, email, linked }));
}

// ── Billing from inside the app (signed in, or a key) ──────────────────
// Get Mullo Pro: a Stripe Checkout tied to the signed-in account. → { url }
async function billingCheckout(req, env, deps, url) {
  const { payer, user, problem } = await caller(req, env, deps);
  if (problem) throw fail(...problem);
  if (!user) throw fail(401, 'Sign in to Mullo first, so the subscription lands on your account.');
  if (payer.plan === 'pro' && !usable(payer.account)) throw fail(409, 'You already have Mullo Pro.');
  if (!stripeReady(env)) throw fail(503, 'Mullo Pro subscriptions open soon.');
  const session = await stripe(env, deps.fetch, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    client_reference_id: user.userId,
    customer_email: user.email || undefined,
    success_url: `${url.origin}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/`,
    allow_promotion_codes: 'true',
    ...checkoutCurrency(req),
    ...taxAtCheckout(env),
  });
  return json(req, env, { url: session.url });
}

// Manage payments or cancel: Stripe's billing portal for this account's subscription. → { url }
async function billingPortal(req, env, deps, url) {
  const { payer, problem } = await caller(req, env, deps);
  if (problem) throw fail(...problem);
  if (payer.plan !== 'pro') throw fail(404, 'There is no paid subscription on this account.');
  if (payer.account.customer_id === 'apple') {
    throw fail(409, 'Mullo Pro was bought through the App Store. Manage it in your iPhone\'s Settings: your name, Subscriptions.', 'apple');
  }
  if (!env.STRIPE_SECRET_KEY) throw fail(503, 'Payments aren\'t set up yet.');
  const portal = await stripe(env, deps.fetch, 'POST', '/billing_portal/sessions', {
    customer: payer.account.customer_id, return_url: `${url.origin}/`,
    configuration: env.STRIPE_PORTAL_CONFIG || undefined,
  });
  return json(req, env, { url: portal.url });
}

// Delete account (Settings, Account; the person themselves, never a key or a connected app).
// Mullo's server lets go first; then the app removes the audio and the account itself
// (sql/005 delete_my_account). A linked Pro subscription is cancelled at once, no refund
// (owner, 2026-10-10). Kept on purpose: the trial fingerprint (trial_claims, an email hash, so
// deleting and signing up again isn't a second trial) and the bare Stripe record, without its
// email or key. Running it twice is harmless.
const ENDED = new Set(['canceled', 'incomplete_expired']);
async function appleClaimRoute(req, env, deps) {
  const user = await appUser(req, env, deps);
  await ready(env);
  const body = await req.json().catch(() => ({}));
  return json(req, env, await claimApple(env, deps.fetch, user.userId, body?.transaction_id, (userId, subId) => linkBuyer(env, userId, subId)));
}

// Apple calls this for renewals, expiry, refunds (App Store Server Notifications V2). Always 200
// for something it can't use, so Apple doesn't retry it for days.
async function appleNotificationRoute(req, env, deps) {
  await ready(env);
  const body = await req.json().catch(() => null);
  try {
    return json(req, env, await appleNotification(env, deps.fetch, body, (userId, subId) => linkBuyer(env, userId, subId)));
  } catch (err) {
    if (err.status >= 500) throw err; // Apple's API was down: let Apple send it again
    return json(req, env, { ignored: true, reason: err.message });
  }
}

async function deleteAccountRoute(req, env, deps) {
  const user = await appUser(req, env, deps);
  await ready(env);
  // Signed in with Apple on the iPhone: its fresh code, so Apple's link to Mullo is revoked too (apple.mjs).
  const body = await req.json().catch(() => ({}));
  const apple = typeof body?.apple_code === 'string' && body.apple_code ? await revokeApple(env, deps.fetch, body.apple_code) : null;
  if (apple) console.log(`account delete: Apple ${apple}`); // the outcome only, nothing personal
  const linked = await env.DB.prepare(`select a.subscription_id, a.status from account_users u join accounts a on a.subscription_id = u.subscription_id
    where u.user_id = ?`).bind(user.userId).first();
  let cancelled = false;
  if (linked) {
    // An App Store subscription can only be cancelled by the person, in their Apple ID settings
    // (the app's delete screen says so).
    if (!ENDED.has(linked.status) && !linked.subscription_id.startsWith('apple:')) {
      await upsertSubscription(env, await stripe(env, deps.fetch, 'DELETE', `/subscriptions/${encodeURIComponent(linked.subscription_id)}`));
      cancelled = true;
    }
    await env.DB.prepare('update accounts set email = null, key_hash = null where subscription_id = ?').bind(linked.subscription_id).run();
    // Apple keeps billing until the person cancels: a new account of theirs may restore it.
    if (linked.subscription_id.startsWith('apple:') && !ENDED.has(linked.status)) {
      await env.DB.prepare('insert into released_subscriptions (subscription_id, released_at) values (?, ?) on conflict(subscription_id) do nothing')
        .bind(linked.subscription_id, nowSec()).run();
    }
  }
  const holder = `user:${user.userId}`;
  await forgetGoogle(env, deps.fetch, user.userId);
  for (const [sql, value] of [
    ['delete from account_users where user_id = ?', user.userId],
    ['delete from plans where user_id = ?', user.userId],
    ['delete from api_keys where user_id = ?', user.userId],
    ['delete from usage where subscription_id = ?', holder],
    ['delete from rate where subscription_id = ?', holder],
    ['delete from legal_acceptances where user_id = ?', user.userId],
    ['delete from own_key_claims where user_id = ?', user.userId],
    ['delete from model_picks where user_id = ?', user.userId],
    ['delete from reports where user_id = ?', user.userId],
  ]) await env.DB.prepare(sql).bind(value).run();
  return json(req, env, { deleted: true, cancelled, ...(apple ? { apple } : {}) });
}

// Events can arrive late, twice, or out of order. So an event is only a nudge:
// the subscription's CURRENT state is read back from Stripe and stored.
// The Stripe account is LizAI Studios', shared with its other apps (the budget app): only a
// Mullo Pro subscription counts. By price, or by product once STRIPE_PRODUCT_ID is set (so a
// later price change still counts).
export const mulloSubscription = (env, sub) => (sub?.items?.data ?? []).some((item) =>
  item.price?.id === env.STRIPE_PRICE_ID || (env.STRIPE_PRODUCT_ID && item.price?.product === env.STRIPE_PRODUCT_ID));

async function webhook(req, env, deps) {
  const raw = await req.text();
  const event = await verifyWebhook(raw, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(event.type)) {
    const sub = await stripe(env, deps.fetch, 'GET', `/subscriptions/${encodeURIComponent(event.data.object.id)}`);
    if (mulloSubscription(env, sub)) await upsertSubscription(env, sub);
  }
  // Bought from inside Mullo: on the buyer's account even if they never open the welcome page.
  const done = event.data?.object;
  if (event.type === 'checkout.session.completed' && done?.mode === 'subscription' && typeof done.subscription === 'string') {
    const sub = await stripe(env, deps.fetch, 'GET', `/subscriptions/${encodeURIComponent(done.subscription)}`);
    if (mulloSubscription(env, sub)) {
      await upsertSubscription(env, sub, { email: done.customer_details?.email ?? null });
      await linkBuyer(env, done.client_reference_id, sub.id);
    }
  }
  await env.DB.prepare('insert into stripe_events (id, received_at) values (?, ?) on conflict(id) do nothing')
    .bind(event.id, nowSec()).run();
  return new Response('ok', { status: 200 });
}

async function manage(req, env, deps, url) {
  if (req.method === 'GET') return html(managePage());
  const form = await req.formData();
  const account = await accountForKey(env, String(form.get('key') ?? '').trim());
  if (!account) return html(managePage({ error: 'That key is not valid. Use the newest key you were given.' }), 401);
  const portal = await stripe(env, deps.fetch, 'POST', '/billing_portal/sessions', {
    customer: account.customer_id, return_url: `${url.origin}/`,
    configuration: env.STRIPE_PORTAL_CONFIG || undefined, // set up by worker/setup-stripe.ps1; else the dashboard default
  });
  return Response.redirect(portal.url, 303);
}

// ── Bring your own AI key (ownkey.mjs) ──────────────────────────────────
// Checks the key with Google and seals it; the sealed text goes back to the phone. Needs a
// Mullo sign-in once SIGNIN_GATE is on (S25; a family on its own Supabase signs in to Mullo for
// the AI too). Limited per address either way: it must not become a way to test stolen keys.
const SEALS_PER_MINUTE = 5;
async function ownKeyRoute(req, env, deps) {
  const user = await keyHolder(req, env, deps, 'seal');
  const from = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await underRate(env, `seal:${(await hashKey(from)).slice(0, 16)}`, SEALS_PER_MINUTE))) {
    throw fail(429, 'Too many tries, wait a minute.');
  }
  const body = await req.json().catch(() => ({}));
  return json(req, env, await sealRoute(body, env, deps.fetch, user?.userId ?? null));
}

// ── Mullo as an MCP server (mcp.mjs) ────────────────────────────────────
// Any origin may call it (a browser-based MCP client too): it uses a bearer token, never cookies.
const MCP_PER_MINUTE = 60;
const OPEN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
const openJson = (body, status = 200, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store', ...SECURITY, ...OPEN_CORS, ...extra },
});

// No token, or one that ran out: point the client at where to sign in (RFC 9728).
const signInFirst = (url) => openJson({ error: 'invalid_token', error_description: 'Sign in to Mullo to connect.' }, 401, {
  'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
});

// Who may read notes (/mcp, /v1): a Supabase token from our project (a connected app's,
// or the app's own), or a personal API key (apikeys.mjs). → { token, userId } or null.
async function reader(req, env, deps) {
  const presented = bearer(req);
  if (presented.startsWith(KEY_PREFIX)) {
    const held = await tokenForKey(env, deps.fetch, presented);
    return held ? { token: held.token, userId: held.userId } : null;
  }
  const user = looksLikeToken(presented) && !presented.startsWith('echo_') ? await verifySignIn(presented, env, deps.fetch) : null;
  return user ? { token: presented, userId: user.userId } : null;
}

async function mcpRoute(req, env, deps, url) {
  if (req.method !== 'POST') return openJson(null, 405, { Allow: 'POST' });
  const who = await reader(req, env, deps);
  if (!who) return signInFirst(url);
  if (!(await underRate(env, `read:${who.userId}`, MCP_PER_MINUTE))) {
    return openJson({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many requests, try again in a minute.' } }, 429);
  }
  let body;
  try { body = await req.json(); } catch { return openJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const notes = notesFor(env, who.token, deps.fetch);
  const messages = Array.isArray(body) ? body : [body];
  let replies;
  try {
    replies = (await Promise.all(messages.map((m) => rpc(m, { notes, version: env.MULLO_VERSION ?? '1' })))).filter(Boolean);
  } catch (err) {
    if (err.status === 401) return signInFirst(url);
    throw err;
  }
  if (!replies.length) return openJson(null, 202);
  return openJson(Array.isArray(body) ? replies : replies[0]);
}

// GET /v1/...: the same reads as plain JSON (mcp.mjs restCall), for scripts and automations.
async function restRoute(req, env, deps, url) {
  if (req.method !== 'GET') return openJson({ error: 'Read-only: GET only.' }, 405, { Allow: 'GET' });
  const who = await reader(req, env, deps);
  if (!who) return openJson({ error: 'A Mullo API key is needed: Authorization: Bearer mullo_...' }, 401);
  if (!(await underRate(env, `read:${who.userId}`, MCP_PER_MINUTE))) return openJson({ error: 'Too many requests, try again in a minute.' }, 429);
  return openJson(await restCall(url.pathname, url.searchParams, notesFor(env, who.token, deps.fetch)));
}

// API keys, managed from the app (the person's own sign-in only).
async function keysRoute(req, env, deps, url, path) {
  const user = await appUser(req, env, deps);
  if (path === '/api/keys' && req.method === 'GET') return json(req, env, { keys: await listKeys(env, user) });
  const body = await req.json().catch(() => ({}));
  if (path === '/api/keys/start') return json(req, env, await startKey(env, deps.fetch, user, { name: body.name, origin: url.origin }));
  if (path === '/api/keys/finish') return json(req, env, await finishKey(env, deps.fetch, user, { redirectUrl: body.redirectUrl, origin: url.origin }));
  if (path === '/api/keys/revoke') return json(req, env, await revokeKey(env, deps.fetch, user, body.id));
  throw fail(404, 'not found');
}

// Google Calendar and Tasks (google.mjs). The callback is the person's browser coming back
// from Google's consent page: no Mullo sign-in there, the single-use state names the account.
async function googleRoute(req, env, deps, url, path) {
  if (req.method === 'GET' && path === '/api/google/callback') {
    const out = await finishGoogle(env, deps.fetch, {
      state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error'), origin: url.origin,
    });
    if (out.back === 'web') return Response.redirect(`${url.origin}/app/#/settings/google`, 302);
    return html(messagePage(out.title, out.text, { toApp: true }));
  }
  const user = await appUser(req, env, deps);
  if (req.method === 'GET' && path === '/api/google') return json(req, env, await googleStatus(env, user));
  if (req.method !== 'POST') throw fail(404, 'not found');
  const body = await req.json().catch(() => ({}));
  if (path === '/api/google/start') return json(req, env, await startGoogle(env, user, { back: body.back, origin: url.origin }));
  if (path === '/api/google/disconnect') return json(req, env, await forgetGoogle(env, deps.fetch, user.userId));
  if (path === '/api/google/push') return json(req, env, await pushGoogle(env, deps.fetch, user, body));
  throw fail(404, 'not found');
}

// Supabase is the authorization server. Older MCP clients look for its metadata on our own
// origin, so it's passed through from Supabase (cached for an hour).
async function authServerMetadata(env, deps) {
  const base = String(env.SUPABASE_URL).replace(/\/+$/, '');
  const doFetch = deps.fetch; // called unbound: Workers refuse fetch with `this` set to another object
  const res = await doFetch(`${base}/.well-known/oauth-authorization-server/auth/v1`);
  if (!res.ok) throw fail(502, 'The sign-in server didn\'t answer.');
  return openJson(await res.json(), 200, { 'Cache-Control': 'public, max-age=3600' });
}

const CONSENT_CSP = (env) => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; `
  + `connect-src ${String(env.SUPABASE_URL).replace(/\/+$/, '')}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; `
  // Its script builds the page with DOM calls only: no HTML or script string is ever allowed.
  + "require-trusted-types-for 'script'; trusted-types 'none'";

function consentRoute(env) {
  if (!env.SUPABASE_PUBLISHABLE_KEY) return html(messagePage('Not set up', 'Connecting apps isn\'t switched on here yet.'), 503);
  return new Response(consentPage({ supabaseUrl: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CONSENT_CSP(env), 'Cache-Control': 'no-store', ...SECURITY },
  });
}

// ── Router ──────────────────────────────────────────────────────────────
// Every response the Worker sends gets the baseline security headers here, so no
// route can forget them (the web app's static files get theirs from _headers).
// A route's own value wins (e.g. a page's CSP, the open CORS of /mcp).
const BASELINE = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none',
};
const PAGE_BASELINE = {
  'Content-Security-Policy': PAGE_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=()',
};
export function harden(res) {
  const headers = new Headers(res.headers);
  const page = /^text\/html/.test(headers.get('Content-Type') ?? '');
  for (const [k, v] of Object.entries({ ...BASELINE, ...(page ? PAGE_BASELINE : {}) })) if (!headers.has(k)) headers.set(k, v);
  // Pages: no-transform stops Cloudflare injecting its analytics script (which the CSP
  // would block anyway). Only HTML: no-transform also turns off compression.
  if (page && !/no-transform/.test(headers.get('Cache-Control') ?? '')) {
    headers.set('Cache-Control', [headers.get('Cache-Control'), 'no-transform'].filter(Boolean).join(', '));
  }
  // Readable only by this site unless the route opened it to others with CORS.
  if (!headers.has('Access-Control-Allow-Origin') && !headers.has('Cross-Origin-Resource-Policy')) headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ── One cap per address (owner, 2026-10-11) ─────────────────────────────
// Checked first, so a flood from one address stops before D1, Supabase or a sign-in
// check. Workers' rate limiting binding (PER_IP in wrangler.toml): counted in memory per
// Cloudflare location, no D1 write. IPv6 counts per /64, the block one home or phone gets
// (an attacker can change addresses inside it at will). The web app's static files never
// reach this code ([assets] answers them first). Not counted here: connected apps and
// Stripe (/mcp, /v1, sign-in discovery, the webhook), which arrive from their company's
// shared addresses; the AI apps have their own per-person limit after sign-in.
const SHARED_SENDERS = /^\/(?:mcp$|v1\/|\.well-known\/|oauth\/|stripe\/webhook$|apple\/notifications$)/;
export const TOO_MANY = 'Too many requests from this address. Try again in a minute.';

// The address to count: an IPv4 as is, an IPv6 as its /64. → string or null.
export function addressKey(ip) {
  if (!ip) return null;
  if (!ip.includes(':')) return ip;
  const [head, tail = null] = ip.toLowerCase().split('::');
  const front = head ? head.split(':') : [];
  const back = tail === null ? [] : tail ? tail.split(':') : [];
  const groups = tail === null ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

async function overLimit(req, env, path) {
  if (!env.PER_IP || SHARED_SENDERS.test(path)) return false;
  const key = addressKey(req.headers.get('CF-Connecting-IP'));
  if (!key) return false;
  try {
    return !(await env.PER_IP.limit({ key })).success;
  } catch (err) {
    console.error(`rate limiter: ${err.message}`); // a limiter fault never locks people out
    return false;
  }
}

// mullo.app shows the website (home, Privacy, Terms, Docs: what Google's consent screen links
// to, owner 2026-10-14); the app and everything apps connect to stay on ONE address, so the app,
// sign-ins, API keys and connectors never get a second origin. On mullo.app those paths move.
export const APP_HOST = 'mullo.lizai.io';
const SITE_HOSTS = new Set(['mullo.app', 'www.mullo.app']);
const APP_ONLY = /^\/(?:app|api|mcp|oauth|v1|\.well-known|setup|manage|checkout|stripe|go)(?:\/|$)/;
export function siteRedirect(url) {
  if (!SITE_HOSTS.has(url.hostname)) return null;
  if (url.hostname === 'www.mullo.app') return Response.redirect(`https://mullo.app${url.pathname}${url.search}`, 301);
  if (APP_ONLY.test(url.pathname)) return Response.redirect(`https://${APP_HOST}${url.pathname}${url.search}`, 301);
  return null;
}

const appPath = (path) => path === '/app' || path.startsWith('/app/');

export async function handle(req, env, deps = { fetch: globalThis.fetch }) {
  const url = new URL(req.url);
  const toApp = siteRedirect(url);
  if (toApp) return toApp;
  // The web app's files: served as they always were (their own _headers, no limit, no harden).
  if (env.ASSETS && appPath(url.pathname)) return env.ASSETS.fetch(req);
  const res = harden(await route(req, env, deps));
  // The sign-in pages apps send people to (consent): an app may open them as a popup and
  // watch it; same-origin COOP would cut that link and look like the window was closed.
  if (new URL(req.url).pathname.startsWith('/oauth/')) res.headers.set('Cross-Origin-Opener-Policy', 'unsafe-none');
  // Every limit here counts per minute.
  if (res.status === 429 && !res.headers.has('Retry-After')) res.headers.set('Retry-After', '60');
  return res;
}

async function route(req, env, deps) {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (await overLimit(req, env, path)) throw fail(429, TOO_MANY);
    if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: {
        // DELETE: only a job's "got it" (S45, releaseJob).
        ...cors(req, env), 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': `Authorization, Content-Type, ${OWN_KEY_HEADER}`, 'Access-Control-Max-Age': '600',
      } });
    }
    // The web app at /app/ is this same site (roadmap S3b): its own origin is always allowed.
    const origin = req.headers.get('Origin');
    if (path.startsWith('/api/') && origin && origin !== url.origin && !cors(req, env)['Access-Control-Allow-Origin']) {
      throw fail(403, 'origin not allowed');
    }
    // MCP and its sign-in discovery (open to any origin: bearer tokens, no cookies).
    if (req.method === 'OPTIONS' && (path === '/mcp' || path.startsWith('/v1/') || path.startsWith('/.well-known/'))) {
      return openJson(null, 204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600' });
    }
    if (path === '/mcp') return await mcpRoute(req, env, deps, url);
    if (path.startsWith('/v1/')) return await restRoute(req, env, deps, url);
    // Where Supabase would send an API key's approval; the app takes it from the consent
    // answer instead, so a person landing here just goes back.
    if (req.method === 'GET' && path === '/api/keys/callback') return html(messagePage('Back to Mullo', 'Go back to the Mullo app to see your new key.', { toApp: true }));
    if (path === '/api/keys' || path.startsWith('/api/keys/')) return await keysRoute(req, env, deps, url, path);
    if (path === '/api/google' || path.startsWith('/api/google/')) return await googleRoute(req, env, deps, url, path);
    if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      return openJson(resourceMetadata(env, url.origin), 200, { 'Cache-Control': 'public, max-age=3600' });
    }
    if (req.method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) {
      return await authServerMetadata(env, deps);
    }
    if (req.method === 'GET' && path === '/oauth/consent') return consentRoute(env);
    if (req.method === 'GET' && path === '/oauth/consent.js') {
      return new Response(CONSENT_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...SECURITY } });
    }
    // The old how-to address (the app links to it) now goes to the docs.
    if (req.method === 'GET' && path === '/connect') return Response.redirect(`${url.origin}/docs/mcp`, 302);
    // "Open Claude" / "Open ChatGPT" in the app's Connect sheet: the app holds no outside
    // addresses, and when an AI company moves its settings page, only this changes.
    if (req.method === 'GET' && GO_TO[path]) return Response.redirect(GO_TO[path], 302);
    const docSlug = /^\/docs(?:\/([a-z0-9-]+))?\/?$/.exec(path);
    if (req.method === 'GET' && docSlug) {
      const page = docsPage(docSlug[1] ?? '', {
        origin: url.origin, minutes: `${monthlyMinutes(env).toLocaleString('en-US')} minutes`, open: env.CONNECTIONS_OPEN === 'yes',
      });
      if (page) return html(page);
    }
    // Your own server: the steps and the SQL (sql/, via scripts/setup-sql.mjs).
    if (req.method === 'GET' && path === '/setup') {
      return html(setupPage({ steps: SQL_STEPS, from: Math.max(0, Number.parseInt(url.searchParams.get('from') ?? '0', 10) || 0) }));
    }
    const sqlFile = /^\/setup\/(\d{3}_[\w-]+\.sql)$/.exec(path);
    if (req.method === 'GET' && sqlFile) {
      const step = SQL_STEPS.find((s) => s.name === sqlFile[1]);
      if (step) return new Response(step.sql, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${step.name}"`, ...SECURITY } });
    }

    if (req.method === 'GET' && path === '/api/health') return json(req, env, { ok: true });
    if (req.method === 'GET' && path === '/api/me') return await meRoute(req, env, deps);
    if ((req.method === 'GET' || req.method === 'POST') && path === '/api/models') return await modelsRoute(req, env, deps);
    if (req.method === 'POST' && path === '/api/link') return await linkRoute(req, env, deps);
    if (req.method === 'POST' && path === '/api/account/delete') return await deleteAccountRoute(req, env, deps);
    if (req.method === 'POST' && path === '/api/reports') {
      const user = await appUser(req, env, deps, 'Sign in to Mullo to send a report, or email us instead.');
      return json(req, env, await sendReport(env, user, await req.json().catch(() => ({}))));
    }
    if (req.method === 'POST' && path === '/api/legal/accept') return await legalAcceptRoute(req, env, deps);
    if (req.method === 'POST' && path === '/api/own-key') return await ownKeyRoute(req, env, deps);
    if (path.startsWith('/api/admin/') && (req.method === 'GET' || req.method === 'POST')) return await adminRoute(req, env, deps, path);
    if (req.method === 'POST' && path === '/api/billing/checkout') return await billingCheckout(req, env, deps, url);
    if (req.method === 'POST' && path === '/api/billing/portal') return await billingPortal(req, env, deps, url);
    // Mullo Pro bought in the iPhone app (S22c, appstore.mjs): a StoreKit transaction id, checked with Apple.
    if (req.method === 'POST' && path === '/api/billing/apple') return await appleClaimRoute(req, env, deps);
    if (req.method === 'POST' && Object.hasOwn(JOB_OF, path)) return await aiRoute(req, env, deps, url);
    if (req.method === 'POST' && path === '/api/transcribe/jobs') return await startJob(req, env, deps);
    if (req.method === 'GET' && JOB_PATH.test(path)) return await jobStatus(req, env, JOB_PATH.exec(path)[1], deps);
    if (req.method === 'DELETE' && JOB_PATH.test(path)) return await releaseJob(req, env, JOB_PATH.exec(path)[1], deps);

    if (req.method === 'GET' && path === '/') {
      // The trial card shows the size NEW accounts get, and hides while trials are off or paused.
      const { trialMinutes, trialsPaused } = await readSettings(env);
      return html(landingPage({
        priceLabel: env.PRICE_LABEL ?? '$9.99', minutesLabel: `${monthlyMinutes(env).toLocaleString('en-US')} minutes`,
        trialMinutes: trialsPaused ? 0 : trialMinutes, checkoutReady: stripeReady(env),
      }));
    }
    if (req.method === 'GET' && path === '/privacy') return html(privacyPage());
    if (req.method === 'GET' && path === '/terms') return html(termsPage());
    if (req.method === 'GET' && path === '/style.css') return new Response(CSS, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=3600', ...SECURITY } });
    // RFC 9116: where to report a security problem. Expires a year after each deploy's date.
    if (req.method === 'GET' && path === '/.well-known/security.txt') {
      const expires = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)).toISOString();
      return new Response(`Contact: mailto:hello@lizai.io\nExpires: ${expires}\nPreferred-Languages: en\nCanonical: ${url.origin}/.well-known/security.txt\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (req.method === 'POST' && path === '/checkout') return await checkout(req, env, deps, url);
    if (req.method === 'GET' && path === '/welcome') return await welcome(env, deps, url);
    if (req.method === 'POST' && path === '/stripe/webhook') return await webhook(req, env, deps);
    if (req.method === 'POST' && path === '/apple/notifications') return await appleNotificationRoute(req, env, deps);
    if (path === '/manage' && (req.method === 'GET' || req.method === 'POST')) return await manage(req, env, deps, url);

    if (path.startsWith('/api/')) throw fail(404, 'not found');
    return html(messagePage('Not found', 'There is nothing here.'), 404);
  } catch (err) {
    const status = err.status ?? 502;
    // Errors only, never bodies: they hold people's conversations.
    console.error(`${req.method} ${path} -> ${status}: ${err.message}`);
    if (path === '/mcp' || path.startsWith('/v1/') || path.startsWith('/.well-known/')) return openJson({ error: err.message }, status);
    if (path === '/api/google/callback') return html(messagePage('Google wasn\'t connected', err.message), status);
    if (path.startsWith('/api/') || path === '/stripe/webhook' || path === '/apple/notifications') return json(req, env, { error: err.message, ...(err.code ? { code: err.code } : {}) }, status);
    return html(messagePage('Something went wrong', err.message), status);
  }
}

export default { fetch: (req, env) => handle(req, env) };
