// What may become a task - from a real screenshot (2026-10-04): the
// first Hebrew note produced "בסדר", "כביסה", "למרות שכביסה לא קונים",
// "ונעליים לימילה שכבר קנינו" as tasks.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleTask } from '../app/domain/task-rules.js';
import { replaceExtracted, actionsFor, addAction, setActionStatus } from '../app/domain/actions.js';
import { createRecording, getRecording, updateRecording } from '../app/domain/recordings.js';
import { saveTranscript } from '../app/domain/transcripts.js';
import { useRemoteEngine } from '../app/domain/pipeline.js';
import { upgradeOfflineSummaries, activeJobs } from '../app/domain/jobs.js';
import { freshDb } from './helpers.mjs';

test('the screenshot\'s junk is rejected', () => {
  for (const junk of ['בסדר', 'כביסה', 'ביצים', 'למרות שכביסה לא קונים', 'ונעליים לימילה שכבר קנינו', 'okay', 'Thanks!', 'although we said so', 'Shoes already bought']) {
    assert.equal(isPlausibleTask(junk), false, junk);
  }
});

test('real tasks pass, in both languages', () => {
  for (const ok of ['לקנות חלב וביצים', 'להתקשר לספק על החשבונית', 'ולבדוק מה קורה עם ההזמנה', 'Email Dana the new quote', 'Call the customs broker', 'Dentist appointment Friday']) {
    assert.equal(isPlausibleTask(ok), true, ok);
  }
});

beforeEach(() => { freshDb(); useRemoteEngine(null); });

test('replaceExtracted filters whatever any engine proposed', async () => {
  const rec = await createRecording({ title: 'x' });
  await replaceExtracted(rec.id, [
    { label: 'לקנות חלב וביצים' }, { label: 'בסדר' }, { label: 'כביסה' }, { label: 'למרות שכביסה לא קונים' },
  ], { engine: 'remote' });
  assert.deepEqual((await actionsFor(rec.id)).map((a) => a.label), ['לקנות חלב וביצים']);
});

test('old offline summaries are redone by Gemini: junk replaced, ticked and hand-added tasks kept', async () => {
  const rec = await createRecording({ title: 'Voice note', source: 'device' });
  await saveTranscript(rec.id, [{ text: 'אנחנו צריכים לקנות חלב, ביצים, כביסה, בסדר?' }]);
  // What the old offline engine left behind:
  for (const label of ['בסדר', 'כביסה']) await addAction(rec.id, { label, origin: 'extracted' });
  const ticked = (await addAction(rec.id, { label: 'לקנות לחם', origin: 'extracted' })).row;
  await setActionStatus(ticked, 'done');
  await addAction(rec.id, { label: 'My own task' });
  await updateRecording(rec.id, { engine: 'local', status: 'ready' });
  const imported = await createRecording({ title: 'From Vocci', source: 'vocci' });
  await updateRecording(imported.id, { engine: 'local', status: 'ready' });

  useRemoteEngine({ id: 'remote', async process() { return { sections: [], actions: [{ label: 'לקנות חלב וביצים', type: 'create_reminder' }], summary: null, title: 'קניות' }; } });
  assert.equal(await upgradeOfflineSummaries(), 1, 'device recordings only');
  while (activeJobs()) await new Promise((r) => setTimeout(r, 5));

  const labels = (await actionsFor(rec.id)).map((a) => `${a.label}:${a.status}`).sort();
  assert.deepEqual(labels, ['My own task:open', 'לקנות חלב וביצים:open', 'לקנות לחם:done']);
  assert.equal((await getRecording(rec.id)).engine, 'remote');
});

test('no upgrade without the AI engine', async () => {
  const rec = await createRecording({ title: 'x', source: 'device' });
  await updateRecording(rec.id, { engine: 'local', status: 'ready' });
  assert.equal(await upgradeOfflineSummaries(), 0);
});
