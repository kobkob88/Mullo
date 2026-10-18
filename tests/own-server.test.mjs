// core/own-server.js: your own server in a browser, and the web build's CSP that allows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServer, browserServer, keepBrowserServer, dropBrowserServer, withBrowserServer } from '../app/core/own-server.js';
import { disk } from '../app/core/disk.js';
import { connectSrc } from '../scripts/lib.mjs';

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co/';
const KEY_OK = 'sb_publishable_abcdefghij1234567890';
const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;

test('own server: a supabase.co project with its publishable key is taken, cleaned to its origin', () => {
  assert.deepEqual(checkServer(URL_OK, ` ${KEY_OK} `, { browser: true }), { url: 'https://abcdefghijklmnopqrst.supabase.co', key: KEY_OK });
  assert.equal(checkServer(URL_OK, jwt('anon'), { browser: true }).url, 'https://abcdefghijklmnopqrst.supabase.co', 'the older anon key too');
});

test('own server: secret and service keys are refused, never kept', () => {
  assert.match(checkServer(URL_OK, 'sb_secret_abcdefghij1234567890', { browser: true }).problem, /secret key/);
  assert.match(checkServer(URL_OK, jwt('service_role'), { browser: true }).problem, /service key/);
  assert.match(checkServer(URL_OK, 'hello', { browser: true }).problem, /publishable key/);
});

test('own server: http and, in a browser, anything but supabase.co are refused (the CSP allows only that)', () => {
  assert.match(checkServer('http://abc.supabase.co', KEY_OK, { browser: true }).problem, /https/);
  assert.match(checkServer('not a url', KEY_OK, { browser: true }).problem, /https/);
  assert.match(checkServer('https://db.example.com', KEY_OK, { browser: true }).problem, /supabase\.co/);
  assert.match(checkServer('https://abc.supabase.co.evil.com', KEY_OK, { browser: true }).problem, /supabase\.co/);
  assert.equal(checkServer('https://db.example.com', KEY_OK, { browser: false }).url, 'https://db.example.com', 'self-hosted: the Android app');
});

test('own server: kept in this browser, applied over config.json, and dropped again', () => {
  const config = { supabaseUrl: 'https://mullo.supabase.co', supabaseAnonKey: 'sb_publishable_mullo1234567890', ownServer: false };
  assert.deepEqual(withBrowserServer(config), config, 'nothing kept: Mullo\'s server');
  keepBrowserServer(checkServer(URL_OK, KEY_OK, { browser: true }));
  assert.deepEqual(withBrowserServer(config), {
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', supabaseAnonKey: KEY_OK, ownServer: true,
    // Mullo's own account server stays known: the AI needs a Mullo sign-in there too (S25).
    mulloSupabaseUrl: 'https://mullo.supabase.co', mulloSupabaseAnonKey: 'sb_publishable_mullo1234567890',
  });
  disk.set('echo:own-server', { url: URL_OK, key: 'sb_secret_abcdefghij1234567890' });
  assert.equal(browserServer(), null, 'a changed entry that fails the checks is ignored');
  dropBrowserServer();
  assert.equal(browserServer(), null);
});

test('own server: only the web build\'s CSP names *.supabase.co', () => {
  const base = { ECHO_SUPABASE_URL: 'https://mullo.supabase.co', ECHO_BRIDGE_URL: '' };
  assert.doesNotMatch(connectSrc(base), /\*/, 'the Android and dev builds stay exact');
  assert.equal(connectSrc({ ...base, ECHO_OWN_SERVERS: 'supabase' }),
    'https://mullo.supabase.co wss://mullo.supabase.co https://*.supabase.co wss://*.supabase.co');
});
