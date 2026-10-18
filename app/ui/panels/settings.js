// Settings - laid out like Pocket's and Vocci's: a header with this month's
// usage, then grouped rows (icon · title · subtitle · chevron or switch),
// each opening its own page. Everything saves on the device as it changes.

import { h, userText } from '../dom.js';
import { languageSelect } from '../components.js';
import { ctx } from '../context.js';
import { applyTheme } from '../theme.js';
import { getSettings, updateSettings, parseVocabulary, SAME, MAX_VOCABULARY } from '../../core/settings.js';
import { languageGroups, languageLabel } from '../../core/languages.js';
import { monthUsage } from '../../core/usage.js';
import { canReach, getSession } from '../../core/auth.js';
import { driverKind, db } from '../../core/db.js';
import { APP_VERSION } from '../../core/version.js';
import { templateText, MAX_CUSTOM_TEMPLATES } from '../../domain/templates.js';
import { allFormats, customFormats, formatFor, saveFormat, deleteFormat } from '../../domain/formats.js';
import { listRecordings, getRecording } from '../../domain/recordings.js';
import { aiAccount, billingPortal } from '../../domain/pipeline.js';
import { photoFor, shrinkPhoto, savePhoto, removePhoto } from '../../core/profile-photo.js';
import { ownAi, keepOwnAi, dropOwnAi, PROVIDER_LABEL, PROVIDER_BILLER, transcribesWith, keyWaitsForSignIn, mulloSignInHref } from '../../core/own-ai.js';
import { inAndroidApp, saveProKey, removeProKey, proKeyHint, copyText, askToUseServer, askToUseMulloServer, finishServerChange } from '../../core/native.js';
import { account, mulloAccount, twoAccounts, signInNonce, deviceSessionStore, mulloSessionStore } from '../../core/account.js';
import { checkServer, keepBrowserServer, dropBrowserServer } from '../../core/own-server.js';
import { knownPlan, rememberPlan, planLine, planLeft, planLow, minutesLeft } from '../../core/ai-plan.js';
import { noteTicked } from '../../core/legal.js';
import { googleSignInAvailable, googleIdToken, appleSignInAvailable, appleIdToken, appleAuthCode, appleCodeAvailable } from '../../core/native.js';
import { linkDevice, syncNow, retryNow, status as cloudStatus, compareCounts, clearClashes, forgetAccountCopy, useForeignHere, switchToThisAccount, SCHEMA_STEP } from '../../core/cloud-sync.js';
import { loadStorage, removeRecordingAudio, removeOldAudio, freeDeletedAudio, formatBytes, OLD_AFTER_DAYS, loadKeepReport, expireAudio } from '../../domain/storage.js';
import { timeOfDay, relativeDay, localDate } from '../../core/dates.js';
import { googleAvailable, googleOn, googleStatus, connectGoogle, disconnectGoogle, syncGoogle, lastGoogleSync } from '../../domain/google.js';
import { inPhoneApp, remindersOnPhone, exactRemindersAllowed, storeProduct, storeManage } from '../../core/native.js';
import { storeReady, buyPro, restorePro } from '../../domain/store.js';
import { parseRoute, previousHash } from '../router.js';
import { mark, take } from '../motion.js';
import { loadModels, pickModel, pickerRows, TIER_LABEL } from '../../core/models.js';
import { reportNote, reportAbout, lastScreen, detailsNow, detailsText, platformOf, mailtoHref, shrinkImage, sendReport, MAX_TEXT } from '../../domain/report.js';
import { dashboardBody, reportBody, statsName, csvFor } from '../admin-stats.js';

export const screen = 'settings';

const APPEARANCE_LABEL = { system: 'Match system', dark: 'Dark', light: 'Light' };
// Account page: the sign-in step ('email' → 'code'), the address the code went to,
// and whether "Sign out" waits for its second tap.
// `agreed`: the Privacy Policy and Terms ticks on the sign-in page.
const signIn = { step: 'email', email: '', confirmOut: false, confirmDelete: false, agreed: { privacy: false, terms: false } };
// The same for the second sign-in on their own server: to Mullo's account, for the AI (S25).
const mulloIn = { step: 'email', email: '', confirmOut: false, agreed: { privacy: false, terms: false } };
// Storage page: which "free up" waits for a second tap ('deleted' | 'old' | a recording id).
let storageConfirm = null;
// Summaries page: the format open in the form ('new' | an id) and the one waiting to be deleted.
let formatEditing = null;
let formatDeleting = null;

// Server answers for Subscription and Developers. Those pages draw at once from what's
// known and draw again when the answer arrives; they used to wait for up to four round
// trips, one after another, before showing anything (owner, 2026-10-11: "a little lag").
// Asked once per visit; an action that changes something asks again with askAgain.
const live = new Map(); // key → { value, error, done, asked, ask }
let liveSection;
let liveUser = null;

function answer(key, load) {
  let e = live.get(key);
  if (!e) { e = { value: undefined, error: null, done: false, asked: false, ask: 0 }; live.set(key, e); }
  if (!e.asked) {
    e.asked = true;
    const ask = ++e.ask;
    Promise.resolve().then(load)
      .then((value) => { if (ask === e.ask) { e.value = value; e.error = null; } },
        (err) => { if (ask === e.ask) e.error = err; })
      .finally(() => { if (ask === e.ask) { e.done = true; ctx.refresh(); } });
  }
  return e;
}

// Ask again on the next draw; the last answer stays on screen meanwhile.
function askAgain(...keys) {
  for (const key of keys.length ? keys : live.keys()) {
    const e = live.get(key);
    if (e) e.asked = false;
  }
}

// ── Building blocks ─────────────────────────────────────────────────────
function group(title, ...rows) {
  const items = rows.flat().filter(Boolean);
  if (!items.length) return null;
  return h('section', { class: 'set-group' },
    title ? h('h2', { class: 'set-group__title' }, title) : null,
    h('div', { class: 'set-list' }, items));
}

function rowInner(icon, title, subtitle) {
  return [
    h('span', { class: 'set-row__icon', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'set-row__text' },
      h('span', { class: 'set-row__title' }, title),
      subtitle ? userText('span', subtitle, { class: 'set-row__sub' }) : null),
  ];
}

const linkRow = (href, icon, title, subtitle) =>
  h('a', { class: 'set-row', href }, rowInner(icon, title, subtitle), h('span', { class: 'set-row__chev', 'aria-hidden': 'true' }, '›'));

const switchRow = (field, icon, title, subtitle, on) =>
  h('label', { class: 'set-row' }, rowInner(icon, title, subtitle),
    h('input', {
      type: 'checkbox', role: 'switch', class: 'switch', checked: on, 'aria-label': title,
      data: { action: 'settings-toggle', field },
    }));

// Back goes to the page that led here when it's this page's parent (Connections → Developers,
// Connections → Google), else to Settings. Owner, 2026-10-14: back from Developers, opened
// from Connections, landed on Settings. Only parents count, so Connections → Developers →
// back → Connections never bounces back to Developers.
// A report opened from the admin dashboard goes back to it.
const PARENT = { developers: 'connections', ai: 'connections', google: 'connections' };
const PARENT_TITLE = { connections: 'Connections', 'admin-dashboard': 'Dashboard' };
const parentOf = (section) => PARENT[section] ?? (statsName(section) ? 'admin-dashboard' : undefined);

function subpage(title, ...body) {
  const parent = parentOf(parseRoute(location.hash).params.section);
  const back = parent && previousHash() === `#/settings/${parent}`
    ? { href: `#/settings/${parent}`, label: PARENT_TITLE[parent] }
    : { href: '#/settings', label: 'Settings' };
  return h('div', { class: 'set-page' },
    h('a', { class: 'back', href: back.href }, `‹ ${back.label}`),
    h('h1', { class: 'page-head__title' }, title),
    body);
}

function choiceList(field, choices, current) {
  return h('div', { class: 'set-list' }, choices.map(([value, label, sub]) =>
    h('button', {
      type: 'button', class: ['set-row', 'set-choice', value === current && 'is-selected'],
      'aria-pressed': String(value === current), data: { action: 'settings-pick', field, value },
    },
    h('span', { class: 'set-row__text' }, h('span', { class: 'set-row__title' }, label), sub ? h('span', { class: 'set-row__sub' }, sub) : null),
    h('span', { class: 'set-choice__mark', 'aria-hidden': 'true' }, value === current ? '✓' : ''))));
}

function hubCopyLine() {
  const s = cloudStatus();
  if (s.state !== 'mine') return 'Signed in · tap to copy your notes into your account';
  const waiting = s.pending + s.audioPending;
  return waiting ? `Signed in · ${waiting} waiting to be copied` : 'Signed in · everything copied';
}

// ── Pages ───────────────────────────────────────────────────────────────
// The estimated AI cost (owner, 2026-10-11): only for people paying the AI company themselves
// (their own key) and for admins. On a Mullo plan it reads like a bill they don't get.
// The estimate uses Gemini's prices, so other companies' keys say so.
function costLine(usage, resets) {
  const own = mulloServer() ? ownAi(ctx.config) : null;
  const admin = Boolean(knownPlan(mulloAccount().user()?.id)?.admin);
  if (!own && !admin) return null;
  const label = !own || own.provider === 'gemini' ? 'Est. Gemini cost' : 'Est. cost at Gemini prices';
  return h('p', { class: 'usage__foot' }, `${label} ≈ $${usage.cost.toFixed(2)} · resets ${resets}`);
}

async function hub() {
  const s = getSettings();
  const recordings = await listRecordings();
  const usage = monthUsage(recordings);
  const estimate = await db.estimate().catch(() => null);
  const used = estimate?.usage != null ? ` · ${formatBytes(estimate.usage)}` : '';
  const session = getSession();
  const resets = usage.resets.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  const signedIn = Boolean(account().user());
  const plan = currentPlan();
  // On their own server, signing in is to THAT server: no Mullo plan badge beside "Sign in".
  const ownHost = ctx.config?.ownServer ? hostOf(ctx.config.supabaseUrl) : null;
  const badge = ownHost && !signedIn ? null : planBadge(plan);
  const profile = [
    planRing(plan, avatar(session?.displayName)),
    h('span', { class: 'profile__text' },
      h('span', { class: 'profile__top' },
        signedIn
          ? userText('span', session.displayName, { class: 'profile__name profile__name--email' })
          : h('span', { class: 'profile__name' }, account().on ? 'Sign in' : (session?.displayName ?? '-')),
        badge ? h('span', { class: `plan-badge plan-badge--${badge.toLowerCase()}` }, badge) : null),
      planLeft(plan) !== null ? h('span', { class: `profile__plan${planLow(plan) ? ' is-low' : ''}` }, planLine(plan)) : null,
      h('span', { class: 'profile__sub' }, signedIn
        ? hubCopyLine()
        : !account().on ? 'Saved on this device'
          : ownHost ? `Keep your notes on your own server, ${ownHost}` : 'Keep your notes in your Mullo account')),
  ];

  return h('div', { class: 'set-hub' },
    account().on
      ? h('a', { class: 'profile profile--link', href: '#/settings/account' }, profile, h('span', { class: 'set-row__chev', 'aria-hidden': 'true' }, '›'))
      : h('header', { class: 'profile' }, profile),

    h('section', { class: 'usage' },
      h('h2', { class: 'usage__title' }, 'This month'),
      h('div', { class: 'usage__tiles' },
        h('div', { class: 'usage__tile' }, h('span', { class: 'usage__label' }, 'Recorded'), h('span', { class: 'usage__value' }, `${Math.round(usage.minutes)} min`)),
        h('div', { class: 'usage__tile' }, h('span', { class: 'usage__label' }, 'Questions asked'), h('span', { class: 'usage__value' }, String(usage.questions)))),
      costLine(usage, resets)),

    account().on || ctx.config?.aiPlan === 'pro'
      ? group('Your plan',
        linkRow('#/settings/subscription', '💳', 'Subscription', subscriptionSubtitle()))
      : null,

    group('Recording & transcription',
      linkRow('#/settings/languages', '🎙️', 'Languages',
        `Listen: ${languageLabel(s.listen)} · Transcript: ${s.transcript === SAME ? 'same' : languageLabel(s.transcript)}`),
      linkRow('#/settings/names', '✍️', 'Names & words',
        s.vocabulary.length ? `${s.vocabulary.length} saved - spelled right in every transcript` : 'Teach it names it should spell right'),
      linkRow('#/settings/summaries', '📝', 'Summaries', `New recordings: ${formatFor(s.template).label}`),
      switchRow('livePreview', '👁️', 'Live preview while recording', 'Text as you talk, from your phone. Off: audio goes only to Gemini.', s.livePreview)),

    // S50: on by default (owner, 2026-10-15). Uses the AI like Ask does.
    group('Tasks',
      switchRow('autoDrafts', '✨', 'Draft emails and messages for me',
        s.autoDrafts ? 'An email or message task gets a draft from its note, ready to check and send. Uses the AI like Ask.' : 'Off: tap "Draft it" on a task when you want one.',
        s.autoDrafts)),

    remindersOnPhone() ? group('Reminders', remindersRows(s)) : null,

    group('Connections',
      linkRow('#/settings/connections', '🔌', 'Connections', 'Calendar, notes apps, Claude and ChatGPT')),

    group('Privacy & data',
      canReach('activity') ? linkRow('#/activity', '🕘', 'Activity', 'Every change, with restore') : null,
      linkRow('#/settings/keep-audio', '🗑️', 'Keep recordings', `Audio: ${KEEP_AUDIO_LABEL[s.keepAudio]}`),
      linkRow('#/settings/server-keep', '⏱️', 'Mullo\'s server', `Keeps a transcript: ${SERVER_KEEP_LABEL[s.serverKeep]}`),
      linkRow('#/settings/storage', '💾', 'Storage', `${driverKind() === 'local' ? 'On this device' : driverKind()}${used}`)),

    group('Display',
      linkRow('#/settings/appearance', '🌓', 'Appearance', APPEARANCE_LABEL[s.appearance])),

    group('Developers',
      linkRow('#/settings/developers', '🛠️', 'Developers', developersSubtitle())),

    group('Help',
      linkRow('#/settings/report', '🐞', 'Report a problem', 'Tell us what went wrong')),

    adminRows(),

    h('p', { class: 'set-version' }, `- Mullo · Build ${APP_VERSION} -`));
}

// Task reminders (S47), in the Android app: each kind of notification has its own switch.
function remindersRows(s) {
  if (!s.reminders) return [switchRow('reminders', '⏰', 'Task reminders', 'Off: tasks never ring.', false)];
  const exact = exactRemindersAllowed();
  return [
    switchRow('reminders', '⏰', 'Task reminders', 'A task with a day and a time rings then, with Done and Snooze.', true),
    switchRow('remindersHidden', '🔒', 'Hide task text on the lock screen', 'It still rings; the text shows once the phone is unlocked.', s.remindersHidden),
    exact === false
      ? h('div', { class: 'set-row' }, rowInner('🕐', 'Ring on time', 'Not allowed: reminders may come up to 10 minutes late.'),
        h('button', { type: 'button', class: 'btn btn--small', data: { action: 'reminders-exact' } }, 'Allow'))
      : null,
  ];
}

// ── Plan, photo, subscription ──────────────────────────────────────────
// The plan as the server last said, for the Mullo account the AI goes through. A Pro key with
// no sign-in has none (S25: it waits for one).
function currentPlan() {
  const user = mulloAccount().user();
  return user ? knownPlan(user.id) : null;
}

