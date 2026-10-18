// The mascot's mood (S20): which of the six faces the app shows, from what is going on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moodOf, afterJob, MOODS } from '../app/domain/mood.js';

const rec = (id, extra = {}) => ({ id, title: id, status: 'ready', ...extra });

test('nothing going on: idle', () => {
  assert.deepEqual(moodOf({ recordings: [rec('a')] }), { mood: 'idle', recording: null });
  assert.deepEqual(moodOf(), { mood: 'idle', recording: null });
});

test('recording wins over everything', () => {
  const r = moodOf({ listening: true, online: false, recordings: [rec('a')], running: new Set(['a']), last: { id: 'a', kind: 'ready' } });
  assert.equal(r.mood, 'listening');
});

test('a job running here: mulling, about that recording', () => {
  const r = moodOf({ recordings: [rec('a'), rec('b', { status: 'transcribing' })], running: new Set(['b']) });
  assert.equal(r.mood, 'mulling');
  assert.equal(r.recording.id, 'b');
});

test('a watch note made ready in the background: mulling, about that note', () => {
  const note = { id: 'w1', duration_ms: 18000 };
  assert.deepEqual(moodOf({ recordings: [rec('a')], elsewhere: [note] }), { mood: 'mulling', recording: null, watchNote: note });
  assert.equal(moodOf({ recordings: [rec('a')], running: new Set(['a']), elsewhere: [note] }).recording.id, 'a', 'a job here comes first');
  assert.equal(moodOf({ online: false, elsewhere: [note] }).mood, 'idle', 'offline: the background job waits too');
});

test('a stuck status with no job running is not mulling', () => {
  assert.equal(moodOf({ recordings: [rec('a', { status: 'processing' })] }).mood, 'idle');
});

test('work waiting and no connection: offline', () => {
  assert.equal(moodOf({ online: false, recordings: [rec('a')], running: new Set(['a']) }).mood, 'offline');
  const waiting = moodOf({ online: false, recordings: [rec('a', { transcribe_job: 'job-1' })] });
  assert.equal(waiting.mood, 'offline');
  assert.equal(waiting.recording.id, 'a');
  // Offline with nothing waiting is just idle.
  assert.equal(moodOf({ online: false, recordings: [rec('a')] }).mood, 'idle');
});

test('a kept server job with a connection and nothing running is not mulling', () => {
  assert.equal(moodOf({ recordings: [rec('a', { transcribe_job: 'job-1' })] }).mood, 'idle');
});

test('ready and no speech last until the recording is gone (or opened: the caller drops last)', () => {
  assert.equal(moodOf({ recordings: [rec('a')], last: { id: 'a', kind: 'ready' } }).mood, 'ready');
  assert.equal(moodOf({ recordings: [rec('a')], last: { id: 'a', kind: 'silent' } }).mood, 'silent');
  assert.equal(moodOf({ recordings: [rec('b')], last: { id: 'a', kind: 'ready' } }).mood, 'idle');
});

test('mulling a new one beats the last ready face', () => {
  const r = moodOf({ recordings: [rec('a'), rec('b')], running: new Set(['b']), last: { id: 'a', kind: 'ready' } });
  assert.equal(r.mood, 'mulling');
});

test('afterJob: ready only when everything worked, silent when no speech', () => {
  assert.deepEqual(afterJob({ recordingId: 'a', ok: true }), { id: 'a', kind: 'ready' });
  assert.deepEqual(afterJob({ recordingId: 'a', ok: true, silent: true }), { id: 'a', kind: 'silent' });
  assert.equal(afterJob({ recordingId: 'a', ok: false, error: 'x' }), null);
  assert.equal(afterJob({ recordingId: 'a', ok: true, offline: true }), null);
  assert.equal(afterJob({ recordingId: 'a', ok: true, transcribeError: 'x' }), null);
  assert.equal(afterJob({ recordingId: 'a', ok: true, aiError: 'x' }), null);
});

test('every mood the rule can return is one the mascot can draw', () => {
  for (const m of ['idle', 'listening', 'mulling', 'ready', 'silent', 'offline']) assert.ok(MOODS.includes(m));
});
