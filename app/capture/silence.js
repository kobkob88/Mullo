// Is there any speech in this audio? Asked before a recording goes to Gemini,
// because a silent recording (record pressed, nothing said) comes back with
// invented words. Silence never leaves the phone.
//
// Measured as loudness over time, not absolute volume: a whisper next to the
// microphone stands well above the room's own noise, a quiet room doesn't.
// Any doubt (can't decode, too long to check) counts as speech - a wrong
// "silent" would drop real words, a wrong "speech" only costs one Gemini call.
// Re-transcribe always sends, whatever this says.

const WINDOW_MS = 50;
const ABOVE_FLOOR_DB = 12;     // a window this far over the room's noise is a sound
const MIN_LOUD_DB = -55;       // and it has to be at least this loud at all
const MIN_SPEECH_MS = 400;     // this much of it, in total, is speech
const CHECK_UP_TO_MS = 3 * 60_000; // brain-dump length; longer ones aren't silent by accident

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

const JOIN_MS = 1000;          // sounds closer than this are one stretch of the speech map

// A watch note starts with the watch's own "mic is on" buzz (it comes after the mic
// starts, so nothing said is lost) and ends with the tap on Stop. Both are recorded:
// a 2-second accidental tap passed as speech and Gemini invented a to-do (2026-10-14).
// So their edges don't count as speech. They are still sent, and still in the map.
export const WATCH_EDGES = { startMs: 400, endMs: 300 };

// Pure: mono samples → { speech, speechMs, floorDb, peakDb, audioMs, ranges }.
// ranges = the speech map, where sound was heard: [[start_ms, end_ms], ...]. It goes
// with the audio so the Worker can drop lines Gemini writes over long silences
// (bridge/transcribe.mjs). It isn't stored.
// edges: { startMs, endMs } at either end that don't count towards speechMs.
export function speechInSamples(samples, sampleRate, edges = null) {
  const size = Math.max(1, Math.round((sampleRate * WINDOW_MS) / 1000));
  const levels = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j += 1) sum += samples[j] * samples[j];
    levels.push(db(Math.sqrt(sum / size)));
  }
  const audioMs = levels.length * WINDOW_MS;
  if (!levels.length) return { speech: false, speechMs: 0, floorDb: -Infinity, peakDb: -Infinity, audioMs, ranges: [] };
  const sorted = [...levels].sort((a, b) => a - b);
  const floorDb = sorted[Math.floor(sorted.length * 0.1)];
  const peakDb = sorted[sorted.length - 1];
  const ranges = [];
  const countFrom = edges?.startMs ?? 0;
  const countTo = audioMs - (edges?.endMs ?? 0);
  let loud = 0;
  levels.forEach((l, i) => {
    if (l < MIN_LOUD_DB || l < floorDb + ABOVE_FLOOR_DB) return;
    const start = i * WINDOW_MS;
    if (start >= countFrom && start + WINDOW_MS <= countTo) loud += 1;
    const last = ranges[ranges.length - 1];
    if (last && start - last[1] < JOIN_MS) last[1] = start + WINDOW_MS;
    else ranges.push([start, start + WINDOW_MS]);
  });
  const speechMs = loud * WINDOW_MS;
  return { speech: speechMs >= MIN_SPEECH_MS, speechMs, floorDb: round(floorDb), peakDb: round(peakDb), audioMs, ranges };
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

// watch: a watch note (its edges hold the buzz and the Stop tap, see WATCH_EDGES).
// → { speech: boolean, checked: boolean, ...levels }
export async function checkSpeech(blob, { durationMs = null, watch = false } = {}) {
  if (Number.isFinite(durationMs) && durationMs > CHECK_UP_TO_MS) return { speech: true, checked: false };
  const Offline = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Offline || !blob?.arrayBuffer) return { speech: true, checked: false };
  try {
    // Decoding resamples to the context's rate; 8 kHz keeps a 3-minute note small.
    const audio = await new Offline(1, 1, 8000).decodeAudioData(await blob.arrayBuffer());
    if (audio.duration * 1000 > CHECK_UP_TO_MS + 5000) return { speech: true, checked: false };
    return { ...speechInSamples(audio.getChannelData(0), audio.sampleRate, watch ? WATCH_EDGES : null), checked: true };
  } catch {
    return { speech: true, checked: false };
  }
}
