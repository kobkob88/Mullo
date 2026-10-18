// The local engine: deterministic, offline heuristics standing in for the AI
// engine (engines/remote.js) behind the same interface. It is the floor, not
// the goal - good enough to make the pipeline real and testable, in English
// and Hebrew.
//
// Engine interface (pure, no I/O):
//   sectionize(segments)                        → [{ title, summary, start_ms, end_ms }]
//   extractActions(segments, { today })         → [{ label, type, priority, due_date, context }]
//   summarize(template, segments, sections, actions) → { template, blocks:[{ heading, items }] }
//   titleFor(segments)                          → string | null

import { templateById } from '../templates.js';
import { addDays, nextWeekday } from '../../core/dates.js';
import { startsTask, HE_NOT_VERB, FILLER } from '../task-rules.js';

export const localEngine = { id: 'local', sectionize, extractActions, summarize, titleFor };

const HEBREW = /[֐-׿]/;

export function clip(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fullText(segments) {
  return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

// ── Sections (the Pocket idea: timestamped chapters) ────────────────────
// New section on a long pause or after ~90 seconds.
export function sectionize(segments, { gapMs = 8000, maxMs = 90_000 } = {}) {
  const groups = [];
  let cur = null;
  for (const seg of segments) {
    const start = seg.start_ms ?? 0;
    const end = seg.end_ms ?? start;
    if (!cur || start - cur.end_ms > gapMs || start - cur.start_ms > maxMs) {
      cur = { start_ms: start, end_ms: end, texts: [] };
      groups.push(cur);
    }
    cur.texts.push(seg.text);
    cur.end_ms = Math.max(cur.end_ms, end);
  }
  return groups.map((g) => {
    const sentences = splitSentences(g.texts.join(' '));
    return {
      title: clip(sentences[0] ?? '', 60),
      summary: clip(sentences.slice(0, 2).join(' '), 220),
      start_ms: g.start_ms,
      end_ms: g.end_ms,
    };
  });
}

// A short gist, not the first sentence: at most 5 words.
export function titleFor(segments) {
  const first = splitSentences(fullText(segments))[0];
  if (!first) return null;
  const words = first.replace(/[.!?؟,]+$/, '').split(/\s+/);
  return clip(words.slice(0, 5).join(' ').replace(/[,;:]+$/, ''), 40);
}

// ── Action items (the Pocket idea: one-tap reminders, messages, emails) ─
// A trigger phrase opens a task list; the rest of the sentence is split on
// commas and "and"/Hebrew vav before an infinitive into separate tasks.
const TRIGGERS = [
  /\bremind me (?:to )?/i,
  /\b(?:i|we) (?:need|have|got) to /i,
  /\bdon'?t forget (?:to )?/i,
  /\bremember to /i,
  /\bto-?do[:,]?\s/i,
  /\bmake sure (?:to |i |we )?/i,
  /\b(?:i'?ll|i will|let me) (?=(?:call|email|send|text|message|follow up|check|book|pay|invoice)\b)/i,
  /תזכיר(?:י)? לי\s*/,
  /תזכורת[:,]?\s*/,
  /לא לשכוח\s*/,
  /(?:אני |אנחנו )?צרי(?:ך|כה|כים|כות)\s+(?=ל)/,
  /לזכור\s+(?=ל)/,
];

// Hebrew infinitives that start a task on their own, even without a trigger.
const HE_TASK_VERB = /^ו?(להתקשר|לשלוח|לבדוק|לדבר|להוציא|לקבוע|לתאם|לשלם|להזמין|לעדכן|לסגור|להכין|לקנות|לבצע)/;

const EN_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HE_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function dueDateIn(text, today) {
  const t = text.toLowerCase();
  if (/\btoday\b|היום/.test(t)) return today;
  if (/\btomorrow\b|מחר/.test(t)) return addDays(today, 1);
  if (/\bnext week\b|בשבוע הבא|שבוע הבא/.test(t)) return addDays(today, 7);
  for (let i = 0; i < 7; i += 1) {
    if (new RegExp(`\\b(?:on |this |next )?${EN_WEEKDAYS[i]}\\b`).test(t)) return nextWeekday(today, i);
    if (new RegExp(`(?:ב?יום )${HE_WEEKDAYS[i]}(?![\\u0590-\\u05FF])`).test(text)) return nextWeekday(today, i);
  }
  return null;
}

// "Remind me to text Dana" is a reminder, not a message to send now.
export function actionType(text) {
  if (/\bremind\b|תזכיר|תזכורת|לזכור/i.test(text)) return 'create_reminder';
  if (/\be-?mail\b|מייל|אימייל/i.test(text)) return 'draft_email';
  if (/\b(?:text|message|whatsapp|sms)\b|הודעה|וואטסאפ|ווטסאפ/i.test(text)) return 'send_message';
  return 'create_reminder';
}

const priorityOf = (text) => (/\burgent\b|\basap\b|\bimportant\b|דחוף|חשוב/i.test(text) ? 'high' : 'medium');

function tidyLabel(part) {
  let s = part.trim()
    .replace(/^(?:and|then|also)\s+/i, '')
    .replace(/^ו(?=ל)/, '')
    .replace(/[\s,.;:!?؟]+$/, '');
  if (!HEBREW.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return clip(s, 120);
}

function splitTasks(rest) {
  return rest
    .split(/,|;|\s+and then\s+|\s+and\s+(?=(?:call|email|send|text|check|book|pay|ask|follow|invoice|buy|talk)\b)|\s+(?=ו(?:ל)[֐-׿])/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
}

// After the trigger, only a part that starts with a verb is a new task.
// "לקנות חלב, ביצים, כביסה" is ONE task (a list of things to buy), not
// three; filler ("בסדר", "okay") and asides ("למרות ש…") are dropped.
// Measured: a first real Hebrew note became 6 "tasks" without this.
// The word lists live in ../task-rules.js, shared with every engine.
export function groupTasks(parts) {
  const out = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part || FILLER.test(part)) continue;
    if (!out.length || startsTask(part)) { out.push(part); continue; }
    // A short item continues the previous task's list; a longer clause that
    // is not a task (an aside) is dropped.
    if (part.split(/\s+/).length <= 3 && !HE_NOT_VERB.test(part)) out[out.length - 1] += `, ${part}`;
  }
  return out;
}

const SOME_OTHER_TIME = /\b(?:later|sometime|some time|someday|eventually|next (?:week|month))\b|בהמשך|מתישהו|אחר כך|בשבוע הבא|בחודש הבא/i;

export function extractActions(segments, { today }) {
  const found = [];
  const seen = new Set();
  // A day named in the sentence covers every task in it (owner, 2026-10-12:
  // said in one breath = the same day), unless the task names its own day or
  // is put off to some other time ("later", "בהמשך").
  const push = (label, context, alone) => {
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    found.push({
      label,
      type: actionType(label),
      priority: priorityOf(alone ? context : label),
      due_date: dueDateIn(label, today) ?? (SOME_OTHER_TIME.test(label) ? null : dueDateIn(context, today)),
      context: clip(context, 300),
    });
  };

  for (const sentence of splitSentences(fullText(segments))) {
    let rest = null;
    for (const trigger of TRIGGERS) {
      const m = trigger.exec(sentence);
      if (m) { rest = sentence.slice(m.index + m[0].length); break; }
    }
    if (rest == null) {
      if (HE_TASK_VERB.test(sentence)) rest = sentence;
      else continue;
    }
    const parts = groupTasks(splitTasks(rest));
    for (const part of parts) push(tidyLabel(part), sentence, parts.length === 1);
  }
  return found;
}

// ── Summary ─────────────────────────────────────────────────────────────
const DECISION = /\b(?:we decided|decided to|agreed|we will|we'll go with|final answer)\b|הוחלט|החלטנו|סיכמנו|מסכימים/i;

// template: an id, or a whole format (a person's own). The offline engine can't
// follow a person's own section descriptions, so those get the key points.
export function summarize(templateOrId, segments, sections, actions) {
  const template = templateOrId && typeof templateOrId === 'object' ? templateOrId : templateById(templateOrId);
  const sentences = splitSentences(fullText(segments));
  const fill = {
    overview: () => (sentences.length ? [clip(sentences.slice(0, 2).join(' '), 320)] : []),
    key_points: () => sections.map((s) => s.title).filter(Boolean).slice(0, 6),
    decisions: () => sentences.filter((s) => DECISION.test(s)).map((s) => clip(s, 200)).slice(0, 6),
    actions: () => actions.map((a) => a.label),
  };
  // It can't sort points into a person's own sections: they go under the first.
  let firstCustom = true;
  fill.custom = () => {
    const items = firstCustom ? fill.key_points() : [];
    firstCustom = false;
    return items;
  };
  return {
    template: template.id,
    engine: 'local',
    blocks: template.blocks.map((b) => ({ heading: b.heading, items: fill[b.kind]?.() ?? [] })),
  };
}
