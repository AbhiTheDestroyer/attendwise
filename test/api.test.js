'use strict';
/**
 * End-to-end API tests (§43, §51):
 * login → take attendance → upload sheet → review/resolve → confirm →
 * defaulters → notifications → edit-with-reason → audit → reports → RBAC.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir, makeFixtures, addStudent, setAttend } = require('./helpers');
freshDataDir();
process.env.SIMULATE_NOTIFICATIONS = 'true';

const { createServer } = require('../src/app');
const { db } = require('../src/db');

let server;
let base;
const fx = (() => {
  const { hashPassword } = require('../src/auth');
  return makeFixtures(db, { hashPassword });
})();

const students = {};
function iso(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

test.before(async () => {
  students.rahul = addStudent(db, { section: fx.section, dept: fx.dept, roll: '1', name: 'Rahul Verma' });
  students.sneha = addStudent(db, { section: fx.section, dept: fx.dept, roll: '2', name: 'Sneha Patel' });
  students.abhishekK = addStudent(db, { section: fx.section, dept: fx.dept, roll: '21', name: 'Abhishek Kumar' });
  students.abhishekS = addStudent(db, { section: fx.section, dept: fx.dept, roll: '27', name: 'Abhishek Sharma' });
  students.at75 = addStudent(db, { section: fx.section, dept: fx.dept, roll: '31', name: 'Exactly SeventyFive', parent_email: 'p31@example.com' });
  students.at50 = addStudent(db, { section: fx.section, dept: fx.dept, roll: '32', name: 'Half Present', parent_email: 'p32@example.com' });
  // 3 of 4 → exactly at 75% (must NOT be a defaulter); 2 of 7 ≈ 28.6% (must be + critical band)
  setAttend(db, students.at75, fx.subject, [[iso(8), 'P'], [iso(7), 'P'], [iso(6), 'P'], [iso(5), 'A'], [iso(4), 'H']]);
  setAttend(db, students.at50, fx.subject, [[iso(8), 'P'], [iso(7), 'P'], [iso(6), 'A'], [iso(5), 'A'], [iso(4), 'A'], [iso(3), 'A'], [iso(2), 'A']]);
  server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((res) => server.close(res)));

/* ------------------------------- http helpers ------------------------------ */
function client() {
  let cookie = '';
  let csrf = '';
  return {
    get csrf() { return csrf; },
    async req(method, path, { body, headers = {}, rawBody, contentType } = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(contentType ? { 'Content-Type': contentType } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
          ...headers,
        },
        body: rawBody || (body ? JSON.stringify(body) : undefined),
        redirect: 'manual',
      });
      const setC = res.headers.get('set-cookie');
      if (setC && setC.includes('ams_session=')) cookie = setC.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* csv etc. */ }
      return { status: res.status, json, text, headers: res.headers };
    },
    async login(email, password) {
      const r = await this.req('POST', '/api/auth/login', { body: { email, password } });
      if (r.status === 200) csrf = r.json.csrf;
      return r;
    },
  };
}
function multipart(fields, file) {
  const b = '----ams' + Math.random().toString(36).slice(2);
  let head = '';
  for (const [k, v] of Object.entries(fields)) head += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  head += `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head), Buffer.from(file.content), Buffer.from(`\r\n--${b}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${b}`,
  };
}

/* --------------------------------- tests ----------------------------------- */
test('auth: bad password 401, good login 200, /me works, unauth blocked', async () => {
  const c = client();
  assert.equal((await c.req('GET', '/api/students')).status, 401);
  assert.equal((await c.login('admin@test.dev', 'wrongpass')).status, 401);
  const ok = await c.login('admin@test.dev', 'Admin@123');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'admin');
  const me = await c.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.settings.threshold, 75);
});

test('students: create, duplicate rejected, RBAC blocks teacher', async () => {
  const admin = client();
  await admin.login('admin@test.dev', 'Admin@123');
  const created = await admin.req('POST', '/api/students', {
    body: {
      enrollment_no: 'NEW-001', roll_no: '40', full_name: 'New Student',
      department_id: fx.dept, semester: 3, section_id: fx.section,
      parent_name: 'Parent', parent_email: 'p@example.com',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const dup = await admin.req('POST', '/api/students', {
    body: {
      enrollment_no: 'NEW-001', roll_no: '41', full_name: 'Duplicate',
      department_id: fx.dept, semester: 3, section_id: fx.section,
    },
  });
  assert.equal(dup.status, 409);

  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  const forbidden = await teacher.req('POST', '/api/students', {
    body: { enrollment_no: 'X-1', roll_no: '99', full_name: 'Nope', department_id: fx.dept, semester: 3, section_id: fx.section },
  });
  assert.equal(forbidden.status, 403, 'teachers must not create students');
});

test('manual attendance: roster → bulk take → idempotent re-save → audited change', async () => {
  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  const date = iso(9);
  const roster = await teacher.req('GET', `/api/attendance/roster?subject_id=${fx.subject}&date=${date}&period=2`);
  assert.equal(roster.status, 200);
  assert.ok(roster.json.students.length >= 6);

  const entries = roster.json.students.map((s) => ({ student_id: s.id, status: s.id === students.rahul ? 'A' : 'P' }));
  const save = await teacher.req('POST', '/api/attendance/bulk', {
    body: { subject_id: fx.subject, date, period: 2, entries },
  });
  assert.equal(save.status, 200, JSON.stringify(save.json));
  assert.ok(save.json.created >= 6);

  // identical re-save is a no-op, not an error
  const again = await teacher.req('POST', '/api/attendance/bulk', {
    body: { subject_id: fx.subject, date, period: 2, entries },
  });
  assert.equal(again.json.unchanged, entries.length);
  assert.equal(again.json.created, 0);

  // change one status → updated + change history row
  const flip = await teacher.req('POST', '/api/attendance/bulk', {
    body: {
      subject_id: fx.subject, date, period: 2,
      entries: [{ student_id: students.rahul, status: 'P', reason: 'Medical document submitted' }],
    },
  });
  assert.equal(flip.json.updated, 1);
  const hist = db.prepare(`SELECT * FROM attendance_audit WHERE student_id = ? AND date = ? AND period = 2`)
    .get(students.rahul, date);
  assert.equal(hist.old_status, 'A');
  assert.equal(hist.new_status, 'P');
  assert.match(hist.reason, /Medical/);
});

test('future dates and cross-subject writes are rejected', async () => {
  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const r = await teacher.req('POST', '/api/attendance/bulk', {
    body: { subject_id: fx.subject, date: future, period: 1, entries: [{ student_id: students.rahul, status: 'P' }] },
  });
  assert.equal(r.status, 400);
  // teacher2 is not assigned to teacher's subject
  const t2 = client();
  await t2.login('teacher2@test.dev', 'Teacher@123');
  const r2 = await t2.req('POST', '/api/attendance/bulk', {
    body: { subject_id: fx.subject, date: iso(3), period: 1, entries: [{ student_id: students.rahul, status: 'P' }] },
  });
  assert.equal(r2.status, 403);
});

test('import pipeline: parse → validate → resolve → confirm (transactional)', async () => {
  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  const csv = [
    'Roll No,Name,01/09,03/09',
    '1,Rahul Verma,P,P',
    '2,Sneha Patel,A,P',
    '999,Ghost Person,P,P',
    ',Abhishek Kr.,P,A',
    '1,Rahul Verma,Z,P',   // invalid status on first date, dup roll
    '',
  ].join('\n');
  const { body, contentType } = multipart(
    { subject_id: String(fx.subject), period: '4' },
    { name: 'attendance.csv', content: csv },
  );
  const up = await teacher.req('POST', '/api/attendance/import', { rawBody: body, contentType });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const s = up.json.summary;
  assert.equal(s.format, 'matrix');
  assert.equal(s.unmatched, 2);        // roll 999 rows (both dates)
  assert.ok(s.possible >= 1);          // "Abhishek Kr."
  assert.equal(s.invalid_status, 1);   // "Z"
  assert.ok(s.matched >= 2);

  const impId = up.json.import_id;
  const detail = await teacher.req('GET', `/api/attendance/import/${impId}`);
  assert.equal(detail.status, 200);
  const rows = detail.json.rows;
  const possibleRow = rows.find((r) => r.match_status === 'possible');
  assert.ok(possibleRow.match_candidates.some((c) => c.full_name === 'Abhishek Kumar'));

  // teacher resolves the ambiguous row manually
  const fix = await teacher.req('PUT', `/api/attendance/import/${impId}/rows/${possibleRow.id}`, {
    body: { student_id: students.abhishekK },
  });
  assert.equal(fix.status, 200);

  // confirm blocked while the "Z" row is unresolved…
  const blocked = await teacher.req('POST', `/api/attendance/import/${impId}/confirm`, { body: {} });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error.message, /unresolved|errors|review/i);

  // …import only valid rows with force
  const conf = await teacher.req('POST', `/api/attendance/import/${impId}/confirm`, { body: { force: true, conflict_policy: 'skip' } });
  assert.equal(conf.status, 200, JSON.stringify(conf.json));
  assert.ok(conf.json.inserted >= 5, `inserted ${conf.json.inserted}`);

  // a second confirm is locked
  const again = await teacher.req('POST', `/api/attendance/import/${impId}/confirm`, { body: { force: true } });
  assert.equal(again.status, 409);

  // verify real records landed with period 4 on 2026-09-01
  const rec = db.prepare(`SELECT status FROM attendance_records WHERE student_id = ? AND subject_id = ? AND date = '2026-09-01' AND period = 4`)
    .get(students.abhishekK, fx.subject);
  assert.equal(rec.status, 'P');
});

test('conflict policy: skip preserves existing; replace overwrites + audits', async () => {
  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  // existing: rahul present on 2026-09-01 period 4 (from previous import)
  const csv = ['Roll No,Name,01/09', '1,Rahul Verma,A'].join('\n');
  const { body, contentType } = multipart(
    { subject_id: String(fx.subject), period: '4' },
    { name: 'correction.csv', content: csv },
  );
  const up = await teacher.req('POST', '/api/attendance/import', { rawBody: body, contentType });
  assert.equal(up.json.summary.conflicts, 1, 'conflict must be detected, never silently overwritten');
  const impId = up.json.import_id;

  const skip = await teacher.req('POST', `/api/attendance/import/${impId}/confirm`, { body: { conflict_policy: 'skip' } });
  assert.equal(skip.json.skipped_conflict, 1);
  assert.equal(db.prepare(`SELECT status FROM attendance_records WHERE student_id=? AND subject_id=? AND date='2026-09-01' AND period=4`)
    .get(students.rahul, fx.subject).status, 'P');

  // re-import with replace
  const up2 = await teacher.req('POST', '/api/attendance/import', { rawBody: body, contentType });
  const rep = await teacher.req('POST', `/api/attendance/import/${up2.json.import_id}/confirm`, { body: { conflict_policy: 'replace' } });
  assert.equal(rep.json.replaced, 1);
  assert.equal(db.prepare(`SELECT status FROM attendance_records WHERE student_id=? AND subject_id=? AND date='2026-09-01' AND period=4`)
    .get(students.rahul, fx.subject).status, 'A');
  const hist = db.prepare(`SELECT * FROM attendance_audit WHERE student_id=? AND subject_id=? AND date='2026-09-01' AND period=4 ORDER BY id DESC`)
    .get(students.rahul, fx.subject);
  assert.equal(hist.old_status, 'P');
  assert.equal(hist.new_status, 'A');
  assert.match(hist.reason, /Import #/);
});

test('defaulters: 75.0% exact is NOT below; 50% is; bands filter', async () => {
  const admin = client();
  await admin.login('admin@test.dev', 'Admin@123');
  const all = await admin.req('GET', '/api/attendance/defaulters?page_size=200');
  const ids = all.json.rows.map((r) => r.student_id);
  assert.ok(!ids.includes(students.at75), '3/4 = exactly 75% must NOT be flagged');
  assert.ok(ids.includes(students.at50), '2/4 = 50% must be flagged');
  const crit = await admin.req('GET', '/api/attendance/defaulters?band=critical&page_size=200');
  assert.ok(crit.json.rows.map((r) => r.student_id).includes(students.at50));
});

test('manual notification send: validates threshold + contact, records truth', async () => {
  const admin = client();
  await admin.login('admin@test.dev', 'Admin@123');
  const send = await admin.req('POST', '/api/notifications/send', {
    body: { channel: 'email', items: [{ student_id: students.at50, subject_id: fx.subject }, { student_id: students.at75, subject_id: fx.subject }] },
  });
  assert.equal(send.status, 200);
  assert.equal(send.json.summary.sent, 1);   // 50% student
  assert.equal(send.json.summary.skipped, 1); // 75% student is not below
  const at75res = send.json.results.find((r) => r.student_id === students.at75);
  assert.equal(at75res.error, 'not_below_threshold');

  const history = await admin.req('GET', `/api/notifications?student_id=${students.at50}`);
  assert.equal(history.json.rows[0].status, 'sent');
  assert.match(history.json.rows[0].message, /Half Present/);
});

test('edit single record with reason → full audit trail', async () => {
  const admin = client();
  await admin.login('admin@test.dev', 'Admin@123');
  const list = await admin.req('GET', `/api/attendance?student_id=${students.at50}&subject_id=${fx.subject}`);
  const rec = list.json.rows.find((r) => r.status === 'A');
  const edit = await admin.req('PUT', `/api/attendance/${rec.id}`, {
    body: { status: 'E', reason: 'Sports meet — dean approved' },
  });
  assert.equal(edit.status, 200);
  const hist = db.prepare('SELECT * FROM attendance_audit WHERE record_id = ? ORDER BY id DESC').get(rec.id);
  assert.equal(hist.new_status, 'E');
  assert.match(hist.reason, /Sports meet/);
  const logs = await admin.req('GET', '/api/audit-logs?action=attendance.modified');
  assert.ok(logs.json.total >= 1);
  // teacher cannot read audit logs
  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  assert.equal((await teacher.req('GET', '/api/audit-logs')).status, 403);
});

test('reports + search + dashboard respond with real data', async () => {
  const admin = client();
  await admin.login('admin@test.dev', 'Admin@123');
  const csv = await admin.req('GET', '/api/reports/student-summary');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /csv|spreadsheet/);
  assert.match(csv.text, /Roll No/);
  assert.match(csv.text, /Exactly SeventyFive/);

  const xlsx = await admin.req('GET', '/api/reports/defaulters?format=xlsx');
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);

  const search = await admin.req('GET', '/api/search?q=abhishek');
  assert.equal(search.status, 200);
  assert.equal(search.json.students.length, 2);

  const dash = await admin.req('GET', '/api/dashboard');
  assert.equal(dash.status, 200);
  assert.ok(dash.json.cards.students >= 6);
});

test('upload security: wrong magic / oversize / unsupported types rejected', async () => {
  const teacher = client();
  await teacher.login('teacher@test.dev', 'Teacher@123');
  const fakeXlsx = multipart(
    { subject_id: String(fx.subject), period: '9' },
    { name: 'evil.xlsx', content: 'MZ this is not a zip' },
  );
  const r1 = await teacher.req('POST', '/api/attendance/import', { rawBody: fakeXlsx.body, contentType: fakeXlsx.contentType });
  assert.equal(r1.status, 400);

  const pdf = multipart({ subject_id: String(fx.subject), period: '9' }, { name: 'scan.pdf', content: '%PDF-1.4 fake' });
  const r2 = await teacher.req('POST', '/api/attendance/import', { rawBody: pdf.body, contentType: pdf.contentType });
  assert.equal(r2.status, 415); // honest: no OCR pipeline, not fake-processed

  const bin = multipart({ subject_id: String(fx.subject), period: '9' },
    { name: 'x.csv', content: Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x63, 0x2c, 0x64, 0x00, 0x00]) });
  const r3 = await teacher.req('POST', '/api/attendance/import', { rawBody: bin.body, contentType: bin.contentType });
  assert.equal(r3.status, 400);
});
