// Background work on recordings: transcribe + summarise after Stop, and
// re-transcribe. The person never waits on Gemini - the recording is saved
// first and its status shows the work ("transcribing", "processing").
//
// Runs while the app is open. A recording left mid-way (app closed, phone
// locked, reload) still carries that status, and resumePending() picks it
// up on the next start - the audio is already saved, so nothing is lost.

import { retranscribe, processRecording, canTranscribe, aiEngineOn } from './pipeline.js';
import { getRecording, listRecordings, updateRecording } from './recordings.js';
import { transcriptFor } from './transcripts.js';
import { emit } from '../core/bus.js';

const running = new Map(); // recording id → promise

export const isRunning = (recordingId) => running.has(recordingId);
export const activeJobs = () => running.size;

// One job per recording at a time; a second request joins the first.
export function runInBackground(recordingId, work) {
  if (running.has(recordingId)) return running.get(recordingId);
  const job = (async () => {
    let result;
    try {
      result = await work();
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    } finally {
      running.delete(recordingId);
    }
    emit('job-done', { recordingId, ...result });
    return result;
  })();
  running.set(recordingId, job);
  emit('job-started', { recordingId });
  return job;
}

// After Stop: Gemini writes the transcript; if it can't, the live preview
// (already saved) is summarised instead, and the recording says why.
// A recording with no speech in it isn't sent at all, and says so - unless
// the phone's live preview heard words (then those are summarised as before).
export function transcribeAndSummarise(recordingId, { language } = {}) {
  return runInBackground(recordingId, async () => {
    const res = await retranscribe(recordingId, { language, checkSilence: true });
    if (res.ok) return res;
    if (res.silent && !(await transcriptFor(recordingId))?.segments?.length) {
      const rec = await getRecording(recordingId);
      await updateRecording(recordingId, {
        status: 'needs_transcript', no_speech: true,
        ...(rec && !rec.title_edited ? { title: 'No speech heard' } : {}),
      }, { reason: 'no speech heard - not sent to the AI' });
      return { ok: true, silent: true };
    }
    if (!res.silent) await updateRecording(recordingId, { transcribe_error: failure(res) });
    const processed = await processRecording(recordingId);
    return { ...processed, ok: processed.ok, transcribeError: res.error, offline: res.offline };
  });
}

// Why the last transcription didn't finish, kept on the recording so its page says so
// after the toast is gone. Cleared by the next one that works (pipeline.retranscribe).
const failure = (res) => ({ message: res.error, offline: Boolean(res.offline), pending: Boolean(res.pending), at: new Date().toISOString() });

// The Re-transcribe button: shows "transcribing" while it runs and puts the
// old status back if it fails (the old transcript is kept by retranscribe).
// The chosen language is saved first so the picker (it re-renders from the
// recording) shows it while the job runs; a failure puts the old one back.
export function retranscribeInBackground(recordingId, { language } = {}) {
  return runInBackground(recordingId, async () => {
    const before = await getRecording(recordingId);
    await updateRecording(recordingId, { status: 'transcribing', ...(language ? { language } : {}) });
    const res = await retranscribe(recordingId, { language });
    if (!res.ok) {
      await updateRecording(recordingId, {
        status: before?.status ?? 'ready', language: before?.language ?? null,
        ...(res.silent ? {} : { transcribe_error: failure(res) }),
      });
    }
    return res;
  });
}

export function summariseInBackground(recordingId, opts = {}) {
  return runInBackground(recordingId, () => processRecording(recordingId, opts));
}

// On start, with the AI engine on: recordings the offline rules summarised
// (the AI was off or didn't answer) are summarised again by Gemini. Text only,
// no audio - cheap. Tasks a person ticked, edited or added are kept;
// the offline engine's untouched guesses are replaced (restorable).
export async function upgradeOfflineSummaries() {
  if (!aiEngineOn()) return 0;
  let upgraded = 0;
  for (const rec of await listRecordings()) {
    // Device recordings only: imports keep the source's own summary.
    if (rec.source !== 'device' || rec.engine !== 'local' || rec.status !== 'ready' || isRunning(rec.id)) continue;
    summariseInBackground(rec.id);
    upgraded += 1;
  }
  return upgraded;
}

// On start: finish whatever was left mid-way.
export async function resumePending() {
  let resumed = 0;
  for (const rec of await listRecordings()) {
    if (rec.status === 'transcribing' && rec.audio_file_id && canTranscribe()) {
      transcribeAndSummarise(rec.id, { language: rec.language });
      resumed += 1;
    } else if (rec.transcribe_job && rec.audio_file_id && canTranscribe()) {
      // The server finished (or is finishing) a transcript the phone lost the signal for.
      retranscribeInBackground(rec.id, { language: rec.language });
      resumed += 1;
    } else if (rec.status === 'transcribing' || rec.status === 'processing') {
      summariseInBackground(rec.id);
      resumed += 1;
    }
  }
  return resumed;
}
