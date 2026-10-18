// The core loop all three products share:
//   capture → transcript → sections → summary (by template) → action items
// Capture lives in capture/, transcripts arrive from the device (live speech
// recognition or typed text) or from a connector; this module turns a
// transcript into everything else and writes it through the funnels.
//
// Returns a result object; the screen decides what to tell the person.

import { getRecording, updateRecording, speakerName } from './recordings.js';
import { transcriptFor, saveTranscript } from './transcripts.js';
import { replaceExtracted } from './actions.js';
import { localEngine } from './engines/local.js';
import { localDate } from '../core/dates.js';
import { audioBlob } from '../core/files.js';
import { getSettings, transcriptTarget } from '../core/settings.js';
import { AUTO } from '../core/languages.js';
import { engineTemplate, formatFor } from './formats.js';
import { applyFixes, fixesAsVocabulary } from './corrections.js';

let remoteEngine = null;
export function useRemoteEngine(engine) { remoteEngine = engine; }
// Mullo's server: the plan behind the key or the sign-in (plan, use), or null.
export async function aiAccount() { return remoteEngine?.me ? remoteEngine.me() : null; }
// Mullo Pro: Stripe's page to change the card or cancel → { url }.
export async function billingPortal() {
  if (!remoteEngine?.portal) throw new Error('Payments are managed in the Mullo app.');
  return remoteEngine.portal();
}

// Whether the AI may be used right now (app.js: a Mullo account's plan allows it).
// None installed (tests, tools, the dev bridge) = always.
let aiGate = () => true;
export function useAiGate(fn) { aiGate = fn; }

// Asked before audio goes to the AI after a recording (capture/silence.js,
// installed by app.js): a silent recording comes back with invented words.
// → { speech, checked, ... }. None installed (tests, tools) = always speech.
let speechCheck = null;
export function useSpeechCheck(fn) { speechCheck = fn; }

// Re-transcribe needs the AI engine (there is no offline transcriber).
export const canTranscribe = () => Boolean(remoteEngine?.transcribe && aiGate());
export const aiEngineOn = () => Boolean(remoteEngine?.process && aiGate());

// The saved audio → a fresh transcript in the chosen language → summary and
// actions rebuilt from it. The previous transcript stays in the activity log
// (it can be restored from there). Never leaves an empty transcript behind:
// if the engine heard nothing, the old one is kept.
// language = what was spoken. The transcript's language and the names list
// come from Settings unless given.
// checkSilence: after a recording, not on the Re-transcribe button (the person
// asking is the answer to "was anything said?").
export async function retranscribe(recordingId, { language, target, checkSilence = false } = {}) {
  if (!canTranscribe()) return { ok: false, error: 'Re-transcribing needs the AI engine (the bridge is off).' };
  const rec = await getRecording(recordingId);
  if (!rec?.audio_file_id) return { ok: false, error: 'This recording has no audio on this device.' };
  const blob = await audioBlob(rec.audio_file_id);
  if (!blob) return { ok: false, error: 'The audio for this recording is missing on this device.' };

  // The speech map (where sound was heard) travels with the audio; only the levels are kept.
  let speech = null;
  if (checkSilence && speechCheck) {
    const { ranges, ...check } = await speechCheck(blob, { durationMs: rec.duration_ms, watch: rec.source === 'watch' });
    if (check.checked) await updateRecording(rec.id, { audio_check: check });
    if (!check.speech) return { ok: false, silent: true, error: 'No speech was heard - nothing was sent to the AI.' };
    if (check.checked && Array.isArray(ranges) && check.audioMs > 0) speech = { ranges, duration_ms: check.audioMs };
  }

  const settings = getSettings();
  const lang = language ?? rec.language ?? null;
  const spoken = lang === AUTO ? null : lang;
  const outLang = target === undefined ? transcriptTarget(settings, lang) : target;
  // Send now, collect later: the server's job id is kept on the recording, so a lost
  // signal or a closed app picks up the finished transcript instead of sending again.
  // Only for the same languages: a new choice is a new job.
  const waiting = rec.transcribe_job;
  const resume = waiting && waiting.language === (spoken ?? null) && waiting.target === (outLang ?? null) ? waiting.id : null;
  let started = null;
  let out;
  try {
    out = await remoteEngine.transcribe(blob, {
      // This recording's own fixes first: the server keeps the first 60 entries.
      language: spoken, target: outLang, vocabulary: [...fixesAsVocabulary(rec.transcript_fixes), ...(settings.vocabulary ?? [])].slice(0, 60), durationMs: rec.duration_ms,
      ...(speech ? { speech } : {}),
      keep: settings.serverKeep,
      job: {
        resume,
        started: async (id) => {
          started = id;
          await updateRecording(rec.id, { transcribe_job: { id, language: spoken ?? null, target: outLang ?? null, at: new Date().toISOString() } });
        },
      },
    });
  } catch (err) {
    // Still on the server (no signal): keep the id. Anything else: the job is over.
    if (!err.offline && !err.pending && (started || waiting)) await updateRecording(rec.id, { transcribe_job: null });
    return {
      ok: false, offline: Boolean(err.offline), pending: Boolean(err.pending),
      error: err.offline ? err.message : `Could not transcribe: ${err.message}`,
    };
  }
  if (started || waiting) await updateRecording(rec.id, { transcribe_job: null });
  if (!out?.segments?.length) {
    releaseJob(out?.job, settings);
    return { ok: false, error: 'No speech was heard in this recording - the old transcript is kept.' };
  }

  const written = outLang ?? spoken;
  // The person's hand fixes go back in, whatever the AI wrote this time. Not into a
  // translation: its words differ from the ones that were fixed.
  const segments = outLang && outLang !== rec.language ? out.segments : applyFixes(out.segments, rec.transcript_fixes);
  await saveTranscript(rec.id, segments, {
    language: written, origin: out.engine ?? 'ai',
    reason: `re-transcribed (${lang ?? 'auto'}${outLang ? ` → ${outLang}` : ''})`,
  });
  releaseJob(out.job, settings);
  if (lang !== rec.language) await updateRecording(rec.id, { language: lang });
  if (rec.no_speech) await updateRecording(rec.id, { no_speech: false });
  if (rec.transcribe_error) await updateRecording(rec.id, { transcribe_error: null });
  const processed = await processRecording(rec.id);
  return { ok: processed.ok, error: processed.error, segments: out.segments.length };
}