// Next to the name: Trial, Pro (paid, or given by Mullo), nothing otherwise.
export function planBadge(p) {
  if (p?.plan === 'trial') return 'Trial';
  if ((p?.plan === 'pro' || p?.plan === 'free') && p.active) return 'Pro';
  return null;
}

function avatar(name) {
  const photo = photoFor(account().user()?.id);
  return photo
    ? h('img', { class: 'profile__avatar profile__avatar--photo', src: photo, alt: '' })
    : h('span', { class: 'profile__avatar', 'aria-hidden': 'true' }, (name ?? '?').slice(0, 1).toUpperCase());
}

// Mullo's own touch: the ring around the photo is what's left of the plan, in its
// colour (full = plenty). In steps of 10%, as classes (no inline styles).
function planRing(p, inner) {
  const left = planLeft(p);
  if (left === null) return h('span', { class: 'ring ring--none' }, inner);
  const kind = left === 0 ? 'empty' : planLow(p) ? 'low' : 'ok';
  return h('span', { class: `ring ring--${kind} ring--${Math.round(left * 10) * 10}`, title: planLine(p) }, inner);
}

function subscriptionSubtitle() {
  const p = currentPlan();
  if (!p) {
    if (mulloAccount().user()) return 'Checking your plan…';
    return keyWaitsForSignIn(ctx.config, false) ? 'Sign in to Mullo to keep using your key' : 'Sign in to see your plan';
  }
  if (p.plan === 'pro') return storeReady() && p.store !== 'apple' ? planLine(p) : `${planLine(p)} · manage payments`;
  return planLine(p);
}

// Stripe's pages open outside Mullo (in the phone's browser).
function openOutside(url) {
  if (inAndroidApp()) { location.href = url; return; }
  if (!window.open(url, '_blank', 'noopener')) location.assign(url);
}

// The plan from Mullo's server, kept for offline and the Record screen.
async function loadMe() {
  const me = await aiAccount();
  const user = mulloAccount().user();
  if (user && me) rememberPlan(user.id, me);
  return me;
}

function subscriptionPage() {
  if (!mulloAccount().user()) {
    return subpage('Subscription',
      h('div', { class: 'card stack' },
        h('p', { class: 'small' }, keyWaitsForSignIn(ctx.config, false)
          ? 'Sign in to Mullo to keep using your key: it still pays, the sign-in says it\'s you.'
          : 'Sign in to see your plan and get Mullo Pro.'),
        h('a', { class: 'btn btn--primary', href: mulloSignInHref(ctx.config) }, 'Sign in')));
  }
  const asked = answer('me', loadMe);
  const me = asked.value ?? null;
  const problem = asked.error?.message ?? null;
  const p = me ?? currentPlan();
  // iPhone (S22c): Apple's in-app purchase and nothing else (App Store rule 3.1.1: no Stripe, no
  // pointing at the website). Apple's own price for this country; Restore, the renewal terms and
  // the Terms + Privacy links are what rule 3.1.2 asks for.
  const apple = storeReady();
  const product = apple ? answer('store-product', storeProduct).value : null;
  const getPro = apple
    ? [
      h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'store-buy' }, disabled: !product?.price },
        product?.price ? `Get Mullo Pro · ${product.price} a month` : 'Get Mullo Pro'),
      product?.error ? h('p', { class: 'muted small' }, product.error) : null,
      h('p', { class: 'muted small' }, `${product?.description ? `${product.description}. ` : ''}`
        + 'Paid through your Apple ID; renews every month until you cancel in Settings, your name, Subscriptions.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'store-restore' } }, 'Restore Purchases'),
        h('a', { href: `${mulloServer()}/terms`, data: { action: 'open-legal', page: 'terms' } }, 'Terms'),
        h('a', { href: `${mulloServer()}/privacy`, data: { action: 'open-legal', page: 'privacy' } }, 'Privacy')),
    ]
    : h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'sub-checkout' } }, 'Get Mullo Pro');
  let body;
  if (!p) body = h('p', { class: 'muted small' }, problem ?? 'Checking your plan…');
  else if (p.plan === 'pro') {
    const renews = p.periodEnd ? new Date(p.periodEnd * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
    body = [
      h('p', null, p.active || p.capped ? planLine(p) : `Mullo Pro · ${p.status ?? 'not active'}`),
      planUse(p),
      renews ? h('p', { class: 'muted small' }, p.active ? `Paid through ${renews}. It renews by itself until you cancel.` : `Ended or unpaid since ${renews}.`) : null,
      ...(p.store === 'apple'
        ? [h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'store-manage' } }, apple ? 'Manage in the App Store' : 'Manage on your iPhone'),
          h('p', { class: 'muted small' }, apple
            ? 'Bought with your Apple ID. Cancel or change it there; Mullo Pro stays on until the end of the paid month.'
            : 'Bought in the iPhone app with your Apple ID: manage it on your iPhone, in Settings, your name, Subscriptions.')]
        : apple
          ? [] // bought on the website: nothing to manage here (rule 3.1.1)
          : [h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'sub-portal' } }, 'Manage payments'),
            h('p', { class: 'muted small' }, 'Change your card, see invoices, or cancel. Opens Stripe, our payment provider. If you cancel, Mullo Pro stays on until the end of the paid month.')]),
    ];
  } else if (p.plan === 'free') {
    body = [h('p', null, planLine(p)), planUse(p), h('p', { class: 'muted small' }, 'Given by Mullo: nothing to pay.')];
  } else if (p.plan === 'trial') {
    body = [h('p', null, planLine(p)), planUse(p), h('p', { class: 'muted small' }, 'When the free minutes run out, Mullo Pro keeps the AI on.'), getPro];
  } else {
    body = [h('p', null, 'No AI on this account yet.'), h('p', { class: 'muted small' }, 'Recordings still save here with an offline summary. Mullo Pro adds transcripts, summaries, tasks and Ask by AI.'), getPro];
  }
  return subpage('Subscription',
    h('div', { class: 'card stack' }, h('h2', { class: 'card__title' }, 'Your plan'), body),
    problem && me === null && p ? h('p', { class: 'notice' }, problem) : null);
}

function photoCard(user) {
  const has = Boolean(photoFor(user.id));
  return h('div', { class: 'card stack account__photo' },
    planRing(currentPlan(), avatar(user.email)),
    h('div', { class: 'row' },
      h('label', { class: 'btn' }, has ? 'Change photo' : 'Add a photo',
        h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', data: { action: 'photo-pick' } })),
      has ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'photo-remove' } }, 'Remove') : null),
    h('p', { class: 'muted small' }, 'Kept on this phone.'));
}

// Syncing starts by itself once signed in (cloud-sync whenSignedIn); this shows
// how it's going. The button is only a way back if starting failed.
async function copyCard() {
  const s = cloudStatus();
  if (s.state === 'other') {
    return h('div', { class: 'notice stack' },
      h('p', null, 'The notes on this phone are synced with a different account. Nothing is synced with this one.'),
      h('p', { class: 'small' }, 'Sign in with that account to keep syncing, or sync this phone with the account you\'re signed in to now.'),
      h('button', { type: 'button', class: 'btn btn--small', data: { action: 'cloud-switch' } }, 'Sync with this account'));
  }
  if (s.state === 'off') {
    return h('div', { class: 'card stack' },
      h('h2', { class: 'card__title' }, 'Syncing with your account'),
      h('p', { class: 'small' }, 'Starting… Your notes go into your account, notes already there come to this phone, and from then on every change follows on its own. Only you can see them.'),
      h('button', { type: 'button', class: 'btn', data: { action: 'cloud-link' } }, 'Start syncing'));
  }
  const waiting = s.pending + s.audioPending;
  let line;
  if (s.pulling) line = 'Bringing your account\'s notes to this phone…';
  else if (s.running && waiting) line = `Copying… ${waiting} left`;
  else if (s.error && waiting) line = `${s.error} · ${waiting} waiting`;
  else if (waiting) line = `${waiting} waiting to be copied`;
  else if (s.stuck && s.stuck === s.foreign) line = 'Everything else is copied';
  else if (s.stuck) line = 'The rest is copied';
  else line = s.lastDone ? `Everything is copied · ${relativeDay(localDate(new Date(s.lastDone)), localDate())} ${timeOfDay(s.lastDone)}` : 'Everything is copied';
  return h('div', { class: 'card stack' },
    h('h2', { class: 'card__title' }, 'In step with your account'),
    h('p', { class: waiting || s.stuck ? 'small' : 'small account__ok' }, line),
    s.clashes
      ? h('div', { class: 'notice stack' },
        h('p', null, `${s.clashes === 1 ? 'One change was' : `${s.clashes} changes were`} made here and on another device at the same time. This phone's version was kept; the other one is in Activity.`),
        h('button', { type: 'button', class: 'btn btn--small', data: { action: 'cloud-clashes-ok' } }, 'Got it'))
      : null,
    s.audioPending ? h('p', { class: 'muted small' }, `${s.audioPending} audio file${s.audioPending === 1 ? '' : 's'} still to upload.`) : null,
    s.foreign
      ? h('div', { class: 'notice stack' },
        h('p', null, s.foreignNotes
          ? `${s.foreignNotes === 1 ? 'One note' : `${s.foreignNotes} notes`} on this phone belong to another Mullo account, so they aren't in this one yet.`
          : 'Some of what\'s on this phone belongs to another Mullo account, so it isn\'t in this one yet.'),
        h('p', { class: 'small' }, 'They stay on this phone. Use them here too (the other account keeps its copy), or sign in to that account.'),
        s.running ? null : h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn--small', data: { action: 'cloud-use-here' } }, 'Use them in this account'),
          h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'cloud-other-account' } }, 'Sign in to the other account')))
      : null,
    s.stuck - s.foreign > 0
      ? h('div', { class: 'notice stack' },
        h('p', null, `${s.stuck - s.foreign} couldn't be copied yet. They're kept on this phone and tried again each time Mullo starts.`),
        h('p', { class: 'small' }, 'The server said: ', s.stuckReasons.join('; ')),
        s.running ? null : h('button', { type: 'button', class: 'btn btn--small', data: { action: 'cloud-retry' } }, 'Try again'))
      : null,
    s.running ? null : h('button', { type: 'button', class: 'btn', data: { action: 'cloud-now' } }, 'Sync now'));
}

// Delete account, below Sign out (owner, 2026-10-10; both app stores require it). Two taps,
// and the second one says plainly what goes: the account copy, a Pro subscription.
function deleteCard(user) {
  if (!signIn.confirmDelete) {
    return h('button', { type: 'button', class: 'btn btn--ghost btn--danger', data: { action: 'account-delete-ask' } }, 'Delete account');
  }
  const own = ctx.config?.ownServer ? hostOf(ctx.config.supabaseUrl) : null;
  const pro = !own && knownPlan(user.id)?.plan === 'pro';
  return h('div', { class: 'card stack' },
    h('h2', { class: 'card__title' }, 'Delete your account?'),
    h('p', { class: 'small' }, own
      ? `Your account on ${own} and everything in it is deleted: notes, audio, tasks and history. This can't be undone.`
      : 'Your Mullo account and everything in it is deleted from Mullo\'s server: notes, audio, tasks and history. This can\'t be undone.'),
    pro && knownPlan(user.id)?.store === 'apple'
      // App Store rule 5.1.1(v): Apple subscriptions are cancelled by the person, with Apple.
      ? h('p', { class: 'notice' }, 'This doesn\'t cancel your Mullo Pro subscription: it\'s billed by Apple. Cancel it in your iPhone\'s Settings, your name, Subscriptions, or it keeps renewing.')
      : pro ? h('p', { class: 'notice' }, 'Your Mullo Pro subscription is cancelled now, with no refund for the rest of the month.') : null,
    h('p', { class: 'muted small' }, 'The notes on this phone stay here. Connected apps and API keys stop working.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--danger', data: { action: 'account-delete' } }, 'Yes, delete my account'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'account-delete-cancel' } }, 'Cancel')));
}

// The two sign-ins (S25). 'notes' = the server the notes sync with (Settings, Account): Mullo's,
// or the person's own. 'mullo' = on their own server only, the second one, to their Mullo
// account, for the AI, its plan and the Terms (Settings, Account, Mullo account).
const signInFor = (which) => (which === 'mullo' ? mulloIn : signIn);
const accountFor = (which) => (which === 'mullo' ? mulloAccount() : account());
const whichOf = (el) => (el.dataset.which === 'mullo' ? 'mullo' : 'notes');
// On the elements of the 'mullo' sign-in, so its actions know which one they're for.
const tagged = (which, data) => (which === 'mullo' ? { ...data, which } : data);

// Privacy Policy and Terms (owner, 2026-10-11): not in Settings; ticked on the sign-in page
// each time someone signs in or makes an account, each with a link to read it on Mullo's
// website. Only for a sign-in to Mullo's own server: signing in to your own server isn't
// Mullo's service (its second sign-in, to Mullo, is).
const legalNeeded = (which = 'notes') => Boolean(mulloServer()) && (which === 'mullo' || !ctx.config?.ownServer);
const legalAgreed = (which = 'notes') => !legalNeeded(which) || (signInFor(which).agreed.privacy && signInFor(which).agreed.terms);
const LEGAL_FIRST = 'First tick that you\'ve read the Privacy Policy and the Terms of Service.';

function legalTick(which, page, text, title) {
  const id = which === 'mullo' ? `legal-mullo-${page}` : `legal-${page}`;
  return h('div', { class: 'legal-tick' },
    h('input', { type: 'checkbox', id, checked: signInFor(which).agreed[page], data: tagged(which, { action: 'legal-tick', page }) }),
    // The link opens the page outside the app; tapping it doesn't tick the box.
    h('label', { for: id }, text, h('a', { href: `${mulloServer()}/${page}`, data: { action: 'open-legal', page } }, title)));
}

function legalCard(which) {
  return h('div', { class: 'card stack' },
    h('p', { class: 'small' }, 'Before you sign in or make an account, please read these. Each opens on Mullo\'s website.'),
    legalTick(which, 'privacy', 'I have read the ', 'Privacy Policy'),
    legalTick(which, 'terms', 'I have read and agree to the ', 'Terms of Service'));
}

function signOutButton(which, question) {
  return signInFor(which).confirmOut
    ? h('div', { class: 'card stack' },
      h('p', { class: 'small' }, question),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--danger', data: tagged(which, { action: 'account-out' }) }, 'Yes, sign out'),
        h('button', { type: 'button', class: 'btn btn--ghost', data: tagged(which, { action: 'account-out-cancel' }) }, 'Cancel')))
    : h('button', { type: 'button', class: 'btn btn--ghost', data: tagged(which, { action: 'account-out-ask' }) }, 'Sign out');
}

// On their own server: where the second sign-in, to Mullo's account, is (S25).
function mulloAccountRow() {
  if (!twoAccounts()) return null;
  const u = mulloAccount().user();
  return group('Mullo account, for the AI',
    linkRow('#/settings/mullo-account', '🤖', u ? 'Signed in to Mullo' : 'Sign in to Mullo',
      u ? (u.email ?? '-') : 'Transcripts, summaries, tasks and Ask go through Mullo\'s server, which needs it'));
}

