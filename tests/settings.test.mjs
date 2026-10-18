import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, updateSettings, parseVocabulary, transcriptTarget, SAME, normalizeSettings } from '../app/core/settings.js';
import { disk } from '../app/core/disk.js';
import { buildTranscribeRequest } from '../bridge/transcribe.mjs';
import { buildRequest } from '../bridge/gemini.mjs';
import { useRemoteEngine, retranscribe, processRecording } from '../app/domain/pipeline.js';
import { createRecording, updateRecording } from '../app/domain/recordings.js';
import { saveTranscript, transcriptFor } from '../app/domain/transcripts.js';
import { saveAudio } from '../app/core/files.js';
import { freshDb } from './helpers.mjs';

beforeEach(() => { disk.remove('echo:settings'); disk.remove('echo:record-prefs'); freshDb(); useRemoteEngine(null); });

test('defaults: listen English, transcript same as spoken, no names, live preview on, match system, no own formats, reminders on with text shown', () => {
  assert.deepEqual(getSettings(), {
    listen: 'en', transcript: SAME, template: 'voice_note', vocabulary: [], livePreview: true, appearance: 'system', templates: [],
    reminders: true, remindersHidden: false, autoDrafts: true, keepAudio: 'keep', serverKeep: '24h',
  });
  // S44/S45: anything off the list falls back to the default (keep everything, a day).
  assert.equal(updateSettings({ keepAudio: 'forever', serverKeep: '48h' }).keepAudio, 'keep');
  assert.equal(getSettings().serverKeep, '24h');
  assert.equal(updateSettings({ keepAudio: '7', serverKeep: 'collected' }).serverKeep, 'collected');
  assert.equal(getSettings().keepAudio, '7');
  updateSettings({ keepAudio: 'keep', serverKeep: '24h' });
  assert.equal(updateSettings({ reminders: false }).reminders, false);
  assert.equal(normalizeSettings({ autoDrafts: false }).autoDrafts, false, 'S50 drafts can be turned off');
  assert.equal(normalizeSettings({ remindersHidden: 'yes' }).remindersHidden, false, 'only a real true hides the text');
});

test('switches and appearance', () => {
  assert.equal(updateSettings({ livePreview: false }).livePreview, false);
  assert.equal('drafts' in updateSettings({ drafts: false }), false, 'the S11 Draft suggestions switch is gone (S10)');
  assert.equal(updateSettings({ appearance: 'light' }).appearance, 'light');
  assert.equal(normalizeSettings({ appearance: 'neon' }).appearance, 'system');
});

test('usage this month: phone and watch minutes, questions, estimated cost, reset date', async () => {
  const { monthUsage, countQuestion, COST_PER_HOUR } = await import('../app/core/usage.js');
  disk.remove('echo:usage:2026-10');
  countQuestion('2026-10-04');
  countQuestion('2026-10-04');
  const recs = [
    { source: 'device', local_date: '2026-10-04', duration_ms: 90 * 60_000 },
    { source: 'device', local_date: '2026-09-30', duration_ms: 60 * 60_000 },
    { source: 'pocket', local_date: '2026-10-03', duration_ms: 60 * 60_000 },
    { source: 'watch', local_date: '2026-10-05', duration_ms: 30 * 60_000 },
  ];
  const u = monthUsage(recs, '2026-10-04');
  assert.equal(u.minutes, 120, 'this month, phone and watch, never an old import');
  assert.equal(u.questions, 2);
  assert.ok(Math.abs(u.cost - (2 * COST_PER_HOUR + 2 * 0.001)) < 1e-9);
  assert.equal(u.resets.getDate(), 1);
  assert.equal(u.resets.getMonth(), 10, 'November');
});

test('old record prefs are read once ("he-IL" → "he")', () => {
  disk.set('echo:record-prefs', { lang: 'en-US', template: 'meeting' });
  assert.deepEqual([getSettings().listen, getSettings().template], ['en', 'meeting']);
});

test('names list: one per line or comma, trimmed, de-duplicated, capped', () => {
  assert.deepEqual(parseVocabulary(' נועה (Noa) \nדניאל, Costco;\n\nדניאל'), ['נועה (Noa)', 'דניאל', 'Costco']);
  assert.equal(parseVocabulary(Array.from({ length: 100 }, (_, i) => `n${i}`).join('\n')).length, 60);
});

test('bad values fall back; "auto" is not a transcript language', () => {
  assert.equal(normalizeSettings({ listen: 'klingon' }).listen, 'en');
  assert.equal(normalizeSettings({ transcript: 'auto' }).transcript, SAME);
  assert.equal(updateSettings({ transcript: 'en-GB' }).transcript, 'en');
});

test('target: none when same as spoken', () => {
  assert.equal(transcriptTarget({ transcript: SAME }, 'he'), null);
  assert.equal(transcriptTarget({ transcript: 'he' }, 'he-IL'), null);
  assert.equal(transcriptTarget({ transcript: 'en' }, 'he'), 'en');
});

