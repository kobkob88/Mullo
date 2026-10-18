// Boot and the shell: connect storage, install the audit log, wire events,
// route between screens, keep the pending badge and the version check alive.

import { loadConfig } from './config.js';
import { registerActions, installEvents } from './events.js';
import { installErrorLog, logError } from './core/error-log.js';
import { rememberScreen } from './domain/report.js';
import { connect } from './core/db.js';
import { installAudit, flushAudit, pendingAudit } from './core/audit.js';
import { setSession, accountSession, canReach, landingScreen } from './core/auth.js';
import { createAccount, useAccount, account, useMulloAccount, mulloAccount, mulloSessionStore, redirectPending } from './core/account.js';
import { startCloudSync, syncSoon, noteServer, whenSignedIn } from './core/cloud-sync.js';
import { on } from './core/bus.js';
import { outbox } from './core/sync.js';
import { pendingLevel } from './core/watchdog.js';
import { createVersionWatch, fetchPublishedVersion } from './core/version.js';
import { useRemoteEngine, useSpeechCheck, useAiGate, useAfterSummary } from './domain/pipeline.js';
import { autoDraft } from './domain/task-drafts.js';
import { knownPlan, rememberPlan } from './core/ai-plan.js';
import { legalPending, takeTicked, noteTicked } from './core/legal.js';
import { ownAi } from './core/own-ai.js';
import { withBrowserServer } from './core/own-server.js';
import { createRemoteEngine } from './domain/engines/remote.js';
import { useChat } from './domain/chat.js';
import { useGoogle, googleSoon, googleStatus } from './domain/google.js';
import { useStore, claimQuietly } from './domain/store.js';
import { resumePending, upgradeOfflineSummaries, activeJobs } from './domain/jobs.js';
import { expireAudio } from './domain/storage.js';
import { getRecording, findByExternal, listRecordings } from './domain/recordings.js';
import { saveCapturedAudio } from './domain/capture.js';
import { drainWatchInbox, fromPhone, watchBattery, watchNotesWorking } from './capture/watch-inbox.js';
import { checkSpeech } from './capture/silence.js';
import { timeOfDay } from './core/dates.js';
import { parseRoute, navTab, noteRoute, takeScrollRestore } from './ui/router.js';
import { setContext } from './ui/context.js';
import { toast, hideToastOnScroll, hideToastOnDrag, actions as toastActions } from './ui/toast.js';
import { measure, play, depth, calm, flyHome, land, flying } from './ui/motion.js';
import { legalUpdateCard, actions as legalActions } from './ui/legal-update.js';
import { aiConsentCard, actions as consentActions } from './ui/ai-consent.js';
import { aiConsented, askingNow } from './core/ai-consent.js';
import { actions as taskDraftActions } from './ui/task-draft.js';
import { saveDrafts, restoreDrafts } from './ui/drafts.js';
import { h } from './ui/dom.js';
import { emptyState } from './ui/components.js';
import { setMood } from './ui/mascot.js';
import { appMood, noteJobDone, noteOpened } from './ui/mood.js';
import * as library from './ui/panels/library.js';
import * as record from './ui/panels/record.js';
import * as recording from './ui/panels/recording.js';
import * as tasks from './ui/panels/tasks.js';
import * as search from './ui/panels/search.js';
import * as activity from './ui/panels/activity.js';
import * as settings from './ui/panels/settings.js';
import { applyTheme } from './ui/theme.js';
import { getSettings, transcriptTarget } from './core/settings.js';
import { pushAiPrefs, googleAnswer, recordingInProgress, keepScreenOnAgain } from './core/native.js';
import { engineTemplate } from './domain/formats.js';
import { syncReminders, applyReminderTaps } from './domain/reminders.js';

const PANELS = Object.fromEntries(
  [library, record, recording, tasks, search, activity, settings].map((p) => [p.screen, p]),
);

const view = () => document.getElementById('view');
let renderToken = 0;
let legalServer = null; // Mullo's server, when the Privacy Policy and Terms are its to ask (S23)
let stale = false;
let currentScreen = null;
let shownHash = null;
let renderQueued = false;
// A computer's wide window (desktop layout, 2026-10-17): Library shows a list and a reader.
// Crossing 1200px redraws, so a recording moves between its own page and the reader.
const wideQuery = globalThis.matchMedia?.('(min-width: 1200px)') ?? null;
const wideWindow = () => Boolean(wideQuery?.matches);
wideQuery?.addEventListener?.('change', () => refresh({ force: true }));

