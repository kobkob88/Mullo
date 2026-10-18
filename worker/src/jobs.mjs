// Send now, collect later: one transcription that outlives the phone's connection.
//
// A long meeting takes Gemini a minute or more, and a phone on weak Wi-Fi can lose the
// connection meanwhile; with one request held open, the finished work was lost with it
// (a 28-minute meeting in a warehouse, 2026-10-07). So the phone uploads, gets a job id
// back at once, and asks for the result until it's there.
//
// One Durable Object per job (named by a random id). It keeps the audio only until the
// transcript is written, then deletes it. The work runs in an alarm, which keeps going
// with nobody connected (up to 15 minutes) and is run again if it's cut off. The result
// stays as long as the person chose (S45, KEEP_CHOICES, a day at most) so a phone that lost
// signal can still collect it, then everything goes; sooner if the phone says "got it".
// Only whoever's allowance paid for it (a subscription, or a Mullo account's own plan)
// can read the result.

import { transcribeAudio } from '../../bridge/providers.mjs';
import { DEFAULT_MODEL } from '../../bridge/gemini.mjs';
import { addUsage, meteredFetch } from './usage.mjs';
import { openKey, OWN_KEY_GONE } from './ownkey.mjs';

export const KEEP_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
// S45: how long the person lets the server keep a finished result. A fixed list, each at or
// under a day: a choice can only shorten the wait, never lengthen it. 'collected' = the phone
// says "got it" (DELETE on the job) once it has saved the result; if it never does, an hour.
// No choice (an app from before S45) = a day, as before.
export const KEEP_CHOICES = Object.freeze({ collected: HOUR_MS, '1h': HOUR_MS, '6h': 6 * HOUR_MS, '24h': KEEP_MS });
// → ms, or null for a value off the list.
export function keepFor(choice) {
  if (choice === undefined || choice === null) return KEEP_MS;
  return typeof choice === 'string' && Object.hasOwn(KEEP_CHOICES, choice) ? KEEP_CHOICES[choice] : null;
}
const MAX_TRIES = 3;
const CHUNK = 1024 * 1024; // a stored row holds at most 2 MB

