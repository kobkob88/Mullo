// Record: press, talk, stop. The audio is kept as evidence; the live
// transcript (browser speech recognition, language chosen up front) feeds the
// pipeline. No microphone or no speech recognition still works: type a note.

import { h, options } from '../dom.js';
import { pageHeader, languageSelect } from '../components.js';
import { speechLang, languageLabel } from '../../core/languages.js';
import { getSettings, updateSettings, SAME } from '../../core/settings.js';
import { ctx } from '../context.js';
import { recordingSupported, startRecorder } from '../../capture/recorder.js';
import { liveTranscribeSupported, startLiveTranscribe } from '../../capture/live-transcribe.js';
import { createRecording, listRecordings } from '../../domain/recordings.js';
import { mascot } from '../mascot.js';
import { appMood } from '../mood.js';
import { saveTranscript, segmentsFromText } from '../../domain/transcripts.js';
import { canTranscribe } from '../../domain/pipeline.js';
import { mulloAccount } from '../../core/account.js';
import { keyWaitsForSignIn, mulloSignInHref } from '../../core/own-ai.js';
import { knownPlan, minutesLeft, planLow } from '../../core/ai-plan.js';
import { summariseInBackground } from '../../domain/jobs.js';
import { saveCapturedAudio } from '../../domain/capture.js';
import { allFormats } from '../../domain/formats.js';
import { formatClock, timeOfDay } from '../../core/dates.js';
import { inAndroidApp, recordingInProgress } from '../../core/native.js';

export const screen = 'record';

let session = null;   // { recorder, live, lang, template, ticker }
let state = 'idle';   // idle | recording | paused | saving
let confirmDiscard = false;
let els = {};

export const isBusy = () => state !== 'idle';
// The mascot listens only while the microphone really records (not paused, not saving).
export const isListening = () => state === 'recording';

// The Settings screen owns these; Record shows the two you change most.
function prefs() {
  const s = getSettings();
  return { lang: s.listen, template: s.template, settings: s };
}

function settingsLine(s) {
  const out = s.transcript === SAME ? 'same as spoken' : languageLabel(s.transcript);
  const names = s.vocabulary.length ? ` · ${s.vocabulary.length} names & words` : '';
  return h('p', { class: 'muted small' },
    `Transcript: ${out}${names} · `,
    h('a', { href: '#/settings' }, 'Settings'));
}

export async function render() {
  const p = prefs();
  els = {};

  if (state !== 'idle' && session) return renderLive();

  const canRecord = recordingSupported();
  const { mood } = appMood(await listRecordings());
  return h('div', { class: 'record' },
    pageHeader('Record'),
    h('div', { class: 'mullo-stage' }, mascot(mood, { size: 'record' })),
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Language you speak'),
        languageSelect({ id: 'rec-lang', data: { action: 'record-pref', pref: 'listen' } }, p.lang)),
      settingsLine(p.settings),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Summarise as'),
        h('select', { id: 'rec-template', data: { action: 'record-pref', pref: 'template' } },
          options(allFormats().map((t) => [t.id, t.label]), p.template))),
      canRecord
        ? h('button', { type: 'button', class: 'rec-button', data: { action: 'record-start' }, 'aria-label': 'Start recording' },
          // Where the floating record button lands when it opens this screen (motion.js land).
          h('span', { class: 'rec-button__dot', data: { landing: 'record' } }), 'Start recording')
        : h('p', { class: 'notice' }, 'This browser cannot record audio. You can still type a note below.'),
      canRecord ? minutesLine() : null,
      canRecord
        ? h('p', { class: 'muted small' }, canTranscribe()
          ? 'When you stop, Gemini writes the transcript in the language above. Any live text while recording is only a preview from your phone.'
          // The iPhone app records natively (MulloRecorder): no browser speech service is involved.
          : globalThis.MulloRecorder
            ? 'The recording is kept on this phone. Sign in to Mullo to get its transcript, summary and tasks.'
          : liveTranscribeSupported()
            ? 'Transcription uses your phone’s speech service, which may ignore the language above and may send audio to the browser maker.'
            : 'Live transcription is not available in this browser - the audio is kept, and you can add the transcript afterwards.')
        : null),
    h('form', { class: 'card stack', data: { action: 'note-save' } },
      h('h2', { class: 'card__title' }, 'Or type a note'),
      h('textarea', {
        id: 'note-text', rows: '5', dir: 'auto', data: { draft: 'note-text' },
        placeholder: 'Remind me to call Dana tomorrow about the invoice…',
      }),
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Save note')));
}

