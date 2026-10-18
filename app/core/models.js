// Which AI writes summaries, tasks, Ask answers and drafts (S54). The list, and what this
// account may use, come from Mullo's server; the phone never decides. The pick is kept on the
// server with the account, so every device and the watch (with Mullo closed) use it.
// Transcripts always use Mullo's default.
import { mulloAccount } from './account.js';

export const TIER_LABEL = { standard: 'Pro', max: 'Max' };

export const loadModels = (workerUrl) => mulloAccount().server(workerUrl, '/api/models');
export const pickModel = (workerUrl, id) => mulloAccount().server(workerUrl, '/api/models', { pick: id });

// ownGemini: the person's own Gemini key pays, so Max models are theirs to use too (the server
// says so on each call; this only draws the list).
export function pickerRows(report, { ownGemini = false } = {}) {
  if (!report?.models?.length) return [];
  return report.models.map((m) => ({ ...m, allowed: ownGemini || m.allowed, current: m.id === report.using }));
}