export class TranscribeJob {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.doFetch = (url, init) => fetch(url, init);
    this.sql = ctx.storage.sql;
    this.sql.exec('create table if not exists job (id integer primary key check (id = 1), meta text not null, result text)');
    this.sql.exec('create table if not exists audio (i integer primary key, data blob not null)');
  }

  // The Worker talks to a job with plain requests (RPC would need the class to extend
  // cloudflare:workers' DurableObject, which the Node tests can't load):
  //   POST /start  form { job: JSON {owner, model, options}, audio }   → 202
  //   GET  /status?owner=<subscription id>                             → the status, or 404
  //   POST /release?owner=<subscription id>  "got it": forget it now   → 204, 409 still working, or 404
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/start') {
      const form = await req.formData();
      const { owner, model, options, ownKey, keepMs } = JSON.parse(form.get('job'));
      const audio = new Uint8Array(await form.get('audio').arrayBuffer());
      await this.start({ owner, model, ownKey, keepMs, request: { ...options, audio } });
      return new Response(null, { status: 202 });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const status = await this.status(url.searchParams.get('owner'));
      return status ? Response.json(status) : new Response(null, { status: 404 });
    }
    if (req.method === 'POST' && url.pathname === '/release') {
      return new Response(null, { status: await this.release(url.searchParams.get('owner')) });
    }
    return new Response(null, { status: 404 });
  }

  meta() {
    const row = this.sql.exec('select meta from job where id = 1').toArray()[0];
    return row ? JSON.parse(row.meta) : null;
  }

  save(meta, result) {
    if (result === undefined) this.sql.exec('update job set meta = ? where id = 1', JSON.stringify(meta));
    else this.sql.exec('update job set meta = ?, result = ? where id = 1', JSON.stringify(meta), result);
  }

  // request: what readTranscribeRequest read (audio + options). Sending the same job twice is harmless.
  // ownKey: the person's own AI key, still SEALED (ownkey.mjs); kept only until the job ends.
  // keepMs: how long the result waits once finished (S45), already checked against KEEP_CHOICES;
  // never more than a day, whatever arrives.
  async start({ owner, request, model, ownKey = null, keepMs = KEEP_MS }) {
    if (this.meta()) return;
    const { audio, ...options } = request;
    const bytes = new Uint8Array(audio.buffer ?? audio, audio.byteOffset ?? 0, audio.byteLength ?? audio.length);
    for (let i = 0; i * CHUNK < bytes.length; i += 1) {
      this.sql.exec('insert into audio (i, data) values (?, ?)', i, bytes.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    const keep = Math.min(Number(keepMs) > 0 ? Number(keepMs) : KEEP_MS, KEEP_MS);
    const meta = { owner, state: 'queued', tries: 0, created: Date.now(), model: model || DEFAULT_MODEL, options, keepMs: keep, ...(ownKey ? { ownKey } : {}) };
    this.sql.exec('insert into job (id, meta) values (1, ?)', JSON.stringify(meta));
    await this.ctx.storage.setAlarm(Date.now());
  }

  // → null (no such job, or someone else's) | { state: 'queued'|'working'|'done'|'failed', result?, error?, status? }
  async status(owner) {
    const meta = this.meta();
    if (!meta || meta.owner !== owner) return null;
    if (meta.state === 'done') {
      const row = this.sql.exec('select result from job where id = 1').toArray()[0];
      return { state: 'done', result: JSON.parse(row.result) };
    }
    if (meta.state === 'failed') return { state: 'failed', error: meta.error, status: meta.status };
    return { state: meta.state };
  }

  // "Got it" (S45): the phone saved the result, so everything goes now. The same owner check
  // as status. Not while it's still running: the alarm would only write it back.
  async release(owner) {
    const meta = this.meta();
    if (!meta || meta.owner !== owner) return 404;
    if (meta.state !== 'done' && meta.state !== 'failed') return 409;
    this.forget();
    await this.ctx.storage.deleteAlarm?.();
    return 204;
  }

  async alarm() {
    const meta = this.meta();
    if (!meta) return;
    if (meta.state === 'done' || meta.state === 'failed') {
      const keep = meta.keepMs ?? KEEP_MS;
      if (Date.now() - meta.finished >= keep) this.forget();
      else await this.ctx.storage.setAlarm(meta.finished + keep);
      return;
    }
    // An alarm cut off mid-way (a deploy, a restart) runs again: a few tries, then say so.
    if (meta.tries >= MAX_TRIES) return this.finish(meta, { error: 'The transcription kept being interrupted - send it again', status: 503 });
    meta.tries += 1;
    meta.state = 'working';
    this.save(meta);

    const chunks = this.sql.exec('select data from audio order by i').toArray().map((r) => new Uint8Array(r.data));
    const audio = Buffer.concat(chunks);
    const meter = { tokens: 0 };
    const own = Boolean(meta.ownKey);
    try {
      const opened = own ? await openKey(this.env, meta.ownKey) : null;
      if (own && !opened) throw Object.assign(new Error(OWN_KEY_GONE), { status: 401 });
      const result = await transcribeAudio({ ...meta.options, audio }, {
        provider: opened?.provider ?? 'gemini',
        apiKey: opened?.key ?? this.env.GEMINI_API_KEY, model: meta.model, fetch: meteredFetch(this.doFetch, meter),
      });
      await this.finish(meta, { result });
    } catch (err) {
      await this.finish(meta, { error: String(err?.message ?? err), status: err?.status ?? 502 });
    } finally {
      // Paid for even when the answer failed: Gemini still counted it. Their own key: the AI company bills them.
      if (meter.tokens && !own) await addUsage(this.env, meta.owner, meter.tokens, meter.seconds);
    }
  }

  async finish(meta, { result, error, status }) {
    this.sql.exec('delete from audio');
    delete meta.ownKey; // the job is over: their key isn't kept
    meta.finished = Date.now();
    if (result) {
      meta.state = 'done';
      this.save(meta, JSON.stringify(result));
    } else {
      Object.assign(meta, { state: 'failed', error, status });
      this.save(meta);
    }
    await this.ctx.storage.setAlarm(meta.finished + (meta.keepMs ?? KEEP_MS));
  }

  forget() {
    this.sql.exec('delete from audio');
    this.sql.exec('delete from job');
  }
}
