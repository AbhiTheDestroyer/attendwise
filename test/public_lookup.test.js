'use strict';
/**
 * Public lookup endpoint tests (§privacy):
 *  - happy path: enrollment + DOB → attendance payload (same math as staff views)
 *  - wrong DOB, wrong enrollment → IDENTICAL generic error (no oracle leakage)
 *  - payload contains no parent contact data / no internal ids
 *  - hard rate limit: 5 attempts / 10 min / IP → 429
 * (Runs in its own node:test process, so the in-memory rate limiter is private
 *  to this file — tests order matters within the file.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir, makeFixtures, addStudent, setAttend } = require('./helpers');
freshDataDir();

const { createServer } = require('../src/app');
const { db } = require('../src/db');

const fx = (() => {
  const { hashPassword } = require('../src/auth');
  return makeFixtures(db, { hashPassword });
})();

let server, base, studentId;
const DOB = '2004-05-17';

function iso(daysAgo) { return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10); }

async function lookup(body) {
  const r = await fetch(`${base}/api/public/lookup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

test.before(async () => {
  studentId = addStudent(db, { section: fx.section, dept: fx.dept, roll: '41', name: 'Public Check', enrollment: 'TEST-LOOKUP-001', dob: DOB });
  // 3 present, 1 absent → 75% exact boundary, plus one Holiday (excluded from applicable)
  setAttend(db, studentId, fx.subject, [[iso(8), 'P'], [iso(7), 'P'], [iso(6), 'P'], [iso(5), 'A'], [iso(4), 'H']]);
  server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((res) => server.close(res)));

test('happy path: enrollment + dob returns attendance (attempt #1)', async () => {
  const { status, data } = await lookup({ enrollment_no: 'TEST-LOOKUP-001', dob: DOB });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.student.name, 'Public Check');
  assert.equal(data.student.enrollment_no, 'TEST-LOOKUP-001');
  // same math as teacher dashboard: 3/4 = 75.00%, boundary exact
  assert.equal(data.overall.present, 3);
  assert.equal(data.overall.absent, 1);
  assert.equal(data.overall.applicable, 4);
  assert.equal(data.overall.pct_bp, 7500);
  assert.ok(Array.isArray(data.by_subject) && data.by_subject.length === 1);
  assert.equal(typeof data.threshold, 'number');
  // privacy: no parent contact / no internal student id
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes('parent@example.com'));
  assert.ok(!raw.includes('9812345678'));
  assert.equal(data.student.id, undefined);
  // case-insensitive enrollment
  const r2 = await lookup({ enrollment_no: 'test-lookup-001', dob: DOB }); // attempt #2
  assert.equal(r2.status, 200);
});

test('wrong dob gives the SAME message as wrong enrollment (attempts #3, #4)', async () => {
  const wrongDob = await lookup({ enrollment_no: 'TEST-LOOKUP-001', dob: '1990-01-01' });
  const wrongEnr = await lookup({ enrollment_no: 'NO-SUCH-ENR', dob: DOB });
  assert.equal(wrongDob.status, 404);
  assert.equal(wrongEnr.status, 404);
  assert.equal(wrongDob.data.error.code, 'no_match');
  assert.equal(wrongEnr.data.error.code, 'no_match');
  assert.equal(wrongDob.data.error.message, wrongEnr.data.error.message,
    'mismatch of either field must return the identical message (no oracle)');
});

test('rate limit: attempt #5 allowed, #6 blocked 429', async () => {
  const five = await lookup({ enrollment_no: 'x', dob: '1999-01-01' });
  assert.equal(five.status, 404); // still within budget (attempt #5)
  const six = await lookup({ enrollment_no: 'TEST-LOOKUP-001', dob: DOB });
  assert.equal(six.status, 429);
  assert.equal(six.data.error.code, 'too_many_attempts');
});