// Minutes left on the plan, where you look before recording; amber when under a fifth.
function minutesLine() {
  // S25: a key on this phone reaches the AI only with a Mullo sign-in beside it.
  if (keyWaitsForSignIn(ctx.config, Boolean(mulloAccount().user()))) {
    return h('a', { class: 'notice', href: mulloSignInHref(ctx.config) }, 'Sign in to Mullo to keep using your key');
  }
  const p = knownPlan(mulloAccount().user()?.id);
  const left = minutesLeft(p);
  if (left === null) return null;
  const words = p.plan === 'trial' ? 'free minutes left' : 'minutes left this month';
  return h('a', { class: `minutes-left${planLow(p) ? ' is-low' : ''}`, href: '#/settings/subscription' },
    `${left.toLocaleString('en-US')} ${words}`);
}

function renderLive() {
  els.timer = h('span', { class: 'live__timer', role: 'timer' }, formatClock(session.recorder.elapsed()));
  els.meter = h('meter', { class: 'live__meter', min: '0', max: '1', value: '0', 'aria-label': 'Microphone level' });
  els.text = h('div', { class: 'live__text', dir: 'auto', 'aria-live': 'polite' });
  els.previewNote = canTranscribe() ? h('p', { class: 'muted small' }, 'Live preview - the final transcript is written when you stop.') : null;
  // A phone browser (iPhone) can't record in the background; the Android app can.
  const phoneBrowser = !inAndroidApp() && !session.recorder.native && globalThis.matchMedia?.('(pointer: coarse)').matches;
  const stayHint = phoneBrowser ? h('p', { class: 'muted small' }, 'Keep Mullo on screen while recording - the phone stops the microphone when you switch apps or lock it.') : null;
  els.discard = h('button', { type: 'button', class: 'btn btn--ghost', data: { action: 'record-discard' } },
    confirmDiscard ? 'Tap again to discard' : 'Discard');
  drawLive(session.lastUpdate ?? { segments: [], interim: '' });
  const face = { recording: 'listening', paused: 'idle', saving: 'mulling' }[state] ?? 'idle';
  return h('div', { class: 'record' },
    pageHeader(state === 'paused' ? 'Paused' : 'Recording'),
    h('div', { class: 'mullo-stage' }, mascot(face, { size: 'live' })),
    h('div', { class: 'card live' },
      h('div', { class: 'live__top' }, h('span', { class: ['live__dot', state === 'paused' && 'is-paused'] }), els.timer, els.meter),
      els.text,
      els.previewNote,
      stayHint,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', data: { action: 'record-pause' }, disabled: state === 'saving' },
          state === 'paused' ? 'Resume' : 'Pause'),
        h('button', { type: 'button', class: 'btn btn--primary', data: { action: 'record-stop' }, disabled: state === 'saving' },
          state === 'saving' ? 'Saving…' : 'Stop & save'),
        els.discard)));
}

function drawLive({ segments, interim }) {
  if (!els.text) return;
  const last = segments.slice(-6).map((s) => h('p', null, s.text));
  els.text.replaceChildren(...last, interim ? h('p', { class: 'live__interim' }, interim) : '');
  if (!segments.length && !interim) {
    els.text.replaceChildren(h('p', { class: 'muted' }, session && !session.live
      ? 'Recording… (live preview is off - Gemini writes the transcript when you stop)'
      : 'Listening…'));
  }
}

function tick() {
  if (!session || !els.timer) return;
  els.timer.textContent = formatClock(session.recorder.elapsed());
  els.meter.value = state === 'recording' ? session.recorder.level() : 0;
}

