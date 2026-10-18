// Report a problem (S56, spec docs/specs/2026-10-17-report-a-problem-design.md). A signed-in
// person sends what happened, the details the app adds (version, device, screen, plan, recent
// errors - never note content) and one optional screenshot; admins read and close them in
// Settings, Admin, Reports. Kept until closed, deleted 90 days after closing (no cron: the
// sweep runs on every send and every admin list) and with the account.

import { ready } from './usage.mjs';

export const MAX_TEXT = 2000;
export const MAX_DETAILS = 8 * 1024;
export const MAX_SHOT = 400 * 1024; // bytes of JPEG (the app shrinks it to fit)
export const PER_HOUR = 5;
export const KEEP_CLOSED_S = 90 * 86400;
const STATUSES = ['open', 'closed'];
const ID = /^[a-z0-9]{8,40}$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
const nowSec = () => Math.floor(Date.now() / 1000);

// The `reports` table is made by usage.mjs ready() (and schema.sql), like every other table.
const table = (env) => ready(env);

// Closed more than 90 days ago → gone. Open reports stay until someone closes them.
async function sweep(env, now = nowSec()) {
  await env.DB.prepare("delete from reports where status = 'closed' and closed_at < ?").bind(now - KEEP_CLOSED_S).run();
}

// base64 → bytes, or null when it isn't base64.
function bytesOf(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  try { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return null; }
}

// body = { text, details: {...}, screenshot?: base64 JPEG } → { ok, id }
export async function sendReport(env, user, body) {
  const text = String(body?.text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw fail(400, 'Write what happened first.');
  if (text.length > MAX_TEXT) throw fail(400, `Keep it under ${MAX_TEXT.toLocaleString('en')} characters.`);
  const details = body?.details && typeof body.details === 'object' && !Array.isArray(body.details) ? JSON.stringify(body.details) : '{}';
  if (new TextEncoder().encode(details).length > MAX_DETAILS) throw fail(400, 'The details are too long.');
  let screenshot = null;
  if (body?.screenshot != null && body.screenshot !== '') {
    const bytes = bytesOf(body.screenshot);
    if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fail(400, 'The screenshot must be a JPEG.');
    if (bytes.length > MAX_SHOT) throw fail(400, 'That image is too big.');
    screenshot = body.screenshot;
  }
  await table(env);
  const now = nowSec();
  await sweep(env, now);
  const recent = await env.DB.prepare('select count(*) as n from reports where user_id = ? and created_at > ?').bind(user.userId, now - 3600).first();
  if ((recent?.n ?? 0) >= PER_HOUR) throw fail(429, 'That\'s a lot of reports in an hour - please try again later, or email us.');
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.DB.prepare(`insert into reports (id, user_id, email, text, details, screenshot, status, created_at)
    values (?, ?, ?, ?, ?, ?, 'open', ?)`).bind(id, user.userId, user.email ?? null, text, details, screenshot, now).run();
  return { ok: true, id };
}

// Admins: newest first, without the screenshot bytes (has_screenshot says there is one).
export async function listReports(env, status = 'open') {
  await table(env);
  await sweep(env);
  const want = STATUSES.includes(status) ? status : 'open';
  const { results } = await env.DB.prepare(`select id, user_id, email, text, details, status, created_at, closed_at,
    screenshot is not null as has_screenshot from reports where status = ? order by created_at desc limit 200`).bind(want).all();
  const open = await env.DB.prepare("select count(*) as n from reports where status = 'open'").first();
  return {
    open: open?.n ?? 0,
    reports: results.map((r) => ({ ...r, details: safeJson(r.details), has_screenshot: Boolean(r.has_screenshot) })),
  };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

export async function reportScreenshot(env, id) {
  if (!ID.test(id)) throw fail(404, 'No such report.');
  await table(env);
  const row = await env.DB.prepare('select screenshot from reports where id = ?').bind(id).first();
  if (!row?.screenshot) throw fail(404, 'No screenshot.');
  return { screenshot: `data:image/jpeg;base64,${row.screenshot}` };
}

export async function setReportStatus(env, adminId, id, status) {
  if (!ID.test(id)) throw fail(404, 'No such report.');
  if (!STATUSES.includes(status)) throw fail(400, 'Status is open or closed.');
  await table(env);
  const row = await env.DB.prepare('select status from reports where id = ?').bind(id).first();
  if (!row) throw fail(404, 'No such report.');
  await env.DB.prepare('update reports set status = ?, closed_at = ? where id = ?').bind(status, status === 'closed' ? nowSec() : null, id).run();
  await env.DB.prepare('insert into admin_log (at, admin_id, action, detail) values (?, ?, ?, ?)').bind(nowSec(), adminId, `report-${status}`, id).run();
  return { ok: true, id, status };
}

// Delete account (index.mjs deleteAccountRoute).
export async function deleteReportsOf(env, userId) {
  await table(env);
  await env.DB.prepare('delete from reports where user_id = ?').bind(userId).run();
}