async function accountPage() {
  const user = account().user();
  if (!account().on) {
    return subpage('Account', h('p', { class: 'muted small' }, 'This copy of Mullo has no account server set. Your notes are saved on this device.'));
  }
  if (user) {
    return subpage('Account',
      photoCard(user),
      h('div', { class: 'card stack' },
        h('span', { class: 'field__label' }, 'Signed in as'),
        userText('p', user.email ?? '-', { class: 'account__email' })),
      await copyCard(),
      mulloAccountRow(),
      signOutButton('notes', 'Sign out? Everything stays on this device.'),
      deleteCard(user));
  }
  return subpage('Sign in', ...signInSteps('notes'), mulloAccountRow());
}

// On their own server: the Mullo account the AI goes through (S25). Only the sign-in and the
// sign-out here; the notes, the photo and deleting the notes' account stay on Account.
function mulloAccountPage() {
  if (!twoAccounts()) return accountPage();
  const user = mulloAccount().user();
  const about = h('p', { class: 'muted small' }, 'Your notes stay on your own server, ', userText('strong', hostOf(ctx.config.supabaseUrl)),
    '. This Mullo account is only for the AI: transcripts, summaries, tasks and Ask go through Mullo\'s server, with your plan or your own AI key.');
  if (user) {
    return subpage('Mullo account',
      h('div', { class: 'card stack' },
        h('span', { class: 'field__label' }, 'Signed in to Mullo as'),
        userText('p', user.email ?? '-', { class: 'account__email' })),
      about,
      signOutButton('mullo', 'Sign out of Mullo? The AI waits until you sign in again; your notes and your own server stay as they are.'),
      h('p', { class: 'muted small' }, 'To delete this Mullo account: Settings, Developers, Your own server, Back to Mullo\'s server, then Account.'));
  }
  return subpage('Sign in to Mullo', about, ...signInSteps('mullo'));
}

// Which of Google / Apple the sign-in's server has on, asked once per page load (a browser only).
// null while asking: the buttons appear when the answer lands.
const webProviders = { notes: undefined, mullo: undefined };
function webProvidersFor(which) {
  if (webProviders[which] === undefined) {
    webProviders[which] = null;
    accountFor(which).providers().then((p) => { webProviders[which] = p; ctx.refresh({ force: true }); });
  }
  return webProviders[which];
}

// Apple's logo for "Continue with Apple" (Apple's sign-in button rules ask for it). Drawn, since
// h() makes HTML only; the shape follows the text colour.
function appleLogo() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 17 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'btn--apple__logo');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M14.2 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM11.6 3c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.1.1 2.3-.6 3-1.5z');
  svg.append(path);
  return svg;
}

// The sign-in itself, the email step or the code step, for either sign-in.
function signInSteps(which) {
  const s = signInFor(which);
  if (s.step === 'code') {
    return [
      h('form', { class: 'card stack', data: tagged(which, { action: 'account-verify' }) },
        h('p', null, 'We emailed a sign-in code to ', userText('strong', s.email), '. It works for one hour.'),
        h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Code'),
          h('input', {
            name: 'code', class: 'account__code', inputmode: 'numeric', autocomplete: 'one-time-code',
            maxlength: '10', placeholder: '123456', autofocus: true, 'aria-label': 'The code from the email',
          })),
        h('button', { type: 'submit', class: 'btn btn--primary' }, 'Sign in')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--ghost', data: tagged(which, { action: 'account-resend' }) }, 'Send a new code'),
        h('button', { type: 'button', class: 'btn btn--ghost', data: tagged(which, { action: 'account-other' }) }, 'Use a different email')),
      h('p', { class: 'muted small' }, 'No email? Look in Spam. A new code makes the old one stop working.'),
    ];
  }
  const locked = !legalAgreed(which);
  const ownNotes = which === 'notes' && ctx.config?.ownServer;
  // Google / Apple are set up for Mullo's server only. The phone apps: their own sheets (Android:
  // Google; iPhone: Apple + Google, S22b). A browser: the provider's own page, for each one the
  // server has switched on (both refuse an app's web view, so never there).
  const web = ownNotes || inPhoneApp() ? null : webProvidersFor(which);
  const googleButton = (action) => h('button', { type: 'button', class: 'btn btn--primary btn--google', disabled: locked, data: tagged(which, { action, provider: 'google', gate: 'legal' }) },
    h('span', { class: 'btn--google__g', 'aria-hidden': 'true' }, 'G'), 'Continue with Google');
  const appleButton = (action) => h('button', { type: 'button', class: 'btn btn--apple', disabled: locked, data: tagged(which, { action, provider: 'apple', gate: 'legal' }) },
    appleLogo(), 'Continue with Apple');
  const providerButtons = [
    appleSignInAvailable() && !ownNotes ? appleButton('account-apple') : null,
    googleSignInAvailable() && !ownNotes ? googleButton('account-google') : null,
    web?.google ? googleButton('account-web') : null,
    web?.apple ? appleButton('account-web') : null,
  ].filter(Boolean);
  return [
    legalNeeded(which) ? legalCard(which) : null,
    providerButtons.length ? [...providerButtons, h('p', { class: 'muted small account__or' }, 'or with your email')] : null,
    ownNotes
      ? h('p', { class: 'notice' }, 'You\'re signing in to your own server, ', userText('strong', hostOf(ctx.config.supabaseUrl)),
        ', not your Mullo account. Back to Mullo: Settings, Developers, Your own server.')
      : null,
    h('form', { class: 'card stack', data: tagged(which, { action: 'account-send' }) },
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, 'Your email'),
        h('input', { name: 'email', type: 'email', autocomplete: 'email', value: s.email, placeholder: 'you@example.com', autofocus: true })),
      h('button', { type: 'submit', class: 'btn btn--primary', disabled: locked, data: { gate: 'legal' } }, 'Email me a code')),
    h('p', { class: 'muted small' }, 'No password. We email you a code each time you sign in on a new device. New here? The same code makes your account.'),
    h('p', { class: 'muted small' }, 'Signing in doesn\'t change the notes on this device.'),
  ];
}

// "Continue with Google / Apple" on a phone: the phone's own sheet → the provider's ID token →
// a Mullo session. `idToken(nonceHash)` is native.js googleIdToken / appleIdToken.
async function providerSheet(el, provider, idToken) {
  const which = whichOf(el);
  if (!legalAgreed(which)) { ctx.toast(LEGAL_FIRST, { error: true }); return; }
  el.disabled = true;
  try {
    const nonce = await signInNonce();
    const token = await idToken(nonce.hashed);
    noteTicked(legalNeeded(which)); // told to Mullo's server once the sign-in lands (app.js, core/legal.js)
    const user = await accountFor(which).signInWithIdToken(provider, token, nonce.raw);
    signInFor(which).agreed = { privacy: false, terms: false }; // ticked again at the next sign-in
    ctx.toast(which === 'mullo' ? `Signed in to Mullo as ${user.email}` : `Signed in as ${user.email}`);
  } catch (err) {
    noteTicked(false);
    if (!err.cancelled) ctx.toast(err.message, { error: true });
  } finally { el.disabled = false; }
}

// Turns a form's submit button off while the server answers.
async function busy(form, work) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try { await work(); } catch (err) { ctx.toast(err.message, { error: true }); } finally { if (button) button.disabled = false; }
}

function languagesPage() {
  const s = getSettings();
  const { common, all } = languageGroups();
  const opt = ([code, label]) => h('option', { value: code, selected: code === s.transcript }, label);
  return subpage('Languages',
    h('div', { class: 'card stack' },
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, 'Language you speak - what to listen for'),
        languageSelect({ id: 'set-listen', data: { action: 'settings-change', field: 'listen' } }, s.listen)),
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, 'Write the transcript in'),
        h('select', { id: 'set-transcript', data: { action: 'settings-change', field: 'transcript' } },
          h('option', { value: SAME, selected: s.transcript === SAME }, 'Same as the language spoken'),
          h('optgroup', { label: 'Common' }, common.filter(([c]) => c !== 'auto').map(opt)),
          h('optgroup', { label: 'All languages' }, all.map(opt))))),
    h('p', { class: 'muted small' }, s.transcript === SAME
      ? 'The transcript keeps every word in the language it was said.'
      : 'Gemini translates what was said into this language, faithfully. The summary and tasks follow the transcript.'));
}

function namesPage() {
  const s = getSettings();
  return subpage('Names & words',
    h('p', { class: 'small' }, 'Names of family, colleagues, clients, products - one per line. Gemini spells them like this in transcripts, titles and tasks.'),
    h('textarea', {
      id: 'set-vocabulary', rows: '8', dir: 'auto',
      placeholder: 'One name or word per line',
      value: s.vocabulary.join('\n'),
      data: { action: 'settings-change', field: 'vocabulary', on: 'change' },
    }),
    h('p', { class: 'muted small' }, `If you mix languages, write both spellings on one line, the second in brackets. Up to ${MAX_VOCABULARY}. Applies to new transcripts - use Re-transcribe on older recordings.`));
}

function formatForm(t) {
  return h('form', { class: 'card stack', data: { action: 'format-save', id: t?.id ?? '' } },
    h('h2', { class: 'card__title' }, t ? 'Edit format' : 'Make your own'),
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'Name'),
      h('input', { name: 'label', dir: 'auto', maxlength: '40', value: t?.label ?? '', placeholder: 'Name', autocomplete: 'off' })),
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'Sections, one per line'),
      h('textarea', { name: 'text', rows: '6', dir: 'auto', placeholder: 'One section per line', value: t ? templateText(t) : '' })),
    h('p', { class: 'muted small' }, 'After a colon, say what goes in that section, in any language. For example "Decisions: only what we agreed on". Up to 8 sections.'),
    h('label', { class: 'row format-tasks' },
      h('input', { type: 'checkbox', name: 'tasks', checked: t ? t.blocks.some((b) => b.kind === 'actions') : true }),
      h('span', null, 'End with a To do list')),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'format-cancel' } }, 'Cancel')));
}

// Which AI writes summaries (S54): the list and what this plan allows come from Mullo's server.
// Their own OpenAI or Claude key keeps that company's model, so no list then.
function modelGroup() {
  if (!mulloServer()) return null;
  const key = ownAi(ctx.config);
  if (key && key.provider !== 'gemini') {
    return h('p', { class: 'muted small' }, `Your own ${PROVIDER_LABEL[key.provider] ?? 'AI'} key writes your summaries with its own model.`);
  }
  if (!mulloAccount().user()) return h('p', { class: 'muted small' }, 'Sign in to choose which AI writes your summaries.');
  const asked = answer('models', () => loadModels(ctx.config.bridgeUrl));
  const rows = pickerRows(asked.value, { ownGemini: key?.provider === 'gemini' });
  return h('section', { class: 'set-group' },
    h('h2', { class: 'set-group__title' }, 'AI model'),
    h('p', { class: 'muted small' }, 'Writes the summary, tasks, Ask answers and drafts. Transcripts always use Mullo\'s default.'),
    asked.error ? h('p', { class: 'notice notice--alert' }, asked.error.message) : null,
    h('div', { class: 'set-list' }, rows.map((m) => h('button', {
      type: 'button', class: ['set-row', 'set-choice', m.current && 'is-selected', !m.allowed && 'is-locked'],
      'aria-pressed': String(m.current), data: { action: 'model-pick', id: m.id, allowed: m.allowed ? '1' : '' },
    },
    h('span', { class: 'set-row__text' },
      h('span', { class: 'set-row__title' }, m.label,
        m.badge === 'recommended' ? h('span', { class: 'badge badge--model' }, 'Recommended') : null,
        m.badge === 'new' ? h('span', { class: 'badge badge--model' }, 'New') : null,
        m.tier === 'max' ? h('span', { class: 'badge badge--max' }, 'MAX') : null),
      m.line ? h('span', { class: 'set-row__sub' }, m.line) : null),
    h('span', { class: 'set-choice__mark', 'aria-hidden': 'true' }, m.current ? '✓' : (m.allowed ? '' : '🔒'))))));
}

function summariesPage() {
  const s = getSettings();
  const own = customFormats();
  const editing = formatEditing === 'new' ? null : own.find((t) => t.id === formatEditing);
  return subpage('Summaries',
    modelGroup(),
    h('p', { class: 'muted small' }, 'How new recordings are summarised. You can change it on any recording later.'),
    choiceList('template', allFormats().map((t) => [t.id, t.label, t.blocks.map((b) => b.heading).join(' · ')]), s.template),
    own.length
      ? h('section', { class: 'set-group' },
        h('h2', { class: 'set-group__title' }, 'Your own formats'),
        h('div', { class: 'set-list' }, own.map((t) => h('div', { class: 'set-row storage-row' },
          h('span', { class: 'set-row__text' }, userText('span', t.label, { class: 'set-row__title' })),
          formatDeleting === t.id
            ? h('span', { class: 'row' },
              h('button', { type: 'button', class: 'btn btn--small btn--danger', data: { action: 'format-delete', id: t.id } }, 'Delete'),
              h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'format-cancel' } }, 'Keep'))
            : h('span', { class: 'row' },
              h('button', { type: 'button', class: 'btn btn--small', data: { action: 'format-edit', id: t.id } }, 'Edit'),
              h('button', { type: 'button', class: 'btn btn--small btn--ghost', 'aria-label': `Delete ${t.label}`, data: { action: 'format-delete-ask', id: t.id } }, 'Delete'))))))
      : null,
    formatEditing
      ? formatForm(editing)
      : own.length < MAX_CUSTOM_TEMPLATES
        ? h('button', { type: 'button', class: 'btn', data: { action: 'format-new' } }, '+ Make your own format')
        : null);
}

// ── S44 / S45: privacy choices (Privacy & data) ─────────────────────────
const KEEP_AUDIO_CHOICES = [
  ['keep', 'Keep it', 'Play it back and re-transcribe it any time.'],
  ['notes', 'Delete once the notes are made', 'As soon as the transcript, summary and tasks are ready.'],
  ['7', 'Delete after 7 days', 'Counted from the day you recorded it.'],
  ['30', 'Delete after 30 days', 'Counted from the day you recorded it.'],
];
const KEEP_AUDIO_LABEL = { keep: 'Kept', notes: 'Deleted once the notes are made', 7: 'Deleted after 7 days', 30: 'Deleted after 30 days' };
const SERVER_KEEP_CHOICES = [
  ['collected', 'Until my phone has it', 'Deleted the moment your phone saves it. If your phone can\'t say so, an hour at most.'],
  ['1h', '1 hour'],
  ['6h', '6 hours'],
  ['24h', '24 hours', 'The most time to collect it after a long loss of signal.'],
];
const SERVER_KEEP_LABEL = { collected: 'Until your phone has it', '1h': '1 hour', '6h': '6 hours', '24h': '24 hours' };
let keepConfirm = null; // a deleting choice waiting for "yes" on the Keep recordings page

