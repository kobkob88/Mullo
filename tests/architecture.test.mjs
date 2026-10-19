// Architectural rules as tests that fail the build (spec §12). Each of these
// was a prose rule somewhere once; prose did not hold the line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, APP, appFiles, readManifest, importsOf, read, walk } from '../scripts/lib.mjs';
import { SURFACES } from '../app/core/surfaces.js';
import { APP_VERSION } from '../app/core/version.js';

const jsFiles = appFiles().filter((f) => f.endsWith('.js'));
const sourceFiles = appFiles().filter((f) => /\.(js|html|css|json)$/.test(f));

// Strip comments so prose about a rule doesn't trip the rule.
function code(rel) {
  const noBlocks = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
  return rel.endsWith('.css') ? noBlocks : noBlocks.replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
const textOf = (f) => (/\.(js|css)$/.test(f) ? code(f) : read(f));

// ── Budget counters: start at 0 and may never rise ─────────────────────
test('zero inline event handlers in markup or JS strings', () => {
  const hits = [];
  for (const f of sourceFiles) {
    const src = textOf(f);
    for (const m of src.matchAll(/[\s<"'`]on[a-z]+\s*=\s*["'`]/gi)) hits.push(`${f}: ${m[0].trim()}`);
  }
  assert.deepEqual(hits, []);
});

test('zero inline style attributes or JS style writes', () => {
  const hits = [];
  for (const f of sourceFiles) {
    const src = textOf(f);
    for (const m of src.matchAll(/\sstyle\s*=\s*["'`]|setAttribute\(\s*['"]style['"]|\.style\.[a-z]|cssText/gi)) hits.push(`${f}: ${m[0].trim()}`);
  }
  assert.deepEqual(hits, []);
});

test('zero HTML-string injection points (innerHTML and friends)', () => {
  const hits = jsFiles.filter((f) => /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code(f)));
  assert.deepEqual(hits, []);
});

test('DOM listeners live only in events.js (and the service worker)', () => {
  const allowed = new Set(['events.js', 'sw.js']);
  const hits = jsFiles.filter((f) => !allowed.has(f) && /addEventListener\(/.test(code(f)));
  assert.deepEqual(hits, []);
});

// ── The write-surface contract ──────────────────────────────────────────
const NON_LITERAL_WRITES = new Set(['core/audit.js']);
const WRITE = /\bdb\.(put|remove|append)\(\s*(['"])(\w+)\2/g;

test('every write targets a registered surface, from that surface\'s funnel only', () => {
  const problems = [];
  for (const f of jsFiles) {
    for (const m of code(f).matchAll(WRITE)) {
      const table = m[3];
      if (!SURFACES[table]) problems.push(`${f}: writes unregistered table "${table}"`);
      else if (SURFACES[table].funnel !== f) problems.push(`${f}: writes "${table}" but its funnel is ${SURFACES[table].funnel}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('non-literal table names only where allow-listed', () => {
  const hits = jsFiles.filter((f) => !NON_LITERAL_WRITES.has(f) && /\bdb\.(put|remove|append)\(\s*[^'"\s)]/.test(code(f)));
  assert.deepEqual(hits, []);
});

test('every registered surface has a funnel file that writes it', () => {
  for (const [table, { funnel }] of Object.entries(SURFACES)) {
    assert.ok(appFiles().includes(funnel), `${table}: funnel ${funnel} does not exist`);
    assert.match(code(funnel), new RegExp(`db\\.(put|remove|append)\\(\\s*['"]${table}['"]`), `${funnel} never writes ${table}`);
  }
});

test('the registry document lists every surface and every SQL table', () => {
  const doc = readFileSync(join(ROOT, 'docs/ops/surface-registry.md'), 'utf8');
  for (const [table, { funnel }] of Object.entries(SURFACES)) {
    assert.match(doc, new RegExp(`\\|\\s*${table}\\s*\\|\\s*\`${funnel.replace('.', '\\.')}`), `registry row for ${table} → ${funnel}`);
  }
  const sqlTables = walk(join(ROOT, 'sql'))
    .flatMap((f) => [...readFileSync(join(ROOT, 'sql', f), 'utf8').matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/gi)].map((m) => m[1]));
  assert.ok(sqlTables.length > 0);
  for (const t of sqlTables) assert.match(doc, new RegExp(`\\|\\s*${t}\\s*\\|`), `sql table ${t} is missing from the registry`);
  for (const t of Object.keys(SURFACES)) assert.ok(sqlTables.includes(t), `surface ${t} has no table in sql/`);
});

// ── Layering ────────────────────────────────────────────────────────────
test('no core/domain/capture module imports UI', () => {
  const bad = [];
  for (const f of jsFiles.filter((x) => /^(core|domain|capture)\//.test(x))) {
    for (const dep of importsOf(f)) if (/^ui\/|^(app|events)\.js$/.test(dep)) bad.push(`${f} → ${dep}`);
  }
  assert.deepEqual(bad, []);
});

test('only core/db.js reaches a storage driver', () => {
  const bad = [];
  for (const f of jsFiles.filter((x) => x !== 'core/db.js' && !x.startsWith('core/drivers/'))) {
    for (const dep of importsOf(f)) if (dep.startsWith('core/drivers/')) bad.push(`${f} → ${dep}`);
  }
  assert.deepEqual(bad, []);
});

// db.adopt/forget/adoptLog skip the audit and the upload queue: only sync may
// write the account's copy of a row (a person's write always goes through put).
test('only core/cloud-sync.js writes what came down from the account', () => {
  const bad = jsFiles.filter((f) => f !== 'core/cloud-sync.js' && /\bdb\.(adopt|forget|adoptLog)\(/.test(code(f)));
  assert.deepEqual(bad, []);
});

test('screens read and write through the domain, never db directly', () => {
  const bad = jsFiles.filter((f) => (f.startsWith('ui/') || f === 'app.js')
    && /\bdb\.(get|list|put|remove|append|putBlob|getBlob)\(/.test(code(f)));
  assert.deepEqual(bad, []);
});

// One exception, decided 2026-10-05: engines/remote.js sends the Mullo Pro key
// (handed over by the Android app's native side in config.json). It unlocks only
// the person's capped, revocable Mullo allowance on the Worker, never an AI
// provider account. Provider keys (bring your own AI) stay native-only.
// Second exception, 2026-10-07: core/account.js sends the person's own sign-in
// token to their own Mullo server (Supabase Auth), and nothing else.
const BEARER_ALLOWED = new Set(['domain/engines/remote.js', 'core/account.js']);

test('the browser bundle never speaks MCP or holds connector tokens', () => {
  const bad = jsFiles.filter((f) => !BEARER_ALLOWED.has(f) && /mcp-client|Authorization['"]?\s*:|Bearer\s/.test(code(f)));
  assert.deepEqual(bad, []);
  // ...and the exceptions only ever send the key they were given, from config,
  // or the person's own session token.
  // remote.js: only what authKey gives (the config key, or the linked sign-in), plus the
  // person's own AI key as Mullo's server SEALED it (core/own-ai.js), never a plain key.
  assert.match(code('domain/engines/remote.js'), /const key = await current\(\);\s*return \{ \.\.\.\(key \? \{ Authorization: `Bearer \$\{key\}` \} : \{\}\), \.\.\.\(ownKey \? \{ 'X-Mullo-Own-Key': ownKey \} : \{\}\) \};/);
  assert.doesNotMatch(code('core/own-ai.js'), /AIza|x-goog-api-key|generativelanguage/, 'the web code never calls an AI provider itself');
  assert.equal(code('domain/engines/remote.js').match(/Bearer /g).length, 1);
  assert.doesNotMatch(code('domain/engines/remote.js'), /mcp-client|localStorage|indexedDB/);
  const bearers = code('core/account.js').match(/Bearer \$\{[^}]+\}/g);
  assert.ok(bearers.length && bearers.every((b) => b === 'Bearer ${token}'), bearers.join(', '));
  assert.doesNotMatch(code('core/account.js'), /mcp-client/);
});

// ── Shipping ────────────────────────────────────────────────────────────
test('deploy manifest lists exactly the files in app/', () => {
  assert.deepEqual([...readManifest()].sort(), appFiles());
});

test('every import resolves to a shipped file', () => {
  const shipped = new Set(readManifest());
  const bad = [];
  for (const f of jsFiles) for (const dep of importsOf(f)) if (!shipped.has(dep)) bad.push(`${f} → ${dep}`);
  assert.deepEqual(bad, []);
});

test('version in code matches version.txt', () => {
  assert.equal(Number(read('version.txt').trim()), APP_VERSION);
});

// core/own-server.js checks the SHAPE of what a person types (refuses sb_secret_ keys, wants an
// sb_publishable_ key and a <project>.supabase.co address), like Cloud.check in WebFiles.kt.
// Those prefixes, and that domain, are allowed there and nowhere else; every other pattern
// still applies to it.
// licenses.html quotes the Apache 2.0 text word for word, its own apache.org links included (S17).
const SHAPE_CHECKS = {
  'core/own-server.js': /sb_(?:secret|publishable)_|supabase\.co/gi,
  'licenses.html': /https?:\/\/www\.apache\.org\/licenses\/(?:LICENSE-2\.0)?/gi,
};

test('no live IDs, keys or URLs in client code', () => {
  const bad = [];
  for (const f of sourceFiles.filter((x) => !x.endsWith('.css'))) {
    const src = SHAPE_CHECKS[f] ? textOf(f).replace(SHAPE_CHECKS[f], '') : textOf(f);
    // Allowed: public share links that are part of a feature, never our own hosts.
    const m = /supabase\.co|eyJ[A-Za-z0-9_-]{20,}|sk_(?:live|test)_|sb_(?:secret|publishable)_|AQ\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|https?:\/\/(?!localhost|www\.w3\.org|wa\.me\/)[a-z0-9.-]+\.[a-z]{2,}/i.exec(src);
    if (m) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('CSP has no unsafe-inline or unsafe-eval, and denies framing', () => {
  const headers = read('_headers');
  const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1] ?? '';
  assert.ok(csp, 'CSP header present');
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /require-trusted-types-for 'script'; trusted-types mullo(;|$)/, 'Trusted Types enforced, one policy');
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Strict-Transport-Security: max-age=\d{8,}/);
  assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});

test('the one Trusted Types policy allows only the service worker', () => {
  const src = code('app.js');
  assert.equal((src.match(/createPolicy\(/g) ?? []).length, 1);
  assert.match(src, /createPolicy\('mullo'/);
  assert.match(src, /url !== 'sw\.js'/);
  const others = jsFiles.filter((f) => f !== 'app.js' && /trustedTypes|createPolicy/.test(code(f)));
  assert.deepEqual(others, []);
});

test('index.html holds markup and script tags only', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<style[\s>]/i);
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\ssrc=/, 'every script tag loads a file');
    assert.equal(m[2].trim(), '', 'no inline script body');
  }
});

// S22a (owner, 2026-10-16): offline opening. The network always goes first (the version.txt
// auto-update must win online), the cache is filled only at install from one build's list.
test('service worker: network first, cache only as the offline fallback, filled per build', () => {
  const sw = code('sw.js');
  assert.match(sw, /fetch\(req\)\.catch\(/, 'network first');
  assert.equal([...sw.matchAll(/respondWith\(/g)].length, [...sw.matchAll(/respondWith\(fetch\(req\)\.catch\(/g)].length,
    'every response tries the network before the cache');
  assert.equal([...sw.matchAll(/cache\.put\(/g)].length, 1, 'the cache is written in one place only');
  assert.match(sw, /addEventListener\('install'[\s\S]*cache\.put\([\s\S]*addEventListener\('activate'/, '...the install');
  assert.match(sw, /^const BUILD = \{ version: 'dev', files: \[\] \};/m, 'build.mjs fills this line');
  assert.match(sw, /version\.txt'\)\) return;/, 'version.txt never comes from the cache');
});

test('the build writes its own file list and version into sw.js', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'ignore' });
  const sw = readFileSync(join(ROOT, 'dist', 'sw.js'), 'utf8');
  const build = JSON.parse(/^const BUILD = (\{.*\});$/m.exec(sw)[1]);
  assert.equal(build.version, readFileSync(join(APP, 'version.txt'), 'utf8').trim());
  assert.ok(build.files.includes('app.js') && build.files.includes('index.html') && build.files.includes('config.json'));
  assert.ok(!build.files.includes('sw.js') && !build.files.includes('version.txt'));
  for (const f of build.files) assert.ok(existsSync(join(ROOT, 'dist', f)), `${f} is in dist/`);
});

test('manifest is valid and has PNG icons for install', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.display, 'standalone');
  for (const size of ['192x192', '512x512']) assert.ok(m.icons.some((i) => i.sizes === size && i.type === 'image/png'), size);
  for (const i of m.icons) assert.ok(appFiles().includes(i.src), `${i.src} exists`);
});

test('no .env files anywhere in the repo - secrets live in the process environment only', () => {
  const found = walk(ROOT)
    .filter((f) => !f.startsWith('.git/') && !f.startsWith('node_modules/'))
    .filter((f) => /(^|\/)\.env(\..*)?$/.test(f));
  assert.deepEqual(found, []);
});

// Owner's rule (2026-10-05): no long dashes in anything a person reads.
test('no em dashes in the app or the Android apps', () => {
  const EM = '—';
  const bad = walk(APP).filter((f) => /\.(js|html|css|json|txt)$/.test(f))
    .filter((f) => readFileSync(join(APP, f), 'utf8').includes(EM))
    .map((f) => `app/${f}`);
  for (const mod of ['app', 'wear']) {
    const src = join(ROOT, 'android', mod, 'src');
    bad.push(...walk(src).filter((f) => /\.(kt|xml)$/.test(f))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes(EM))
      .map((f) => `android/${mod}/src/${f}`));
  }
  assert.deepEqual(bad, []);
});

test('no NUL bytes or mojibake in source', () => {
  const bad = walk(APP).filter((f) => /\.(js|html|css|json|txt)$/.test(f))
    .filter((f) => /\u0000|Ã.|â€/.test(readFileSync(join(APP, f), 'utf8')));
  assert.deepEqual(bad, []);
});