function textFieldFocused() {
  const el = document.activeElement;
  return Boolean(el && view()?.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(el.type))));
}

// A background job finishing must not restart audio someone is listening to.
function audioPlaying() {
  const player = view()?.querySelector('audio.player');
  return Boolean(player && !player.paused);
}

async function render() {
  const token = ++renderToken;
  stale = false;
  const wide = wideWindow();
  let { screen, params } = parseRoute(location.hash, { wide });
  if (!screen) { location.hash = '#/library'; return; }
  if (!canReach(screen)) {
    const landing = landingScreen();
    if (!landing) {
      view().replaceChildren(emptyState('No access', 'Your account has no screens assigned. Ask the owner.'));
      return;
    }
    screen = landing;
    params = {};
  }
  // Opening a recording takes its "ready" / "no speech" face off the mascot.
  if (screen === 'recording') noteOpened(params.id);
  if (screen === 'library' && params.open) {
    if (canReach('recording')) noteOpened(params.open);
    else params = {};
  }
  let node;
  try {
    node = await PANELS[screen].render({ ...params, wide });
  } catch (err) {
    console.error(err);
    node = emptyState('Something went wrong on this screen', String(err.message ?? err));
  }
  if (token !== renderToken) return; // a newer render won
  // The player survives a re-render (a tab switch, a sync, one that was already on its way
  // when Play was tapped): the element itself moves into the new screen, in the same task,
  // so it never pauses (owner, 2026-10-12: the player stopped right after Play). Paused too
  // (owner, 2026-10-14: while a new watch note came in, the redraws kept resetting a paused
  // player to 0:00 and reloading it).
  const shown = view().querySelector('audio.player');
  if (shown) {
    const fresh = node.querySelector?.('audio.player');
    if (fresh && fresh.src === shown.src) fresh.replaceWith(shown);
  }
  const shownScreen = currentScreen;
  currentScreen = screen;
  // Motion (ui/motion.js): a new screen slides in from the side going deeper, back the other
  // way going back, and fades between tabs. A redraw of the same screen moves only what moved.
  const newScreen = location.hash !== shownHash;
  if (newScreen && shownHash !== null && node instanceof Element && !calm()) {
    if (wide && screen === 'library' && shownScreen === 'library') {
      // Another recording (or Today) beside the same list: only the reader changes.
      node.querySelector('.lib-split__reader')?.classList.add('view-fade');
    } else {
      const [from, to] = [depth(shownHash), depth(location.hash)];
      // The record button flying in lands on a screen that only fades: a sliding screen would
      // move its landing spot from under it.
      node.classList.add(flying() ? 'view-fade' : to > from ? 'view-push' : to < from ? 'view-pop' : 'view-fade');
    }
  }
  shownHash = location.hash;
  const before = newScreen ? new Map() : measure(view());
  // S23: "We updated our Privacy Policy and Terms" above every screen until it's accepted.
  const user = legalServer && mulloAccount().user();
  const legal = user ? legalPending(knownPlan(user.id)) : null;
  // S22e: permission before anything goes to an AI company (App Store rule 5.1.2(i)).
  const consent = legal ? null : aiAsk?.();
  // Panes that scroll on their own (Library's list and reader on a computer) keep their place
  // across a redraw. A reader showing another recording has another key, so it starts at the top.
  const keptScroll = new Map([...view().querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollTop]));
  view().replaceChildren(...(legal ? [legalUpdateCard(legal, legalServer)] : consent ? [aiConsentCard(consent)] : []), node);
  for (const el of view().querySelectorAll('[data-keep-scroll]')) {
    const y = keptScroll.get(el.dataset.keepScroll);
    if (y) el.scrollTop = y;
  }
  play(view(), before);
  restoreDrafts(view());
  // A screen marks what just arrived (a chat answer) to bring it into view, once.
  view().querySelector('[data-scroll-here]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  for (const link of document.querySelectorAll('[data-nav]')) {
    const active = link.dataset.nav === navTab(screen);
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  // The floating Record button (tap it during a recording to get back to it). Hidden on
  // Record itself. Mullo, the mascot, lives on Record and on top of Search / Ask (owner,
  // 2026-10-10), not on the button.
  const fab = document.getElementById('record-fab');
  if (fab) {
    fab.hidden = screen === 'record';
    fab.classList.toggle('is-live', record.isBusy());
    fab.setAttribute('aria-label', record.isBusy() ? 'Back to the recording' : 'Record');
  }
  // Sign in beside the name for anyone signed out, so a first visit shows the way in
  // (owner, 2026-10-10). Not on the sign-in page itself, nor without a server to sign in to.
  const signIn = document.getElementById('head-signin');
  if (signIn) signIn.hidden = !account().on || Boolean(account().user()) || location.hash.startsWith('#/settings/account');
  updateMood();
  // Focus never scrolls the page; the scroll is decided just below.
  if (screen !== 'record') view().querySelector('[autofocus]')?.focus({ preventScroll: true });
  // Back to a list just left (Actions after opening a recording): where it was scrolled to.
  // Any other move to a different screen starts at the top; a re-render of the same one stays
  // put. (A recording opened from a scrolled Actions list kept that scroll and opened at its
  // bottom, owner 2026-10-09.)
  const moved = location.hash !== renderedHash;
  renderedHash = location.hash;
  const y = takeScrollRestore();
  if (y != null) window.scrollTo(0, y);
  else if (moved) window.scrollTo(0, 0);
  // Last, once the page is scrolled where it stays: the record button measures where it lands
  // (owner, 2026-10-15: opened from a scrolled Library it flew to the old scroll's spot).
  land(view());
}
let renderedHash = null;