async function keepAudioPage() {
  const s = getSettings();
  const report = await loadKeepReport();
  const asking = keepConfirm && keepConfirm !== s.keepAudio ? keepConfirm : null;
  const label = KEEP_AUDIO_CHOICES.find(([v]) => v === asking)?.[1];
  return subpage('Keep recordings',
    h('p', { class: 'muted small' }, 'What happens to a recording\'s audio once Mullo has made its notes. The transcript, summary and tasks always stay.'),
    h('div', { class: 'set-list' }, KEEP_AUDIO_CHOICES.map(([value, title, sub]) =>
      h('button', {
        type: 'button', class: ['set-row', 'set-choice', value === s.keepAudio && 'is-selected'],
        'aria-pressed': String(value === s.keepAudio), data: { action: 'keep-audio-pick', value },
      },
      h('span', { class: 'set-row__text' }, h('span', { class: 'set-row__title' }, title), h('span', { class: 'set-row__sub' }, sub)),
      h('span', { class: 'set-choice__mark', 'aria-hidden': 'true' }, value === s.keepAudio ? '✓' : '')))),
    asking
      ? h('div', { class: 'card stack' },
        h('h2', { class: 'card__title' }, `${label}?`),
        h('p', { class: 'muted small' }, `This deletes the audio of ${report[asking]} recording${report[asking] === 1 ? '' : 's'} now, on this phone and in your account, for good. You can't undo it.`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn--danger', data: { action: 'keep-audio-yes', value: asking } }, 'Yes, delete it'),
          h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'keep-audio-cancel' } }, 'Cancel')))
      : null,
    h('p', { class: 'muted small' }, 'Deleted means gone: from this phone and from your account\'s copy, with no copy kept for restoring, so you can\'t play it or re-transcribe it. A deleted recording\'s audio goes too, and restoring it from Activity brings back only the words. Your other phones and computers keep audio they already downloaded until you choose the same there.'));
}

function serverKeepPage() {
  const s = getSettings();
  return subpage('Mullo\'s server',
    h('p', { class: 'muted small' }, 'To make a transcript, your recording passes through Mullo\'s server. It deletes the audio as soon as the transcript is written. The transcript then waits there so a phone that lost signal can still collect it. Choose how long:'),
    choiceList('serverKeep', SERVER_KEEP_CHOICES, s.serverKeep),
    h('p', { class: 'muted small' }, 'Shorter is more private. If the transcript is gone before your phone collects it, Mullo sends the recording again, which uses minutes again. Applies to recordings sent from now on, from this phone and its watch.'));
}

function appearancePage() {
  const s = getSettings();
  return subpage('Appearance',
    choiceList('appearance', [['system', 'Match system', 'Follows your phone'], ['dark', 'Dark'], ['light', 'Light']], s.appearance));
}

// The techy things in one place (owner, 2026-10-10): the plan itself lives in Subscription.
function developersSubtitle() {
  if (ctx.config?.ownServer) return `Your own server: ${hostOf(ctx.config.supabaseUrl)}`;
  const own = mulloServer() ? ownAi(ctx.config) : null;
  if (own) return `Your own ${PROVIDER_LABEL[own.provider] ?? 'AI'} key${own.hint ? ` …${own.hint}` : ''}`;
  if (ctx.config?.aiPlan === 'pro') return `Mullo Pro key …${proKeyHint()}`;
  return 'Your own AI key, MCP, API keys, your own server';
}

// The plan's use, as a meter: minutes for a trial, this month's share otherwise.
// The plan's minutes, as a meter of what's left.
function planUse(me) {
  if (me.minutesAllowed) {
    const left = minutesLeft(me);
    return [
      h('meter', { class: 'live__meter', min: '0', max: String(me.minutesAllowed), value: String(left), low: String(Math.round(me.minutesAllowed * 0.2)), 'aria-label': 'Minutes left' }),
      h('p', { class: 'muted small' }, me.plan === 'trial'
        ? 'Free minutes, once. Minutes of recordings sent to the AI; summaries and Ask are included.'
        : `Minutes of recordings sent to the AI this month; summaries and Ask are included. Back to ${me.minutesAllowed.toLocaleString('en-US')} on the 1st.`),
    ];
  }
  if (me.plan === 'none') return h('p', { class: 'muted small' }, 'Mullo AI isn\'t on this account. Get Mullo Pro, or wait for free minutes to open.');
  return null;
}

// ── Admin (owner, 2026-10-17: its own group at the bottom of Settings, one page per tool;
// it was a card in Developers, but it isn't developer setup). Shown only to admins
// (/api/me said so); the server checks again on every call.
const isAdminHere = () => Boolean(knownPlan(mulloAccount().user()?.id)?.admin);

function adminRows() {
  if (!isAdminHere()) return null;
  return group('Admin',
    linkRow('#/settings/admin-dashboard', '📊', 'Dashboard', 'People, Pro, minutes, reports'),
    linkRow('#/settings/admin-trials', '⏳', 'Trials', 'Free minutes for new accounts, pause all'),
    linkRow('#/settings/admin-free', '🎁', 'Free Mullo AI', 'Give or take back by email'),
    linkRow('#/settings/admin-models', '🧠', 'Summary models', 'Tiers, default, Test'),
    linkRow('#/settings/admin-reports', '📮', 'Reports', 'Problems people sent'));
}

// ── Report a problem (S56, domain/report.js). The text lives in reportView so a re-render
// (picking a screenshot) never empties the box.
const reportView = { text: '', shot: null, details: false, sent: false, sending: false, error: null };

function reportEnv() {
  return {
    version: APP_VERSION,
    platform: platformOf({ android: inAndroidApp(), phoneApp: inPhoneApp() }),
    userAgent: navigator.userAgent,
    hash: lastScreen(),
    plan: knownPlan(mulloAccount().user()?.id)?.plan ?? null,
    language: navigator.language,
    noteId: reportNote(),
  };
}

async function reportPage() {
  const server = mulloServer();
  const canSend = Boolean(server && mulloAccount().user()) && navigator.onLine !== false;
  const noteId = reportNote();
  const note = noteId ? await getRecording(noteId) : null;
  const details = detailsNow(reportEnv());
  const why = !server ? 'Reports go to Mullo\'s server, which this setup doesn\'t use.'
    : !mulloAccount().user() ? 'Sign in to Mullo to send a report from here.'
      : 'You\'re offline.';
  return subpage('Report a problem',
    reportView.sent ? h('p', { class: 'notice notice--info' }, 'Thanks, it reached us.') : null,
    h('form', { class: 'card stack', data: { action: 'report-send' } },
      note ? h('p', { class: 'muted small' }, `About the note from ${relativeDay(note.local_date)}`) : null,
      h('label', { class: 'field' },
        h('span', { class: 'field__label' }, 'What happened?'),
        h('textarea', { name: 'text', rows: '6', dir: 'auto', maxlength: String(MAX_TEXT), placeholder: 'What you did, what you expected, what happened instead', data: { action: 'report-text', draft: 'report-text' } }, reportView.text)),
      canSend
        ? (reportView.shot
          ? h('div', { class: 'row report-shot' },
            h('img', { src: reportView.shot.url, alt: 'Your screenshot', class: 'report-shot__img' }),
            h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'report-shot-remove' } }, 'Remove'))
          : h('label', { class: 'btn btn--ghost report-shot__pick' }, 'Add a screenshot',
            h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', data: { action: 'report-shot' } })))
        : null,
      h('p', { class: 'muted small' }, 'We also send: Mullo version, device, screen, plan and recent errors. Never your notes. ',
        h('button', { type: 'button', class: 'btn btn--ghost btn--small', data: { action: 'report-details' } }, reportView.details ? 'Hide' : 'See what\'s sent')),
      reportView.details ? userText('pre', detailsText(details), { class: 'report-details' }) : null,
      reportView.error ? h('p', { class: 'notice notice--alert' }, reportView.error) : null,
      canSend ? null : h('p', { class: 'small' }, `${why} Email us instead: it opens your email app with the details filled in.`),
      h('div', { class: 'row' },
        canSend ? h('button', { type: 'submit', class: 'btn btn--primary', disabled: reportView.sending }, reportView.sending ? 'Sending…' : 'Send') : null,
        h('button', { type: 'button', class: canSend ? 'btn btn--ghost' : 'btn btn--primary', data: { action: 'report-email' } }, 'Email us instead'))));
}

// ── Admin: the reports people sent (worker/src/reports.mjs).
const reportsView = { status: 'open', shots: new Map() };

function adminReportsPage() {
  const status = reportsView.status;
  const asked = answer(`admin-reports-${status}`, () => mulloAccount().server(ctx.config.bridgeUrl, `/api/admin/reports?status=${status}`));
  const list = asked.value?.reports ?? [];
  return adminOnly('Reports', h('div', { class: 'stack' },
    choiceList('reports-status', [['open', `Open${asked.value && status === 'open' ? ` (${asked.value.open})` : ''}`], ['closed', 'Closed', 'Deleted 90 days after closing']], status),
    asked.error ? h('p', { class: 'notice notice--alert' }, asked.error.message) : null,
    asked.value && !list.length ? h('p', { class: 'muted small' }, status === 'open' ? 'No open reports.' : 'No closed reports.') : null,
    list.map((r) => h('div', { class: 'card stack' },
      userText('p', r.text, { class: 'report__text' }),
      h('p', { class: 'muted small' }, `${new Date(r.created_at * 1000).toLocaleString()} · `, userText('span', r.email ?? 'no email')),
      h('details', null, h('summary', { class: 'small' }, 'Details'), userText('pre', detailsText(r.details), { class: 'report-details' })),
      reportsView.shots.get(r.id) ? h('img', { src: reportsView.shots.get(r.id), alt: 'Screenshot', class: 'report-shot__full' }) : null,
      h('div', { class: 'row' },
        r.has_screenshot && !reportsView.shots.get(r.id) ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'admin-report-shot', id: r.id } }, 'Screenshot') : null,
        r.email ? h('a', { class: 'btn btn--ghost', href: `mailto:${r.email}?subject=${encodeURIComponent('Re: your Mullo problem report')}` }, 'Reply by email') : null,
        h('button', { type: 'button', class: 'btn', data: { action: 'admin-report-status', id: r.id, status: r.status === 'open' ? 'closed' : 'open' } }, r.status === 'open' ? 'Close' : 'Reopen'))))));
}

const adminOnly = (title, body) => subpage(title, isAdminHere() ? body : h('p', { class: 'muted small' }, 'Admins only.'));

// ── Admin: the dashboard and its reports (S59, ui/admin-stats.js; worker admin-reports.mjs).
function adminDashboardPage() {
  const asked = answer('admin-dashboard', () => mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/dashboard'));
  return adminOnly('Dashboard', h('div', { class: 'stack' },
    asked.error ? h('p', { class: 'notice notice--alert' }, asked.error.message) : null,
    asked.value ? dashboardBody(asked.value) : h('p', { class: 'muted small' }, 'Counting…')));
}

const STATS_TITLE = { people: 'People & plans', subscriptions: 'Subscriptions', heavy: 'Heavy users & limits', features: 'Feature use',
  legal: 'Privacy & Terms', problems: 'Problem reports', log: 'Admin log', groups: 'How people use Mullo', cost: 'AI use & cost' };

function adminStatsPage(name) {
  const asked = answer(`admin-stats-${name}`, () => mulloAccount().server(ctx.config.bridgeUrl, `/api/admin/stats/${name}`));
  return adminOnly(asked.value?.title ?? STATS_TITLE[name] ?? 'Report', h('div', { class: 'stack' },
    asked.error ? h('p', { class: 'notice notice--alert' }, asked.error.message) : null,
    asked.value ? reportBody(asked.value) : h('p', { class: 'muted small' }, 'Counting…')));
}

function adminTrialsPage() {
  const asked = answer('admin', () => mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/settings'));
  const s = asked.value;
  return adminOnly('Trials', h('div', { class: 'card stack' },
    asked.error ? h('p', { class: 'notice notice--alert' }, asked.error.message) : null,
    s ? [
      h('form', { class: 'stack', data: { action: 'admin-trial' } },
        h('label', { class: 'field' },
          h('span', { class: 'field__label' }, 'Free minutes for new accounts (0 = no trial)'),
          h('input', { name: 'minutes', type: 'number', min: '0', max: '100000', step: '1', inputmode: 'numeric', value: String(s.trialMinutes) })),
        h('p', { class: 'muted small' }, 'Applies from the next new account. People already on a trial keep what they were given.'),
        h('button', { type: 'submit', class: 'btn' }, 'Save')),
      h('label', { class: 'set-row' }, rowInner('⏸', 'Pause all trials', 'Stops every trial now; lift it to carry on'),
        h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: s.trialsPaused, 'aria-label': 'Pause all trials', data: { action: 'admin-pause' } })),
    ] : null));
}

function adminFreePage() {
  return adminOnly('Free Mullo AI', h('form', { class: 'card stack', data: { action: 'admin-grant' } },
    h('label', { class: 'field' },
      h('span', { class: 'field__label' }, 'Free Mullo AI by email (their own monthly allowance)'),
      h('input', { name: 'email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com' })),
    h('select', { name: 'plan', 'aria-label': 'What to do' },
      h('option', { value: 'free' }, 'Give free Mullo AI'),
      h('option', { value: 'none' }, 'Take it back')),
    h('p', { class: 'muted small' }, 'Works before they sign up: it waits for that email\'s first sign-in.'),
    h('button', { type: 'submit', class: 'btn' }, 'Apply')));
}

// Summary models (S54): tier (Pro / Max / Off), badge, thinking, the one default, and Test
// before switching on. Test tries the other thinking settings when the chosen one fails.
const adminTest = {};
const THINKING_LABEL = [['none', 'No thinking'], ['minimal', 'Minimal'], ['low', 'Low']];
function adminModelsPage() {
  const asked = answer('admin-models', () => mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/models'));
  const list = asked.value?.models ?? [];
  return adminOnly('Summary models', h('form', { class: 'card stack', data: { action: 'admin-models' } },
    asked.error ? h('p', { class: 'notice notice--alert' }, asked.error.message) : null,
    list.map((m, i) => h('div', { class: 'stack admin-model' },
      h('p', { class: 'set-row__title' }, m.label, h('span', { class: 'muted small' }, ` ${m.id}`)),
      h('div', { class: 'row' },
        h('select', { name: `tier-${i}`, 'aria-label': `${m.label} tier` },
          [['standard', 'Pro'], ['max', 'Max'], ['off', 'Off']].map(([v, l]) => h('option', { value: v, selected: m.tier === v }, l))),
        h('select', { name: `badge-${i}`, 'aria-label': `${m.label} badge` },
          [['none', 'No badge'], ['recommended', 'Recommended'], ['new', 'New']].map(([v, l]) => h('option', { value: v, selected: m.badge === v }, l))),
        h('select', { name: `thinking-${i}`, 'aria-label': `${m.label} thinking` },
          THINKING_LABEL.map(([v, l]) => h('option', { value: v, selected: m.thinking === v }, l))),
        h('label', { class: 'row' }, h('input', { type: 'radio', name: 'default', value: m.id, checked: m.isDefault }), 'Default'),
        h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'admin-model-test', id: m.id, index: i } }, 'Test')),
      adminTest[m.id] ? h('p', { class: 'muted small' }, adminTest[m.id]) : null)),
    h('p', { class: 'muted small' }, 'Pro models: every paying account. Max: Mullo Max (own Gemini keys too). Thinking: if Test fails, it tries the other settings and says which works; pick that one and save. Test a model before turning it on.'),
    list.length ? h('button', { type: 'submit', class: 'btn' }, 'Save models') : null));
}

// What Test found: each thinking setting it tried, in order, with Google's own words on a failure.
function testLine(r) {
  const name = (t) => THINKING_LABEL.find(([v]) => v === t)?.[1] ?? t;
  const tried = r.tried?.length ? r.tried : [{ ...r, thinking: r.thinking ?? 'none' }];
  return tried.map((t) => t.ok
    ? `${name(t.thinking)}: works, "${t.title}", ${t.actions} tasks, ${(t.ms / 1000).toFixed(1)} s`
    : `${name(t.thinking)}: failed, ${t.error}`).join(' · ');
}

