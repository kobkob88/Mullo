import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, COMMON, AUTO, baseCode, englishName, languageLabel, languageGroups, speechLang, isKnownLanguage } from '../app/core/languages.js';

test('the list covers the ~110 Gemini languages', () => {
  assert.ok(Object.keys(LANGUAGES).length >= 108, `${Object.keys(LANGUAGES).length} languages`);
});

test('old regional codes and aliases read as base codes', () => {
  assert.equal(baseCode('he-IL'), 'he');
  assert.equal(baseCode('iw'), 'he');
  assert.equal(baseCode('en-GB'), 'en');
  assert.equal(baseCode('zh-TW'), 'zh-Hant');
  assert.equal(baseCode('zh-CN'), 'zh-Hans');
  assert.equal(baseCode(AUTO), AUTO);
  assert.equal(baseCode('xx'), null);
  assert.ok(isKnownLanguage('ar') && isKnownLanguage(AUTO) && !isKnownLanguage('klingon'));
});

test('labels: own name plus English', () => {
  assert.equal(englishName('he-IL'), 'Hebrew');
  assert.match(languageLabel('he'), /^עברית - Hebrew$/);
  assert.match(languageLabel('ru'), /- Russian$/);
  assert.equal(languageLabel('en'), 'English');
  assert.match(languageLabel(AUTO), /Detect automatically/);
});

test('groups: common first, every language once, sorted', () => {
  const { common, all } = languageGroups();
  assert.deepEqual(common.map(([c]) => c), COMMON);
  const codes = [...common, ...all].map(([c]) => c);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(codes.length, Object.keys(LANGUAGES).length + 1, 'all languages + auto');
});

test('live preview gets a regional code where browsers expect one', () => {
  assert.equal(speechLang('he'), 'he-IL');
  assert.equal(speechLang('sw'), 'sw');
});
