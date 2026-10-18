import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { drainWatchInbox, fromPhone, watchInboxAvailable, watchBattery, watchNotesWorking } from '../app/capture/watch-inbox.js';
import { saveCapturedAudio } from '../app/domain/capture.js';
import { findByExternal, listRecordings } from '../app/domain/recordings.js';
import { transcriptFor } from '../app/domain/transcripts.js';
import { actionsFor } from '../app/domain/actions.js';
import { useRemoteEngine } from '../app/domain/pipeline.js';
import { disk } from '../app/core/disk.js';
import { freshDb } from './helpers.mjs';

// The native side as the Android app exposes it: list() → JSON, done(id).
function fakeInbox(entries) {
  const left = new Map(entries.map((e) => [e.id, e]));
  return {
    left,
    list: () => JSON.stringify([...left.values()]),
    done: (id) => { left.delete(id); },
  };
}

const audio = () => ({ ok: true, blob: async () => new Blob(['m4a'], { type: 'audio/mp4' }) });

// The app's real wiring (app.js takeWatchRecordings), minus fetch.
const deps = (inbox, fetchAudio = audio) => ({
  inbox,
  fetchAudio,
  findExisting: (id, entry) => findByExternal(fromPhone(entry) ? 'device' : 'watch', id),
  save: (entry, blob) => saveCapturedAudio({
    blob, durationMs: entry.duration_ms, language: 'he', template: 'general',
    title: fromPhone(entry) ? 'Recovered' : 'Watch', source: fromPhone(entry) ? 'device' : 'watch', externalId: entry.id,
    recordedAt: new Date(entry.started_at).toISOString(), prepared: entry.ai ?? null,
    watchBattery: fromPhone(entry) ? null : watchBattery(entry),
  }),
});

beforeEach(() => { disk.remove('echo:settings'); freshDb(); useRemoteEngine(null); });

test('in a browser (no native inbox) it does nothing', async () => {
  assert.equal(watchInboxAvailable(), false);
  assert.equal(await drainWatchInbox({ save: () => assert.fail('no save') }), 0);
});

test('each watch recording is saved once, from the watch, at its own time, then released', async () => {
  const at = Date.UTC(2026, 9, 5, 18, 30);
  const inbox = fakeInbox([{ id: '20261005-143000', duration_ms: 12_000, started_at: at }]);
  assert.equal(await drainWatchInbox(deps(inbox)), 1);
  const rec = await findByExternal('watch', '20261005-143000');
  assert.equal(rec.source, 'watch');
  assert.equal(rec.duration_ms, 12_000);
  assert.equal(rec.recorded_at, new Date(at).toISOString());
  assert.ok(rec.audio_file_id, 'audio stored with the recording');
  assert.equal(inbox.left.size, 0, 'native copy released only after saving');
});

test('a crash between saving and done() never makes a duplicate', async () => {
  const entry = { id: '20261005-150000', duration_ms: 1000, started_at: Date.now() };
  const first = fakeInbox([entry]);
  first.done = () => {}; // the app died before telling the native side
  await drainWatchInbox(deps(first));
  const again = fakeInbox([entry]);
  assert.equal(await drainWatchInbox(deps(again)), 0);
  assert.equal((await listRecordings()).length, 1);
  assert.equal(again.left.size, 0, 'confirmed this time');
});

test('a file that cannot be read stays in the inbox for next time', async () => {
  const inbox = fakeInbox([{ id: '20261005-160000', duration_ms: 1000, started_at: Date.now() }]);
  assert.equal(await drainWatchInbox(deps(inbox, async () => ({ ok: false }))), 0);
  assert.equal(inbox.left.size, 1);
  assert.equal((await listRecordings()).length, 0);
});

