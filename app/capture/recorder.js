// Audio capture on the device (the Plaud/Pocket "press and talk" part).
// MediaRecorder → one Blob. A level meter reads an AnalyserNode so the person
// can see the mic is hearing them.

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const AUDIO_BPS = 32_000;

export function recordingSupported() {
  if (nativeRecorder()) return true;
  return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

// The iPhone app records natively (ios/Mullo/NativeRecorder.swift), so it goes on with the
// phone locked; the WebView's own microphone stops when Mullo leaves the screen.
const nativeRecorder = () => globalThis.MulloRecorder ?? null;

async function startNativeRecorder(rec) {
  try {
    await rec.start();
  } catch (err) {
    const msg = String(err?.message ?? err);
    throw Object.assign(new Error(msg), { name: msg === 'denied' ? 'NotAllowedError' : 'Error' });
  }
  const startedAt = Date.now();
  let pausedMs = 0;
  let pausedAt = null;
  let level = 0;
  let onLost = null;
  let lost = false;
  let stopping = false;
  const poll = setInterval(async () => {
    try {
      const p = await rec.poll();
      level = Number(p?.level) || 0;
      if (p?.state === 'lost' && !stopping && !lost) { lost = true; onLost?.(); }
    } catch { /* the next poll tries again */ }
  }, 150);
  const elapsed = () => Date.now() - startedAt - pausedMs - (pausedAt ? Date.now() - pausedAt : 0);
  return {
    mime: 'audio/mp4',
    native: true,
    elapsed,
    level: () => level,
    get paused() { return pausedAt !== null; },
    whenLost(cb) { onLost = cb; if (lost) cb(); },
    pause() { if (pausedAt === null) { rec.pause(); pausedAt = Date.now(); } },
    resume() { if (pausedAt !== null) { rec.resume(); pausedMs += Date.now() - pausedAt; pausedAt = null; } },
    async stop() {
      stopping = true;
      clearInterval(poll);
      const { blob, durationMs } = await rec.stop();
      return { blob, durationMs: durationMs || elapsed() };
    },
  };
}

function pickMime() {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
}

export async function startRecorder() {
  const rec = nativeRecorder();
  if (rec) return startNativeRecorder(rec);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime = pickMime();
  // 32 kbps, like the watch: plenty for speech. The browser's default (~128 kbps) filled
  // Gemini's 19 MB inline limit in about 20 minutes; at 32 kbps that's 80.
  const recorder = new MediaRecorder(stream, { audioBitsPerSecond: AUDIO_BPS, ...(mime ? { mimeType: mime } : {}) });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  const ctx = new AudioContext();
  // iPhone starts an AudioContext made after an await as suspended: the meter would sit at 0.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  // The system took the mic away (iPhone: a call, Siri, Mullo left in the background).
  // Told once, so the caller can keep what was recorded instead of waiting on silence.
  let stopping = false;
  let onLost = null;
  let lost = false;
  const loseMic = () => {
    if (stopping || lost) return;
    lost = true;
    onLost?.();
  };
  stream.getTracks().forEach((t) => { t.onended = loseMic; });
  recorder.onstop = loseMic; // stop() swaps in its own handler
  recorder.onerror = loseMic;

  const startedAt = Date.now();
  let pausedMs = 0;
  let pausedAt = null;
  recorder.start(1000); // a chunk a second, so a crash loses at most a second

  const elapsed = () => Date.now() - startedAt - pausedMs - (pausedAt ? Date.now() - pausedAt : 0);

  return {
    mime: recorder.mimeType || mime || 'audio/webm',
    elapsed,
    // 0..1 loudness for the meter
    level() {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 64);
    },
    get paused() { return recorder.state === 'paused'; },
    whenLost(cb) { onLost = cb; if (lost) cb(); },
    pause() { if (recorder.state === 'recording') { recorder.pause(); pausedAt = Date.now(); } },
    resume() {
      if (recorder.state === 'paused') { recorder.resume(); pausedMs += Date.now() - pausedAt; pausedAt = null; }
    },
    stop() {
      stopping = true;
      return new Promise((resolve) => {
        const durationMs = elapsed();
        const done = () => {
          stream.getTracks().forEach((t) => t.stop());
          ctx.close().catch(() => {});
          resolve({ blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), durationMs });
        };
        // Already stopped by the system: no second stop event will come.
        if (recorder.state === 'inactive') { done(); return; }
        recorder.onstop = done;
        recorder.stop();
      });
    },
  };
}
