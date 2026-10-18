# The AI bridge

The app never holds the Gemini key. The bridge does, server side, and the app
calls it for the three AI jobs:

- `POST /api/transcribe`: audio body, options in the query (`lang`, `out`, `vocab`, `duration_ms`)
- `POST /api/process`: transcript → title, sections, summary, tasks
- `POST /api/ask`: a question plus the recordings the phone chose to share
- `GET /api/health`

```
App (browser or Android) ──fetch──▶ dev server (/api, origin check) ──▶ bridge ──▶ Gemini
```

## Rules

- The key comes from the process environment at launch (`GEMINI_API_KEY`). Never a file.
- AI calls are capped (`AI_PER_MINUTE`, default 20): a dev tunnel is a public link.
- In dev, `scripts/serve.mjs` fronts the bridge and refuses cross-site calls except from
  the Android app's own origin.
- Errors are logged, never request bodies: they hold people's conversations.

## Next

Done on the Worker (2026-10-08, `docs/specs/2026-10-08-connections-design.md`): bring your
own AI (Gemini; the Worker seals the key, the phone keeps the sealed text) and Mullo as a
read-only MCP server. Still to come:

1. **Claude and OpenAI keys** for summaries and Ask (transcription needs an audio model).
2. **MCP writes** (add a task or a note) once the phone pulls changes down.
3. **Per-user auth on the PC bridge**, then move it into a Supabase Edge Function.