// Mullo on top of Search / Ask, kept current without a re-render (which waits while someone
// types): jobs start and finish, the connection comes and goes, a recording runs.
async function updateMood() {
  const el = document.querySelector('.mullo-stage--ask .mullo');
  if (!el) return;
  const { mood } = appMood(await listRecordings(), { listening: record.isListening() });
  setMood(el, search.isThinking() ? 'mulling' : mood);
}

// Data changed somewhere. Don't yank the screen out from under someone who
// is typing or recording - mark it stale and catch up when they stop.
function refresh({ force = false } = {}) {
  if (!force && (textFieldFocused() || audioPlaying() || (currentScreen === 'record' && record.isBusy()))) {
    stale = true;
    return;
  }
  // One render for a burst of writes (the pipeline makes dozens).
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 16);
}

function updatePendingBadge() {
  const badge = document.getElementById('pending-badge');
  if (!badge) return;
  const items = [...pendingAudit().map((e) => e.at), ...outbox().map((e) => e.queuedAt)].sort();
  const level = pendingLevel(items[0]);
  badge.hidden = !items.length && navigator.onLine;
  badge.textContent = !navigator.onLine ? `Offline${items.length ? ` · ${items.length} waiting` : ''}` : `${items.length} unsent`;
  badge.className = `pending pending--${navigator.onLine ? level : 'warn'}`;
}

const toastError = (err) => toast(err?.message ?? String(err), { error: true });

// Watch recordings waiting in the Android app's inbox → the library, through
// the same save path as the Record button. On the iPhone the inbox also holds
// recordings Mullo was killed in the middle of (`from: 'phone'`).
let hadWatchWork = false;
let watchRecheck = null;
async function takeWatchRecordings() {
  const s = getSettings();
  const n = await drainWatchInbox({
    findExisting: (id, entry) => findByExternal(fromPhone(entry) ? 'device' : 'watch', id),
    fetchAudio: (id) => fetch(`watch-inbox/${encodeURIComponent(id)}`),
    save: async (entry, blob) => {
      const recordedAt = Number.isFinite(entry.started_at) ? new Date(entry.started_at).toISOString() : null;
      const phone = fromPhone(entry);
      const res = await saveCapturedAudio({
        blob, durationMs: entry.duration_ms ?? null, language: s.listen, template: s.template,
        title: `${phone ? 'Recovered' : 'Watch'} · ${timeOfDay(recordedAt ?? new Date().toISOString())}`,
        source: phone ? 'device' : 'watch', externalId: entry.id, recordedAt, prepared: entry.ai ?? null,
        watchBattery: phone ? null : watchBattery(entry),
      });
      // Made ready in the background: no job ran here, so say "Ready" (or "No
      // speech") the way a finished job does.
      if (res.prepared) noteJobDone({ recordingId: res.rec.id, ok: true, silent: entry.ai?.state === 'silent' });
      return res;
    },
  });
  // The mood card follows notes still being made ready; while there are any, look
  // again now and then (the native side's "done" signal reaches only an open Mullo).
  const working = watchNotesWorking().length;
  if (n || working || hadWatchWork) { refresh(); updateMood(); }
  hadWatchWork = working > 0;
  clearTimeout(watchRecheck);
  if (working) watchRecheck = setTimeout(() => takeWatchRecordings().catch(toastError), 20_000);
}

