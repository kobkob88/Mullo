import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phraseChanges, teachEntry, parseTeachEntry, newTeachings, lineFixes, mergeFixes, applyFixes, fixesAsVocabulary } from '../app/domain/corrections.js';
import { vocabularyLine } from '../bridge/gemini.mjs';

test('the owner\'s case: a misheard name inside a Hebrew sentence', () => {
  assert.deepEqual(
    phraseChanges('אמיליה רוצה את שרמן דרך בצעצוע', 'אמיליה רוצה את Charmander בצעצוע'),
    [{ heard: 'שרמן דרך', meant: 'Charmander' }],
  );
});

test('several fixes in one line, punctuation ignored', () => {
  assert.deepEqual(
    phraseChanges('Call Donna about the Mont royal delivery.', 'Call Dana about the Montreal delivery.'),
    [{ heard: 'Donna', meant: 'Dana' }, { heard: 'Mont royal', meant: 'Montreal' }],
  );
});

test('nothing to teach: same words, case or punctuation only, pure additions or deletions', () => {
  assert.deepEqual(phraseChanges('hello world', 'hello world'), []);
  assert.deepEqual(phraseChanges('hello world', 'Hello, world!'), []);
  assert.deepEqual(phraseChanges('call Dana', 'call Dana tomorrow'), []);
  assert.deepEqual(phraseChanges('um call Dana', 'call Dana'), []);
  assert.deepEqual(phraseChanges('Mont real', 'Montreal'), [], 'only spacing changed');
});

test('a rewritten sentence is not a misheard word', () => {
  assert.deepEqual(phraseChanges(
    'we need to go to the store and buy some milk for the kids',
    'remind me tomorrow morning please about everything regarding groceries today',
  ), []);
});

test('teach entries round-trip and skip what is already taught', () => {
  const e = teachEntry('Charmander', 'שרמן דרך');
  assert.equal(e, 'Charmander (heard as שרמן דרך)');
  assert.deepEqual(parseTeachEntry(e), { word: 'Charmander', heardAs: 'שרמן דרך' });
  assert.equal(parseTeachEntry('נועה (Noa)'), null, 'a plain two-spellings entry is not a teaching');
  const changes = [{ heard: 'שרמן דרך', meant: 'Charmander' }, { heard: 'Donna', meant: 'Dana' }];
  assert.deepEqual(newTeachings(changes, [e]), [{ heard: 'Donna', meant: 'Dana' }]);
});

test('fixes kept with a recording: exact, so "235" → "2.35" counts', () => {
  assert.deepEqual(lineFixes('Uh, 235?', 'Uh, 2.35?'), [{ heard: '235', meant: '2.35' }]);
  assert.deepEqual(lineFixes('Yeah 85 and $1.50.', 'Yeah 1.85 and $1.50.'), [{ heard: '85', meant: '1.85' }]);
  assert.deepEqual(lineFixes('call Dana', 'call Dana tomorrow'), [], 'an addition has nothing to anchor on');
  assert.deepEqual(lineFixes('Uh pretty good', 'Uh, pretty good'), [], 'punctuation at the edge only');
});

test('fixes merge: newest wins, putting a word back drops the fix', () => {
  const kept = [{ heard: '235', meant: '2.35' }, { heard: 'Donna', meant: 'Dana' }];
  assert.deepEqual(mergeFixes(kept, [{ heard: 'Donna', meant: 'Dana C.' }]),
    [{ heard: 'Donna', meant: 'Dana C.' }, { heard: '235', meant: '2.35' }]);
  assert.deepEqual(mergeFixes(kept, [{ heard: '2.35', meant: '235' }]), [{ heard: 'Donna', meant: 'Dana' }]);
  assert.deepEqual(mergeFixes(undefined, []), []);
});

test('a new transcript gets the fixes back: whole words, never inside a number, never doubled', () => {
  const fixes = [{ heard: '235', meant: '2.35' }, { heard: 'David', meant: 'David Cohen' }, { heard: '35', meant: 'thirty-five' }];
  const out = applyFixes([
    { speaker: 'Speaker 1', text: 'Uh, 235?', start_ms: 33_000 },
    { text: 'It is 235, yeah, not 1235 or 2350.' },
    { text: 'David and David Cohen' },
    { text: 'It costs 2.35 or 1,350.' },
  ], fixes);
  assert.deepEqual(out.map((s) => s.text), [
    'Uh, 2.35?',
    'It is 2.35, yeah, not 1235 or 2350.',
    'David Cohen and David Cohen',
    'It costs 2.35 or 1,350.',
  ]);
  assert.equal(out[0].start_ms, 33_000);
  assert.deepEqual(fixesAsVocabulary([{ heard: '235', meant: '2.35' }]), ['2.35 (heard as 235)']);
});

test('the transcription prompt turns taught entries into "heard X, write Y"', () => {
  const line = vocabularyLine(['נועה (Noa)', 'Charmander (heard as שרמן דרך)']);
  assert.match(line, /נועה \(Noa\)/);
  assert.match(line, /Charmander/);
  assert.match(line, /"שרמן דרך" → write "Charmander"/);
  assert.doesNotMatch(line, /\(heard as/, 'Gemini never sees the raw "(heard as" note as a spelling');
});