// Bring your own AI key: only through Mullo's server, the one place that can open the sealed key.
// Adding one and using one both need a Mullo sign-in (S25): the key pays, the sign-in says who.
function ownKeyCard() {
  if (!mulloServer()) return null;
  const own = ownAi(ctx.config);
  const signedIn = Boolean(mulloAccount().user());
  if (own) {
    return h('div', { class: 'card stack' },
      h('h2', { class: 'card__title' }, 'Your own AI key'),
      h('p', null, `${PROVIDER_LABEL[own.provider] ?? 'AI'} key${own.hint ? ` …${own.hint}` : ''} is ${signedIn ? 'in use' : 'saved'}.`),
      signedIn ? null : signInForKey('Sign in to Mullo to keep using your key: it still pays, the sign-in says it\'s you.'),
      h('p', { class: 'muted small' }, `${PROVIDER_BILLER[own.provider] ?? 'The AI company'} bills you directly, and no Mullo minutes are used. Watch notes use it too.`),
      transcribesWith(own.provider) ? null
        : h('p', { class: 'notice' }, 'Claude doesn\'t take audio, so transcripts still use your Mullo plan. Titles, summaries, tasks and Ask run on Claude.'),
      own.provider === 'openai'
        ? h('p', { class: 'muted small' }, 'OpenAI transcribes recordings up to 25 MB (about 1 hour 45 minutes), labels speakers, and doesn\'t use your Names and words list or translate.')
        : null,
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'ai-own-remove' } }, 'Stop using my key'));
  }
  const intro = h('p', { class: 'small' }, 'Have a Gemini, OpenAI or Claude API key? Mullo can run on it: that company bills you, and no Mullo minutes are used.');
  if (!signedIn) {
    return h('div', { class: 'card stack' }, h('h2', { class: 'card__title' }, 'Use your own AI key'), intro,
      signInForKey('Sign in to Mullo first, then add your key.'));
  }
  return h('form', { class: 'card stack', data: { action: 'ai-own-save' } },
    h('h2', { class: 'card__title' }, 'Use your own AI key'),
    intro,
    h('input', { name: 'key', type: 'password', autocomplete: 'off', placeholder: 'AIza… / AQ. (Gemini), sk-… (OpenAI), sk-ant-… (Claude)', 'aria-label': 'Your AI API key' }),
    h('button', { type: 'submit', class: 'btn btn--primary' }, 'Use this key'),
    h('p', { class: 'muted small' }, 'Claude doesn\'t take audio: with a Claude key, transcripts still use your Mullo plan.'),
    h('p', { class: 'muted small' }, 'It\'s checked with its company, then locked so only Mullo\'s server can use it, and kept on this device. Mullo doesn\'t store it.'));
}

// What runs where, at the top of Settings, Developers.
function aiIntro(own) {
  const tail = 'Recordings stay on this device; audio passes through to the AI and is not stored by Mullo.';
  if (own?.provider === 'openai') return `Transcripts, titles, summaries, tasks and Ask run on OpenAI, with your key. ${tail}`;
  if (own?.provider === 'anthropic') return `Titles, summaries, tasks and Ask run on Claude, with your key; transcripts on Google Gemini through your Mullo plan. ${tail}`;
  return `Transcripts, titles, summaries, tasks and Ask run on Google Gemini. ${tail}`;
}

// "Sign in to Mullo" where a key waits for it (S25).
function signInForKey(text) {
  return h('div', { class: 'notice stack' },
    h('p', { class: 'small' }, text),
    h('a', { class: 'btn btn--primary', href: mulloSignInHref(ctx.config) }, 'Sign in to Mullo'));
}

// A Mullo Pro key (Android only: it's sealed natively). Behind the sign-in (S25): the key
// becomes part of the Mullo account, and the sign-in is what's sent.
function proKeyCard(pro) {
  if (!mulloAccount().user()) {
    return h('div', { class: 'card stack' },
      h('h2', { class: 'card__title' }, 'Mullo Pro key'),
      pro ? h('p', null, `Saved: key …${proKeyHint()}`) : null,
      signInForKey(pro ? 'Sign in to Mullo to keep using it: the key becomes part of your account.' : 'Sign in to Mullo first: a Mullo Pro key becomes part of your account.'),
      pro ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'ai-pro-remove' } }, 'Remove this key') : null);
  }
  return h('form', { class: 'card stack', data: { action: 'ai-pro-save' } },
    h('h2', { class: 'card__title' }, 'Mullo Pro key'),
    pro ? h('p', null, `In use: key …${proKeyHint()}`) : null,
    h('p', { class: 'muted small' }, 'Paste the key from your Mullo Pro welcome page: it becomes part of your Mullo account. It is encrypted on this phone.'),
    h('input', { name: 'key', type: 'password', autocomplete: 'off', placeholder: 'echo_...', 'aria-label': 'Mullo Pro key' }),
    h('button', { type: 'submit', class: 'btn btn--primary' }, pro ? 'Use a different key' : 'Save key'),
    pro ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'ai-pro-remove' } }, 'Remove this key') : null);
}

// Developers (was "AI", owner 2026-10-10): your own AI key, Claude/ChatGPT over MCP, API keys,
// your own server, a Pro key. The plan is shown in Subscription only; admin tools have their
// own group at the bottom of Settings (adminRows).
function developersPage() {
  const plan = ctx.config?.aiPlan;
  const own = Boolean(ctx.config?.ownServer);
  return subpage('Developers',
    h('p', { class: 'muted small' }, aiIntro(mulloServer() ? ownAi(ctx.config) : null)),
    ownKeyCard(),
    own ? null : yourAiCard(),
    own ? null : apiKeysCard(),
    serverCard(),
    inAndroidApp() ? proKeyCard(plan === 'pro') : null);
}

// Two taps for anything that deletes: the button, then "Yes, ..." in its place.
function freeButton(key, label, confirmLabel) {
  return storageConfirm === key
    ? h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--danger', data: { action: 'storage-free', what: key } }, confirmLabel),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'storage-cancel' } }, 'Cancel'))
    : h('button', { type: 'button', class: 'btn', data: { action: 'storage-ask', what: key } }, label);
}

function storageRow(i, today) {
  let control;
  if (!i.removable) control = h('span', { class: 'muted small' }, 'Not transcribed yet');
  else if (storageConfirm === i.id) {
    control = h('span', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--small btn--danger', data: { action: 'storage-free', what: 'one', id: i.id } }, 'Remove'),
      h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'storage-cancel' } }, 'Keep'));
  } else {
    control = h('button', {
      type: 'button', class: 'btn btn--small', 'aria-label': 'Remove the audio, keep the words',
      data: { action: 'storage-ask', what: i.id },
    }, 'Remove audio');
  }
  return h('div', { class: 'set-row storage-row' },
    h('span', { class: 'set-row__text' },
      userText('span', i.title, { class: 'set-row__title' }),
      h('span', { class: 'set-row__sub' }, `${relativeDay(localDate(new Date(i.recorded_at)), today)} · ${timeOfDay(i.recorded_at)} · ${formatBytes(i.bytes)}`)),
    control);
}

async function storagePage() {
  const r = await loadStorage();
  const today = localDate();
  return subpage('Storage',
    h('section', { class: 'usage' },
      h('h2', { class: 'usage__title' }, 'On this phone'),
      h('div', { class: 'usage__tiles' },
        h('div', { class: 'usage__tile' }, h('span', { class: 'usage__label' }, 'Mullo uses'), h('span', { class: 'usage__value' }, r.usage != null ? formatBytes(r.usage) : '-')),
        h('div', { class: 'usage__tile' }, h('span', { class: 'usage__label' }, `Audio of ${r.audio.count} recordings`), h('span', { class: 'usage__value' }, formatBytes(r.audio.bytes)))),
      h('p', { class: 'usage__foot' }, cloudStatus().state === 'mine'
        ? 'Also copied to your account. Removing audio here frees this phone; the copy in your account stays.'
        : 'Saved on this phone only. Sign in to copy them into your account.')),

    r.deleted.count
      ? h('div', { class: 'card stack' },
        h('h2', { class: 'card__title' }, `Audio of deleted recordings · ${formatBytes(r.deleted.bytes)}`),
        h('p', { class: 'muted small' }, 'Kept so a recording restored from Activity comes back with its audio. Freeing it deletes that audio for good; the recordings can still be restored, without audio.'),
        freeButton('deleted', `Free up ${formatBytes(r.deleted.bytes)}`, 'Yes, delete it for good'))
      : null,

    r.old.count
      ? h('div', { class: 'card stack' },
        h('h2', { class: 'card__title' }, `Older than ${OLD_AFTER_DAYS} days · ${formatBytes(r.old.bytes)}`),
        h('p', { class: 'muted small' }, `The audio of ${r.old.count} transcribed recordings. Their transcripts, summaries and tasks stay; you just can't play them or re-transcribe.`),
        freeButton('old', 'Remove their audio', `Yes, remove ${r.old.count}`))
      : null,

    r.items.length
      ? h('section', { class: 'set-group' },
        h('h2', { class: 'set-group__title' }, 'Biggest first'),
        h('div', { class: 'set-list' }, r.items.slice(0, 30).map((i) => storageRow(i, today))))
      : h('p', { class: 'muted small' }, 'No audio stored.'),
    h('p', { class: 'muted small' }, 'Removing audio keeps the transcript, summary and tasks. It is logged in Activity.'));
}

// ── Connections (spec docs/specs/2026-10-08-connections-design.md) ──────
// Apps that reach Mullo (the person's own AI, through MCP) and apps Mullo hands things to.
// Disconnect waits for a second tap: `connectConfirm` is the app's client id.
let connectConfirm = null;

// Where /mcp lives: Mullo's own server, when this copy of Mullo uses it.
// The web app at mullo.lizai.io/app/ is served BY Mullo's server: bridgeUrl '' = this same site.
function mulloServer() {
  const plan = ctx.config?.aiPlan;
  const url = ctx.config?.bridgeUrl;
  if ((plan !== 'account' && plan !== 'pro') || typeof url !== 'string') return null;
  return url ? url.replace(/\/+$/, '') : location.origin;
}

// The apps this account let in (Supabase's OAuth server). → { list } | { off } | { problem }
async function connectedApps() {
  try {
    const res = await account().request('auth/v1/user/oauth/grants');
    if (res.status === 404) return { off: true };
    if (!res.ok) return { problem: `The account server answered ${res.status}.` };
    const list = await res.json();
    return { list: (Array.isArray(list) ? list : []).map((g) => ({
      id: g.client?.id ?? g.client_id,
      // Mullo's own client behind API keys: disconnecting it turns every key off.
      name: (g.client?.name ?? g.client_name) === 'Mullo API keys' ? 'Your API keys (all of them)' : (g.client?.name ?? g.client_name ?? 'An app'),
      at: g.granted_at ?? g.created_at ?? null,
    })).filter((g) => g.id) };
  } catch (err) { return { problem: err.message }; }
}

function appRow(app) {
  const since = app.at ? `Connected ${new Date(app.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Connected';
  return h('div', { class: 'set-row' },
    h('span', { class: 'set-row__icon', 'aria-hidden': 'true' }, '🤖'),
    h('span', { class: 'set-row__text' }, userText('span', app.name, { class: 'set-row__title' }), h('span', { class: 'set-row__sub' }, since)),
    connectConfirm === app.id
      ? h('span', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--small btn--danger', data: { action: 'connect-remove', id: app.id } }, 'Disconnect'),
        h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'connect-cancel' } }, 'Keep'))
      : h('button', { type: 'button', class: 'btn btn--small', data: { action: 'connect-ask', id: app.id } }, 'Disconnect'));
}

function yourAiCard() {
  const server = mulloServer();
  const user = account().user();
  const head = [
    h('h2', { class: 'card__title' }, 'Claude, ChatGPT and other AI apps'),
    h('p', { class: 'small' }, 'Ask your own AI about your meetings, in its own chat. It can search and read your notes; it can\'t change anything or hear your audio.'),
  ];
  if (!server) return h('div', { class: 'card stack' }, head, h('p', { class: 'muted small' }, 'This works through Mullo\'s own server, which this copy of Mullo doesn\'t use.'));
  if (!user) {
    return h('div', { class: 'card stack' }, head,
      h('p', { class: 'muted small' }, 'Sign in first: your AI reads the notes in your Mullo account.'),
      h('a', { class: 'btn btn--primary', href: '#/settings/account' }, 'Sign in'));
  }
  const apps = answer('apps', connectedApps).value ?? {};
  return h('div', { class: 'card stack' }, head,
    cloudStatus().state !== 'mine'
      ? h('p', { class: 'notice' }, 'Your AI reads the copy in your account, and this phone isn\'t syncing yet. See ', h('a', { href: '#/settings/account' }, 'Account'), '.')
      : null,
    h('span', { class: 'field__label' }, 'The address to give it'),
    h('input', { class: 'connect__address', readonly: true, value: `${server}/mcp`, 'aria-label': 'Mullo MCP address' }),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'connect-copy' } }, 'Copy address'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'connect-howto' } }, 'How to connect')),
    apps.off ? h('p', { class: 'muted small' }, 'Connecting AI apps is being switched on. The address works as soon as it is.') : null,
    apps.problem ? h('p', { class: 'notice notice--alert' }, apps.problem) : null,
    apps.list?.length
      ? h('section', { class: 'set-group' }, h('h3', { class: 'set-group__title' }, 'Connected'), h('div', { class: 'set-list' }, apps.list.map(appRow)))
      : apps.list ? h('p', { class: 'muted small' }, 'No apps connected yet.') : null);
}

// API keys: the new key is shown once (kept here until leaving the page); revoking waits
// for a second tap (`keyConfirm` = the key's id).
const keyView = { fresh: null, confirm: null };

function keyRow(k) {
  const day = (s) => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const sub = !k.working ? 'Turned off (its access was disconnected)'
    : `Made ${day(k.createdAt)}${k.lastUsedAt ? ` · last used ${day(k.lastUsedAt)}` : ' · not used yet'}`;
  return h('div', { class: 'set-row' },
    h('span', { class: 'set-row__icon', 'aria-hidden': 'true' }, '🔑'),
    h('span', { class: 'set-row__text' }, userText('span', k.name, { class: 'set-row__title' }), h('span', { class: 'set-row__sub' }, sub)),
    keyView.confirm === k.id
      ? h('span', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--small btn--danger', data: { action: 'key-revoke', id: k.id } }, 'Revoke'),
        h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'key-cancel' } }, 'Keep'))
      : h('button', { type: 'button', class: 'btn btn--small', data: { action: 'key-ask', id: k.id } }, 'Revoke'));
}

function apiKeysCard() {
  const server = mulloServer();
  if (!server || !account().user()) return null;
  const asked = answer('keys', async () => (await mulloAccount().server(server, '/api/keys')).keys);
  const list = asked.value ?? null;
  const problem = asked.error?.message ?? null;
  return h('div', { class: 'card stack' },
    h('h2', { class: 'card__title' }, 'API keys'),
    h('p', { class: 'small' }, 'For your own scripts and automations (n8n, Zapier, Make), and AI tools that take a key instead of signing in. A key reads your notes, like the apps above; it can\'t change anything.'),
    keyView.fresh
      ? h('div', { class: 'notice stack' },
        h('p', null, `Your new key "${keyView.fresh.name}". Copy it now: it is shown only once.`),
        h('input', { class: 'connect__address', readonly: true, value: keyView.fresh.key, 'aria-label': 'Your new API key' }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'key-copy' } }, 'Copy key'),
          h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'key-done' } }, 'Done')),
        h('p', { class: 'muted small' }, `Send it as a bearer token in the Authorization header, to ${server}/v1/recordings, /v1/recordings/<id> and /v1/tasks, or to ${server}/mcp.`))
      : null,
    problem ? h('p', { class: /switched on/.test(problem) ? 'muted small' : 'notice notice--alert' }, problem) : null,
    list?.length ? h('div', { class: 'set-list' }, list.map(keyRow)) : null,
    list ? h('form', { class: 'row', data: { action: 'key-new' } },
      h('input', { name: 'name', maxlength: '40', placeholder: 'What it\'s for, e.g. n8n', 'aria-label': 'Key name' }),
      h('button', { type: 'submit', class: 'btn' }, 'New key')) : null);
}

// Your own server: the move's row counts once checked; in a browser, the server waiting for a
// yes (`pending`, checked) or a yes to going back (`back`). All cleared when leaving the page.
const serverView = { counts: null, pending: null, back: false };
const TABLE_LABEL = { folders: 'Folders', recordings: 'Recordings', audio_files: 'Audio files', transcripts: 'Transcripts', action_items: 'Tasks', activity: 'History entries' };

function hostOf(u) { try { return new URL(u).host; } catch { return u ?? ''; } }

// The person said yes to their own server (Android's dialog): close every way into their
// account on Mullo's server first (API keys, connected apps, every other device), then switch.
// This phone's Mullo sign-in is kept for the AI (S25; native moves it to its second slot).
// If that fails, the server stays as it was and they can try again with signal.
export async function leaveMulloServer() {
  try {
    await account().endAllAccess(mulloServer(), { keepThisDevice: true });
    finishServerChange(true);
  } catch (err) {
    finishServerChange(false);
    ctx.toast(`Your server wasn't changed: ${err.message}`, { error: true });
  }
}

