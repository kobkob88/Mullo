import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disk } from '../app/core/disk.js';
import { aiConsented, giveAiConsent, recipients, askLater, askingNow } from '../app/core/ai-consent.js';

// App Store rule 5.1.2(i), S22e: asked before anything goes to an AI company, naming who gets it.
test('AI permission: per account, per recipient; a new recipient asks again', () => {
  disk.remove('echo:ai-consent');
  const me = 'aaaaaaaa-0000-0000-0000-000000000001';
  assert.equal(aiConsented(me, 'gemini'), false, 'nothing goes before a yes');
  assert.equal(aiConsented(null, 'gemini'), false, 'signed out: never');
  giveAiConsent(me, 'gemini');
  assert.equal(aiConsented(me, 'gemini'), true);
  assert.equal(aiConsented('bbbbbbbb-0000-0000-0000-000000000002', 'gemini'), false, 'another account on this phone is asked itself');
  assert.equal(aiConsented(me, 'openai'), false, 'their own OpenAI key: a new company, asked again');
  assert.equal(aiConsented(me, 'anthropic'), false);
});

test('a Claude key still sends audio to Gemini, so both are named', () => {
  assert.deepEqual(recipients('anthropic'), ['gemini', 'anthropic']);
  assert.deepEqual(recipients('openai'), ['openai']);
  assert.deepEqual(recipients(undefined), ['gemini']);
});

test('"Not now" puts the card away until the next start; it is not a yes', () => {
  assert.equal(askingNow(), true);
  askLater();
  assert.equal(askingNow(), false);
  assert.equal(aiConsented('cccccccc-0000-0000-0000-000000000003', 'gemini'), false);
});
