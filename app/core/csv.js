// CSV for the admin reports' tables (S59: "CSV for every table"). Pure: columns + rows in,
// one RFC 4180 text out (comma, CRLF, quotes doubled). A cell starting with = + - @ gets a
// leading ' so a spreadsheet never runs it as a formula (a problem report's version string
// or an admin-log detail is text someone else typed).

const RISKY = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (typeof value !== 'number' && RISKY.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = ({ columns = [], rows = [] }) =>
  [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

// "people-plans-2026-10.csv"
export const csvName = (report, table, month) =>
  `mullo-${[report, table, month].filter(Boolean).join('-').replace(/[^\w-]+/g, '-')}.csv`;
