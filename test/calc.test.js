'use strict';
/**
 * Attendance calculation tests — the 74.99/75/75.01 boundary suite (§43/44).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir } = require('./helpers');
freshDataDir();
const calc = require('../src/services/calc');
const { db } = require('../src/db');

test('pctBp: exact basis points, never NaN', () => {
  assert.equal(calc.pctBp(31, 40), 7750);        // 77.5%
  assert.equal(calc.pctBp(3, 4), 7500);          // 75.0%
  assert.equal(calc.pctBp(0, 0), null);          // no classes → undefined, not 0%
  assert.equal(calc.pctBp(0, 10), 0);            // 0% is real when classes happened
});

test('threshold boundary: 74.9 / 75.0 / 75.1 classified exactly', () => {
  // integer cross-multiplication, no float comparisons anywhere
  assert.equal(calc.thresholdRelation(749, 1000, 75), 'below');
  assert.equal(calc.thresholdRelation(750, 1000, 75), 'at');
  assert.equal(calc.thresholdRelation(751, 1000, 75), 'above');
  assert.equal(calc.thresholdRelation(3, 4, 75), 'at');
  assert.equal(calc.thresholdRelation(299, 400, 75), 'below');  // 74.75
  assert.equal(calc.thresholdRelation(300, 400, 75), 'at');
  assert.equal(calc.thresholdRelation(301, 400, 75), 'above');
  assert.equal(calc.thresholdRelation(0, 0, 75), 'na');
  assert.ok(!calc.isBelow(3, 4, 75));           // AT threshold is NOT below (75% passes)
  assert.ok(calc.isBelow(299, 400, 75));
});

test('configurable threshold: 80 works without touching code', () => {
  assert.equal(calc.thresholdRelation(79, 100, 80), 'below');
  assert.equal(calc.thresholdRelation(80, 100, 80), 'at');
  assert.equal(calc.thresholdRelation(81, 100, 80), 'above');
});

test('holiday/cancelled never count; excused configurable', () => {
  const sid = 900001;
  const sub = 900001;
  db.prepare('INSERT INTO departments(id, name, code, created_at) VALUES (?,?,?,?)')
    .run(900001, 'D', 'D', new Date().toISOString());
  db.prepare('INSERT INTO sections(id, name, department_id, semester, created_at) VALUES (?,?,?,3,?)')
    .run(900001, 'A', 900001, new Date().toISOString());
  db.prepare(`INSERT INTO students(id, enrollment_no, roll_no, full_name, department_id, semester, section_id, status, created_at)
              VALUES (?,?,?,?,?,3,?,'active',?)`)
    .run(sid, `E-${sid}`, '1', 'Test Student', 900001, 900001, new Date().toISOString());
  db.prepare(`INSERT INTO subjects(id, code, name, department_id, semester, section_id, created_at)
              VALUES (?,?,?,?,3,?,?)`)
    .run(sub, 'T101', 'Test', 900001, 900001, new Date().toISOString());
  const ins = db.prepare(`INSERT INTO attendance_records(student_id, subject_id, date, period, status, source, created_at)
                          VALUES (?,?,?,1,?,'manual',?)`);
  // 3P 1A 1E 1H 1C  → applicable = 4 (or 5 with excused)
  for (const [i, st] of ['P', 'P', 'P', 'A', 'E', 'H', 'C'].entries()) ins.run(sid, sub, `2026-09-0${i + 1}`, st, new Date().toISOString());

  let s = calc.studentSubjectSummary(sid, sub, false);
  assert.equal(s.applicable, 4);
  assert.equal(s.pct_bp, 7500);
  assert.equal(s.holiday, 1);
  assert.equal(s.cancelled, 1);

  s = calc.studentSubjectSummary(sid, sub, true);
  assert.equal(s.applicable, 5);   // excused counted when configured
  assert.equal(s.pct_bp, 6000);

  const overall = calc.studentOverall(sid, false);
  assert.equal(overall.applicable, 4);
});
