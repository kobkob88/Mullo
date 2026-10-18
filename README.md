# Mullo

Mullo turns conversations and voice notes into **a transcript, a title, a summary and action
items**. Record on the phone, in the browser, or on a watch (Wear OS or Apple Watch); ask
questions about your notes; send tasks to your calendar. The hosted app is at
[mullo.app](https://mullo.app).

This repository is a copy of Mullo's source code, published with each release.

## What's in it

- `app/`: the web app (vanilla ES modules, no build step, no dependencies). Every shipped file is
  listed in `deploy-manifest.json`.
- `bridge/`: the AI side (Gemini, OpenAI, Claude): transcription, summaries, Ask. Runs as a small
  Node server for development.
- `worker/`: the Cloudflare Worker behind Mullo: the same AI routes plus sign-in checks, plans,
  payments, the MCP server (`/mcp`) and the website pages.
- `android/`: the Android app (Mullo in a WebView) and the Wear OS recorder.
- `ios/`: the iPhone app and the Apple Watch recorder (built on a Mac with XcodeGen, see
  `ios/README.md`).
- `sql/`: the Supabase schema with row-level security.
- `tests/`, `scripts/`.

## Run it locally

Node 22 or newer. No `npm install`: there are no dependencies.

```bash
npm run dev                                   # http://localhost:5173, with the production security headers
GEMINI_API_KEY=... node bridge/server.mjs     # optional: the AI (port 8787; /api is proxied to it)
npm test                                      # unit + architecture tests
node scripts/smoke.mjs                        # drives the app in headless Chrome; screenshots in .smoke/
```

Without the bridge the app falls back to simple offline rules. Keys go in the process
environment at launch, never in a file (a test fails on a `.env` file).

## Running your own copy

The Worker needs its own Cloudflare account, D1 database and Supabase project. Copy
`worker/wrangler.example.toml` to `worker/wrangler.toml`, fill in your own values, apply `sql/`
to your Supabase project, put the secrets in with `npx wrangler secret put NAME`, then
`npm run deploy:web`. The phone apps point at Mullo's servers; change the addresses in
`android/` and `ios/` (marked `YOUR-...`) to use your own. This is not a supported setup yet.

## License

Mullo is open source under the **GNU Affero General Public License v3** (`AGPL-3.0-only`, see
`LICENSE` and `NOTICE`). Copyright (C) 2026 LizAI Studios.

Use it, change it, run it yourself. If you share a changed version, or run one as a service for
other people, you must offer them your source code under the same license. The Mullo and lizai
names, logos and icons are not part of the license: a fork needs its own.

## Security and contributing

Found a weakness? Please email hello@lizai.io, not a public issue: see `SECURITY.md`.
Contributions are welcome on the terms in `CONTRIBUTING.md`.