async function finish({ keep }) {
  const s = session;
  clearInterval(s.ticker);
  state = 'saving';
  ctx.refresh();
  const { blob, durationMs } = await s.recorder.stop();
  recordingInProgress(false);
  const segments = s.live?.stop() ?? [];
  session = null;
  if (!keep) {
    state = 'idle';
    ctx.toast('Recording discarded');
    ctx.refresh();
    return;
  }
  // Save first, then hand the slow part to the background: the person can
  // record the next note right away (domain/capture.js).
  try {
    const { ai, audioError } = await saveCapturedAudio({
      blob, durationMs, segments, language: s.lang, template: s.template,
      title: `Voice note · ${timeOfDay(new Date().toISOString())}`,
    });
    if (audioError) ctx.toast(`The audio could not be stored: ${audioError.message}`, { error: true });
    state = 'idle';
    ctx.toast(ai ? 'Saved - Gemini is transcribing it in the background' : 'Saved');
    ctx.go('#/library');
  } finally {
    state = 'idle';
  }
}

export const actions = {
  'record-pref'(el) {
    updateSettings({ [el.dataset.pref]: el.value });
  },

  async 'record-start'() {
    if (state !== 'idle') return;
    const p = prefs();
    let recorder;
    try {
      recorder = await startRecorder();
    } catch (err) {
      ctx.toast(err.name === 'NotAllowedError'
        ? 'Microphone permission was refused. Allow it in the browser settings to record.'
        : `Could not start the microphone: ${err.message}`, { error: true });
      return;
    }
    const micProblem = recordingInProgress(true);
    if (micProblem) ctx.toast(`Keep Mullo open while recording - the phone may stop the microphone when locked (${micProblem})`, { error: true });
    session = { recorder, lang: p.lang, template: p.template, lastUpdate: null };
    // Settings → Live preview off: no phone speech service; Gemini only.
    // The iPhone app's native recorder holds the mic; the speech service would fight it for it.
    session.live = !p.settings.livePreview || recorder.native ? null : startLiveTranscribe({
      lang: speechLang(p.lang),
      elapsed: recorder.elapsed,
      onUpdate: (u) => { if (session) { session.lastUpdate = u; drawLive(u); } },
    });
    session.ticker = setInterval(tick, 200);
    // The phone took the mic away (iPhone: a call, or Mullo left in the background):
    // keep what was recorded rather than a recording that's silent from here on.
    const mine = session;
    recorder.whenLost(() => {
      if (session !== mine || state === 'saving') return;
      ctx.toast('The phone stopped the microphone - the recording up to then is saved', { error: true });
      finish({ keep: true });
    });
    state = 'recording';
    confirmDiscard = false;
    ctx.refresh({ force: true });
  },

  'record-pause'() {
    if (!session) return;
    if (state === 'recording') { session.recorder.pause(); session.live?.pause(); state = 'paused'; }
    else if (state === 'paused') { session.recorder.resume(); session.live?.resume(); state = 'recording'; }
    ctx.refresh({ force: true });
  },

  async 'record-stop'() {
    if (session && state !== 'saving') await finish({ keep: true });
  },

  async 'record-discard'() {
    if (!session) return;
    if (!confirmDiscard) {
      confirmDiscard = true;
      if (els.discard) els.discard.textContent = 'Tap again to discard';
      return;
    }
    confirmDiscard = false;
    await finish({ keep: false });
  },

  async 'note-save'(form) {
    const field = form.querySelector('#note-text');
    const segments = segmentsFromText(field.value);
    if (!segments.length) { ctx.toast('Type something first'); return; }
    const p = prefs();
    const rec = await createRecording({
      title: `Note · ${timeOfDay(new Date().toISOString())}`,
      source: 'device', language: p.lang, template: p.template,
    });
    await saveTranscript(rec.id, segments, { language: p.lang, origin: 'typed' });
    field.value = '';
    summariseInBackground(rec.id, { template: p.template });
    ctx.go(`#/rec/${rec.id}`);
  },
};
