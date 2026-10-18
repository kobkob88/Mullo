// The AI engine (Gemini on the bridge - model chosen in bridge/gemini.mjs). Same interface as
// engines/local.js, but async: it posts the transcript to the bridge
// (bridge/server.mjs, later a Supabase Edge Function), which holds the model
// key. No model key ever ships in the browser bundle.
//
// The bridge answers { sections, actions, summary, title } in exactly the
// local engine's shapes, so the pipeline and the screens don't change.
// Numbers and dates in the reply are the model's reading of the transcript;
// the pipeline treats them as suggestions the person confirms, like Pocket's
// one-tap actions.

// authKey: who is calling Mullo Pro. A Mullo Pro key (Android app only; the native
// side hands it over in config.json), or a function giving the current one: the
// person's Mullo sign-in once it's linked to their subscription (core/account.js),
// asked for before every call because it refreshes hourly. Either unlocks only the
// person's capped Mullo allowance, never an AI provider account - provider keys
// (bring your own AI) stay native.
// No signal, or it dropped while waiting (a long meeting takes a minute or more to
// come back): said as that, not as "Gemini didn't answer". err.offline marks it.
export const OFFLINE_BEFORE = 'You’re offline - nothing was sent. The recording is safe on this phone.';
export const OFFLINE_DURING = 'The connection dropped before the answer came back (weak signal?). The recording is safe on this phone.';
export const OFFLINE_WAITING = 'The connection dropped, but Mullo’s server is still writing the transcript - nothing needs sending again.';
const offline = (message) => Object.assign(new Error(message), { offline: true });

// Send now, collect later (worker/src/jobs.mjs): the audio goes up once, the server works
// on it whatever the signal does, and the phone asks until the transcript is there.
const FIRST_POLL_MS = 1500;
const POLL_MS = 3000;
const GIVE_UP_OFFLINE_MS = 2 * 60_000; // then the job id stays on the recording for later
const GIVE_UP_MS = 20 * 60_000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function send(url, init) {
  if (globalThis.navigator?.onLine === false) throw offline(OFFLINE_BEFORE);
  try {
    return await fetch(url, init);
  } catch (err) {
    // fetch rejects with a TypeError only when the network failed.
    if (err instanceof TypeError) throw offline(OFFLINE_DURING);
    throw err;
  }
}

