// Live transcription for the prototype, through the browser's speech
// recognition (Chrome, Edge, Safari). The language is CHOSEN, not guessed:
// Pocket transcribed Hebrew speech as Latin-letter gibberish when it guessed
// wrong, so the person picks he-IL / en-US before recording.
//
// Privacy note shown in the UI: in Chrome this sends audio to the browser
// vendor's speech service. The real transcriber (server-side, via the bridge)
// replaces this later; the segment shape stays the same.

export function liveTranscribeSupported() {
  return Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
}

export function startLiveTranscribe({ lang, elapsed, onUpdate }) {
  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Recognition) return null;

  const segments = [];
  let interim = '';
  let active = true;
  let segStart = elapsed();
  let rec = null;

  const emit = () => onUpdate?.({ segments: [...segments], interim });

  function begin() {
    rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          segments.push({ speaker: null, text, start_ms: segStart, end_ms: elapsed() });
          segStart = elapsed();
        } else {
          interim = text;
        }
      }
      emit();
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') active = false;
    };
    // Recognition stops by itself after silence; keep it going while recording.
    rec.onend = () => { if (active) { segStart = elapsed(); try { rec.start(); } catch { /* already started */ } } };
    rec.start();
  }

  begin();
  return {
    pause() { active = false; rec?.stop(); },
    resume() { active = true; segStart = elapsed(); begin(); },
    stop() {
      active = false;
      try { rec?.stop(); } catch { /* ignore */ }
      if (interim) segments.push({ speaker: null, text: interim, start_ms: segStart, end_ms: elapsed() });
      interim = '';
      return segments;
    },
  };
}