// The Android app makes watch notes ready while Mullo is closed, with the same
// settings: what you speak, the transcript language, Names & words, the
// summary format. Sent whenever they change (nothing secret in them).
function syncAiPrefs() {
  const s = getSettings();
  pushAiPrefs({
    listen: s.listen,
    target: transcriptTarget(s, s.listen),
    vocabulary: s.vocabulary,
    template: engineTemplate(s.template),
    template_id: s.template,
    keep: s.serverKeep, // S45: how long Mullo's server keeps the result
  });
}

// The CSP requires Trusted Types (_headers): the browser refuses every HTML or
// script string sink unless a policy vouches for it. The service worker's address
// is the only one this app ever sets, so the only policy allows exactly that.
const scriptUrls = globalThis.trustedTypes?.createPolicy('mullo', {
  createScriptURL: (url) => {
    if (url !== 'sw.js') throw new TypeError(`script URL not allowed: ${url}`);
    return url;
  },
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    const sw = scriptUrls ? scriptUrls.createScriptURL('sw.js') : 'sw.js';
    navigator.serviceWorker.register(sw).catch((err) => console.warn('service worker not registered', err));
  }
}

// `?code=` (or `?error=`) from Supabase after "Continue with Google / Apple" in a browser
// (account.redirectUrl). The address is cleaned first, so a reload never tries the code twice.
// S22e: who to ask for AI permission now (set in boot), or null.
let aiAsk = null;

async function finishSignInRedirect(accounts) {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error_description') || params.get('error');
  const pending = redirectPending();
  if (!pending || (!code && !error)) return;
  history.replaceState(null, '', location.pathname + (pending.back || location.hash));
  const acct = pending.which === 'mullo' ? accounts.mullo : accounts.notes;
  if (error) {
    acct.finishRedirect('').catch(() => {}); // only clears what was kept for the trip
    toast(/denied|cancel/i.test(error) ? 'Sign-in cancelled.' : `Sign-in didn't work: ${error}`, { error: true });
    return;
  }
  noteTicked(Boolean(pending.ticked));
  try {
    const user = await acct.finishRedirect(code);
    toast(pending.which === 'mullo' ? `Signed in to Mullo as ${user.email}` : `Signed in as ${user.email}`);
  } catch (err) {
    noteTicked(false);
    toast(err.message, { error: true });
  }
}

