'use strict';
/**
 * Attendance sheet parsing & normalization (CSV or XLSX cell-grids).
 *
 * Supported layouts
 *  ─ "matrix": students in rows, dates as columns, P/A (etc.) in cells
 *      | Roll No | Name  | 01/09 | 03/09 |
 *      | 101     | Rahul |  P    |  A    |
 *  ─ "long": one row per student-date
 *      | Roll No | Name | Date       | Status  |
 *      | 101     | Rahul| 2026-09-01 | Present |
 *
 * The parser never decides what a bad value means; it flags and keeps it.
 */

/* ------------------------------ status values ----------------------------- */
const STATUS_MAP = new Map([
  ['p', 'P'], ['present', 'P'], ['prs', 'P'], ['✓', 'P'], ['✔', 'P'], ['1', 'P'], ['y', 'P'], ['yes', 'P'],
  ['a', 'A'], ['absent', 'A'], ['abs', 'A'], ['✗', 'A'], ['x', 'A'], ['0', 'A'], ['n', 'A'], ['no', 'A'],
  ['e', 'E'], ['excused', 'E'], ['leave', 'E'], ['l', 'E'], ['od', 'E'], ['on duty', 'E'],
  ['h', 'H'], ['holiday', 'H'], ['hol', 'H'],
  ['c', 'C'], ['cancelled', 'C'], ['canceled', 'C'], ['n/a', 'C'], ['na', 'C'],
]);
function normalizeStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { status: null, valid: false, reason: 'empty' };
  const hit = STATUS_MAP.get(s);
  if (hit) return { status: hit, valid: true };
  return { status: null, valid: false, reason: `Unrecognized attendance value "${String(raw).trim()}"` };
}

/* --------------------------------- dates ---------------------------------- */
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoFromParts(y, m, d) {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  return dt.toISOString().slice(0, 10) === iso ? iso : null;
}

/** True when a header cell looks like a date column. */
function isDateLike(header) {
  return parseDateCell(header, { lenient: true }) !== null;
}

/**
 * Parse a date cell into YYYY-MM-DD.
 * Supports: 01/09, 01-09-2026, 01.09.26, 2026-09-01, "1 Sep", "Sep 1",
 * Excel serials (as strings, 30000-60000), and US-unambiguous forms.
 * Day-first interpretation (institutional default in IN). When no year is
 * given, `refYear` is used and dates >45 days in the future roll back a year.
 */
function parseDateCell(input, { refYear, refDate = new Date(), lenient = false } = {}) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;

  // Excel serial number
  if (/^\d{5}(\.0+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 30000 && serial <= 60000) {
      const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    return null;
  }
  s = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  // ISO 2026-09-01
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoFromParts(+m[1], +m[2], +m[3]);

  // "1 Sep" / "Sep 1" / "1 Sep 26"
  m = /^(\d{1,2})\s+([A-Za-z]{3,4})\.?\s*(\d{2,4})?$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return withYear(isoFromParts(m[3] ? +m[3] : refYear || refDate.getFullYear(), MONTHS[m[2].toLowerCase()], +m[1]), !!m[3], refDate);
  }
  m = /^([A-Za-z]{3,4})\.?\s+(\d{1,2})\s*(\d{2,4})?$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return withYear(isoFromParts(m[3] ? +m[3] : refYear || refDate.getFullYear(), MONTHS[m[1].toLowerCase()], +m[2]), !!m[3], refDate);
  }

  // 01/09, 01-09-2026, 01.09.26 (day first)
  m = /^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/.exec(s);
  if (m) {
    let d = +m[1], mo = +m[2];
    // If day>12 and month≤12 keep; if BOTH ≤12 we assume day-first; if month>12 swap.
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return withYear(isoFromParts(m[3] ? +m[3] : refYear || refDate.getFullYear(), mo, d), !!m[3], refDate);
  }
  if (lenient) return null;
  return null;
}

function withYear(iso, hadYear, refDate) {
  if (!iso) return null;
  if (hadYear) return iso;
  // Year-less headers: avoid silently dropping a class into the future.
  const d = new Date(iso + 'T00:00:00Z');
  const diffDays = (d - refDate) / 86400000;
  if (diffDays > 45) {
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }
  return iso;
}

