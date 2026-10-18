// Summary formats: the built-in templates plus the person's own, which are
// kept with their settings on this device (and move to their profile when
// sign-in arrives). The engines get a built-in by id and an own format whole,
// because the bridge and the Worker only know the built-ins.

import { TEMPLATES, templateById, cleanTemplate, parseTemplateText, MAX_CUSTOM_TEMPLATES } from './templates.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { newId } from '../core/ids.js';

export const customFormats = () => getSettings().templates.map(cleanTemplate).filter(Boolean);
export const allFormats = () => [...TEMPLATES, ...customFormats()];
export const formatFor = (id) => templateById(id, customFormats());

export function engineTemplate(id) {
  const t = formatFor(id);
  return t.custom ? t : t.id;
}

// New when id is empty, else replaces that format. → { ok, template } | { ok:false, error }
export function saveFormat({ id = null, label, text, withTasks = true }) {
  const list = customFormats();
  const editing = id && list.some((t) => t.id === id);
  if (!editing && list.length >= MAX_CUSTOM_TEMPLATES) {
    return { ok: false, error: `You can keep up to ${MAX_CUSTOM_TEMPLATES} of your own formats - delete one first.` };
  }
  const fid = editing ? id : `c_${newId().replace(/[^a-f0-9]/g, '').slice(0, 12)}`;
  const t = parseTemplateText({ id: fid, label, text, withTasks });
  if (!t) return { ok: false, error: 'Give it a name and at least one section.' };
  updateSettings({ templates: editing ? list.map((x) => (x.id === id ? t : x)) : [...list, t] });
  return { ok: true, template: t };
}

// Recordings already summarised with it keep their summary; "Summarise again"
// on them falls back to General.
export function deleteFormat(id) {
  const s = getSettings();
  updateSettings({
    templates: customFormats().filter((t) => t.id !== id),
    ...(s.template === id ? { template: 'voice_note' } : {}),
  });
}