async function boot() {
  applyTheme(getSettings().appearance);
  // In a browser, the person's own server (Settings, Developers) over config.json.
  const config = withBrowserServer(await loadConfig());
  await connect(config);
  // Signed in or not, the notes on this device stay theirs; the account adds sync.
  const acct = createAccount({ url: config.supabaseUrl, key: config.supabaseAnonKey });
  useAccount(acct);
  setSession(accountSession(acct.user()));
  on('account', (user) => { setSession(accountSession(user)); refresh({ force: true }); if (user) whenSignedIn(); });
  installAudit();
  noteServer(config.supabaseUrl); // a different server since last time: start its copying afresh
  startCloudSync();
  on('cloud', () => { if (currentScreen === 'settings') refresh(); });
  await flushAudit(); // anything queued before the last reload goes out first

  // Mullo's server (aiPlan 'pro' = a key on this phone, 'account' = no key: the sign-in
  // and the account's plan). Anything through it needs a Mullo sign-in (S25): a Pro key or
  // their own AI key still pays, the sign-in says who. On their own server that's a second
  // sign-in, to Mullo's account, with its own event so it never starts syncing.
  const mullo = config.aiPlan === 'pro' || config.aiPlan === 'account';
  const ai = mullo && config.ownServer && config.mulloSupabaseUrl
    ? createAccount({ url: config.mulloSupabaseUrl, key: config.mulloSupabaseAnonKey, store: mulloSessionStore, event: 'mullo-account' })
    : acct;
  useMulloAccount(ai);
  const aiEvent = ai === acct ? 'account' : 'mullo-account';
  if (ai !== acct) on('mullo-account', () => refresh({ force: true }));
  // "This key is mine", once per account, when signed in with a key on this phone. A key
  // another account holds is tried once per account and start, not on every call.
  let linking = null;
  let linkRefused = null;
  const linkPro = () => {
    const user = ai.user();
    if (config.aiPlan !== 'pro' || !config.aiKey || !user || ai.proLinked() || linkRefused === user.id) return Promise.resolve();
    linking ??= ai.linkPro(config.bridgeUrl, config.aiKey)
      .then((done) => { if (done) { toast('Mullo Pro is now part of your account'); checkPlan(); } })
      .catch((err) => { if (!err.offline) linkRefused = user.id; console.warn('Mullo Pro link:', err.message); })
      .finally(() => { linking = null; });
    return linking;
  };
  // The sign-in, with a key on this phone linked to it first. Signed out: the key alone, which
  // Mullo's server refuses once SIGNIN_GATE is on (the AI gate below holds the work anyway).
  const credential = async () => {
    const token = await ai.accessToken();
    if (!token) return config.aiKey;
    if (config.aiKey && !ai.proLinked()) await linkPro();
    return token;
  };
  // Their own AI key (core/own-ai.js), only through Mullo's server: it alone can open it.
  const own = mullo ? ownAi(config) : null;
  const remote = createRemoteEngine({ bridgeUrl: config.bridgeUrl, authKey: mullo ? credential : config.aiKey, ownKey: own?.sealed ?? null });
  // What the server says this account may do (trial, free, Pro, none). Without a key,
  // AI is used only while the last answer said yes; nothing is sent on a guess.
  const checkPlan = async () => {
    const user = ai.user();
    if (!mullo || !remote || !user) return;
    try { rememberPlan(user.id, await remote.me()); } catch (err) { if (!err.offline) console.warn('Mullo plan:', err.message); }
  };
  let planCheckedAt = 0;
  const checkPlanNow = () => { planCheckedAt = Date.now(); checkPlan(); };
  const checkPlanSometimes = () => { if (Date.now() - planCheckedAt > 10 * 60_000) checkPlanNow(); };
  useAiGate(() => {
    const user = ai.user();
    const plan = user ? knownPlan(user.id) : null;
    if (legalPending(plan)) return false; // S23: AI waits for the new Privacy Policy and Terms
    if (!mullo) return true; // a dev bridge: no plan, no sign-in
    if (!user) return false; // S25: no Mullo sign-in, nothing goes to Mullo's server, whoever pays
    if (!aiConsented(user.id, own?.provider ?? 'gemini')) return false; // S22e: asked first (core/ai-consent.js)
    return Boolean(own) || config.aiPlan === 'pro' || Boolean(plan?.active);
  });
  // Privacy Policy and Terms (S23, core/legal.js), whenever the AI goes through Mullo's server
  // (on their own server too, S25): the ticks on the sign-in page are told to the server once
  // the sign-in lands; the "We updated" card accepts the version it showed. Then the plan is
  // asked again, so the card goes and AI resumes.
  const legalHere = Boolean(mullo && remote && typeof config.bridgeUrl === 'string');
  legalServer = legalHere ? (config.bridgeUrl || location.origin).replace(/\/+$/, '') : null;
  // version: the one the card showed, or null at sign-in (the pages as they are now).
  const acceptLegal = async (version = null) => {
    if (!legalHere) throw new Error('Sign in to Mullo first.');
    try { await ai.server(legalServer, '/api/legal/accept', version ? { version } : {}); } finally { await checkPlan(); }
    resumePending().catch(toastError);
  };
  on(aiEvent, async (user) => {
    if (!user) return;
    await linkPro();
    if (takeTicked() && legalHere) await acceptLegal().catch((err) => console.warn('Mullo legal:', err.message));
    else {
      // Work held while signed out (S25: a key alone no longer reaches the AI) goes now.
      planCheckedAt = Date.now();
      await checkPlan();
      resumePending().catch(toastError);
    }
  });
  on('ai-plan', () => refresh());
  aiAsk = () => {
    const user = mullo ? ai.user() : null;
    const provider = own?.provider ?? 'gemini';
    return user && askingNow() && !aiConsented(user.id, provider) ? { userId: user.id, provider, server: legalServer ?? location.origin } : null;
  };
  on('ai-consent', (yes) => {
    if (yes) { toast('Thanks. Mullo\'s AI is on.'); resumePending().catch(toastError); }
    refresh({ force: true });
  });
  // Back from Google's / Apple's page (a browser, Settings sign-in): after the listeners above,
  // so the ticks reach Mullo's server like any sign-in.
  await finishSignInRedirect({ notes: acct, mullo: ai });
  if (remote) { useRemoteEngine(remote); useChat(remote); }
  // S50: a note's email and message tasks get drafts once its AI summary is saved.
  useAfterSummary((id) => { autoDraft(id).catch(console.warn); });
  // Google Calendar and Tasks: Mullo's server holds the connection (never an own server).
  useGoogle(mullo && !config.ownServer && typeof config.bridgeUrl === 'string' ? (config.bridgeUrl || location.origin).replace(/\/+$/, '') : null);
  // Mullo Pro through the App Store (iPhone, S22c): what StoreKit says is paid up goes to Mullo's
  // server once per start and at each sign-in (a renewal, or a claim cut off by no signal).
  useStore(mullo && !config.ownServer && typeof config.bridgeUrl === 'string' ? (config.bridgeUrl || location.origin).replace(/\/+$/, '') : null);
  const claimStore = () => claimQuietly().then((n) => { if (n) checkPlanNow(); }).catch(() => {});
  claimStore();
  on(aiEvent, (user) => { if (user) claimStore(); });
  // Once per start and sign-in: is Google connected for this account (maybe from another device)?
  const checkGoogle = () => { if (acct.user()) googleStatus().then(() => googleSoon(3000)).catch(() => {}); };
  on('changed', (c) => { if (c?.table === 'action_items' || c?.table === 'recordings') googleSoon(); });
  on('account', checkGoogle);
  checkGoogle();
  useSpeechCheck(checkSpeech);
  syncAiPrefs();
  on('settings', syncAiPrefs);
  // Task reminders (S47): the phone's alarms follow every task and settings change,
  // and taps on Done / Snooze made while Mullo was closed are written first.
  let reminderTimer = null;
  const remindersSoon = (ms = 500) => { clearTimeout(reminderTimer); reminderTimer = setTimeout(() => syncReminders().catch(console.warn), ms); };
  const takeReminderTaps = () => applyReminderTaps().then((n) => { if (n) refresh({ force: true }); }).catch(console.warn).finally(() => remindersSoon(0));
  on('changed', (c) => { if (c?.table === 'action_items' || c?.table === 'recordings') remindersSoon(); });
  on('settings', () => remindersSoon(0));
  takeReminderTaps();
  // S44 "Keep the recording?": audio whose notes are made goes when Settings says (here and in
  // the account). Checked at start, after each finished job or watch note, on focus (days pass)
  // and when the choice changes; 'keep' (the default) does nothing.
  let keepTimer = null;
  const keepAudioSoon = (ms = 2000) => {
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => {
      if (getSettings().keepAudio === 'keep' || activeJobs() > 0) return;
      expireAudio().then((r) => { if (r.count) refresh(); }).catch(console.warn);
    }, ms);
  };
  on('settings', () => keepAudioSoon(0));
  // A fresh start records nothing yet: a "Mullo is recording" left by a page that reloaded mid-recording goes.
  recordingInProgress(false);

  setContext({ config, refresh, go: (hash) => { location.hash = hash; }, toast, acceptLegal });
  for (const panel of Object.values(PANELS)) registerActions(panel.actions);
  registerActions(toastActions);
  registerActions(legalActions);
  registerActions(consentActions);
  registerActions(taskDraftActions);
  installErrorLog();
  // The record button flies into its place on the Record screen (ui/motion.js).
  registerActions({ 'record-open'(el) { flyHome(el, () => { location.hash = '#/record'; }); } });

  const versionWatch = createVersionWatch({
    fetchVersion: fetchPublishedVersion,
    isOnline: () => navigator.onLine,
    // Don't reload under a recording or a running Gemini call (it would resume, but waste the call).
    isBusy: () => record.isBusy() || activeJobs() > 0,
    beforeReload: saveDrafts,
    reload: () => location.reload(),
  });

  installEvents({
    onRoute: () => { noteRoute(location.hash, window.scrollY); rememberScreen(location.hash); refresh({ force: true }); },
    onFocus: () => { keepScreenOnAgain(); versionWatch.check(); flushAudit(); takeWatchRecordings().catch(toastError); syncSoon(1000); checkPlanSometimes(); googleSoon(2000); settings.focused(); takeReminderTaps(); keepAudioSoon(); },
    onWatch: () => { takeWatchRecordings().catch(toastError).finally(() => keepAudioSoon()); },
    onReminderTap: takeReminderTaps,
    onGoogle: googleAnswer,
    onLeaveMullo: settings.leaveMulloServer,
    onScroll: hideToastOnScroll,
    onDrag: hideToastOnDrag,
    onConnectivity: () => { updatePendingBadge(); refresh(); updateMood(); flushAudit(); syncSoon(1000); },
    onIdle: () => { if (stale) setTimeout(() => { if (stale && !textFieldFocused()) refresh(); }, 0); },
    isBusy: record.isBusy,
    onError: (err, where) => {
      console.error(err);
      logError(err, where); // for Report a problem (S56)
      toast(err?.message ?? 'Something went wrong', { error: true });
    },
  });

  on('changed', () => refresh());
  on('drafting', () => refresh()); // "Writing the draft…" on a task comes and goes
  // The mascot (Search / Ask, library card) follows jobs as they start and finish.
  on('job-started', () => { refresh(); updateMood(); });
  on('job-done', async (done) => {
    noteJobDone(done);
    refresh();
    updateMood();
    keepAudioSoon();
    const { recordingId, ok, error, aiError, transcribeError, silent, offline } = done;
    // The server refused or the minutes ran out: ask what the plan is now.
    if (!ok || aiError || transcribeError) checkPlanNow();
    const rec = await getRecording(recordingId);
    if (!rec) return;
    if (silent) toast('No speech heard in that recording - nothing was sent to the AI');
    else if (!ok) toast(`“${rec.title}”: ${error}${offline ? ' Tap Re-transcribe when you have signal.' : ''}`, { error: true });
    else if (offline) toast(`“${rec.title}” is saved, but the connection dropped before the transcript came back - open it and tap Re-transcribe when you have signal.`, { error: true });
    else if (transcribeError || aiError) toast(`“${rec.title}” is saved, but Gemini didn’t answer - open it and tap Re-transcribe.`, { error: true });
    // A good result gets no toast (owner, 2026-10-12): the Library's Ready card and
    // Mullo on Search already say it.
  });
  on('pending', updatePendingBadge);
  setInterval(updatePendingBadge, 30_000);

  // The red record button: a white dot, no mascot (owner, 2026-10-10).
  document.getElementById('record-fab')?.replaceChildren(
    h('span', { class: 'fab__dot', 'aria-hidden': 'true' }));
  updatePendingBadge();
  noteRoute(location.hash);
  await render();
  // Recordings left mid-way (app closed while Gemini worked) finish now.
  const resumed = await resumePending();
  const upgraded = await upgradeOfflineSummaries();
  if (resumed + upgraded) {
    toast([
      resumed ? `Finishing ${resumed} recording${resumed > 1 ? 's' : ''}` : null,
      upgraded ? `improving ${upgraded} offline summar${upgraded > 1 ? 'ies' : 'y'} with Gemini` : null,
    ].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase()));
  }
  await takeWatchRecordings().catch(toastError);
  keepAudioSoon(5000);
  linkPro();
  checkPlanNow();
  versionWatch.start();
  registerServiceWorker();
}

boot().catch((err) => {
  console.error(err);
  const root = view();
  if (root) root.replaceChildren(h('p', { class: 'notice notice--alert' }, `The app could not start: ${err.message}`));
});
