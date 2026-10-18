// Summary templates (the Plaud idea): the same transcript summarised for the
// kind of conversation it was. An engine fills each block by its `kind`.

export const TEMPLATES = [
  {
    id: 'general', label: 'General',
    blocks: [
      { heading: 'Overview', kind: 'overview' },
      { heading: 'Key points', kind: 'key_points' },
      { heading: 'Next steps', kind: 'actions' },
    ],
  },
  {
    id: 'meeting', label: 'Meeting',
    blocks: [
      { heading: 'Overview', kind: 'overview' },
      { heading: 'Decisions', kind: 'decisions' },
      { heading: 'Discussion', kind: 'key_points' },
      { heading: 'Action items', kind: 'actions' },
    ],
  },
  {
    id: 'call', label: 'Phone call',
    blocks: [
      { heading: 'What it was about', kind: 'overview' },
      { heading: 'Highlights', kind: 'key_points' },
      { heading: 'Follow-ups', kind: 'actions' },
    ],
  },
  {
    id: 'voice_note', label: 'Voice note',
    blocks: [
      { heading: 'Note', kind: 'overview' },
      { heading: 'To do', kind: 'actions' },
    ],
  },
  {
    id: 'lecture', label: 'Lecture / learning',
    blocks: [
      { heading: 'Topic', kind: 'overview' },
      { heading: 'Main ideas', kind: 'key_points' },
      { heading: 'To look up', kind: 'actions' },
    ],
  },
];


// ── Your own formats ────────────────────────────────────────────────────
// A person writes their own: a name and up to 8 sections, each a heading and
// (optionally) what goes under it. The phone keeps them; with each summary
// request the format itself travels to the engine (an id alone means a
// built-in). The same check runs on the phone, the bridge and the Worker, so a
// format that reaches the model is always this small and this shape.

export const BLOCK_KINDS = ['overview', 'key_points', 'decisions', 'actions', 'custom'];
export const MAX_CUSTOM_TEMPLATES = 10;
export const MAX_BLOCKS = 8;
const CUSTOM_ID = /^c_[a-z0-9]{4,24}$/;

const line = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// → a clean template, or null if it isn't one.
export function cleanTemplate(raw) {
  if (!raw || typeof raw !== 'object' || !CUSTOM_ID.test(String(raw.id ?? ''))) return null;
  const label = line(raw.label, 40);
  let tasks = false;
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : [])
    .map((b) => ({ heading: line(b?.heading, 40), kind: BLOCK_KINDS.includes(b?.kind) ? b.kind : 'custom', hint: line(b?.hint, 200) }))
    .filter((b) => {
      if (!b.heading) return false;
      if (b.kind !== 'actions') return true;
      if (tasks) return false; // one task list per summary
      tasks = true;
      return true;
    })
    .slice(0, MAX_BLOCKS)
    .map((b) => (b.hint ? b : { heading: b.heading, kind: b.kind }));
  if (!label || !blocks.length) return null;
  return { id: raw.id, label, custom: true, blocks };
}

// custom: the person's own formats (the phone passes them; servers don't have any).
export function templateById(id, custom = []) {
  return custom.find((t) => t.id === id) ?? TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

// What an engine was handed: a built-in's id, or a whole format.
export function resolveTemplate(template) {
  if (template && typeof template === 'object') return cleanTemplate(template) ?? TEMPLATES[0];
  return templateById(template);
}

// The edit box: one section per line, "Heading: what goes in it". The tasks
// section is a tick box, not a line.
const TASK_HEADINGS = /^(?:to ?do|tasks|action items|next steps|משימות|לעשות|מה לעשות)$/i;

export function parseTemplateText({ id, label, text, withTasks = true }) {
  const blocks = [];
  for (const raw of String(text ?? '').split(/\n+/)) {
    const m = /^\s*([^:]+?)\s*(?::\s*(.*))?$/.exec(raw);
    if (!m || !m[1].trim()) continue;
    if (TASK_HEADINGS.test(m[1].trim()) && !m[2]) continue; // the tick box covers it
    blocks.push({ heading: m[1], kind: 'custom', hint: m[2] ?? '' });
  }
  if (withTasks) blocks.push({ heading: 'To do', kind: 'actions' });
  return cleanTemplate({ id, label, blocks });
}

export function templateText(t) {
  return t.blocks.filter((b) => b.kind !== 'actions').map((b) => (b.hint ? `${b.heading}: ${b.hint}` : b.heading)).join('\n');
}
