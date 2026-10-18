// Local dev server for app/ that applies _headers, so the CSP and the other
// security headers are enforced on your machine exactly as in production.
// Microphone access works on http://localhost (a secure context).
//   node scripts/serve.mjs [port]

import { createServer, request as httpRequest } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { readFileSync } from 'node:fs';
import { APP, connectSrc } from './lib.mjs';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

// Minimal _headers parser: "path" lines, then indented "Name: value" lines.
function parseHeaders() {
  const rules = [];
  let current = null;
  for (const line of readFileSync(join(APP, '_headers'), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = { path: line.trim(), headers: {} }; rules.push(current); continue; }
    const at = line.indexOf(':');
    if (current && at > 0) current.headers[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace('__CONNECT_SRC__', connectSrc());
  }
  return rules;
}

const matches = (rulePath, urlPath) =>
  rulePath === urlPath || (rulePath.endsWith('*') && urlPath.startsWith(rulePath.slice(0, -1)));

// /api/* goes to the bridge (BRIDGE_URL, default localhost:8787), so a phone
// on the tunnel reaches it through the same origin. The dev server is the
// trusted front here, so it drops Origin before forwarding.
const BRIDGE = new URL(process.env.BRIDGE_URL ?? 'http://localhost:8787');
// ECHO_AI=off: the app gets no AI engine and runs the offline one, so the smoke
// test doesn't depend on the bridge or a Gemini key.
const AI_OFF = process.env.ECHO_AI === 'off';

// The Android app (android/) serves Mullo's own files from this address - it is
// answered inside the app and never resolves on the internet - and calls /api
// here through the tunnel. It is the ONE other origin allowed. Any other site
// is refused before the bridge (and the paid AI key) is reached.
const ANDROID_APP_ORIGIN = 'https://app.mullo.lizai.io';

function apiAccess(req) {
  const origin = req.headers.origin;
  if (!origin) return { ok: true, cors: null }; // no browser cross-site context
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (origin === `https://${host}` || origin === `http://${host}`) return { ok: true, cors: null };
  if (origin === ANDROID_APP_ORIGIN) return { ok: true, cors: { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } };
  return { ok: false, cors: null };
}

function proxyToBridge(req, res, cors) {
  const { origin, referer, host, ...headers } = req.headers;
  const upstream = httpRequest({
    hostname: BRIDGE.hostname, port: BRIDGE.port, path: req.url, method: req.method, headers,
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, { 'Content-Type': up.headers['content-type'] ?? 'application/json', ...cors });
    up.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'The bridge is not running (npm run bridge)' }));
  });
  req.pipe(upstream);
}

createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const access = apiAccess(req);
    if (!access.ok) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin not allowed' }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...access.cors,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    proxyToBridge(req, res, access.cors);
    return;
  }
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^[/\\]+/, '');
  const file = join(APP, rel);
  if (!file.startsWith(APP)) { res.writeHead(403).end(); return; }
  for (const rule of parseHeaders()) if (matches(rule.path, urlPath)) for (const [k, v] of Object.entries(rule.headers)) res.setHeader(k, v);
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch {
    // No local config.json: the dev server fronts the bridge on the same origin.
    if (rel === 'config.json') {
      res.setHeader('Content-Type', 'application/json');
      // ECHO_SUPABASE_URL + ECHO_SUPABASE_ANON_KEY (public values) switch sign-in on.
      const cloud = process.env.ECHO_SUPABASE_URL
        ? { supabaseUrl: process.env.ECHO_SUPABASE_URL, supabaseAnonKey: process.env.ECHO_SUPABASE_ANON_KEY ?? null }
        : {};
      res.end(JSON.stringify({ ...(AI_OFF ? {} : { bridgeUrl: '' }), ...cloud }));
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
  }
// This machine only unless HOST says otherwise: /api here reaches the bridge, which spends the key.
}).listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`Mullo dev server: http://localhost:${PORT}`));
