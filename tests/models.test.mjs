// Summary models (S54): the list, who may use what, and how a pick is resolved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODELS, cleanModels, tiersFor, resolveModel, defaultModel, modelsReport } from '../worker/src/models.mjs';

test('starting list: 3.1 Flash-Lite is the one default, a Pro model; 3.8 Flash is Max; no slow flagship', () => {
  const byId = Object.fromEntries(DEFAULT_MODELS.map((m) => [m.id, m]));
  assert.equal(defaultModel(DEFAULT_MODELS).id, 'gemini-3.1-flash-lite');
  assert.deepEqual(DEFAULT_MODELS.map((m) => [m.id, m.tier]),
    [['gemini-3.1-flash-lite', 'standard'], ['gemini-3.5-flash-lite', 'standard'], ['gemini-3.8-flash', 'max']]);
  assert.equal(byId['gemini-3.5-flash-lite'].thinking, 'minimal', 'refuses budget 0 (Admin Test, 2026-10-17)');
  assert.equal(cleanModels([{ id: 'gemini-a1', tier: 'standard', isDefault: true, thinking: 'minimal' }])[0].thinking, 'minimal');
  assert.deepEqual(cleanModels(DEFAULT_MODELS), DEFAULT_MODELS, 'the coded list passes its own check');
});

test('who may use what: trial = default only, Pro/free = Pro list, own Gemini key = Pro + Max', () => {
  assert.deepEqual(tiersFor({ plan: 'trial' }), []);
  assert.deepEqual(tiersFor({ plan: 'none' }), []);
  assert.deepEqual(tiersFor({ plan: 'pro' }), ['standard']);
  assert.deepEqual(tiersFor({ plan: 'free' }), ['standard']);
  assert.deepEqual(tiersFor({ plan: 'max' }), ['standard', 'max']);
  assert.deepEqual(tiersFor({ plan: 'own', provider: 'gemini' }), ['standard', 'max']);
  assert.deepEqual(tiersFor({ plan: 'own', provider: 'openai' }), []);
});

test('resolve: a pick the plan allows is used; anything else falls back to the default', () => {
  const L = DEFAULT_MODELS;
  assert.equal(resolveModel(L, ['standard'], 'gemini-3.5-flash-lite').id, 'gemini-3.5-flash-lite');
  assert.equal(resolveModel(L, ['standard'], 'gemini-3.8-flash').id, 'gemini-3.1-flash-lite', 'Max model on Pro');
  assert.equal(resolveModel(L, ['standard', 'max'], 'gemini-3.8-flash').id, 'gemini-3.8-flash');
  const withOff = [...L, { ...L[2], id: 'gemini-x-off', tier: 'off' }];
  assert.equal(resolveModel(withOff, ['standard', 'max'], 'gemini-x-off').id, 'gemini-3.1-flash-lite', 'off is never used');
  assert.equal(resolveModel(L, [], 'gemini-3.5-flash-lite').id, 'gemini-3.1-flash-lite', 'trial');
  assert.equal(resolveModel(L, [], null).id, 'gemini-3.1-flash-lite');
  assert.equal(resolveModel(L, ['standard'], 'made-up').id, 'gemini-3.1-flash-lite');
});

test('the admin list is checked: ids, one Pro default, unknown values made safe', () => {
  const bad = (list, re) => assert.throws(() => cleanModels(list), (e) => e.status === 400 && re.test(e.message));
  bad([], /1 to 20/);
  bad([{ id: 'gpt-6-luna', tier: 'standard', isDefault: true }], /isn't a Gemini model id/);
  bad([{ id: 'gemini-a1', tier: 'standard', isDefault: true }, { id: 'gemini-a1', tier: 'max' }], /twice/);
  bad([{ id: 'gemini-a1', tier: 'max', isDefault: true }], /exactly one default/);
  bad([{ id: 'gemini-a1', tier: 'standard' }], /exactly one default/);
  const [m] = cleanModels([{ id: 'gemini-a1', tier: 'weird', badge: 'x', thinking: 'max', isDefault: true, label: '', priceIn: -3, line: 'y'.repeat(300) }]);
  assert.deepEqual(m, { id: 'gemini-a1', label: 'gemini-a1', line: 'y'.repeat(120), tier: 'standard', badge: 'none', thinking: 'none', isDefault: true, priceIn: 0, priceOut: 0 },
    'an unknown tier on the default becomes standard; the rest fall back to safe values');
});

test('report for the app: off models hidden, allowed per plan, what is used now', () => {
  const r = modelsReport(DEFAULT_MODELS, ['standard'], 'gemini-3.8-flash');
  assert.deepEqual(r.models.map((m) => [m.id, m.allowed]),
    [['gemini-3.1-flash-lite', true], ['gemini-3.5-flash-lite', true], ['gemini-3.8-flash', false]]);
  assert.equal(r.pick, 'gemini-3.8-flash');
  assert.equal(r.using, 'gemini-3.1-flash-lite');
  assert.ok(!('priceIn' in r.models[0]), 'prices stay on the server');
});