test('the iPhone inbox: list() is a promise and the audio comes from audio(id), not a fetch', async () => {
  const left = new Map([['A1B2', { id: 'A1B2', duration_ms: 4000, started_at: Date.now() }]]);
  const inbox = {
    list: async () => JSON.stringify([...left.values()]),
    done: (id) => { left.delete(id); },
    audio: async () => new Response(new Blob(['m4a'], { type: 'audio/mp4' })),
  };
  const noFetch = () => assert.fail('the iPhone inbox never fetches');
  assert.equal(await drainWatchInbox(deps(inbox, noFetch)), 1);
  assert.ok((await findByExternal('watch', 'A1B2')).audio_file_id);
  assert.equal(left.size, 0);
});

test('a phone recording recovered after Mullo was killed is saved once, as this phone\'s, then released', async () => {
  const at = Date.UTC(2026, 9, 17, 14, 0);
  const entry = { id: 'C0FFEE-1', from: 'phone', duration_ms: 59 * 60_000, started_at: at };
  const first = fakeInbox([entry]);
  first.done = () => {}; // killed again before done(): no duplicate next time
  assert.equal(await drainWatchInbox(deps(first)), 1);
  const rec = await findByExternal('device', 'C0FFEE-1');
  assert.equal(rec.source, 'device');
  assert.equal(rec.title, 'Recovered');
  assert.equal(rec.duration_ms, 59 * 60_000);
  assert.equal(rec.recorded_at, new Date(at).toISOString());
  assert.equal(rec.watch_battery ?? null, null);
  assert.equal(await findByExternal('watch', 'C0FFEE-1'), null, 'not filed as a watch note');
  const again = fakeInbox([entry]);
  assert.equal(await drainWatchInbox(deps(again)), 0);
  assert.equal((await listRecordings()).length, 1);
  assert.equal(again.left.size, 0);
});

test('two drains at once share one run (focus and the native event can fire together)', async () => {
  const inbox = fakeInbox([{ id: '20261005-170000', duration_ms: 1000, started_at: Date.now() }]);
  const [a, b] = await Promise.all([drainWatchInbox(deps(inbox)), drainWatchInbox(deps(inbox))]);
  assert.equal(a + b, 2); // the same run's result, reported to both callers
  assert.equal((await listRecordings()).length, 1);
});

// ── Made ready in the background (Mullo closed) ──────────────────────────
const READY = {
  state: 'done', template_id: 'voice_note',
  check: { speech: true, checked: true, speechMs: 5200, floorDb: -61, peakDb: -22 },
  transcript: { segments: [{ text: 'Need to transfer Andre his payment for today.', start_ms: 0, speaker: 'Speaker 1' }], language: 'he', engine: 'gemini' },
  processed: {
    title: 'Payment for Andre', sections: [{ title: 'Payment', summary: 'Pay Andre', start_ms: 0, end_ms: 5000 }],
    actions: [{ label: 'Transfer Andre his payment', type: 'create_reminder', priority: 'medium', due_date: '2026-10-06' }],
    summary: { template: 'voice_note', engine: 'gemini', blocks: [{ heading: 'Note', items: ['Pay Andre for the trial day'] }] },
  },
};

test('a note made ready in the background is saved as is - no AI call', async () => {
  let calls = 0;
  useRemoteEngine({ id: 'remote', transcribe: async () => { calls += 1; return { segments: [] }; }, process: async () => { calls += 1; return {}; } });
  const inbox = fakeInbox([{ id: '20261006-171526', duration_ms: 16_000, started_at: Date.now(), ai: READY }]);
  assert.equal(await drainWatchInbox(deps(inbox)), 1);
  const rec = await findByExternal('watch', '20261006-171526');
  assert.equal(calls, 0);
  assert.equal(rec.status, 'ready');
  assert.equal(rec.title, 'Payment for Andre');
  assert.equal(rec.template, 'voice_note');
  assert.equal(rec.audio_check.speechMs, 5200);
  assert.equal((await transcriptFor(rec.id)).segments[0].text, 'Need to transfer Andre his payment for today.');
  assert.deepEqual((await actionsFor(rec.id)).map((a) => a.label), ['Transfer Andre his payment']);
  assert.ok(rec.audio_file_id, 'and the audio, for playing and re-transcribing');
});

