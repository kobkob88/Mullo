// Drives the real app in headless Chrome over the DevTools protocol (no
// dependencies): phone-sized viewport, CSP enforced by the dev server.
// Fails on any console error, uncaught exception or CSP violation, and saves
// screenshots to .smoke/ for a human to look at.
//   node scripts/serve.mjs &   then   node scripts/smoke.mjs
// Without the bridge (or a Gemini key): ECHO_AI=off node scripts/serve.mjs 5179 &
//   then SMOKE_URL=http://localhost:5179/ node scripts/smoke.mjs (offline engine).
// CHROME=<path to chrome/edge> if it is not in the default place.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from './lib.mjs';

const BASE = process.env.SMOKE_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const OUT = join(ROOT, '.smoke');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'echo-smoke-'))}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
const problems = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function connect() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description ?? expression}`);
  return res.result.value;
}

async function waitFor(expression, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(300);
  }
  return null;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

async function go(hash, wait = 600) {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(wait);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (msg.method === 'Log.entryAdded' && (msg.params.entry.level === 'error' || /Content Security Policy/i.test(msg.params.entry.text))) {
      if (!/favicon/.test(msg.params.entry.url ?? '')) problems.push(`log: ${msg.params.entry.text}`);
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}#/library` });
  await sleep(1500);
  await shot('1-library-empty');

  // Type a note (Hebrew + English) and let the pipeline run.
  await go('#/record');
  await shot('2-record');
  await evaluate(`(() => {
    const t = document.querySelector('#note-text');
    t.value = 'Planning call with the warehouse about the October shipments.\\nRemind me to email Dana the new quote tomorrow, and call the customs broker.\\nWe decided to move the Montreal delivery to Friday.\\nתזכורת להתקשר ביום שני לספק על החשבונית, ולבדוק מה קורה עם ההזמנה.';
    document.querySelector('form[data-action="note-save"] button[type="submit"]').click();
  })()`);
  // With the AI engine on, saving waits for a real Gemini call.
  const detailTitle = await waitFor(`document.querySelector('.rec-title__edit')?.textContent || null`, 15_000);
  if (!detailTitle) problems.push('note did not open its recording');
  // Summarising runs in the background; the page fills in when it's done.
  const settled = await waitFor(`document.querySelector('.rec-title__edit') && !document.querySelector('.chip--processing, .chip--transcribing') ? 'done' : null`, 45_000);
  if (!settled) problems.push('background summary never finished');
  await sleep(500);
  await shot('3-recording-summary');
  await evaluate(`document.querySelector('[data-action="rec-tab"][data-tab="actions"]').click()`);
  await sleep(500);
  const actionCount = await evaluate(`document.querySelectorAll('.action-row').length`);
  if (actionCount < 4) problems.push(`expected ≥4 extracted actions, saw ${actionCount}`);
  await shot('4-recording-actions');

  // Tick one off from the Actions screen.
  await go('#/actions');
  await evaluate(`document.querySelector('.action-row input[type="checkbox"]').click()`);
  await sleep(600);
  await shot('5-actions');

  // Open a task (its tools and its note link show), then its recording, then back:
  // Actions again, not the Library.
  await evaluate(`document.querySelector('.action-row__main').click()`);
  await waitFor(`document.querySelector('.action-row.is-open .action-row__rec') ? true : null`, 5_000);
  await evaluate(`document.querySelector('.action-row.is-open .action-row__rec').click()`);
  const backLabel = await waitFor(`document.querySelector('.rec-detail .back')?.textContent ?? null`, 5_000);
  if (backLabel !== '‹ Actions') problems.push(`a recording opened from Actions says "${backLabel}" instead of "‹ Actions"`);
  await evaluate(`document.querySelector('.rec-detail .back').click()`);
  const backAt = await waitFor(`location.hash === '#/actions' && document.querySelector('.action-row') ? location.hash : null`, 5_000);
  if (!backAt) problems.push('the back link on a recording opened from Actions did not lead back to Actions');

  await go('#/library');
  const cards = await evaluate(`document.querySelectorAll('.rec-card').length`);
  if (cards !== 1) problems.push(`expected 1 recording in the library, saw ${cards}`);
  await shot('7-library');

  // Delete the note, then restore it from Activity.
  await evaluate(`document.querySelector('.rec-card').click()`);
  await sleep(700);
  await evaluate(`document.querySelector('[data-action="rec-sheet"][data-sheet="more"]').click()`);
  await sleep(300);
  await shot('3b-recording-more');
  await evaluate(`document.querySelector('[data-action="rec-delete-ask"]').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('form[data-action="rec-delete"] button[type="submit"]').click()`);
  await sleep(800);
  await go('#/activity');
  await shot('8-activity');
  await evaluate(`document.querySelector('[data-action="activity-restore"]').click()`);
  await sleep(800);
  await go('#/library');
  const afterRestore = await evaluate(`document.querySelectorAll('.rec-card').length`);
  if (afterRestore !== 1) problems.push(`restore: expected 1 recording, saw ${afterRestore}`);

  await go('#/search');
  await evaluate(`(() => { const i = document.querySelector('.search-input'); i.value = 'Montreal'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(600);
  const hits = await evaluate(`document.querySelectorAll('.search-hit').length`);
  if (hits < 1) problems.push('search found nothing for "Montreal"');
  await shot('9-search');

  await go('#/settings');
  await shot('10-settings');
  await go('#/settings/languages');
  await shot('11-settings-languages');
  // These two draw at once and fill in server answers later: they must still show a title.
  for (const page of ['subscription', 'developers', 'connections', 'google']) {
    await go(`#/settings/${page}`);
    if (!(await evaluate(`Boolean(document.querySelector('.set-page .page-head__title'))`))) problems.push(`Settings, ${page} did not draw`);
    if (page === 'connections' || page === 'google') await shot(`13-settings-${page}`);
  }
  // S56: signed out, the report page still draws, with Email us instead and the details.
  await go('#/settings/report');
  if (!(await evaluate(`Boolean(document.querySelector('[data-action="report-email"]'))`))) problems.push('Report a problem did not draw');
  await evaluate(`document.querySelector('[data-action="report-details"]').click()`);
  await sleep(300);
  if (!(await evaluate(`Boolean(document.querySelector('.report-details'))`))) problems.push('Report a problem: "See what is sent" showed nothing');
  await shot('14-settings-report');
  await go('#/settings/appearance');
  await evaluate(`document.querySelector('[data-action="settings-pick"][data-value="light"]').click()`);
  await sleep(400);
  if ((await evaluate(`document.documentElement.dataset.theme`)) !== 'light') problems.push('Appearance → Light did not apply');
  await go('#/library');
  await shot('12-library-light');
  await go('#/settings/appearance');
  await evaluate(`document.querySelector('[data-action="settings-pick"][data-value="system"]').click()`);
  await sleep(300);
  const fabOnRecord = await (async () => { await go('#/record', 400); return evaluate(`document.getElementById('record-fab').hidden`); })();
  if (!fabOnRecord) problems.push('the floating Record button should hide on the Record screen');

  const swOk = await evaluate(`navigator.serviceWorker.getRegistration().then((r) => Boolean(r))`);
  if (!swOk) problems.push('service worker not registered');
}

main()
  .catch((err) => problems.push(`smoke crashed: ${err.stack ?? err}`))
  .finally(() => {
    try { ws?.close(); } catch { /* ignore */ }
    chrome.kill();
    if (problems.length) {
      console.error(`SMOKE FAILED:\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log(`smoke ok - screenshots in ${OUT}`);
    }
  });