// S45: "as soon as my phone has it" - once the transcript is saved here, the server forgets
// it. Not on the first read: a reply lost on weak Wi-Fi would have lost the transcript.
// Not awaited: a miss only means the server forgets it after an hour instead.
function releaseJob(job, settings) {
  if (job && settings.serverKeep === 'collected' && typeof remoteEngine?.release === 'function') {
    remoteEngine.release(job).catch(() => {});
  }
}

// Falls back to the offline engine when the AI engine fails - and says so
// (aiError), so the screen can tell the person and offer a retry instead of
// silently showing the weaker result.
async function runEngine({ segments, template, language, today, model = null }) {
  let aiError = null;
  if (aiEngineOn()) {
    try {
      const { vocabulary } = getSettings();
      return { ...(await remoteEngine.process({ segments, template: engineTemplate(template), language, today, vocabulary, model })), engine: remoteEngine.id, aiError: null };
    } catch (err) {
      aiError = String(err?.message ?? err);
      console.warn('AI engine failed - falling back to the local engine', err);
    }
  }
  const sections = localEngine.sectionize(segments);
  const actions = localEngine.extractActions(segments, { today });
  return {
    engine: localEngine.id,
    aiError,
    sections,
    actions,
    summary: localEngine.summarize(formatFor(template), segments, sections, actions),
    title: localEngine.titleFor(segments),
  };
}

// keepSummary: the source wrote its own summary (Vocci notes, Pocket
// sections) - keep it, and only add sections and action items.
// model: "Summarise again with" one model for this note (S54); null = the account's pick.
export async function processRecording(recordingId, { template, model = null, keepSummary = false } = {}) {
  const rec = await getRecording(recordingId);
  if (!rec) return { ok: false, error: 'Recording not found' };
  const transcript = await transcriptFor(recordingId);
  // Names the person gave the speakers go into the summary ("Dana will…").
  const segments = (transcript?.segments ?? []).map((s) => ({ ...s, speaker: speakerName(rec, s.speaker) }));
  const chosen = template ?? rec.template ?? 'general';

  if (!segments.length) {
    await updateRecording(rec.id, { status: 'needs_transcript', template: chosen });
    return { ok: true, status: 'needs_transcript' };
  }

  await updateRecording(rec.id, { status: 'processing', template: chosen });
  try {
    const out = await runEngine({
      segments, template: chosen, language: transcript.language ?? rec.language, today: localDate(), model,
    });
    return await saveEngineResult(rec, out, { keepSummary });
  } catch (err) {
    await updateRecording(rec.id, { status: 'failed', error: String(err.message ?? err) });
    return { ok: false, error: 'Processing failed - the transcript is safe; try again.' };
  }
}

// What an engine made of a transcript → tasks, sections, summary, title.
async function saveEngineResult(rec, out, { keepSummary = false } = {}) {
  await replaceExtracted(rec.id, out.actions ?? [], { engine: out.engine });
  const patch = {
    status: 'ready',
    engine: out.engine,
    ai_error: out.aiError ?? null,
    processed_at: new Date().toISOString(),
  };
  if (!(keepSummary && rec.sections?.length)) patch.sections = out.sections ?? [];
  if (!(keepSummary && rec.summary)) patch.summary = out.summary ?? null;
  // Imported recordings keep the source's title; ones captured here (phone or
  // watch) get a derived one.
  if (!rec.title_edited && (rec.source === 'device' || rec.source === 'watch') && out.title) patch.title = out.title;
  await updateRecording(rec.id, patch, { reason: `processed (${out.engine})` });
  // The AI made these tasks (not the offline engine): app.js drafts its emails and messages (S50).
  if (out.engine !== localEngine.id) afterSummary(rec.id);
  return { ok: true, status: 'ready', actions: out.actions?.length ?? 0, aiError: out.aiError ?? null };
}

// Called (not awaited) once an AI summary is saved; app.js installs the S50 drafts.
let afterSummary = () => {};
export function useAfterSummary(fn) { afterSummary = fn; }

// A watch note the phone's background side already ran through the AI while
// Mullo was closed (android WatchAi): the same Worker's /api/process answer,
// saved as if this app had asked. No AI call here.
export async function applyPrepared(recordingId, processed) {
  const rec = await getRecording(recordingId);
  if (!rec) return { ok: false, error: 'Recording not found' };
  return saveEngineResult(rec, { ...processed, engine: 'remote', aiError: null });
}