test('a silent note found in the background says so, and nothing is sent', async () => {
  let calls = 0;
  useRemoteEngine({ id: 'remote', transcribe: async () => { calls += 1; return { segments: [{ text: 'invented' }] }; }, process: async () => ({}) });
  const inbox = fakeInbox([{ id: '20261006-080000', duration_ms: 4000, started_at: Date.now(), ai: { state: 'silent', check: { speech: false, checked: true } } }]);
  await drainWatchInbox(deps(inbox));
  const rec = await findByExternal('watch', '20261006-080000');
  assert.equal(calls, 0);
  assert.equal(rec.no_speech, true);
  assert.equal(rec.title, 'No speech heard');
});

test('a transcription the background job sent but couldn\'t collect is collected, not sent again', async () => {
  const seen = [];
  useRemoteEngine({
    id: 'remote',
    transcribe: async (_blob, { job }) => { seen.push(job?.resume ?? null); return { segments: [{ text: 'Call Dana', start_ms: 0 }] }; },
    process: async () => ({ title: 'Call Dana', sections: [], actions: [], summary: { blocks: [] } }),
  });
  const job = { id: '0b6f3c1e-1111-4222-8333-444455556666', language: 'he', target: null };
  const inbox = fakeInbox([{ id: '20261010-120000', duration_ms: 4000, started_at: Date.now(), ai: { state: 'sent', job } }]);
  await drainWatchInbox(deps(inbox));
  let rec = await findByExternal('watch', '20261010-120000');
  for (let i = 0; i < 100 && rec.status !== 'ready'; i += 1) {
    await new Promise((r) => { setTimeout(r, 5); });
    rec = await findByExternal('watch', '20261010-120000');
  }
  assert.deepEqual(seen, [job.id], 'the phone\'s job id goes first');
  assert.equal(rec.status, 'ready');
  assert.equal(rec.transcribe_job, null, 'collected: the id is dropped');
});

test('while the background job works on a note, the app leaves it alone', async () => {
  const inbox = fakeInbox([{ id: '20261006-090000', duration_ms: 4000, started_at: Date.now(), ai_state: 'working' }]);
  assert.equal(await drainWatchInbox(deps(inbox)), 0);
  assert.equal(inbox.left.size, 1, 'still there for the next drain');
  assert.equal((await listRecordings()).length, 0);
  assert.deepEqual(watchNotesWorking(), [{ id: '20261006-090000', duration_ms: 4000 }], 'the library can show Mullo mulling over it');
  await drainWatchInbox(deps(fakeInbox([])));
  assert.deepEqual(watchNotesWorking(), [], 'gone once the native side is done');
});

test('the watch battery at start and end is kept on the recording', async () => {
  const inbox = fakeInbox([
    { id: '20261006-205227', duration_ms: 6961, started_at: Date.UTC(2026, 9, 7, 0, 52), battery_start: 45, battery_end: 44 },
    { id: '20261006-205300', duration_ms: 5000, started_at: Date.UTC(2026, 9, 7, 0, 53) },
  ]);
  await drainWatchInbox(deps(inbox));
  assert.deepEqual((await findByExternal('watch', '20261006-205227')).watch_battery, { start: 45, end: 44 });
  assert.equal('watch_battery' in (await findByExternal('watch', '20261006-205300')), false, 'nothing made up when the watch sent none');
});

test('battery numbers that are not 0-100 whole percents are dropped', () => {
  assert.equal(watchBattery({ battery_start: 45 }), null);
  assert.equal(watchBattery({ battery_start: -1, battery_end: 40 }), null);
  assert.equal(watchBattery({ battery_start: '45', battery_end: 40 }), null);
  assert.deepEqual(watchBattery({ battery_start: 100, battery_end: 0 }), { start: 100, end: 0 });
});