/* ------------------------------ grid → entries ---------------------------- */
const ROLL_RE = /^(roll\s*(no|number|#)?|enroll(ment)?\s*(no|number)?|reg(istration)?\s*(no|number)?|adm(ission)?\s*(no)?|id|sr\.?\s*no|s\.?\s*no)$/i;
const NAME_RE = /^(name|student\s*name|student|full\s*name)$/i;
const STATUS_RE = /^(status|attendance|mark|p\/a|present\/absent|att)$/i;
const DATE_HDR_RE = /^(date|class\s*date|day)$/i;

/**
 * @param {string[][]} grid raw rows of string cells
 * @returns {{format:'matrix'|'long'|null, entries:Array, fileIssues:string[], emptyRows:number}}
 */
function parseSheetGrid(grid, { refYear } = {}) {
  const fileIssues = [];
  const rows = grid.map((r) => r.map((c) => String(c ?? '').trim()));
  let emptyRows = 0;

  // locate the header row (first row with a roll- or name-like cell and ≥2 cells)
  let hIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i];
    const nonEmpty = r.filter((c) => c !== '');
    if (nonEmpty.length < 2) continue;
    if (r.some((c) => ROLL_RE.test(c)) || r.some((c) => NAME_RE.test(c))) { hIdx = i; break; }
  }
  if (hIdx === -1) {
    return {
      format: null, entries: [], emptyRows,
      fileIssues: ['Could not find a header row with a Roll No / Name column. Expected a first row like "Roll No, Name, <date...>" or "Roll No, Name, Date, Status".'],
    };
  }
  const header = rows[hIdx];
  const rollCol = header.findIndex((c) => ROLL_RE.test(c));
  const nameCol = header.findIndex((c) => NAME_RE.test(c));
  const dateCol = header.findIndex((c) => DATE_HDR_RE.test(c));
  const statusCol = header.findIndex((c) => STATUS_RE.test(c));

  const entries = [];
  const seen = new Map(); // dedup key -> first rowNo

  const pushEntry = (entry) => {
    const key = `${(entry.rollNo || '').toLowerCase()}|${(entry.name || '').toLowerCase()}|${entry.date || '?'}`;
    if (seen.has(key)) {
      entry.duplicateOf = seen.get(key);
    } else {
      seen.set(key, entry.rowNo);
    }
    entries.push(entry);
  };

  if (dateCol >= 0 && statusCol >= 0) {
    /* ------------------------------- long format ------------------------------ */
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.every((c) => c === '')) { emptyRows++; continue; }
      const dateRaw = r[dateCol] || '';
      const date = parseDateCell(dateRaw, { refYear });
      pushEntry({
        rowNo: i + 1,
        rollNo: rollCol >= 0 ? r[rollCol] || null : null,
        name: nameCol >= 0 ? r[nameCol] || null : null,
        date,
        dateRaw: dateRaw || null,
        dateInvalid: !!(dateRaw && !date),
        statusRaw: r[statusCol] || '',
      });
    }
    return { format: 'long', entries, fileIssues, emptyRows };
  }

  /* ------------------------------- matrix format ------------------------------ */
  const dateCols = [];
  for (let j = 0; j < header.length; j++) {
    if (j === rollCol || j === nameCol) continue;
    if (header[j] === '') continue;
    const iso = parseDateCell(header[j], { refYear, lenient: true });
    if (iso) dateCols.push({ col: j, date: iso, header: header[j] });
  }
  if (!dateCols.length) {
    return {
      format: null, entries: [], emptyRows,
      fileIssues: ['No date columns detected. Date headers should look like "01/09", "01-09-2026" or "1 Sep".'],
    };
  }
  if (rollCol === -1 && nameCol === -1) {
    fileIssues.push('No Roll No or Name column detected; matching will be weak.');
  }
  const dupDates = dateCols.map((d) => d.date).filter((d, i, arr) => arr.indexOf(d) !== i);
  if (dupDates.length) {
    fileIssues.push(`Duplicate date column(s) in header: ${[...new Set(dupDates)].join(', ')} — later columns were flagged.`);
  }

  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => c === '')) { emptyRows++; continue; }
    const rollNo = rollCol >= 0 ? r[rollCol] || null : null;
    const name = nameCol >= 0 ? r[nameCol] || null : null;
    if (!rollNo && !name) { emptyRows++; continue; }
    let anyCell = false;
    const seenDates = new Set();
    for (const dc of dateCols) {
      let cell = r[dc.col] ?? '';
      const dupDateCol = seenDates.has(dc.date);
      seenDates.add(dc.date);
      if (cell === '') continue; // a student with no mark for that day — not a record
      anyCell = true;
      pushEntry({
        rowNo: i + 1,
        rollNo, name,
        date: dc.date,
        dateRaw: dc.header,
        dateInvalid: false,
        statusRaw: cell,
        duplicateDateColumn: dupDateCol,
      });
    }
    if (!anyCell) {
      // student row with zero marks: keep as an explicit issue row so nothing is silently lost
      pushEntry({
        rowNo: i + 1, rollNo, name, date: null, dateRaw: null,
        dateInvalid: false, statusRaw: '', noMarks: true,
      });
    }
  }
  return { format: 'matrix', entries, fileIssues, emptyRows, dateColumns: dateCols.length };
}

module.exports = { parseSheetGrid, parseDateCell, isDateLike, normalizeStatus, isoFromParts };
