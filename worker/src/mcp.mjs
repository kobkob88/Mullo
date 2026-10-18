// Mullo as an MCP server (spec docs/specs/2026-10-08-connections-design.md §1).
// The person's own AI (Claude, ChatGPT, Cursor...) connects to /mcp and reads their notes.
//
// - Streamable HTTP, stateless: every POST is one JSON-RPC message answered with JSON. No
//   session, no server-to-client stream (GET answers 405, which the spec allows).
// - Who: a Supabase token from OUR project (signin.mjs). Connected apps get theirs from
//   Supabase's OAuth server; /.well-known/oauth-protected-resource points them there.
// - What: read-only tools. Reads go to Supabase AS the person (notes.mjs), so row-level
//   security decides, and sql/003 refuses any write from a connected app's token anyway.
// - The search is the app's own (app/domain/search.js), one copy.

import { search, normalize } from '../../app/domain/search.js';
import { recordingAsText } from '../../app/domain/export.js';
import { formatDuration, localDate, addDays } from '../../app/core/dates.js';
import { notesFor, isId } from './notes.mjs';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = '2025-06-18';
const TRANSCRIPT_MAX_CHARS = 120_000;
const SEARCH_TRANSCRIPTS = 80; // the newest this many recordings are searched word by word too

const INSTRUCTIONS = 'Mullo holds this person\'s recorded conversations and voice notes: a title, a summary, '
  + 'sections, tasks and a transcript for each. Use `search` for a topic, person or decision, `recent_recordings` '
  + 'for "what did I record this week", `get_recording` to read one, and `list_tasks` for to-dos. Only notes the '
  + 'person copied into their Mullo account are here. Read-only: nothing can be changed from here. '
  + 'Quote what the notes say; say so when they don\'t cover something.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'search',
    title: 'Search recordings',
    description: 'Search the person\'s recordings by words: titles, summaries, sections, tasks, and the transcripts of '
      + 'the most recent recordings. Matches whole words in any language (Hebrew too). Returns the best matches with '
      + 'their ids; read one with get_recording.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "Montreal delivery" or a person\'s name.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many results (default 10).' },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'recent_recordings',
    title: 'Recent recordings',
    description: 'The person\'s recordings, newest first, with a short summary of each. Either the last `days` days, '
      + 'or between `from` and `to` (local dates, YYYY-MM-DD).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 366, description: 'The last N days (default 7).' },
        from: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'At most this many (default 30).' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_recording',
    title: 'Read a recording',
    description: 'One recording: title, date, length, summary, sections, tasks and the updates the person added '
      + 'later (dated follow-ups, newest last; they can be newer than the summary). The transcript (who said what, '
      + 'with times) only when include_transcript is true, since it can be long.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The recording id, from search or recent_recordings.' },
        include_transcript: { type: 'boolean', description: 'Add the full transcript (default false).' },
      },
      required: ['id'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'Tasks Mullo found in the person\'s recordings (or they added): what, when it\'s due, and which '
      + 'recording it came from.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Default open.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many (default 50).' },
      },
    },
    annotations: READ_ONLY,
  },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clampInt = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt);

function overview(rec) {
  const first = (rec.summary?.blocks ?? []).find((b) => b.items?.length);
  return first ? first.items.slice(0, 3).join(' · ') : '';
}
const lineFor = (r) => `${r.title} (${r.local_date}${r.duration_ms ? `, ${formatDuration(r.duration_ms)}` : ''}) id: ${r.id}`;
const brief = (r) => ({ id: r.id, title: r.title, date: r.local_date, duration_ms: r.duration_ms ?? null, overview: overview(r) });

const text = (t, structured) => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) });
const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

