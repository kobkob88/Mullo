// The AI bridge - reference implementation (Node, zero dependencies).
// It holds the Gemini key so the app never does: transcription, summaries and
// Ask go through here. Later this becomes a Supabase Edge Function.
//
// Run:  GEMINI_API_KEY=... APP_ORIGIN=http://localhost:5173 node bridge/server.mjs
// Env:
//   APP_ORIGIN                      the PWA's origin (CORS allow-list, exactly one)
//   BRIDGE_PORT                     default 8787
//   HOST                            default 127.0.0.1: this machine only. It answers anyone who
//                                   reaches it and spends the key, so open it ("0.0.0.0") only on
//                                   purpose; a tunnel reaches it on 127.0.0.1 anyway.
//   GEMINI_API_KEY, GEMINI_MODEL    AI engine (bridge/gemini.mjs)
//   AI_PER_MINUTE                   cap on AI calls, default 20
// Secrets come from the process environment only. No .env files in this
// repo, ever (tests/architecture.test.mjs fails on one). Later: Supabase
// Edge Function secrets.
//
// NOT DONE YET: per-user auth between the app and the bridge.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { processWithGemini, DEFAULT_MODEL } from './gemini.mjs';
import { transcribeWithGemini, readTranscribeRequest, MAX_REQUEST_BYTES, TOO_LARGE } from './transcribe.mjs';
import { askWithGemini } from './ask.mjs';
import { chatWithGemini } from './chat.mjs';

const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173';

// The AI key pays per call and a dev tunnel is a public link: cap it.
const AI_PER_MINUTE = Number(process.env.AI_PER_MINUTE ?? 20);
let aiWindow = { start: 0, count: 0 };
function allowAiCall(now = Date.now()) {
  if (now - aiWindow.start > 60_000) aiWindow = { start: now, count: 0 };
  aiWindow.count += 1;
  return aiWindow.count <= AI_PER_MINUTE;
}

// ── HTTP ────────────────────────────────────────────────────────────────
function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  });
  res.end(JSON.stringify(body));
}

async function readBinary(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(TOO_LARGE), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bridge');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': APP_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      // (/api/transcribe takes a form: the audio + its options)
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }
  // Browsers send Origin on cross-origin requests; refuse any other site.
  if (req.headers.origin && req.headers.origin !== APP_ORIGIN) { send(res, 403, { error: 'origin not allowed' }); return; }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/process') {
      if (!allowAiCall()) { send(res, 429, { error: 'Too many AI requests - try again in a minute' }); return; }
      const { segments, template, today, vocabulary } = await readJson(req);
      send(res, 200, await processWithGemini({ segments, template, today, vocabulary: Array.isArray(vocabulary) ? vocabulary.slice(0, 60) : [] }, {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      if (!allowAiCall()) { send(res, 429, { error: 'Too many AI requests - try again in a minute' }); return; }
      const { question, today, recordings } = await readJson(req);
      send(res, 200, await askWithGemini({ question, today, recordings }, {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      if (!allowAiCall()) { send(res, 429, { error: 'Too many AI requests - try again in a minute' }); return; }
      const { messages, today, recordings, focus } = await readJson(req);
      send(res, 200, await chatWithGemini({ messages, today, recordings, focus }, {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      if (!allowAiCall()) { send(res, 429, { error: 'Too many AI requests - try again in a minute' }); return; }
      const body = await readBinary(req, MAX_REQUEST_BYTES);
      const request = new Request(url, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] ?? '' }, body });
      send(res, 200, await transcribeWithGemini(await readTranscribeRequest(request), {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      }));
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status ?? 502;
    // Errors only - never request bodies (they hold people's conversations).
    console.error(`${new Date().toISOString()} ${req.method} ${url.pathname} → ${status}: ${err.message}`);
    send(res, status, { error: err.message });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST || '127.0.0.1';
  server.listen(PORT, host, () => console.log(`Mullo bridge on http://${host}:${PORT} (app origin ${APP_ORIGIN})`));
}