test('prompts: names go to transcription and to the summary; translation only when asked', () => {
  const t = buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: 'he', vocabulary: ['נועה (Noa)'] }).system_instruction.parts[0].text;
  assert.match(t, /write it exactly as given: נועה \(Noa\)/);
  assert.match(t, /never translate/);
  const tr = buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: 'he', target: 'en' }).system_instruction.parts[0].text;
  assert.match(tr, /write it in English: a faithful, complete translation/);
  assert.doesNotMatch(tr, /never translate/);
  const req = buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: 'he', target: 'en', vocabulary: ['נועה (Noa)'] });
  assert.equal(req.contents[0].parts[1].text, req.system_instruction.parts[0].text, 'instruction repeated next to the audio (3.1-flash-lite ignores it otherwise)');
  const same = buildTranscribeRequest({ audioBase64: 'A', mime: 'audio/webm', language: 'he', target: 'he' }).system_instruction.parts[0].text;
  assert.doesNotMatch(same, /translation/);
  const p = buildRequest({ segments: [{ text: 'x' }], template: 'general', today: '2026-10-04', vocabulary: ['נועה (Noa)'] }).system_instruction.parts[0].text;
  assert.match(p, /נועה \(Noa\)/);
  assert.doesNotMatch(buildRequest({ segments: [{ text: 'x' }], template: 'general', today: '2026-10-04' }).system_instruction.parts[0].text, /Names and words/);
});

test('the app sends the settings: names + target to transcription, names to the summary', async () => {
  updateSettings({ transcript: 'en', vocabulary: ['נועה (Noa)'] });
  const calls = { transcribe: null, process: null };
  useRemoteEngine({
    id: 'remote',
    async transcribe(blob, { job, ...opts }) { calls.transcribe = opts; return { segments: [{ text: 'Buy shoes for Noa' }], engine: 'gemini' }; },
    async process(payload) { calls.process = payload; return { sections: [], actions: [], summary: null, title: 'Shoes for Noa' }; },
  });
  const rec = await createRecording({ title: 'x', language: 'he', duration_ms: 3000 });
  const file = await saveAudio(new Blob(['a'], { type: 'audio/webm' }), { recordingId: rec.id });
  await updateRecording(rec.id, { audio_file_id: file.id });
  const res = await retranscribe(rec.id, { language: 'he' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.transcribe, { language: 'he', target: 'en', vocabulary: ['נועה (Noa)'], durationMs: 3000, keep: '24h' });
  assert.deepEqual(calls.process.vocabulary, ['נועה (Noa)']);
  assert.equal((await transcriptFor(rec.id)).language, 'en', 'the transcript records the language it is written in');
});

test('S45: "as soon as my phone has it" says "got it" only after the transcript is saved; other choices never do', async () => {
  for (const [serverKeep, expected] of [['collected', ['job-1']], ['1h', []], ['24h', []]]) {
    updateSettings({ serverKeep });
    const released = [];
    let savedFirst = null;
    let recId = null;
    useRemoteEngine({
      id: 'remote',
      async transcribe() { return { segments: [{ text: 'hi' }], engine: 'gemini', job: 'job-1' }; },
      async release(id) { savedFirst = Boolean((await transcriptFor(recId))?.segments?.length); released.push(id); return true; },
      async process() { return { sections: [], actions: [], summary: null, title: 't' }; },
    });
    const rec = await createRecording({ title: 'x', language: 'en' });
    recId = rec.id;
    const file = await saveAudio(new Blob(['a'], { type: 'audio/webm' }), { recordingId: rec.id });
    await updateRecording(rec.id, { audio_file_id: file.id });
    assert.equal((await retranscribe(rec.id, {})).ok, true);
    await new Promise((r) => { setTimeout(r, 0); });
    assert.deepEqual(released, expected, serverKeep);
    if (expected.length) assert.equal(savedFirst, true, 'the transcript was saved before the server was told');
  }
});

test('auto = no spoken language sent (Gemini detects)', async () => {
  let sent;
  useRemoteEngine({ id: 'remote', async transcribe(b, o) { sent = o; return { segments: [{ text: 'hi' }] }; }, async process() { return { sections: [], actions: [] }; } });
  const rec = await createRecording({ title: 'x' });
  const file = await saveAudio(new Blob(['a'], { type: 'audio/webm' }), { recordingId: rec.id });
  await updateRecording(rec.id, { audio_file_id: file.id });
  await retranscribe(rec.id, { language: 'auto' });
  assert.equal(sent.language, null);
  assert.equal(sent.target, null);
});

test('processRecording alone also carries the names', async () => {
  updateSettings({ vocabulary: ['דניאל'] });
  let seen;
  useRemoteEngine({ id: 'remote', async process(p) { seen = p; return { sections: [], actions: [] }; } });
  const rec = await createRecording({ title: 'x' });
  await saveTranscript(rec.id, [{ text: 'talk to Daniel' }]);
  await processRecording(rec.id);
  assert.deepEqual(seen.vocabulary, ['דניאל']);
});
