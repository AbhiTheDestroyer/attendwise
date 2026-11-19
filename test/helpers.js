'use strict';
/** Test helpers: temp data dir + minimal org fixtures. */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REQUEST_LOG = 'false';
process.env.SIMULATE_NOTIFICATIONS = process.env.SIMULATE_NOTIFICATIONS ?? 'true';

function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-test-'));
  process.env.DATA_DIR = dir;
  process.env.DB_FILE = path.join(dir, 'test.db');
  return dir;
}

/** Call AFTER freshDataDir(), before requiring src modules. */
function makeFixtures(db, { hashPassword }) {
  const now = new Date().toISOString();
  const dept = db.prepare('INSERT INTO departments(name, code, created_at) VALUES (?,?,?)')
    .run('Computer Science', 'CSE', now).lastInsertRowid;
  const course = db.prepare('INSERT INTO courses(name, code, department_id, created_at) VALUES (?,?,?,?)')
    .run('B.Tech', 'BT', dept, now).lastInsertRowid;
  const section = db.prepare(`INSERT INTO sections(name, department_id, course_id, semester, batch, academic_year, created_at)
                              VALUES ('A',?,?,3,'2024','2026-27',?)`).run(dept, course, now).lastInsertRowid;
  const admin = db.prepare('INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)')
    .run('Admin', 'admin@test.dev', hashPassword('Admin@123'), 'admin', now).lastInsertRowid;
  const teacher = db.prepare('INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)')
    .run('Teacher One', 'teacher@test.dev', hashPassword('Teacher@123'), 'teacher', now).lastInsertRowid;
  const teacher2 = db.prepare('INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)')
    .run('Teacher Two', 'teacher2@test.dev', hashPassword('Teacher@123'), 'teacher', now).lastInsertRowid;
  const subject = db.prepare(`INSERT INTO subjects(code, name, department_id, semester, section_id, teacher_id, credits, created_at)
                              VALUES ('CS301','Data Structures',?,3,?,?,4,?)`).run(dept, section, teacher, now).lastInsertRowid;
  const subject2 = db.prepare(`INSERT INTO subjects(code, name, department_id, semester, section_id, teacher_id, credits, created_at)
                              VALUES ('CS302','DBMS',?,3,?,?,4,?)`).run(dept, section, teacher2, now).lastInsertRowid;
  return { dept, course, section, admin, teacher, teacher2, subject, subject2 };
}

function addStudent(db, { section, dept, roll, name, enrollment, status = 'active', dob = null, parent_email = 'parent@example.com', parent_phone = '9812345678', joined = null }) {
  return db.prepare(`INSERT INTO students(enrollment_no, roll_no, full_name, dob, department_id, semester, section_id,
      parent_name, parent_phone, parent_email, batch, joined_date, status, created_at)
    VALUES (?,?,?,?,?,3,?, 'Parent ' || ?, ?, ?, '2024', ?, ?, ?)`)
    .run(enrollment || `ENR-${roll}`, roll, name, dob, dept, section, name, parent_phone, parent_email, joined, status,
      new Date().toISOString()).lastInsertRowid;
}

function setAttend(db, studentId, subjectId, specs, userId = 1) {
  // specs: array of [date, status, period]
  const ins = db.prepare(`INSERT INTO attendance_records(student_id, subject_id, date, period, status, source, created_by, created_at)
                          VALUES (?,?,?,?,?,'manual',?,?)`);
  for (const [date, status, period = 1] of specs) {
    ins.run(studentId, subjectId, date, period, status, userId, new Date().toISOString());
  }
}

module.exports = { freshDataDir, makeFixtures, addStudent, setAttend };
