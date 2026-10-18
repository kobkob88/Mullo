// Captured audio → a saved recording, then the slow part in the background.
// The ONE path for audio made on this side: the Record button and the watch
// (capture/watch-inbox.js) both come through here, so they can't drift.
//
// Save first: the audio and any live preview are on disk before any network
// call, so a closed app loses nothing; the background job transcribes and
// summarises, and resumePending() finishes it after a restart.

import { createRecording, updateRecording } from './recordings.js';
import { saveTranscript } from './transcripts.js';
import { canTranscribe, applyPrepared } from './pipeline.js';
import { transcribeAndSummarise, summariseInBackground } from './jobs.js';
import { saveAudio } from '../core/files.js';

// prepared: a watch note the phone's background side already made ready
// (android WatchAi): { state: 'done' | 'silent', transcript, processed, check,
// template_id }. Saved as is - no AI call. { state: 'sent', job } = the normal
// path, collecting that job first. Anything else = the normal path.
// → { rec, ai, audioError }  (audioError: the audio couldn't be stored, the row still exists)
export async function saveCapturedAudio({
  blob, durationMs, segments = [], language, template, title,
  source = 'device', externalId = null, recordedAt = null, prepared = null, watchBattery = null,
}) {
  const ready = prepared?.state === 'done' && prepared.transcript?.segments?.length && prepared.processed;
  const silent = prepared?.state === 'silent';
  // 'sent': the server has the audio and a job id, but the background job stopped before the
  // transcript came back. Kept as the recording's transcribe_job, so it's collected, not resent.
  const sent = prepared?.state === 'sent' && typeof prepared.job?.id === 'string' ? prepared.job : null;
  const ai = canTranscribe();
  const rec = await createRecording({
    title, source, external_id: externalId, recorded_at: recordedAt ?? undefined, watch_battery: watchBattery,
    duration_ms: durationMs, language, template: ready ? (prepared.template_id ?? template) : template,
    status: ready ? 'processing' : ai ? 'transcribing' : 'processing',
  });
  if (sent) {
    await updateRecording(rec.id, {
      transcribe_job: { id: sent.id, language: sent.language ?? null, target: sent.target ?? null, at: new Date().toISOString() },
    });
  }
  let audioError = null;
  try {
    const file = await saveAudio(blob, { recordingId: rec.id, durationMs });
    await updateRecording(rec.id, { audio_file_id: file.id });
  } catch (err) {
    audioError = err;
  }
  if (ready) {
    await saveTranscript(rec.id, prepared.transcript.segments, {
      language: prepared.transcript.language ?? language, origin: prepared.transcript.engine ?? 'ai',
      reason: 'made ready in the background',
    });
    if (prepared.check) await updateRecording(rec.id, { audio_check: prepared.check });
    await applyPrepared(rec.id, prepared.processed);
    return { rec, ai: true, audioError, prepared: true };
  }
  if (silent) {
    await saveTranscript(rec.id, [], { language, origin: 'device-live' });
    await updateRecording(rec.id, {
      status: 'needs_transcript', no_speech: true, title: 'No speech heard', audio_check: prepared.check ?? null,
    }, { reason: 'no speech heard - not sent to the AI' });
    return { rec, ai: false, audioError, prepared: true };
  }
  // The browser's live recognizer is only a preview (some phones ignore the
  // language - Hebrew came out as English words); it is the fallback if Gemini
  // can't be reached.
  await saveTranscript(rec.id, segments, { language, origin: 'device-live' });
  if (ai) transcribeAndSummarise(rec.id, { language });
  else summariseInBackground(rec.id, { template });
  return { rec, ai, audioError };
}
