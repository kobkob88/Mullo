// The docs on the Worker (/docs): every page renders, every docs link lands on a page,
// no scripts, no long dashes, and the "opening soon" note follows CONNECTIONS_OPEN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCS } from '../worker/src/docs.mjs';
import { handle } from '../worker/src/index.mjs';

const call = (path, env = {}) => handle(new Request(`https://mullo.example${path}`), env, { fetch: () => { throw new Error('no network'); } });
const pathOf = (d) => `/docs${d.slug ? `/${d.slug}` : ''}`;

test('every docs page renders as a page with no scripts and no long dashes', async () => {
  assert.equal(new Set(DOCS.map((d) => d.slug)).size, DOCS.length, 'slugs are unique');
  for (const d of DOCS) {
    const res = await call(pathOf(d));
    assert.equal(res.status, 200, d.slug);
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
    const page = await res.text();
    assert.ok(page.includes(`<h1>${d.slug ? d.title.replace(/'/g, '&#39;') : 'Mullo Docs'}</h1>`), d.slug);
    assert.doesNotMatch(page, /<script/i, d.slug);
    assert.ok(!page.includes('—'), `${d.slug}: no long dash`);
    assert.doesNotMatch(page, /\$\{|undefined|\[object /, `${d.slug}: nothing left unfilled`);
  }
});

test('every /docs link on every page goes to a page that exists', async () => {
  const known = new Set(DOCS.map(pathOf));
  for (const d of DOCS) {
    const page = await (await call(pathOf(d))).text();
    for (const [, href] of page.matchAll(/href="(\/docs[^"#?]*)"/g)) assert.ok(known.has(href), `${d.slug} links to ${href}`);
  }
  assert.equal((await call('/docs/no-such-page')).status, 404);
});

test('the address shown is the site\'s own, and MCP pages say "opening soon" until switched on', async () => {
  const off = await (await call('/docs/mcp')).text();
  assert.ok(off.includes('https://mullo.example/mcp'));
  assert.ok(off.includes('Opening soon'));
  const on = await (await call('/docs/mcp', { CONNECTIONS_OPEN: 'yes' })).text();
  assert.ok(!on.includes('Opening soon'));
});

test('/connect, the app\'s old how-to link, goes to the MCP docs', async () => {
  const res = await call('/connect');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://mullo.example/docs/mcp');
});

test('mullo.app shows the website; the app and what apps connect to stay on mullo.lizai.io', async () => {
  const at = (u, env = {}) => handle(new Request(u), env, { fetch: () => { throw new Error('no network'); } });
  for (const page of ['/privacy', '/terms', '/docs/mcp']) { // '/' needs D1 (the trial size); same path
    assert.equal((await at(`https://mullo.app${page}`)).status, 200, page);
  }
  for (const [from, to] of [
    ['https://mullo.app/app/', 'https://mullo.lizai.io/app/'],
    ['https://mullo.app/mcp', 'https://mullo.lizai.io/mcp'],
    ['https://mullo.app/api/google/callback?state=x', 'https://mullo.lizai.io/api/google/callback?state=x'],
    ['https://mullo.app/.well-known/oauth-protected-resource', 'https://mullo.lizai.io/.well-known/oauth-protected-resource'],
    ['https://www.mullo.app/privacy', 'https://mullo.app/privacy'],
  ]) {
    const res = await at(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('Location'), to);
  }
  // On the app's own address /app is the static files, handed over untouched.
  const ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) };
  assert.equal(await (await at('https://mullo.lizai.io/app/', { ASSETS })).text(), 'asset /app/');
  assert.notEqual((await at('https://mullo.lizai.io/privacy', { ASSETS })).status, 301);
});

test('/go/claude and /go/chatgpt lead to their connector settings; anything else under /go is not a redirect', async () => {
  for (const [path, to] of [['/go/claude', /^https:\/\/claude\.ai\//], ['/go/chatgpt', /^https:\/\/chatgpt\.com\//]]) {
    const res = await call(path);
    assert.equal(res.status, 302);
    assert.match(res.headers.get('Location'), to);
  }
  assert.notEqual((await call('/go/evil')).status, 302);
});
