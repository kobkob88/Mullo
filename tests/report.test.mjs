// Report a problem (S56): the error log, the details a report carries and what is sent
// (app/core/error-log.js, app/domain/report.js). The server side is in worker.test.mjs.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { logError, recentErrors, clearErrors, MAX_ERRORS } from '../app/core/error-log.js';
import { reportDetails, detailsNow, screenName, platformOf, mailtoHref, sendReport, reportAbout, reportNote, rememberScreen, lastScreen } from '../app/domain/report.js';
import { createRecording } from '../app/domain/recordings.js';
import { saveTranscript } from '../app/domain/transcripts.js';
import { addAction } from '../app/domain/actions.js';
import { freshDb } from './helpers.mjs';

beforeEach(() => { freshDb(); clearErrors(); reportAbout(null); });

test('error log: keeps the last 20, cuts long messages, in memory only', () => {
  for (let i = 0; i < 25; i++) logError(new Error(`boom ${i}`), 'rec-tab');
  const errors = recentErrors();
  assert.equal(errors.length, MAX_ERRORS);
  assert.equal(errors[0].message, 'boom 5');
  assert.equal(errors.at(-1).where, 'rec-tab');
  logError(new Error('x'.repeat(1000)));
  assert.equal(recentErrors().at(-1).message.length, 300);
  logError('plain text');
  assert.equal(recentErrors().at(-1).message, 'plain text');
});

test('details: screen names carry no ids; a reported note goes as noteId only', () => {
  assert.equal(screenName('#/rec/abc123'), 'recording');
  assert.equal(screenName('#/settings/report'), 'settings/report');
  assert.equal(screenName('#/actions'), 'actions');
  assert.equal(screenName(''), 'library');
  assert.equal(platformOf({ android: true, phoneApp: true }), 'android-app');
  assert.equal(platformOf({ phoneApp: true }), 'ios-app');
  assert.equal(platformOf(), 'browser');
  const d = reportDetails({ version: '95', platform: 'browser', userAgent: 'UA', hash: '#/rec/abc123', plan: 'pro', language: 'he-IL', noteId: 'abc123' });
  assert.deepEqual(d, { version: '95', platform: 'browser', userAgent: 'UA', screen: 'recording', plan: 'pro', language: 'he-IL', noteId: 'abc123', errors: [] });
  assert.equal(reportDetails({ version: '95', platform: 'browser' }).noteId, undefined);
});

test('the last screen outside Settings is the one reported', () => {
  rememberScreen('#/actions');
  rememberScreen('#/settings');
  rememberScreen('#/settings/report');
  assert.equal(lastScreen(), '#/actions');
});

test('a report from a device full of notes and secrets carries none of them', async () => {
  const rec = await createRecording({ title: 'Secret plans with Dana' });
  await saveTranscript(rec.id, [{ text: 'the transcript words nobody else should see' }]);
  await addAction(rec.id, { label: 'Pay the private invoice' });
  globalThis.localStorage?.setItem?.('echo:own-ai', 'AIza-secret-key');
  logError(new Error('Could not save'), 'rec-rename');
  reportAbout(rec.id);
  assert.equal(reportNote(), rec.id);

  const sent = [];
  const server = async (url, path, body) => { sent.push({ url, path, body }); return { ok: true }; };
  const details = detailsNow({ version: '95', platform: 'android-app', userAgent: 'UA', hash: `#/rec/${rec.id}`, plan: 'free', language: 'en', noteId: reportNote() });
  assert.deepEqual(await sendReport(server, 'https://mullo.test', { text: 'The title edit froze', details, screenshot: 'AAAA' }), { ok: true });
  assert.equal(sent[0].path, '/api/reports');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['details', 'screenshot', 'text']);
  const all = JSON.stringify(sent[0].body);
  for (const secret of ['Secret plans', 'transcript words', 'private invoice', 'AIza-secret-key']) assert.ok(!all.includes(secret), secret);
  assert.equal(sent[0].body.details.noteId, rec.id);
  assert.equal(sent[0].body.details.screen, 'recording');
  assert.deepEqual(sent[0].body.details.errors.map((e) => e.where), ['rec-rename']);
});

test('sending: empty or too long text is refused before the network; a failure keeps its reason', async () => {
  const never = async () => { throw new Error('should not be called'); };
  assert.match((await sendReport(never, 'u', { text: '  ', details: {} })).error, /Write what happened/);
  assert.match((await sendReport(never, 'u', { text: 'x'.repeat(2001), details: {} })).error, /under 2,000/);
  const offline = async () => { throw Object.assign(new Error('You\'re offline.'), { offline: true }); };
  assert.deepEqual(await sendReport(offline, 'u', { text: 'hi', details: {} }), { ok: false, error: 'You\'re offline.', offline: true });
});

test('Email us instead: the text and the details in the body, to hello@lizai.io', () => {
  const href = mailtoHref('שלום, it broke', { version: '95' });
  assert.match(href, /^mailto:hello@lizai\.io\?subject=Mullo%20problem%20report&body=/);
  const body = decodeURIComponent(href.split('body=')[1]);
  assert.match(body, /^שלום, it broke\n\n---\n\{\n {2}"version": "95"\n\}$/);
});