// ownKey: the person's own AI key as Mullo's server sealed it (core/own-ai.js). Sent with
// every call; the server then uses their key and counts no minutes.
export function createRemoteEngine({ bridgeUrl, authKey = null, ownKey = null, wait = sleep, now = Date.now }) {
  if (typeof bridgeUrl !== 'string') return null; // '' = same origin
  const current = typeof authKey === 'function' ? authKey : async () => authKey;
  const authHeader = async () => {
    const key = await current();
    return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(ownKey ? { 'X-Mullo-Own-Key': ownKey } : {}) };
  };

  // A job's result, or null if the server doesn't have it (expired, or never there).
  // Signal drops and server hiccups are waited out; after GIVE_UP_OFFLINE_MS without
  // signal the error says the server is still on it (err.offline, err.pending).
  async function collect(id) {
    const begun = now();
    let lostSince = null;
    for (let delay = FIRST_POLL_MS; ; delay = POLL_MS) {
      await wait(delay);
      let res;
      try {
        res = await send(`${bridgeUrl}/api/transcribe/jobs/${id}`, { headers: await authHeader() });
      } catch (err) {
        if (!err.offline) throw err;
        lostSince ??= now();
        if (now() - lostSince > GIVE_UP_OFFLINE_MS) throw Object.assign(offline(OFFLINE_WAITING), { pending: true });
        continue;
      }
      if (res.status === 404) return null;
      const body = await res.json().catch(() => null);
      if (res.status >= 500 || !body) { lostSince ??= now(); continue; } // a hiccup: ask again
      lostSince = null;
      if (!res.ok) throw new Error(body.error ?? `Transcription unavailable (${res.status})`);
      if (body.state === 'done' && Array.isArray(body.result?.segments)) return body.result;
      if (body.state === 'failed') throw new Error(body.error ?? 'The transcription failed');
      if (now() - begun > GIVE_UP_MS) {
        throw Object.assign(new Error('The transcription is taking unusually long - tap Re-transcribe to check on it'), { pending: true });
      }
    }
  }

  // The older way, one request held open until the transcript is back: for a bridge
  // without jobs (the PC dev bridge, a Worker from before 2026-10-07).
  async function transcribeNow(form) {
    const res = await send(`${bridgeUrl}/api/transcribe`, { method: 'POST', headers: await authHeader(), body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `Transcription unavailable (${res.status})`);
    // A good answer always has its lines, even none: anything else was cut off on the way.
    if (!Array.isArray(body?.segments)) throw offline(OFFLINE_DURING);
    return body;
  }

  return {
    id: 'remote',
    // Mullo Pro only: { status, active, tokensUsed, tokensAllowed, month }.
    async me() {
      const auth = await authHeader();
      if (!auth.Authorization) return null;
      const res = await send(`${bridgeUrl}/api/me`, { headers: auth });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Mullo Pro unavailable (${res.status})`);
      return body;
    },
    // template: a built-in's id, or a person's own format as a whole object.
    // model: "Summarise again with" (S54); left out, the server uses the account's pick.
    async process({ segments, template, language, today, vocabulary = [], model = null }) {
      const res = await send(`${bridgeUrl}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ segments, template, language, today, vocabulary, ...(model ? { model } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `AI engine unavailable (${res.status})`);
      return body;
    },
    // Mullo Pro: Stripe's billing portal for this subscription → { url }.
    async portal() {
      const res = await send(`${bridgeUrl}/api/billing/portal`, { method: 'POST', headers: await authHeader() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Payments unavailable (${res.status})`);
      return body;
    },
    // Ask as a chat (bridge/chat.mjs): { messages, today, recordings, focus }
    // → { answer, found, sources: [recording ids], draft: { kind, subject, body } | null }
    async chat(payload) {
      const res = await send(`${bridgeUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Ask unavailable (${res.status})`);
      return body;
    },
    // Audio → { segments, language, engine }. A form: the audio + its options.
    // Names stay in the body, never the URL (a URL ends up in request logs).
    // speech: the speech map from the silence check, or null (see bridge/transcribe.mjs).
    // job: { resume: an earlier job id to collect first (null = none),
    //        started(id): called once the server has the audio, to keep the id }.
    // keep: how long the server may keep the result (S45, settings.serverKeep); null = its default.
    // The answer carries `job` (the server's id) when it came from a job, for release().
    async transcribe(blob, { language, target, vocabulary = [], durationMs, speech = null, job = null, keep = null }) {
      if (job?.resume) {
        const earlier = await collect(job.resume);
        if (earlier) return { ...earlier, job: job.resume };
      }
      const options = {
        lang: language || null,
        out: target || null,
        vocabulary: vocabulary.slice(0, 60),
        duration_ms: durationMs ? Math.round(durationMs) : null,
        mime: blob.type || 'audio/webm',
        speech,
        ...(keep ? { keep } : {}),
      };
      const form = new FormData();
      form.append('options', JSON.stringify(options));
      form.append('audio', blob, 'audio');
      const res = await send(`${bridgeUrl}/api/transcribe/jobs`, { method: 'POST', headers: await authHeader(), body: form });
      if (res.status === 404) return transcribeNow(form);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Transcription unavailable (${res.status})`);
      if (!body?.job) throw offline(OFFLINE_DURING); // the answer was cut off on the way
      await job?.started?.(body.job);
      const out = await collect(body.job);
      if (!out) throw new Error('The server lost this transcription - try again');
      return { ...out, job: body.job };
    },
    // S45 "got it": this phone saved the transcript, so the server can forget it now
    // (settings.serverKeep 'collected'). Best effort: if it doesn't arrive, the server
    // forgets it after an hour anyway. → true when the server said so.
    async release(id) {
      try {
        const res = await send(`${bridgeUrl}/api/transcribe/jobs/${id}`, { method: 'DELETE', headers: await authHeader() });
        return res.status === 204 || res.status === 404;
      } catch {
        return false;
      }
    },
  };
}
