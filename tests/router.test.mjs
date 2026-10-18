import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noteRoute, takeScrollRestore, backLink, navTab, resetTrail, parseRoute } from '../app/ui/router.js';

beforeEach(resetTrail);

// Owner, 2026-10-07: opening a recording from Actions had no way back to the action.
test('a recording opened from Actions leads back to Actions, scrolled to where it was', () => {
  noteRoute('#/actions');
  noteRoute('#/rec/abc', 1240); // Actions was scrolled to 1240 when the recording was tapped
  assert.deepEqual(backLink(), { hash: '#/actions', label: 'Actions', isPrevious: true });
  assert.equal(navTab('recording'), 'actions', 'the Actions tab stays lit');
  assert.equal(takeScrollRestore(), null, 'a recording opens at the top');

  noteRoute('#/actions', 300); // back
  assert.equal(takeScrollRestore(), 1240);
  assert.equal(takeScrollRestore(), null, 'only once');
});

test('desktop layout: on a wide window a recording opens beside the Library list', () => {
  assert.deepEqual(parseRoute('#/rec/abc', { wide: true }), { screen: 'library', params: { open: 'abc' } });
  assert.deepEqual(parseRoute('#/rec/abc'), { screen: 'recording', params: { id: 'abc' } });
  assert.deepEqual(parseRoute('#/library', { wide: true }), { screen: 'library', params: {} });
  assert.deepEqual(parseRoute('#/actions', { wide: true }), { screen: 'actions', params: { focus: null } });
});

test('from Search it says Search; from the Library, or opened directly, it says Library', () => {
  noteRoute('#/search');
  noteRoute('#/rec/abc');
  assert.equal(backLink().label, 'Search');

  resetTrail();
  noteRoute('#/library');
  noteRoute('#/rec/abc');
  assert.deepEqual(backLink(), { hash: '#/library', label: 'Library', isPrevious: true });
  assert.equal(navTab('recording'), 'library');

  resetTrail();
  noteRoute('#/rec/abc'); // a link from outside: going "back" would leave the app
  assert.deepEqual(backLink(), { hash: '#/library', label: 'Library', isPrevious: false });
});

// Owner, 2026-10-10: Developers and every Connections "Set up" opened the Library - the
// router didn't know #/settings/developers, so app.js sent it to #/library.
test('every Settings link opens its Settings page', () => {
  const src = readFileSync(new URL('../app/ui/panels/settings.js', import.meta.url), 'utf8');
  const sections = [...new Set([...src.matchAll(/#\/settings\/([\w-]+)/g)].map((m) => m[1]))];
  assert.ok(sections.includes('developers'));
  for (const section of sections) {
    assert.deepEqual(parseRoute(`#/settings/${section}`), { screen: 'settings', params: { section } }, section);
  }
});

test('going somewhere new starts at the top; only the screen just left gets its scroll back', () => {
  noteRoute('#/actions');
  noteRoute('#/rec/abc', 900);
  noteRoute('#/settings', 0);
  noteRoute('#/actions', 0);
  assert.equal(takeScrollRestore(), null);
});

// Owner, 2026-10-16: scroll Record down, go to another tab, come back: it starts at the top.
test('Record always opens at the top, even going back to it', () => {
  noteRoute('#/record');
  noteRoute('#/library', 640); // Record was scrolled to 640
  noteRoute('#/record', 0);
  assert.equal(takeScrollRestore(), null);
});
