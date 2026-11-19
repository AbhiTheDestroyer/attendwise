'use strict';
/** Import parsing tests (§45): formats, dates, invalid values, duplicates. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSheetGrid, parseDateCell, normalizeStatus } = require('../src/services/parsing');
const { parseCSV } = require('../src/util');
const { buildXlsx, readXlsxGrid } = require('../src/services/xlsx');

const REF = { refYear: 2026 };

test('matrix format: students in rows, dates in columns', () => {
  const grid = [
    ['Roll No', 'Name', '01/09', '03/09', '05/09'],
    ['101', 'Rahul Kumar', 'P', 'P', 'A'],
    ['102', 'Aman Gupta', 'A', 'P', ''],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.equal(p.format, 'matrix');
  assert.equal(p.entries.length, 5); // Aman's empty cell on 05/09 is not a record
  assert.equal(p.entries[0].date, '2026-09-01');
  assert.equal(p.entries[2].statusRaw, 'A');
});

test('long format: one row per student-date', () => {
  const grid = [
    ['Roll No', 'Student Name', 'Date', 'Attendance'],
    ['101', 'Rahul Kumar', '01/09/2026', 'Present'],
    ['102', 'Aman Gupta', '2026-09-03', 'Absent'],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.equal(p.format, 'long');
  assert.equal(p.entries.length, 2);
  assert.equal(p.entries[1].date, '2026-09-03');
  assert.equal(normalizeStatus(p.entries[1].statusRaw).status, 'A');
});

test('different column ordering still works', () => {
  const grid = [
    ['Name', '07/09', 'Roll No', '01/09'],
    ['Rahul Kumar', 'P', '101', 'A'],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.equal(p.format, 'matrix');
  const dates = p.entries.map((e) => e.date).sort();
  assert.deepEqual(dates, ['2026-09-01', '2026-09-07']);
});

test('dates: d/m, d-m-yyyy, ISO, "1 Sep", Excel serials; invalid → null', () => {
  assert.equal(parseDateCell('01/09', { refYear: 2026 }), '2026-09-01');
  assert.equal(parseDateCell('1-9-26', {}), '2026-09-01');
  assert.equal(parseDateCell('2026-09-05', {}), '2026-09-05');
  assert.equal(parseDateCell('5 Sep', { refYear: 2026 }), '2026-09-05');
  assert.equal(parseDateCell('Sep 7 2026', {}), '2026-09-07');
  assert.equal(parseDateCell('45870', {}), '2025-08-01'); // excel serial (1899-12-30 epoch)
  assert.equal(parseDateCell('32/13/2026', {}), null);    // impossible date
  assert.equal(parseDateCell('hello', {}), null);
  // 13/02 is unambiguous day-first even though 02/13 would be US-style
  assert.equal(parseDateCell('13/02', { refYear: 2026 }), '2026-02-13');
});

test('status vocabulary incl. Present/Absent words and symbols', () => {
  for (const [raw, want] of [['P', 'P'], ['present', 'P'], ['✓', 'P'], ['A', 'A'], ['Absent', 'A'],
    ['leave', 'E'], ['Holiday', 'H'], ['cancelled', 'C']]) {
    assert.equal(normalizeStatus(raw).status, want, raw);
  }
  assert.equal(normalizeStatus('💥').valid, false);
  assert.equal(normalizeStatus('').valid, false);
});

test('missing roll number is kept and flagged (not discarded)', () => {
  const grid = [
    ['Roll No', 'Name', '01/09'],
    ['', 'Mystery Person', 'P'],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].rollNo, null);
  assert.equal(p.entries[0].name, 'Mystery Person');
});

test('duplicate rows in the same file are flagged via duplicateOf', () => {
  const grid = [
    ['Roll No', 'Name', '01/09'],
    ['101', 'Rahul Kumar', 'P'],
    ['101', 'Rahul Kumar', 'A'],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.equal(p.entries.length, 2);
  assert.equal(p.entries[1].duplicateOf, p.entries[0].rowNo);
});

test('empty rows are counted, not treated as students', () => {
  const grid = [
    ['Roll No', 'Name', '01/09'],
    ['', '', ''],
    ['101', 'Rahul', 'P'],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.equal(p.emptyRows, 1);
  assert.equal(p.entries.length, 1);
});

test('unparseable sheet reports a helpful file-level issue', () => {
  const p = parseSheetGrid([['random', 'junk'], ['more', 'junk']], REF);
  assert.equal(p.format, null);
  assert.ok(p.fileIssues[0].includes('header'));
});

test('CSV with quoting/commas parses correctly', () => {
  const rows = parseCSV('Roll No,Name,01/09\r\n101,"Kumar, Rahul",P\n102,"Quote ""User""",A');
  assert.equal(rows[1][1], 'Kumar, Rahul');
  assert.equal(rows[2][1], 'Quote "User"');
});

test('XLSX write → read round trip', () => {
  const grid = [
    ['Roll No', 'Name', '01/09', '03/09'],
    ['101', 'Rahul Kumar', 'P', 'A'],
    ['102', 'Ishaan Joshi', '✓', ''],
  ];
  const back = readXlsxGrid(buildXlsx(grid));
  assert.deepEqual(back, grid);
  const p = parseSheetGrid(back, REF);
  assert.equal(p.format, 'matrix');
  assert.equal(p.entries.length, 3); // Ishaan's EMPTY 03/09 cell is "no mark" → no record
});


test('duplicate date columns in header produce a file-level warning', () => {
  const grid = [
    ['Roll No', 'Name', '01/09', '01/09'],
    ['101', 'Rahul', 'P', 'A'],
  ];
  const p = parseSheetGrid(grid, REF);
  assert.ok(p.fileIssues.some((i) => i.includes('Duplicate date')));
  assert.ok(p.entries.some((e) => e.duplicateDateColumn));
});
