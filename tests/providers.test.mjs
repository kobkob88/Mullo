// bridge/providers.mjs: the pieces that let OpenAI and Claude reuse Mullo's Gemini prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonSchema, fromGemini, openaiSegments, CAN } from '../bridge/providers.mjs';
import { buildRequest } from '../bridge/gemini.mjs';

test('providers: Gemini\'s schema becomes a strict JSON Schema (closed, all required, optional = nullable)', () => {
  const out = jsonSchema({
    type: 'OBJECT',
    properties: { label: { type: 'STRING' }, priority: { type: 'STRING', enum: ['high', 'low'] }, start: { type: 'STRING', nullable: true }, tags: { type: 'ARRAY', items: { type: 'STRING' } } },
    required: ['label'],
  });
  assert.deepEqual(out.required, ['label', 'priority', 'start', 'tags']);
  assert.equal(out.additionalProperties, false);
  assert.equal(out.properties.label.type, 'string');
  assert.deepEqual(out.properties.priority, { type: ['string', 'null'], enum: ['high', 'low', null] });
  assert.deepEqual(out.properties.start.type, ['string', 'null']);
  assert.deepEqual(out.properties.tags.type, ['array', 'null']);
});

test('providers: every object in the notes schema is closed, and the prompt is Mullo\'s own', () => {
  const spec = fromGemini(buildRequest({ segments: [{ text: 'Buy milk', start_ms: 0 }], template: 'general', today: '2026-10-09' }), 'notes');
  assert.match(spec.system, /structured notes/);
  assert.match(spec.user, /Transcript:/);
  const objects = [];
  (function walk(s) {
    if (!s || typeof s !== 'object') return;
    if (s.properties) objects.push(s);
    Object.values(s.properties ?? {}).forEach(walk);
    walk(s.items);
  })(spec.schema);
  assert.ok(objects.length >= 4);
  for (const o of objects) {
    assert.equal(o.additionalProperties, false);
    assert.deepEqual(o.required, Object.keys(o.properties));
  }
});

test('providers: OpenAI\'s speakers become Speaker 1, 2 by first appearance; bad times are dropped', () => {
  const segs = openaiSegments({ segments: [
    { speaker: 'B', start: 1, end: 2, text: 'First voice' },
    { speaker: 'A', start: 3, end: 4, text: ' Second  voice ' },
    { speaker: 'B', start: 2.5, end: 9999, text: 'Back in time' },
    { speaker: 'A', start: 5, end: 6, text: '' },
  ] }, { durationMs: 10_000 });
  assert.deepEqual(segs.map((s) => [s.speaker, s.text, s.start_ms, s.end_ms]), [
    ['Speaker 1', 'First voice', 1000, 2000],
    ['Speaker 2', 'Second voice', 3000, 4000],
    ['Speaker 1', 'Back in time', null, null],
  ]);
});

test('providers: Claude takes no audio', () => {
  assert.ok(!CAN.anthropic.includes('transcribe'));
  assert.ok(CAN.openai.includes('transcribe') && CAN.gemini.includes('transcribe'));
});
