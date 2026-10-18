// Admin dashboard and reports (S59 round 1; the numbers come from worker/src/admin-reports.mjs).
// The dashboard is one window per area, each opening its report; a report is its headline
// tiles, what it can't see (blind spots, always shown, never folded away), then its tables,
// each with CSV. settings.js asks the server and draws the page around these.

import { h, userText } from './dom.js';
import { toCsv, csvName } from '../core/csv.js';

export const statsHref = (name) => `#/settings/admin-stats-${name}`;
export const statsName = (section) => (/^admin-stats-([a-z]+)$/.exec(section ?? '') ?? [])[1] ?? null;

// The last report drawn per name, for the CSV buttons.
const shown = new Map();

const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? ''));
const updated = (sec) => `Updated ${new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

function refreshRow(at) {
  return h('div', { class: 'row stats-updated' },
    at ? h('span', { class: 'muted small' }, updated(at)) : null,
    h('button', { type: 'button', class: 'btn btn--ghost btn--small', data: { action: 'admin-stats-refresh' } }, 'Refresh'));
}

export function dashboardBody(value) {
  if (!value) return null;
  return [
    refreshRow(value.generatedAt),
    h('div', { class: 'stats-grid' }, value.windows.map((w) => h('a', { class: 'card stats-window', href: statsHref(w.name) },
      h('span', { class: 'stats-window__title' }, w.title),
      h('span', { class: 'stats-window__value' }, num(w.value)),
      h('span', { class: 'muted small' }, w.line),
      w.blind ? h('span', { class: 'stats-window__blind small' }, w.blind === 1 ? '1 blind spot' : `${w.blind} blind spots`) : null))),
    h('p', { class: 'muted small' }, `Calendar month: ${value.month} (UTC). Every number comes from what Mullo's server records; nothing is estimated.`),
  ];
}

function table(report, t) {
  const bars = t.bars ? Math.max(1, ...t.rows.map((r) => Number(r.at(-1)) || 0)) : 0;
  return h('section', { class: 'card stack' },
    h('h2', { class: 'card__title' }, t.title),
    t.rows.length
      ? h('div', { class: 'stats-table-wrap' }, h('table', { class: 'stats-table' },
        h('thead', null, h('tr', null, t.columns.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, t.rows.map((row) => h('tr', null, row.map((cell, i) => h('td', { class: typeof cell === 'number' ? 'is-num' : null },
          userText('span', num(cell)),
          bars && i === row.length - 1 ? h('meter', { class: 'stats-bar', min: '0', max: String(bars), value: String(Number(cell) || 0), 'aria-hidden': 'true' }) : null)))))))
      : h('p', { class: 'muted small' }, 'Nothing here yet.'),
    t.rows.length ? h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', data: { action: 'admin-csv', report: report.name, table: t.id, how: 'copy' } }, 'Copy CSV'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', data: { action: 'admin-csv', report: report.name, table: t.id, how: 'download' } }, 'Download CSV')) : null);
}

export function reportBody(report) {
  if (!report) return null;
  shown.set(report.name, report);
  return [
    refreshRow(report.generatedAt),
    report.tiles.length ? h('div', { class: 'stats-grid' }, report.tiles.map((t) => h('div', { class: 'card stats-window' },
      h('span', { class: 'stats-window__title' }, t.label),
      h('span', { class: 'stats-window__value' }, num(t.value))))) : null,
    report.blind.length ? h('section', { class: 'notice stack' },
      h('p', { class: 'set-row__title' }, 'What this doesn\'t show'),
      h('ul', { class: 'stats-blind' }, report.blind.map((b) => h('li', { class: 'small' }, b)))) : null,
    report.link ? h('a', { class: 'btn', href: report.link.href }, report.link.label) : null,
    report.tables.map((t) => table(report, t)),
  ];
}

// → { name, text } for a table of a report on screen, or null.
export function csvFor(reportName, tableId) {
  const r = shown.get(reportName);
  const t = r?.tables.find((x) => x.id === tableId);
  return t ? { name: csvName(reportName, tableId, r.month), text: toCsv(t) } : null;
}