// In a browser the page itself asks (Android asks in a native dialog): the same words.
function serverConfirm() {
  return h('div', { class: 'notice stack' },
    h('p', null, 'Use your own server? ', userText('strong', hostOf(serverView.pending.url))),
    h('p', { class: 'small' }, 'On Mullo\'s server, every connected app (Claude, ChatGPT...) and API key is disconnected, and you\'re signed out on your other devices. Here you stay signed in to Mullo for the AI only: your plan or your own AI key keep working through it. Then sign in on your server: it\'s a new account there. The notes on this device stay and are copied there once you sign in.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'server-confirm' } }, 'Use it'),
      h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'server-cancel' } }, 'Cancel')));
}

function serverCard() {
  const own = Boolean(ctx.config?.ownServer);
  const setupUrl = mulloServer() ? `${mulloServer()}/setup` : null;
  if (!own) {
    return h('div', { class: 'card stack' },
      h('h2', { class: 'card__title' }, 'Your own server'),
      h('p', { class: 'small' }, 'Your notes are copied to Mullo\'s server. You can keep them on your own Supabase project instead; the notes on this device stay either way.'),
      serverView.pending ? serverConfirm()
        : h('form', { class: 'stack', data: { action: 'server-use' } },
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Project URL'),
            h('input', { name: 'url', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://… (Project Settings, API)' })),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Publishable key'),
            h('input', { name: 'key', autocomplete: 'off', placeholder: 'The publishable key, never the secret one' })),
          h('button', { type: 'submit', class: 'btn' }, 'Use my server')),
      inAndroidApp() ? null : h('p', { class: 'muted small' }, 'In a browser: a project on Supabase\'s own hosting. A self-hosted server works in the Android app.'),
      setupUrl ? h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'server-setup', from: '0' } }, 'How to set one up') : null,
      h('p', { class: 'muted small' }, 'Connected AI apps and API keys work on Mullo\'s server only. The AI keeps working on your own server: you stay signed in to Mullo for it, with your plan, a Mullo Pro key or your own AI key.'));
  }
  const asked = answer('schema', () => account().schemaVersion());
  const version = asked.value ?? null;
  let state;
  if (!asked.done) state = h('p', { class: 'muted small' }, 'Checking your server…');
  else if (version === null) state = h('p', { class: 'notice notice--alert' }, 'Mullo couldn\'t reach your server. Check the address, or try again with signal.');
  else if (version < SCHEMA_STEP) {
    state = h('div', { class: 'notice stack' },
      h('p', null, version === 0 ? 'Your server doesn\'t have Mullo\'s tables yet.' : `Your server is at setup step ${version}; this Mullo needs step ${SCHEMA_STEP}.`),
      h('p', { class: 'small' }, 'Run the SQL in your project\'s SQL editor, then come back. Mullo never changes your server\'s tables itself.'),
      setupUrl ? h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'server-setup', from: String(version) } }, 'Open the setup SQL') : null);
  } else state = h('p', { class: 'small account__ok' }, 'Ready: it has everything this Mullo needs.');
  const counts = serverView.counts;
  const moved = counts && counts.every((c) => c.there !== null && c.there >= c.here);
  return h('div', { class: 'card stack' },
    h('h2', { class: 'card__title' }, 'Your own server'),
    h('p', null, 'Your notes are copied to ', userText('strong', hostOf(ctx.config.supabaseUrl)), '.'),
    state,
    cloudStatus().state === 'mine'
      ? [
        h('button', { type: 'button', class: 'btn', data: { action: 'server-count' } }, 'Check the move'),
        counts ? h('div', { class: 'set-list' }, counts.map((c) => h('div', { class: 'set-row' },
          h('span', { class: 'set-row__text' }, h('span', { class: 'set-row__title' }, TABLE_LABEL[c.table] ?? c.table),
            h('span', { class: 'set-row__sub' }, `${c.here} on this device · ${c.there ?? '?'} on your server`)),
          h('span', { 'aria-hidden': 'true' }, c.there !== null && c.there >= c.here ? '✓' : '…')))) : null,
        counts ? h('p', { class: moved ? 'small account__ok' : 'muted small' }, moved ? 'Moved: everything on this device is on your server.' : 'Not all there yet. Copying carries on in the background; check again in a while.') : null,
      ]
      : h('p', { class: 'muted small' }, account().user() ? 'Starting to copy everything on this device here (Settings, Account shows how it goes).' : 'Next: sign in here (Settings, Account). Everything on this device then moves here by itself.'),
    serverView.back
      ? h('div', { class: 'notice stack' },
        h('p', null, mulloAccount().user()
          ? 'Back to Mullo\'s server? You\'ll be signed out of your own server here; your Mullo sign-in carries on as your account. The notes on this device stay.'
          : 'Back to Mullo\'s server? You\'ll be signed out here. Sign in again with your Mullo account. The notes on this device stay.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'server-back-confirm' } }, 'Use Mullo\'s server'),
          h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'server-cancel' } }, 'Cancel')))
      : h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'server-mullo' } }, 'Back to Mullo\'s server'));
}

// Connections (owner, 2026-10-10, like Pocket's): the apps Mullo works with, one row each,
// with what you can do today on the right. The techy setup lives in Developers.
const connRow = (icon, title, sub, end) => h('div', { class: 'set-row conn-row' }, rowInner(icon, title, sub), end);
const connChip = (label, kind) => h('span', { class: `conn-chip${kind ? ` conn-chip--${kind}` : ''}` }, label);
// AI apps open a sheet with what to paste (owner, 2026-10-14, like Pocket's "Connect Claude"),
// not the Developers page. `connSheet` = the app shown, or null.
let connSheet = null;
const AI_APPS = {
  claude: {
    name: 'Claude', go: 'claude', docs: 'mcp-claude',
    steps: 'In Claude on the web or desktop: Settings, Connectors, Add custom connector. Paste the name and the address, tap Connect, then sign in to Mullo and Approve. It then works in the Claude phone app too.',
  },
  chatgpt: {
    name: 'ChatGPT', go: 'chatgpt', docs: 'mcp-chatgpt',
    steps: 'In ChatGPT on the web: Settings, Apps and Connectors, turn on Developer mode (Advanced settings), then Create. Paste the name and the address, choose OAuth, then sign in to Mullo and Approve.',
  },
};
const connectBtn = (app) => h('button', { type: 'button', class: 'conn-chip conn-chip--action', data: { action: 'conn-sheet', app } }, 'Connect');

function connSheetView() {
  const app = AI_APPS[connSheet];
  const server = mulloServer();
  if (!app || !server) return null;
  const field = (label, value, what) => h('div', { class: 'conn-sheet__field' },
    h('span', { class: 'conn-sheet__text' },
      h('span', { class: 'conn-sheet__label' }, label),
      h('span', { class: 'conn-sheet__value' }, value)),
    h('button', { type: 'button', class: 'btn btn--small', data: { action: 'conn-copy', what } }, 'Copy'));
  const user = account().user();
  const entering = take('conn-sheet');
  return [
    h('button', { type: 'button', class: ['conn-sheet-backdrop', entering && 'is-entering'], 'aria-label': 'Close', data: { action: 'conn-sheet-close' } }),
    h('div', { class: ['conn-sheet', 'stack', entering && 'is-entering'], role: 'dialog', 'aria-modal': 'true', 'aria-label': `Connect ${app.name}` },
      h('div', { class: 'row conn-sheet__head' },
        h('h2', { class: 'conn-sheet__title' }, `Connect ${app.name}`),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', data: { action: 'conn-sheet-close' } }, '✕')),
      h('p', { class: 'small' }, `Add Mullo as a connector so ${app.name} can search and read your notes. It can't change anything or hear your audio.`),
      !user
        ? h('p', { class: 'notice' }, `Sign in to Mullo first (`, h('a', { href: '#/settings/account' }, 'Account'), `): ${app.name} reads the notes in your Mullo account.`)
        : cloudStatus().state !== 'mine'
          ? h('p', { class: 'notice' }, `${app.name} reads the copy in your account, and this device isn't syncing yet. See `, h('a', { href: '#/settings/account' }, 'Account'), '.')
          : null,
      h('div', { class: 'conn-sheet__fields' },
        field('Name', 'Mullo', 'name'),
        field('Remote MCP server URL', `${server}/mcp`, 'url')),
      h('p', { class: 'muted small' }, app.steps),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'conn-docs' } }, 'Step by step')),
      h('button', { type: 'button', class: 'btn btn--primary conn-sheet__open', data: { action: 'conn-open' } }, `Open ${app.name}`)),
  ];
}

async function connectionsPage() {
  const aiApps = mulloServer() && !ctx.config?.ownServer;
  return subpage('Connections',
    aiApps ? group('AI apps',
      connRow('✳️', 'Claude', 'Ask Claude about your notes, in its own chat', connectBtn('claude')),
      connRow('💬', 'ChatGPT', 'Ask ChatGPT about your notes, in its own chat', connectBtn('chatgpt')),
      connRow('🛠️', 'Other AI apps and API keys', 'Cursor, Claude Code, your own scripts; what\'s connected', h('a', { class: 'conn-chip conn-chip--action', href: '#/settings/developers' }, 'Developers'))) : null,
    group('Calendar and tasks',
      connRow('📅', 'Your phone\'s calendar', 'Tap 📅 on a task: it opens filled in, on its date', connChip('Built in')),
      // Own rows (owner, 2026-10-14): Calendar needs no Google review, Tasks waits for it
      // (GOOGLE_TASKS on the Worker). Once Tasks is on, one Google connection still serves both.
      connRow('🗓️', 'Google Calendar', 'Tasks with a date, in a calendar called Mullo', googleChip()),
      connRow('✅', 'Google Tasks', 'Open tasks, in a list called Mullo', tasksChip())),
    group('Notes and documents',
      connRow('📤', 'Any notes app', 'Notion, Google Docs, Keep: open a recording, tap Share', connChip('Built in')),
      connRow('📝', 'Notion', 'Every note, kept in sync', connChip('Coming soon', 'soon')),
      connRow('📁', 'Google Drive', 'Every note, kept in sync', connChip('Coming soon', 'soon'))),
    group('Email',
      connRow('✉️', 'Gmail', 'A follow-up email, drafted from your meeting', connChip('Coming soon', 'soon'))),
    connSheetView());
}

// Google Calendar and Google Tasks (roadmap S9, domain/google.js): connected once to the Mullo
// account, on Mullo's server, so every device signed in to it sends its tasks.
const googleChip = () => (googleAvailable()
  ? h('a', { class: 'conn-chip conn-chip--action', href: '#/settings/google' }, googleOn() ? 'On' : 'Set up')
  : connChip('Coming soon', 'soon'));
// Google Tasks: Coming soon until the Worker says it's on (the last status this device saw).
const tasksChip = () => (googleAvailable() && answer('google', googleStatus).value?.tasksReady
  ? h('a', { class: 'conn-chip conn-chip--action', href: '#/settings/google' }, googleOn() ? 'On' : 'Set up')
  : connChip('Coming soon', 'soon'));

// `waiting`: Google's page was opened outside Mullo; coming back asks the server again (focused()).
const googleView = { busy: false, confirmOff: false, waiting: false };

export function focused() {
  if (googleView.waiting) { askAgain('google'); ctx.refresh(); }
  // Back from Android's "Alarms & reminders" page: the rows that show it follow.
  else if (remindersOnPhone() && ['settings', 'actions'].includes(parseRoute(location.hash).screen)) ctx.refresh();
}

function googleSentLine(last) {
  if (!last) return null;
  if (last.error) return h('p', { class: 'notice notice--alert' }, last.error);
  const n = last.sent;
  return h('p', { class: 'muted small' }, `Last sent at ${timeOfDay(last.at)}: ${n ? `${n} ${n === 1 ? 'change' : 'changes'}` : 'nothing new'}.`);
}

