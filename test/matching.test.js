'use strict';
/** Student matching tests (§9): exact roll → enrollment → name → careful fuzzy. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir, makeFixtures, addStudent } = require('./helpers');
freshDataDir();
const { db } = require('../src/db');
const { matchStudent } = require('../src/services/matching');

const fx = (() => {
  const { hashPassword } = require('../src/auth');
  return makeFixtures(db, { hashPassword });
})();
const S = (roll, name, enr) => addStudent(db, { section: fx.section, dept: fx.dept, roll, name, enrollment: enr });

const abhishekKumar = S('21', 'Abhishek Kumar', 'CSE2024A-021');
S('27', 'Abhishek Sharma', 'CSE2024A-027');
S('1', 'Rahul Verma', 'CSE2024A-001');
S('2', 'Sneha Patel', 'CSE2024A-002');
S('3', 'Wei Chen', 'CSE2024A-003');

test('roll number match wins (case/space-insensitive)', () => {
  const m = matchStudent({ rollNo: ' 21 ', name: null, sectionId: fx.section });
  assert.equal(m.status, 'matched');
  assert.equal(m.student.id, abhishekKumar);
  assert.equal(m.via, 'roll_no');
});

test('enrollment number typed into the roll column also matches', () => {
  const m = matchStudent({ rollNo: 'cse2024a-001', name: null, sectionId: fx.section });
  assert.equal(m.status, 'matched');
  assert.equal(m.student.full_name, 'Rahul Verma');
});

test('exact unique name matches; case and punctuation ignored', () => {
  const m = matchStudent({ rollNo: null, name: 'rahul verma', sectionId: fx.section });
  assert.equal(m.status, 'matched');
  assert.equal(m.student.roll_no, '1');
});

test('"Abhishek Kr." is NEVER auto-assigned — candidates offered (§9 example)', () => {
  const m = matchStudent({ rollNo: null, name: 'Abhishek Kr.', sectionId: fx.section });
  assert.equal(m.status, 'possible');
  const names = m.candidates.map((c) => c.full_name);
  assert.ok(names.some((n) => n.startsWith('Abhishek')), `candidates: ${names}`);
  assert.ok(m.candidates.length >= 2, 'both Abhisheks offered');
});

test('unknown student returns none, never a guess', () => {
  const m = matchStudent({ rollNo: '999', name: 'Zzyzx Qwerton', sectionId: fx.section });
  assert.equal(m.status, 'none');
});

test('matching is scoped to the subject section', () => {
  const other = matchStudent({ rollNo: '21', sectionId: 999999 });
  assert.equal(other.status, 'none'); // section filter applies
});
