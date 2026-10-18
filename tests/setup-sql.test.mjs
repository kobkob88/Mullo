// Your own server: the SQL the Worker serves on /setup is exactly sql/, and the app asks
// for the newest step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { steps, moduleText, OUT } from '../scripts/setup-sql.mjs';
import { SQL_STEPS } from '../worker/src/setup-sql.mjs';
import { SCHEMA_STEP } from '../app/core/cloud-sync.js';
import { handle } from '../worker/src/index.mjs';

test('worker/src/setup-sql.mjs is sql/ as it is now (run: node scripts/setup-sql.mjs)', () => {
  assert.equal(readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), moduleText());
  assert.deepEqual(SQL_STEPS.map((s) => s.step), steps().map((_, i) => i + 1), 'numbered 1, 2, 3... with no gaps');
});

test('the app needs the newest step, and that step says so in schema_version()', () => {
  const last = SQL_STEPS.at(-1);
  assert.equal(SCHEMA_STEP, last.step);
  assert.match(last.sql, new RegExp(`schema_version\\(\\)[\\s\\S]*select ${last.step} \\$\\$`));
});

test('/setup shows the steps from the one after the server\'s, and each file downloads', async () => {
  const call = (path) => handle(new Request(`https://mullo.example${path}`), {}, { fetch: () => { throw new Error('no network'); } });
  const all = await (await call('/setup')).text();
  for (const s of SQL_STEPS) assert.ok(all.includes(s.name), s.name);
  assert.ok(all.includes('publishable'), 'says which key');
  const later = await (await call('/setup?from=2')).text();
  assert.ok(!later.includes('001_core.sql') && later.includes('003_connected_apps.sql'));
  const file = await call('/setup/001_core.sql');
  assert.equal(file.status, 200);
  assert.equal(await file.text(), SQL_STEPS[0].sql);
  assert.equal((await call('/setup/../wrangler.toml')).status, 404);
});