export async function callTool(name, args, notes, today = localDate()) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'search') {
    const query = String(a.query ?? '').trim();
    if (!normalize(query)) return toolError('Give some words to search for.');
    const limit = clampInt(a.limit, 1, 25, 10);
    const recordings = await notes.recordings({ limit: 1000 });
    const [actions, transcripts] = await Promise.all([
      notes.actions({ status: 'all' }),
      notes.transcripts(recordings.slice(0, SEARCH_TRANSCRIPTS).map((r) => r.id)),
    ]);
    const hits = search(query, { recordings, actions, transcripts: transcripts.map((t) => ({ ...t, segments: t.segments ?? [] })) }).slice(0, limit);
    if (!hits.length) return text(`Nothing in Mullo matches "${query}".`, { results: [] });
    const results = hits.map((h) => ({ ...brief(h.recording), matched: h.matches.map((m) => `${m.kind}: ${m.text}`) }));
    return text(results.map((r) => `- ${lineFor({ ...r, local_date: r.date })}\n  ${r.matched.join('\n  ')}`).join('\n'), { results });
  }
  if (name === 'recent_recordings') {
    const limit = clampInt(a.limit, 1, 100, 30);
    let from = DATE.test(a.from ?? '') ? a.from : null;
    const to = DATE.test(a.to ?? '') ? a.to : null;
    if (!from && !to) from = addDays(today, -clampInt(a.days, 1, 366, 7));
    const list = await notes.recordings({ limit, from, to });
    if (!list.length) return text('No recordings in that time.', { recordings: [] });
    const recordings = list.map(brief);
    return text(recordings.map((r) => `- ${lineFor({ ...r, local_date: r.date })}${r.overview ? `\n  ${r.overview}` : ''}`).join('\n'), { recordings });
  }
  if (name === 'get_recording') {
    if (!isId(a.id)) return toolError('That isn\'t a recording id. Use search or recent_recordings to find one.');
    const rec = await notes.recording(a.id);
    if (!rec) return toolError('No recording with that id (it may not be copied into the Mullo account).');
    const withTranscript = a.include_transcript === true;
    const [actions, transcripts] = await Promise.all([
      notes.actions({ recordingIds: [rec.id] }),
      withTranscript ? notes.transcripts([rec.id]) : [],
    ]);
    let out = recordingAsText(rec, {
      segments: transcripts[0]?.segments ?? [], actions, withTranscript, when: rec.local_date,
      nameOf: (label) => rec.speakers?.[label] ?? label,
    });
    if (out.length > TRANSCRIPT_MAX_CHARS) out = `${out.slice(0, TRANSCRIPT_MAX_CHARS)}\n… (cut here: the transcript is longer)`;
    if (withTranscript && !transcripts.length) out += '\n\n(No transcript for this recording.)';
    return text(`id: ${rec.id}\n${out}`);
  }
  if (name === 'list_tasks') {
    const status = ['open', 'done', 'all'].includes(a.status) ? a.status : 'open';
    const limit = clampInt(a.limit, 1, 200, 50);
    const tasks = (await notes.actions({ status, limit })).filter((t) => t.status !== 'cancelled');
    if (!tasks.length) return text(status === 'open' ? 'No open tasks.' : 'No tasks.', { tasks: [] });
    const recIds = [...new Set(tasks.map((t) => t.recording_id).filter(Boolean))];
    const titles = new Map();
    if (recIds.length) {
      for (const r of await notes.recordings({ limit: 1000, fields: 'id,title,local_date,extra' })) titles.set(r.id, r.title);
    }
    const shaped = tasks.map((t) => ({
      id: t.id, label: t.label, status: t.status, due: t.due_date ?? null, due_time: (t.due_date && t.due_time) || null,
      recording: t.recording_id ? { id: t.recording_id, title: titles.get(t.recording_id) ?? null } : null,
    }));
    return text(shaped.map((t) => `${t.status === 'done' ? '[x]' : '[ ]'} ${t.label}${t.due ? ` (due ${t.due}${t.due_time ? ` ${t.due_time}` : ''})` : ''}`
      + `${t.recording?.title ? ` · from "${t.recording.title}"` : ''}`).join('\n'), { tasks: shaped });
  }
  return null;
}

// One JSON-RPC message → the reply object, or null for a notification (no reply).
export async function rpc(msg, { notes, version = '0' }) {
  const id = msg?.id ?? null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid request');
  if (msg.id === undefined) return null; // notifications/initialized and friends
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mullo', title: 'Mullo', version: String(version) },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`);
      try {
        return reply(await callTool(name, msg.params?.arguments, notes));
      } catch (err) {
        if (err.status === 401) throw err; // the token ran out mid-call: the client signs in again
        return reply(toolError(err.message || 'Mullo couldn\'t read the notes just now. Try again.'));
      }
    }
    default: return error(-32601, `Method not found: ${msg.method}`);
  }
}

// ── The same reads as plain JSON (GET /v1/...), for scripts and automations ──
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function restCall(path, params, notes) {
  const int = (k) => (params.has(k) ? Number.parseInt(params.get(k), 10) : undefined);
  if (path === '/v1/recordings') {
    const q = params.get('q');
    const r = q
      ? await callTool('search', { query: q, limit: int('limit') }, notes)
      : await callTool('recent_recordings', { from: params.get('from') ?? undefined, to: params.get('to') ?? undefined, days: int('days'), limit: int('limit') }, notes);
    if (r.isError) throw fail(400, r.content[0].text);
    return q ? { recordings: r.structuredContent.results } : r.structuredContent;
  }
  const one = /^\/v1\/recordings\/([0-9a-f-]{36})$/i.exec(path);
  if (one) {
    const rec = await notes.recording(one[1]);
    if (!rec) throw fail(404, 'No recording with that id (it may not be copied into the Mullo account).');
    const withTranscript = ['1', 'true', 'yes'].includes(params.get('transcript'));
    const [actions, transcripts] = await Promise.all([
      notes.actions({ recordingIds: [rec.id] }),
      withTranscript ? notes.transcripts([rec.id]) : [],
    ]);
    const speaker = (label) => (label ? rec.speakers?.[label] ?? label : null);
    return {
      recording: {
        id: rec.id, title: rec.title, date: rec.local_date, recorded_at: rec.recorded_at, duration_ms: rec.duration_ms ?? null,
        language: rec.language ?? null, summary: rec.summary ?? null, sections: rec.sections ?? [],
        updates: (rec.updates ?? []).map((u) => ({ date: u.date ?? null, text: u.text })),
        tasks: actions.filter((t) => t.status !== 'cancelled').map((t) => ({ id: t.id, label: t.label, status: t.status, due: t.due_date ?? null, due_time: (t.due_date && t.due_time) || null })),
        ...(withTranscript ? { transcript: (transcripts[0]?.segments ?? []).map((s) => ({ speaker: speaker(s.speaker), start_ms: s.start_ms ?? null, text: s.text })) } : {}),
      },
    };
  }
  if (path === '/v1/tasks') {
    return (await callTool('list_tasks', { status: params.get('status') ?? undefined, limit: int('limit') }, notes)).structuredContent;
  }
  throw fail(404, 'Not found. The API has /v1/recordings, /v1/recordings/<id> and /v1/tasks.');
}

// ── Discovery: where to sign in (RFC 9728 protected resource metadata) ──
export function resourceMetadata(env, origin) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'Mullo',
    resource_documentation: `${origin}/docs/mcp`,
  };
}

export { notesFor };