function googlePage() {
  const withTasks = Boolean(answer('google', googleStatus).value?.tasksReady);
  const title = withTasks ? 'Google Calendar and Tasks' : 'Google Calendar';
  if (!googleAvailable()) {
    return subpage(title, h('p', { class: 'muted' }, 'This works with Mullo\'s own server. On your own server, tap 📅 on a task to add it to your phone\'s calendar.'));
  }
  if (!account().user()) {
    return subpage(title, h('p', null, 'Sign in first (Settings, Account). Google is connected to your Mullo account, so every device you sign in on sends its tasks.'));
  }
  const asked = answer('google', googleStatus);
  const s = asked.value;
  if (s?.connected) googleView.waiting = false;
  const problem = asked.error?.message ?? null;
  const connectBtn = (label) => h('button', { type: 'button', class: 'btn btn--primary', disabled: googleView.busy, data: { action: 'google-connect' } }, label);
  const what = h('div', { class: 'set-list' },
    connRow('🗓️', 'Google Calendar', 'A task with a date becomes an all-day event on that day, in a calendar called Mullo',
      s?.connected ? connChip(s.calendar ? 'On' : 'Not allowed', s.calendar ? null : 'soon') : null),
    withTasks ? connRow('✅', 'Google Tasks', 'Every open task goes to a list called Mullo. Ticked done in Mullo, it\'s ticked there too',
      s?.connected ? connChip(s.tasks ? 'On' : 'Not allowed', s.tasks ? null : 'soon') : null) : null);
  let body;
  if (!s) body = problem ? h('p', { class: 'notice notice--alert' }, problem) : h('p', { class: 'muted' }, 'Checking…');
  else if (!s.ready) body = h('p', { class: 'muted' }, 'Coming soon: Google isn\'t switched on on Mullo\'s server yet.');
  else if (!s.connected) {
    body = [
      h('p', null, 'Mullo sends your tasks to your Google account by itself:'),
      what,
      h('p', { class: 'muted small' }, withTasks
        ? 'Mullo can only touch the calendar and the list it makes. It sends; changes you make in Google don\'t come back to Mullo. Tasks finished before you connect aren\'t sent.'
        : 'Mullo can only touch the calendar it makes. It sends; changes you make in Google don\'t come back to Mullo. Tasks finished before you connect aren\'t sent. Google Tasks is coming soon.'),
      withTasks ? h('p', { class: 'muted small' }, 'Google asks for both at once. Want only one? Untick the other on Google\'s screen.') : null,
      connectBtn('Connect Google'),
      inPhoneApp() ? h('p', { class: 'muted small' }, 'Google opens in your browser. When it says connected, come back to Mullo.') : null,
    ];
  } else {
    body = [
      s.gone
        ? h('div', { class: 'notice notice--alert stack' }, h('p', null, 'Google stopped letting Mullo in (the access was removed, or the password changed).'), connectBtn('Connect again'))
        : h('p', null, 'Connected. New and changed tasks go to Google by themselves.'),
      what,
      googleSentLine(lastGoogleSync()),
      googleView.confirmOff
        ? h('div', { class: 'notice stack' },
          h('p', null, `Disconnect Google? Mullo stops sending tasks, on every device. The Mullo ${withTasks ? 'calendar and list stay' : 'calendar stays'} in your Google account; delete ${withTasks ? 'them' : 'it'} there if you like.`),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn btn--primary', disabled: googleView.busy, data: { action: 'google-off-confirm' } }, 'Disconnect'),
            h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'google-off-cancel' } }, 'Cancel')))
        : h('div', { class: 'row' },
          s.gone ? null : h('button', { type: 'button', class: 'btn', disabled: googleView.busy, data: { action: 'google-sync' } }, 'Send now'),
          h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'google-off' } }, 'Disconnect')),
    ];
  }
  return subpage(title, h('div', { class: 'card stack' }, body));
}

const PAGES = { account: accountPage, 'mullo-account': mulloAccountPage, subscription: subscriptionPage, languages: languagesPage, names: namesPage, summaries: summariesPage, appearance: appearancePage, 'keep-audio': keepAudioPage, 'server-keep': serverKeepPage, developers: developersPage, ai: developersPage, storage: storagePage, connections: connectionsPage, google: googlePage,
  'admin-trials': adminTrialsPage, 'admin-free': adminFreePage, 'admin-models': adminModelsPage,
  report: reportPage, 'admin-reports': adminReportsPage, 'admin-dashboard': adminDashboardPage };

export async function render({ section } = {}) {
  if (section !== 'storage') storageConfirm = null;
  if (section !== 'keep-audio') keepConfirm = null;
  if (section !== 'account') { signIn.confirmOut = false; signIn.confirmDelete = false; }
  if (section !== 'mullo-account') mulloIn.confirmOut = false;
  if (section !== 'summaries') { formatEditing = null; formatDeleting = null; }
  if (section !== 'google') { googleView.confirmOff = false; googleView.waiting = false; }
  if (section !== 'connections') connSheet = null;
  if (section !== 'report') { reportView.sent = false; reportView.details = false; reportView.error = null; }
  if (section !== 'admin-reports') reportsView.shots.clear();
  if (section !== 'developers' && section !== 'ai') {
    connectConfirm = null; keyView.fresh = null; keyView.confirm = null;
    serverView.counts = null; serverView.pending = null; serverView.back = false;
  }
  // Another account's answers are never shown, not even for a moment.
  const who = `${account().user()?.id ?? ''}|${mulloAccount().user()?.id ?? ''}`;
  if (who !== liveUser) { live.clear(); liveUser = who; }
  if (section !== liveSection) { askAgain(); liveSection = section; }
  if (statsName(section)) return adminStatsPage(statsName(section));
  return PAGES[section] ? PAGES[section]() : hub();
}

