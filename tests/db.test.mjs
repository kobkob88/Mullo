import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, setAuditSink, useDriver } from '../app/core/db.js';
import { applyPut, applyDelete, nextStamp } from '../app/core/drivers/cas.js';
import { createMemoryDriver } from '../app/core/drivers/memory.js';
import { listActivity, restoreDeleted, revertEdit, installAudit } from '../app/core/audit.js';
import { setSession, localOwnerSession } from '../app/core/auth.js';
import { freshDb } from './helpers.mjs';

beforeEach(() => { freshDb(); });

test('stamps strictly increase and keep microseconds as a raw string', () => {
  const a = nextStamp(1_000);
  const b = nextStamp(1_000);
  const c = nextStamp(500); // clock went backwards
  assert.ok(a < b && b < c, `${a} < ${b} < ${c}`);
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
});

test('no expected stamp → unconditional write', () => {
  const res = applyPut({ id: 'x', updated_at: 'old', a: 1 }, { id: 'x', a: 2 }, undefined);
  assert.equal(res.ok, true);
  assert.equal(res.row.a, 2);
});

test('stale stamp → conflict, not an error', () => {
  const res = applyPut({ id: 'x', updated_at: 's2' }, { id: 'x' }, 's1');
  assert.deepEqual([res.ok, res.conflict, res.reason], [false, true, 'stale']);
});

test('the client cannot set updated_at; the "trigger" always advances it', () => {
  const res = applyPut(null, { id: 'x', updated_at: '1999-01-01' }, undefined);
  assert.notEqual(res.row.updated_at, '1999-01-01');
});

test('fields an older build does not know survive its write', () => {
  const res = applyPut({ id: 'x', updated_at: 's', newer_field: 'keep me' }, { id: 'x', title: 't' }, 's');
  assert.equal(res.row.newer_field, 'keep me');
});

test('delete of a missing row is reported, never silently ok', () => {
  assert.equal(applyDelete(undefined, null).ok, false);
});

test('writes are refused without an audit sink', async () => {
  useDriver(createMemoryDriver());
  setAuditSink(null);
  await assert.rejects(db.put('folders', { id: 'f', label: 'x' }), /audit sink/);
  installAudit();
});

test('writes are refused for unregistered tables and without permission', async () => {
  await assert.rejects(db.put('secrets', { id: 'a' }), /Unregistered write surface/);
  setSession({ userId: 'v', roles: ['viewer'] });
  await assert.rejects(db.put('folders', { id: 'f', label: 'x' }), /Not allowed/);
  setSession(null);
  await assert.rejects(db.put('folders', { id: 'f', label: 'x' }), /Not allowed/);
  setSession(localOwnerSession());
});

test('deletes must name an intent', async () => {
  await db.put('folders', { id: 'f', label: 'x' });
  await assert.rejects(db.remove('folders', 'f'), /intent/);
});

test('every edit logs before and after; every delete logs the full row', async () => {
  const first = await db.put('folders', { id: 'f', label: 'One' });
  await db.put('folders', { id: 'f', label: 'Two' }, { expected: first.row.updated_at });
  const current = await db.get('folders', 'f');
  await db.remove('folders', 'f', { intent: 'test', expected: current.updated_at });
  const log = (await listActivity()).reverse();
  assert.deepEqual(log.map((e) => e.action), ['insert', 'update', 'delete']);
  assert.equal(log[1].before.label, 'One');
  assert.equal(log[1].after.label, 'Two');
  assert.equal(log[2].before.label, 'Two');
  assert.equal(log[2].after, null);
});

test('a refused write is not logged', async () => {
  await db.put('folders', { id: 'f', label: 'One' });
  const res = await db.put('folders', { id: 'f', label: 'Late' }, { expected: 'not-the-stamp' });
  assert.equal(res.conflict, true);
  assert.equal((await listActivity()).length, 1);
});

test('restore brings back a deleted row exactly, created_at included', async () => {
  const { row } = await db.put('folders', { id: 'f', label: 'Keep' });
  await db.remove('folders', 'f', { intent: 'test' });
  const del = (await listActivity()).find((e) => e.action === 'delete');
  await restoreDeleted(del.id);
  const back = await db.get('folders', 'f');
  assert.equal(back.label, 'Keep');
  assert.equal(back.created_at, row.created_at);
});

test('revert only lands on a record nobody changed since', async () => {
  const a = await db.put('folders', { id: 'f', label: 'A' });
  const b = await db.put('folders', { id: 'f', label: 'B' }, { expected: a.row.updated_at });
  const edit = (await listActivity()).find((e) => e.action === 'update');
  await db.put('folders', { id: 'f', label: 'C' }, { expected: b.row.updated_at });
  await assert.rejects(revertEdit(edit.id), /changed again/);
});
