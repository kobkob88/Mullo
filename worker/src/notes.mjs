// A person's notes in Mullo's Supabase, read AS that person: every request carries their own
// token (the app's sign-in, or a connected app's OAuth token), so row-level security decides
// what comes back, exactly as for the app. No secret key is ever used here.
//
// Rows come back in the device's shape: fields kept in `extra` (speakers...) are spread back.

const fail = (status, message) => Object.assign(new Error(message), { status });

export const REC_FIELDS = 'id,title,recorded_at,local_date,duration_ms,language,status,summary,sections,folder_id,extra';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (s) => UUID.test(String(s ?? ''));

const unpack = (row) => ({ ...(row.extra ?? {}), ...row, extra: undefined });

export function notesFor(env, token, doFetch = globalThis.fetch) {
  const base = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) throw fail(503, 'Mullo\'s account server isn\'t set up on this server.');

  async function get(path) {
    const res = await doFetch(`${base}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (res.status === 401) throw fail(401, 'Your Mullo sign-in has run out. Connect again.');
    if (!res.ok) throw fail(502, `Mullo's account server answered ${res.status}.`);
    return res.json();
  }
  const inList = (ids) => `in.(${ids.filter(isId).join(',')})`;

  return {
    // Newest first. from/to: local dates (YYYY-MM-DD), inclusive.
    async recordings({ limit = 500, from = null, to = null, fields = REC_FIELDS } = {}) {
      const q = [`select=${fields}`, 'order=recorded_at.desc', `limit=${Math.min(Math.max(1, limit), 1000)}`];
      if (from) q.push(`local_date=gte.${from}`);
      if (to) q.push(`local_date=lte.${to}`);
      return (await get(`recordings?${q.join('&')}`)).map(unpack);
    },
    async recording(id) {
      if (!isId(id)) return null;
      return (await get(`recordings?select=${REC_FIELDS}&id=eq.${id}`)).map(unpack)[0] ?? null;
    },
    async transcripts(recordingIds) {
      const ids = recordingIds.filter(isId);
      if (!ids.length) return [];
      return (await get(`transcripts?select=recording_id,segments&recording_id=${inList(ids)}`)).map(unpack);
    },
    // status: 'open' | 'done' | 'all'. recordingIds narrows to those recordings.
    async actions({ status = 'all', recordingIds = null, limit = 1000 } = {}) {
      const q = ['select=id,recording_id,label,type,status,due_date,priority,completed_at,created_at,extra', `limit=${limit}`,
        'order=due_date.asc.nullslast,created_at.desc'];
      if (status !== 'all') q.push(`status=eq.${status === 'done' ? 'done' : 'open'}`);
      if (recordingIds) {
        const ids = recordingIds.filter(isId);
        if (!ids.length) return [];
        q.push(`recording_id=${inList(ids)}`);
      }
      return (await get(`action_items?${q.join('&')}`)).map(unpack);
    },
  };
}