export const actions = {
  'settings-change'(el) {
    const field = el.dataset.field;
    const value = field === 'vocabulary' ? parseVocabulary(el.value) : el.value;
    updateSettings({ [field]: value });
    ctx.toast(field === 'vocabulary' ? `Saved ${value.length} names & words` : 'Saved');
    if (field === 'transcript' || field === 'vocabulary') ctx.refresh({ force: true });
  },
  'settings-toggle'(el) {
    updateSettings({ [el.dataset.field]: el.checked });
    // Reminders: its other rows come and go. Drafts: the line under the switch changes.
    if (el.dataset.field === 'reminders' || el.dataset.field === 'autoDrafts') ctx.refresh({ force: true });
  },
  'legal-tick'(el) {
    const which = whichOf(el);
    signInFor(which).agreed[el.dataset.page] = el.checked;
    // Only the buttons change: a re-render waits while the email box has focus.
    for (const button of document.querySelectorAll('[data-gate="legal"]')) button.disabled = !legalAgreed(which);
  },
  'account-send'(form) {
    const which = whichOf(form);
    if (!legalAgreed(which)) { ctx.toast(LEGAL_FIRST, { error: true }); return undefined; }
    return busy(form, async () => {
      const s = signInFor(which);
      s.email = await accountFor(which).sendCode(form.elements.email.value);
      s.step = 'code';
      ctx.toast('Code sent - check your email');
      ctx.refresh({ force: true });
    });
  },
  'account-verify'(form) {
    const which = whichOf(form);
    return busy(form, async () => {
      const s = signInFor(which);
      // The ticks reach Mullo's server once the sign-in lands (app.js, core/legal.js).
      noteTicked(legalNeeded(which) && legalAgreed(which));
      let user;
      try { user = await accountFor(which).verifyCode(s.email, form.elements.code.value); } catch (err) { noteTicked(false); throw err; }
      s.step = 'email';
      s.agreed = { privacy: false, terms: false }; // ticked again at the next sign-in
      ctx.toast(which === 'mullo' ? `Signed in to Mullo as ${user.email}` : `Signed in as ${user.email}`);
    });
  },
  // The phone's own sheet: Google (Android, iPhone) or Apple (iPhone).
  'account-google'(el) { return providerSheet(el, 'google', googleIdToken); },
  'account-apple'(el) { return providerSheet(el, 'apple', appleIdToken); },
  // A browser: off to Google's / Apple's own page, back to this screen signed in (app.js
  // finishSignInRedirect). The ticks travel with it, since the page reloads on the way back.
  async 'account-web'(el) {
    const which = whichOf(el);
    if (!legalAgreed(which)) { ctx.toast(LEGAL_FIRST, { error: true }); return; }
    el.disabled = true;
    try {
      const to = await accountFor(which).redirectUrl(el.dataset.provider, location.origin + location.pathname,
        { which, ticked: legalNeeded(which), back: location.hash || '#/settings/account' });
      location.assign(to);
    } catch (err) {
      ctx.toast(err.message, { error: true });
      el.disabled = false;
    }
  },
  async 'account-resend'(el) {
    const which = whichOf(el);
    el.disabled = true;
    try {
      await accountFor(which).sendCode(signInFor(which).email);
      ctx.toast('New code sent');
    } catch (err) { ctx.toast(err.message, { error: true }); } finally { el.disabled = false; }
  },
  async 'cloud-link'(el) {
    el.disabled = true;
    try {
      await linkDevice();
      ctx.toast('Syncing with your account');
    } catch (err) { ctx.toast(err.message, { error: true }); el.disabled = false; }
    ctx.refresh({ force: true });
  },
  // Notes the server keeps for another account (cloud-sync useForeignHere): new ids, copied up.
  async 'cloud-use-here'(el) {
    el.disabled = true;
    try {
      await useForeignHere();
      ctx.toast('Copying them into this account');
    } catch (err) { ctx.toast(err.message, { error: true }); el.disabled = false; }
    ctx.refresh({ force: true });
  },
  // Signed in with the wrong account: out of this one, to the sign-in page.
  async 'cloud-other-account'() {
    await account().signOut();
    location.hash = '#/settings/account';
    ctx.refresh({ force: true });
  },
  // This phone syncs with another account; the person picks the one signed in now.
  async 'cloud-switch'(el) {
    el.disabled = true;
    try {
      await switchToThisAccount();
      ctx.toast('Syncing with this account');
    } catch (err) { ctx.toast(err.message, { error: true }); el.disabled = false; }
    ctx.refresh({ force: true });
  },
  async 'cloud-retry'(el) {
    el.disabled = true;
    const s = await retryNow();
    ctx.toast(s.stuck ? `${s.stuck} still couldn't be copied` : 'All copied');
    ctx.refresh({ force: true });
  },
  async 'cloud-now'(el) {
    el.disabled = true;
    await syncNow({ pull: true });
    ctx.refresh({ force: true });
  },
  'cloud-clashes-ok'() { clearClashes(); ctx.refresh({ force: true }); },
  'account-other'(el) { signInFor(whichOf(el)).step = 'email'; ctx.refresh({ force: true }); },
  'account-out-ask'(el) { signInFor(whichOf(el)).confirmOut = true; ctx.refresh({ force: true }); },
  'account-out-cancel'(el) { signInFor(whichOf(el)).confirmOut = false; ctx.refresh({ force: true }); },
  async 'account-out'(el) {
    const which = whichOf(el);
    signInFor(which).confirmOut = false;
    await accountFor(which).signOut();
    ctx.toast(which === 'mullo' ? 'Signed out of Mullo - the AI waits until you sign in again' : 'Signed out - your notes are still on this device');
  },
  'account-delete-ask'() { signIn.confirmDelete = true; signIn.confirmOut = false; ctx.refresh({ force: true }); },
  'account-delete-cancel'() { signIn.confirmDelete = false; ctx.refresh({ force: true }); },
  async 'account-delete'(el) {
    el.disabled = true;
    el.textContent = 'Deleting…';
    try {
      // Signed in with Apple, on the iPhone: Apple confirms once and hands a fresh code, so Mullo's
      // server can revoke Apple's link to Mullo with the delete (App Store rule 5.1.1(v), apple.mjs).
      const server = ctx.config?.ownServer ? null : mulloServer();
      const appleCode = server && appleCodeAvailable() && account().signInMethods().includes('apple')
        ? await appleAuthCode() : null;
      await account().deleteAccount(server, { appleCode });
      forgetAccountCopy();
      signIn.confirmDelete = false;
      signIn.step = 'email';
      ctx.toast('Your account is deleted. The notes on this phone are still here.');
      location.hash = '#/settings';
      ctx.refresh({ force: true });
    } catch (err) {
      ctx.toast(err.cancelled ? 'Not deleted. Confirm with Apple to delete your account.' : err.message, { error: true });
      el.disabled = false;
      el.textContent = 'Yes, delete my account';
    }
  },
  // Saved natively (Keystore); the app restarts so config.json carries the new plan.
  'ai-pro-save'(form) {
    const key = form.elements.key.value.trim();
    if (!key) { ctx.toast('Paste your key first', { error: true }); return; }
    const problem = saveProKey(key);
    form.elements.key.value = '';
    if (problem) { ctx.toast(problem, { error: true }); return; }
    ctx.toast('Key saved - restarting Mullo');
    setTimeout(() => location.reload(), 600);
  },
  async 'photo-pick'(input) {
    const file = input.files?.[0];
    input.value = '';
    const user = account().user();
    if (!file || !user) return;
    try {
      savePhoto(user.id, await shrinkPhoto(file));
      ctx.toast('Photo saved');
    } catch (err) { ctx.toast(err.message, { error: true }); }
    ctx.refresh({ force: true });
  },
  'photo-remove'() {
    removePhoto(account().user()?.id);
    ctx.refresh({ force: true });
  },
  // iPhone (S22c, domain/store.js): Apple's purchase sheet, then the plan again.
  async 'store-buy'(el) {
    el.disabled = true;
    try {
      const done = await buyPro();
      if (done === 'bought') ctx.toast('Mullo Pro is on. Thank you!');
      else if (done === 'pending') ctx.toast('Waiting for approval. Mullo Pro turns on once it\'s approved.');
      askAgain('me');
    } catch (err) { ctx.toast(err.message, { error: true }); } finally { el.disabled = false; ctx.refresh({ force: true }); }
  },
  async 'store-restore'(el) {
    el.disabled = true;
    try {
      const n = await restorePro();
      ctx.toast(n ? 'Mullo Pro restored' : 'No Mullo Pro purchase found for this Apple ID');
      askAgain('me');
    } catch (err) { ctx.toast(err.message, { error: true }); } finally { el.disabled = false; ctx.refresh({ force: true }); }
  },
  'store-manage'() { storeManage(); },
  async 'sub-checkout'(el) {
    el.disabled = true;
    try {
      const { url } = await mulloAccount().server(ctx.config.bridgeUrl, '/api/billing/checkout', {});
      openOutside(url);
    } catch (err) {
      ctx.toast(err.message, { error: true });
    } finally { el.disabled = false; }
  },
  async 'sub-portal'(el) {
    el.disabled = true;
    try {
      const { url } = await billingPortal();
      openOutside(url);
    } catch (err) {
      ctx.toast(err.message, { error: true });
    } finally { el.disabled = false; }
  },
  'admin-trial'(form) {
    return busy(form, async () => {
      const minutes = Math.floor(Number(form.elements.minutes.value));
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('Minutes are a whole number, 0 or more.');
      const s = await mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/settings', { trialMinutes: minutes });
      ctx.toast(s.trialMinutes ? `New accounts get ${s.trialMinutes} free minutes` : 'No trial for new accounts');
      askAgain('admin');
      ctx.refresh({ force: true });
    });
  },
  async 'admin-pause'(el) {
    try {
      const s = await mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/settings', { trialsPaused: el.checked });
      ctx.toast(s.trialsPaused ? 'All trials paused' : 'Trials carry on');
    } catch (err) {
      el.checked = !el.checked;
      ctx.toast(err.message, { error: true });
    }
  },
  async 'model-pick'(el) {
    if (!el.dataset.allowed) { ctx.toast(`${TIER_LABEL.max} models come with Mullo Max, coming soon.`); return; }
    try {
      await pickModel(ctx.config.bridgeUrl, el.dataset.id);
      askAgain('models');
      ctx.refresh({ force: true });
    } catch (err) { ctx.toast(err.message, { error: true }); }
  },
  'admin-models'(form) {
    return busy(form, async () => {
      const current = (await mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/models')).models;
      const def = form.elements.default.value;
      const models = current.map((m, i) => ({
        ...m, tier: form.elements[`tier-${i}`].value, badge: form.elements[`badge-${i}`].value,
        thinking: form.elements[`thinking-${i}`].value, isDefault: m.id === def,
      }));
      await mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/models', { models });
      askAgain('admin-models', 'models');
      ctx.toast('Models saved');
      ctx.refresh({ force: true });
    });
  },
  async 'admin-model-test'(el) {
    el.disabled = true;
    try {
      // The thinking setting on screen, saved or not, so a change can be tried before saving.
      const thinking = el.form?.elements[`thinking-${el.dataset.index}`]?.value;
      const r = await mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/models/test', { id: el.dataset.id, thinking });
      adminTest[el.dataset.id] = testLine(r);
    } catch (err) {
      adminTest[el.dataset.id] = `Failed: ${err.message}`;
    } finally { el.disabled = false; ctx.refresh({ force: true }); }
  },
  'admin-grant'(form) {
    return busy(form, async () => {
      const email = form.elements.email.value.trim();
      const plan = form.elements.plan.value;
      const out = await mulloAccount().server(ctx.config.bridgeUrl, '/api/admin/grant', { email, plan });
      form.elements.email.value = '';
      if (plan === 'free') ctx.toast(out.signedUp ? 'Free Mullo AI is on for them now' : 'Done. It starts when they first sign in');
      else ctx.toast('Taken back');
    });
  },
  // The key goes once to Mullo's server, which tells Gemini, OpenAI and Claude keys apart,
  // checks it with that company and seals it; only the sealed text is kept. Then Mullo
  // restarts so every call carries it.
  'ai-own-save'(form) {
    return busy(form, async () => {
      const key = form.elements.key.value.trim();
      form.elements.key.value = '';
      if (!key) throw new Error('Paste your key first');
      // With the Mullo sign-in (S25): Mullo's server seals a key only for a signed-in person.
      const body = await mulloAccount().server(mulloServer(), '/api/own-key', { key });
      const problem = keepOwnAi(body);
      if (problem) throw new Error(problem);
      ctx.toast('Your key is in use - restarting Mullo');
      setTimeout(() => location.reload(), 600);
    });
  },
  'ai-own-remove'() {
    dropOwnAi();
    ctx.toast('Your key is removed - restarting Mullo');
    setTimeout(() => location.reload(), 600);
  },
  'ai-pro-remove'() {
    removeProKey();
    ctx.toast('Key removed - restarting Mullo');
    setTimeout(() => location.reload(), 600);
  },
  'format-new'() { formatEditing = 'new'; formatDeleting = null; ctx.refresh({ force: true }); },
  'format-edit'(el) { formatEditing = el.dataset.id; formatDeleting = null; ctx.refresh({ force: true }); },
  'format-cancel'() { formatEditing = null; formatDeleting = null; ctx.refresh({ force: true }); },
  'format-delete-ask'(el) { formatDeleting = el.dataset.id; ctx.refresh({ force: true }); },
  'format-save'(form) {
    const res = saveFormat({
      id: form.dataset.id || null,
      label: form.elements.label.value,
      text: form.elements.text.value,
      withTasks: form.elements.tasks.checked,
    });
    if (!res.ok) { ctx.toast(res.error, { error: true }); return; }
    formatEditing = null;
    ctx.toast(`Saved "${res.template.label}" - pick it above, or on any recording`);
    ctx.refresh({ force: true });
  },
  'format-delete'(el) {
    deleteFormat(el.dataset.id);
    formatDeleting = null;
    ctx.toast('Format deleted');
    ctx.refresh({ force: true });
  },
  // S44: a choice that would delete audio already here asks first; keep, or nothing to delete, doesn't.
  async 'keep-audio-pick'(el) {
    const { value } = el.dataset;
    const report = await loadKeepReport();
    if (value !== getSettings().keepAudio && report[value] > 0) keepConfirm = value;
    else { keepConfirm = null; updateSettings({ keepAudio: value }); }
    ctx.refresh({ force: true });
  },
  'keep-audio-cancel'() { keepConfirm = null; ctx.refresh({ force: true }); },
  async 'keep-audio-yes'(el) {
    keepConfirm = null;
    el.disabled = true;
    updateSettings({ keepAudio: el.dataset.value });
    const res = await expireAudio();
    if (res.count) ctx.toast(`Deleted the audio of ${res.count} recording${res.count === 1 ? '' : 's'}`);
    ctx.refresh({ force: true });
  },
  'storage-ask'(el) { storageConfirm = el.dataset.what; ctx.refresh({ force: true }); },
  'storage-cancel'() { storageConfirm = null; ctx.refresh({ force: true }); },
  async 'storage-free'(el) {
    const { what, id } = el.dataset;
    storageConfirm = null;
    el.disabled = true;
    if (what === 'deleted') {
      const res = await freeDeletedAudio();
      ctx.toast(`Freed ${formatBytes(res.bytes)}`);
    } else if (what === 'old') {
      const { old } = await loadStorage();
      const res = await removeOldAudio(old.ids);
      ctx.toast(`Removed the audio of ${res.count} recordings · ${formatBytes(res.bytes)} freed`);
    } else {
      const res = await removeRecordingAudio(id);
      ctx.toast(res.ok ? `Audio removed · ${formatBytes(res.bytes)} freed` : res.error, { error: !res.ok });
    }
    ctx.refresh({ force: true });
  },
  async 'connect-copy'() {
    const server = mulloServer();
    if (server && await copyText(`${server}/mcp`)) ctx.toast('Address copied');
  },
  'conn-sheet'(el) { connSheet = AI_APPS[el.dataset.app] ? el.dataset.app : null; mark('conn-sheet'); ctx.refresh({ force: true }); },
  'conn-sheet-close'() { connSheet = null; ctx.refresh({ force: true }); },
  async 'conn-copy'(el) {
    const server = mulloServer();
    const text = el.dataset.what === 'name' ? 'Mullo' : server && `${server}/mcp`;
    if (text && await copyText(text)) ctx.toast(el.dataset.what === 'name' ? 'Name copied' : 'Address copied');
  },
  // Through Mullo's server (/go/…): the app holds no outside addresses (architecture test).
  'conn-open'() {
    const app = AI_APPS[connSheet];
    const server = mulloServer();
    if (app && server) openOutside(`${server}/go/${app.go}`);
  },
  'conn-docs'() {
    const app = AI_APPS[connSheet];
    const server = mulloServer();
    if (app && server) openOutside(`${server}/docs/${app.docs}`);
  },
  'connect-howto'() {
    const server = mulloServer();
    if (server) openOutside(`${server}/connect`);
  },
  // A new API key: Mullo's server opens an authorization, this sign-in approves it, the server
  // turns the approval into a key. Shown once.
  'key-new'(form) {
    return busy(form, async () => {
      const server = mulloServer();
      const { authorizationId } = await mulloAccount().server(server, '/api/keys/start', { name: form.elements.name.value });
      const redirectUrl = await account().approve(authorizationId);
      keyView.fresh = await mulloAccount().server(server, '/api/keys/finish', { redirectUrl });
      askAgain('keys', 'apps'); // a first key also connects "Your API keys"
      ctx.refresh({ force: true });
    });
  },
  async 'key-copy'() {
    if (keyView.fresh && await copyText(keyView.fresh.key)) ctx.toast('Key copied');
  },
  'key-done'() { keyView.fresh = null; ctx.refresh({ force: true }); },

  // Google (googlePage). In a browser Google's page opens here and comes back into the web
  // app; the phone apps open it in the browser, and coming back to Mullo asks again.
  async 'google-connect'() {
    if (googleView.busy) return;
    googleView.busy = true;
    ctx.refresh({ force: true });
    try {
      const outside = inPhoneApp();
      const url = await connectGoogle(outside ? 'app' : 'web');
      if (outside) { googleView.waiting = true; openOutside(url); } else location.assign(url);
    } catch (err) {
      ctx.toast(err.message, { error: true });
    } finally {
      googleView.busy = false;
      ctx.refresh({ force: true });
    }
  },
  async 'google-sync'() {
    if (googleView.busy) return;
    googleView.busy = true;
    ctx.refresh({ force: true });
    try {
      const last = await syncGoogle();
      if (last?.offline) ctx.toast('No connection. Mullo sends them when there\'s signal.');
      else if (last && !last.error) ctx.toast(last.sent ? 'Sent to Google' : 'Google already has everything');
      if (last?.gone) askAgain('google');
    } finally {
      googleView.busy = false;
      ctx.refresh({ force: true });
    }
  },
  'google-off'() { googleView.confirmOff = true; ctx.refresh({ force: true }); },
  'google-off-cancel'() { googleView.confirmOff = false; ctx.refresh({ force: true }); },
  async 'google-off-confirm'() {
    if (googleView.busy) return;
    googleView.busy = true;
    try {
      await disconnectGoogle();
      googleView.confirmOff = false;
      ctx.toast('Google disconnected');
    } catch (err) {
      ctx.toast(err.message, { error: true });
    } finally {
      googleView.busy = false;
      askAgain('google');
      ctx.refresh({ force: true });
    }
  },
  'key-ask'(el) { keyView.confirm = el.dataset.id; ctx.refresh({ force: true }); },
  'key-cancel'() { keyView.confirm = null; ctx.refresh({ force: true }); },
  async 'key-revoke'(el) {
    el.disabled = true;
    keyView.confirm = null;
    try {
      await mulloAccount().server(mulloServer(), '/api/keys/revoke', { id: el.dataset.id });
      ctx.toast('Key revoked. It stops working now.');
    } catch (err) { ctx.toast(err.message, { error: true }); }
    askAgain('keys');
    ctx.refresh({ force: true });
  },
  // Your own server: Android checks the values (a secret key is refused) and asks in its own
  // dialog; on yes it signs out here and restarts Mullo on that server. In a browser the same
  // checks run here (core/own-server.js) and the page asks.
  'server-use'(form) {
    if (inAndroidApp()) {
      const problem = askToUseServer(form.elements.url.value, form.elements.key.value);
      if (problem) ctx.toast(problem, { error: true });
      return;
    }
    const clean = checkServer(form.elements.url.value, form.elements.key.value);
    if (clean.problem) { ctx.toast(clean.problem, { error: true }); return; }
    serverView.pending = clean;
    ctx.refresh({ force: true });
  },
  // Browser: leaving Mullo's server closes every way into the account there first (as on
  // Android); a failed step keeps the server as it was.
  async 'server-confirm'(el) {
    const pending = serverView.pending;
    if (!pending) return;
    el.disabled = true;
    const leaving = !ctx.config?.ownServer;
    try {
      if (leaving) await account().endAllAccess(mulloServer(), { keepThisDevice: true });
    } catch (err) {
      el.disabled = false;
      ctx.toast(`Your server wasn't changed: ${err.message}`, { error: true });
      return;
    }
    // A session belongs to one server; this browser's Mullo sign-in carries on for the AI (S25).
    const mulloSession = leaving ? deviceSessionStore.load() : null;
    if (mulloSession) mulloSessionStore.save(mulloSession);
    deviceSessionStore.clear();
    keepBrowserServer(pending);
    ctx.toast('Switching to your server');
    setTimeout(() => location.reload(), 600);
  },
  'server-cancel'() {
    serverView.pending = null;
    serverView.back = false;
    ctx.refresh({ force: true });
  },
  'server-mullo'() {
    if (!inAndroidApp()) { serverView.back = true; ctx.refresh({ force: true }); return; }
    const problem = askToUseMulloServer();
    if (problem) ctx.toast(problem, { error: true });
  },
  'server-back-confirm'() {
    // Back on Mullo's server, its sign-in for the AI is the one sign-in again (S25).
    const mulloSession = mulloSessionStore.load();
    if (mulloSession) deviceSessionStore.save(mulloSession); else deviceSessionStore.clear();
    mulloSessionStore.clear();
    dropBrowserServer();
    ctx.toast('Back to Mullo\'s server');
    setTimeout(() => location.reload(), 600);
  },
  'open-legal'(el) {
    const server = mulloServer();
    if (server && (el.dataset.page === 'privacy' || el.dataset.page === 'terms')) openOutside(`${server}/${el.dataset.page}`);
  },
  'server-setup'(el) {
    const server = mulloServer();
    if (server) openOutside(`${server}/setup${Number(el.dataset.from) ? `?from=${el.dataset.from}` : ''}`);
  },
  async 'server-count'(el) {
    el.disabled = true;
    serverView.counts = await compareCounts();
    ctx.refresh({ force: true });
  },
  'connect-ask'(el) { connectConfirm = el.dataset.id; ctx.refresh({ force: true }); },
  'connect-cancel'() { connectConfirm = null; ctx.refresh({ force: true }); },
  async 'connect-remove'(el) {
    el.disabled = true;
    connectConfirm = null;
    try {
      const res = await account().request(`auth/v1/user/oauth/grants?client_id=${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`The account server answered ${res.status}.`);
      ctx.toast('Disconnected. It can\'t read your notes any more.');
    } catch (err) { ctx.toast(err.message, { error: true }); }
    askAgain('apps', 'keys'); // disconnecting "Your API keys" turns every key off
    ctx.refresh({ force: true });
  },
  // ── Report a problem (S56)
  'report-text'(el) { reportView.text = el.value; reportView.sent = false; },
  async 'report-shot'(el) {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    try {
      reportView.shot = await shrinkImage(file);
      reportView.error = null;
    } catch (err) {
      reportView.error = err.message;
    }
    ctx.refresh({ force: true });
  },
  'report-shot-remove'() { reportView.shot = null; ctx.refresh({ force: true }); },
  'report-details'() { reportView.details = !reportView.details; ctx.refresh({ force: true }); },
  'report-email'() {
    openOutside(mailtoHref(reportView.text, detailsNow(reportEnv())));
  },
  async 'report-send'(form) {
    if (reportView.sending) return;
    reportView.text = form.elements.text.value;
    reportView.sending = true;
    reportView.error = null;
    ctx.refresh({ force: true });
    const res = await sendReport((url, path, body) => mulloAccount().server(url, path, body), mulloServer(), {
      text: reportView.text, details: detailsNow(reportEnv()), screenshot: reportView.shot?.b64 ?? null,
    });
    reportView.sending = false;
    if (res.ok) {
      Object.assign(reportView, { text: '', shot: null, details: false, sent: true });
      reportAbout(null);
    } else {
      reportView.error = res.offline ? `${res.error} Your report is still here; send it when you're back online, or email us instead.` : res.error;
    }
    ctx.refresh({ force: true });
  },
  async 'admin-report-shot'(el) {
    const res = await mulloAccount().server(ctx.config.bridgeUrl, `/api/admin/reports/${el.dataset.id}/screenshot`);
    reportsView.shots.set(el.dataset.id, res.screenshot);
    ctx.refresh({ force: true });
  },
  'admin-stats-refresh'() {
    const name = statsName(parseRoute(location.hash).params.section);
    askAgain(name ? `admin-stats-${name}` : 'admin-dashboard');
    ctx.refresh({ force: true });
  },
  async 'admin-csv'(el) {
    const csv = csvFor(el.dataset.report, el.dataset.table);
    if (!csv) return;
    // The phone apps' web views don't save a download: copy there instead.
    if (el.dataset.how === 'download' && !inPhoneApp()) {
      const url = URL.createObjectURL(new Blob([csv.text], { type: 'text/csv' }));
      const link = h('a', { href: url, download: csv.name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    ctx.toast(await copyText(csv.text) ? 'CSV copied' : 'Couldn\'t copy');
  },
  async 'admin-report-status'(el) {
    el.disabled = true;
    await mulloAccount().server(ctx.config.bridgeUrl, `/api/admin/reports/${el.dataset.id}`, { status: el.dataset.status });
    askAgain('admin-reports-open', 'admin-reports-closed');
    ctx.refresh({ force: true });
  },

  'settings-pick'(el) {
    const { field, value } = el.dataset;
    if (field === 'reports-status') {
      reportsView.status = value === 'closed' ? 'closed' : 'open';
      askAgain(`admin-reports-${reportsView.status}`);
      ctx.refresh({ force: true });
      return;
    }
    const next = updateSettings({ [field]: value });
    if (field === 'appearance') applyTheme(next.appearance);
    ctx.refresh({ force: true });
  },
};
