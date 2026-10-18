// Activity: the audit log, readable. Every insert, edit and delete with who,
// when and why; deletes restore in one tap, edits revert if untouched since.
// The health box is where the watchdogs speak (spec §11: surface alerts
// where someone already looks).

import { h, userText } from '../dom.js';
import { pageHeader, emptyState } from '../components.js';
import { ctx } from '../context.js';
import { listActivity, restoreDeleted, revertEdit, pendingAudit } from '../../core/audit.js';
import { massDeleteAlerts } from '../../core/watchdog.js';
import { conflictCount } from '../../core/db.js';
import { relativeDay, timeOfDay, localDate } from '../../core/dates.js';

export const screen = 'activity';

const TABLE_LABEL = {
  recordings: 'recording', transcripts: 'transcript', action_items: 'action',
  folders: 'folder', audio_files: 'audio',
};
const VERB = { insert: 'Added', update: 'Changed', delete: 'Deleted' };
const LIMIT = 200;

function labelOf(entry) {
  const row = entry.after ?? entry.before ?? {};
  return row.title ?? row.label ?? (entry.table === 'transcripts' ? `${row.segments?.length ?? 0} lines` : '');
}

export async function render() {
  const entries = await listActivity();
  const alerts = massDeleteAlerts(entries);
  const queued = pendingAudit().length;
  const conflicts = conflictCount();

  const health = h('section', { class: ['card', 'stack', alerts.length ? 'is-alert' : null] },
    h('h2', { class: 'card__title' }, 'Health'),
    alerts.length
      ? alerts.map((a) => h('p', { class: 'notice notice--alert' }, a.message, ' - check below and restore anything that should not have gone.'))
      : h('p', { class: 'small' }, 'No mass deletes.'),
    h('p', { class: 'small muted' }, `${queued} log entries waiting to be written · ${conflicts} refused writes this session (someone else got there first; nothing lost)`));

  if (!entries.length) return h('div', null, pageHeader('Activity'), health, emptyState('Nothing yet'));

  // A cascade (a recording and its transcript/actions) is one intent: show it
  // once, on the recording, with a count. Restore brings the whole batch back.
  const batchSize = new Map();
  for (const e of entries) if (e.batch) batchSize.set(e.batch, (batchSize.get(e.batch) ?? 0) + 1);
  const leadOf = new Map();
  for (const e of entries) {
    if (!e.batch) continue;
    const lead = leadOf.get(e.batch);
    if (!lead || (e.table === 'recordings' && lead.table !== 'recordings')) leadOf.set(e.batch, e);
  }
  const shown = entries
    .filter(Boolean)
    .filter((e) => !e.batch || leadOf.get(e.batch) === e)
    .slice(0, LIMIT);
  return h('div', null,
    pageHeader('Activity'),
    health,
    h('ol', { class: 'activity card' }, shown.map((e) =>
      h('li', { class: 'activity__item' },
        h('div', { class: 'activity__line' },
          h('span', { class: ['activity__verb', `is-${e.action}`] }, VERB[e.action] ?? e.action),
          ` ${TABLE_LABEL[e.table] ?? e.table} `,
          userText('span', labelOf(e), { class: 'activity__label' }),
          e.batch && batchSize.get(e.batch) > 1 ? h('span', { class: 'muted' }, ` + ${batchSize.get(e.batch) - 1} linked`) : null),
        h('div', { class: 'activity__meta muted small' },
          `${relativeDay(localDate(new Date(e.at)))} ${timeOfDay(e.at)}`,
          e.reason ? userText('span', ` · ${e.reason}`) : null),
        e.action === 'delete' && e.before
          ? h('button', { type: 'button', class: 'btn btn--small', data: { action: 'activity-restore', id: e.id } }, 'Restore')
          : null,
        e.action === 'update' && e.before && e.table !== 'transcripts'
          ? h('button', { type: 'button', class: 'btn btn--small btn--ghost', data: { action: 'activity-revert', id: e.id } }, 'Undo change')
          : null))),
    entries.length > LIMIT ? h('p', { class: 'muted small' }, `Showing the latest ${LIMIT}.`) : null);
}

export const actions = {
  async 'activity-restore'(el) {
    el.disabled = true;
    try {
      const n = await restoreDeleted(el.dataset.id);
      ctx.toast(n > 1 ? `Restored ${n} records` : 'Restored');
    } catch (err) {
      ctx.toast(err.message, { error: true });
    }
    ctx.refresh({ force: true });
  },
  async 'activity-revert'(el) {
    el.disabled = true;
    try {
      await revertEdit(el.dataset.id);
      ctx.toast('Change undone');
    } catch (err) {
      ctx.toast(err.message, { error: true });
    }
    ctx.refresh({ force: true });
  },
};
