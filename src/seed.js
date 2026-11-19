'use strict';
/**
 * Demo seed data — clearly labeled (settings.demo_mode = 1).
 * Deterministic (mulberry32) so tests and demos are reproducible.
 *
 *   3 departments · 5 sections · 10 subjects · 6 users
 *   120 students across performance bands (90%+ … <60%)
 *   ~10 weeks of real attendance events incl. holiday/cancelled handling
 *   sample notification history consistent with notification_state
 */
const { db, withTx, setSetting } = require('./db');
const { hashPassword } = require('./auth');
const { nowIso, mulberry32, todayInTz } = require('./util');
const { DEFAULT_TEMPLATE } = require('./services/notify');
const calc = require('./services/calc');

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Kabir',
  'Ananya', 'Diya', 'Aadhya', 'Myra', 'Sara', 'Ira', 'Priya', 'Kavya', 'Anika', 'Navya',
  'Rahul', 'Aman', 'Ravi', 'Sneha', 'Pooja', 'Neha', 'Karan', 'Vishal', 'Meena', 'Tarun',
  'Harsh', 'Yash', 'Nikhil', 'Simran', 'Gauri', 'Lakshya', 'Manav', 'Tanvi', 'Ishita', 'Dev'];
const LAST = ['Sharma', 'Verma', 'Gupta', 'Mehta', 'Patel', 'Khan', 'Singh', 'Yadav', 'Joshi', 'Nair',
  'Iyer', 'Reddy', 'Das', 'Kumar', 'Chauhan', 'Mishra', 'Agarwal', 'Bansal', 'Pillai', 'Saxena',
  'Choudhary', 'Bhatt', 'Trivedi', 'Rathore', 'Kulkarni', 'Deshmukh', 'Pawar', 'Ghosh', 'Bose', 'Menon'];

function execSeed(force = false) {
  const rnd = mulberry32(20260930);
  const now = nowIso();
  const today = todayInTz('Asia/Kolkata');

  if (force) {
    withTx(() => {
      for (const t of ['notification_state', 'notification_events', 'import_rows', 'imports', 'attendance_audit',
        'attendance_records', 'students', 'subjects', 'sections', 'courses', 'departments',
        'sessions', 'password_resets', 'audit_logs', 'users']) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
    });
    console.log('[seed] existing data cleared (--force)');
  }
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) {
    console.log('[seed] database already populated — skipping');
    return;
  }

  withTx(() => {
    /* ------------------------------- settings ------------------------------ */
    const defaults = {
      institution_name: 'Greenfield Institute of Technology (Demo)',
      threshold: 75,
      academic_year: '2026-27',
      timezone: 'Asia/Kolkata',
      upload_max_mb: 5,
      count_excused_as_applicable: 0,
      notification_policy: 'first_crossing',
      notification_channels: JSON.stringify({ email: true, sms: true, whatsapp: true }),
      message_template: DEFAULT_TEMPLATE,
      demo_mode: 1,
    };
    for (const [k, v] of Object.entries(defaults)) setSetting(k, v);

    /* --------------------------------- users -------------------------------- */
    const insUser = db.prepare('INSERT INTO users(name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,1,?)');
    const adminId = insUser.run('Prof. Meera Nair', 'admin@git.edu', hashPassword('Admin@123'), 'admin', now).lastInsertRowid;
    const teacherDefs = [
      ['Dr. Anil Verma', 'anil.verma@git.edu'],
      ['Dr. Sunita Rao', 'sunita.rao@git.edu'],
      ['Prof. Rajesh Iyer', 'rajesh.iyer@git.edu'],
      ['Dr. Farah Khan', 'farah.khan@git.edu'],
      ['Prof. Vikram Singh', 'vikram.singh@git.edu'],
    ];
    const teacherIds = {};
    for (const [name, email] of teacherDefs) {
      teacherIds[email] = insUser.run(name, email, hashPassword('Teacher@123'), 'teacher', now).lastInsertRowid;
    }
    const tIds = Object.values(teacherIds);

    /* ---------------------------- org structure ----------------------------- */
    const insDept = db.prepare('INSERT INTO departments(name, code, created_at) VALUES (?,?,?)');
    const insCourse = db.prepare('INSERT INTO courses(name, code, department_id, duration_years, created_at) VALUES (?,?,?,4,?)');
    const insSection = db.prepare(`INSERT INTO sections(name, department_id, course_id, semester, batch, academic_year, created_at)
                                   VALUES (?,?,?,?,?,?,?)`);
    const depts = {
      CSE: insDept.run('Computer Science & Engineering', 'CSE', now).lastInsertRowid,
      ECE: insDept.run('Electronics & Communication Engineering', 'ECE', now).lastInsertRowid,
      CE: insDept.run('Civil Engineering', 'CE', now).lastInsertRowid,
    };
    const courses = {};
    for (const [code, id] of Object.entries(depts)) {
      courses[code] = insCourse.run('B.Tech', code, id, now).lastInsertRowid;
    }
    const secDef = [
      { key: 'CSE3A', dept: 'CSE', sem: 3, name: 'A', batch: '2024' },
      { key: 'CSE3B', dept: 'CSE', sem: 3, name: 'B', batch: '2024' },
      { key: 'CSE5A', dept: 'CSE', sem: 5, name: 'A', batch: '2022' },
      { key: 'ECE3A', dept: 'ECE', sem: 3, name: 'A', batch: '2024' },
      { key: 'CE3A', dept: 'CE', sem: 3, name: 'A', batch: '2024' },
    ];
    const sections = {};
    for (const s of secDef) {
      sections[s.key] = insSection.run(s.name, depts[s.dept], courses[s.dept], s.sem, s.batch, '2026-27', now).lastInsertRowid;
    }

    /* -------------------------------- subjects ------------------------------ */
    const insSubject = db.prepare(`INSERT INTO subjects(code, name, department_id, semester, section_id, teacher_id, credits, academic_year, created_at)
                                   VALUES (?,?,?,?,?,?,?,?,?)`);
    const todayWeekday = (() => {
      const d = new Date(today + 'T00:00:00Z');
      return (d.getUTCDay() + 6) % 7; // 0 = Monday
    })();
    const subDef = [
      { code: 'CS301', name: 'Data Structures', sec: 'CSE3A', t: 0, credits: 4 },
      { code: 'CS302', name: 'Database Management Systems', sec: 'CSE3A', t: 1, credits: 4 },
      { code: 'CS301', name: 'Data Structures', sec: 'CSE3B', t: 0, credits: 4 },
      { code: 'CS303', name: 'Operating Systems', sec: 'CSE3B', t: 2, credits: 4 },
      { code: 'CS501', name: 'Computer Networks', sec: 'CSE5A', t: 3, credits: 3 },
      { code: 'CS502', name: 'Machine Learning', sec: 'CSE5A', t: 4, credits: 3 },
      { code: 'EC301', name: 'Signals & Systems', sec: 'ECE3A', t: 1, credits: 4 },
      { code: 'EC302', name: 'Digital Electronics', sec: 'ECE3A', t: 2, credits: 3 },
      { code: 'CE301', name: 'Structural Analysis', sec: 'CE3A', t: 3, credits: 4 },
      { code: 'CE302', name: 'Fluid Mechanics', sec: 'CE3A', t: 4, credits: 3 },
    ];
    const subjects = [];
    subDef.forEach((s, i) => {
      const deptCode = s.sec.startsWith('CS') ? 'CSE' : s.sec.startsWith('EC') ? 'ECE' : 'CE';
      const semester = s.sec.includes('5') ? 5 : 3;
      const id = insSubject.run(s.code, s.name, depts[deptCode], semester, sections[s.sec],
        tIds[s.t], s.credits, '2026-27', now).lastInsertRowid;
      // class weekdays: first subjects class on today's weekday so the dashboard shows live data
      const d1 = i < 3 ? todayWeekday : (i * 2) % 6;
      const d2 = (d1 + 3) % 6;
      subjects.push({ id, ...s, sectionKey: s.sec, days: [d1, d2], period: (i % 4) + 1 });
    });

    /* -------------------------------- students ------------------------------ */
    const insStudent = db.prepare(`INSERT INTO students(enrollment_no, roll_no, full_name, dob, gender, department_id,
      course_id, semester, section_id, batch, email, phone, parent_name, parent_phone, parent_email,
      admission_year, joined_date, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const sizes = { CSE3A: 26, CSE3B: 24, CSE5A: 22, ECE3A: 24, CE3A: 24 };
    const students = [];
    const usedNames = new Set();
    for (const sec of secDef) {
      const n = sizes[sec.key];
      const batch = sec.batch;
      for (let roll = 1; roll <= n; roll++) {
        let full;
        do {
          full = `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`;
        } while (usedNames.has(full));
        usedNames.add(full);
        const deptCode = sec.dept;
        const enr = `${deptCode}${batch}${sec.name}-${String(roll).padStart(3, '0')}`;
        const gender = rnd() < 0.5 ? 'male' : 'female';
        const first = full.split(' ')[0].toLowerCase();
        const last = full.split(' ')[1].toLowerCase();
        const isInactive = rnd() < 0.03;
        const midJoiner = roll === n && rnd() < 0.8; // one mid-semester joiner per section
        const missingContact = rnd() < 0.06;
        const parentName = `${gender === 'female' ? 'Mr.' : rnd() < 0.5 ? 'Mr.' : 'Mrs.'} ${LAST[Math.floor(rnd() * LAST.length)]}`;
        const id = insStudent.run(
          enr, String(roll), full,
          `200${2 + Math.floor(rnd() * 5)}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`,
          gender, depts[sec.dept], courses[sec.dept], sec.sem, sections[sec.key], batch,
          rnd() < 0.9 ? `${first}.${last}${roll}@student.git.edu` : null,
          `98${String(Math.floor(10000000 + rnd() * 89999999))}`,
          parentName,
          missingContact && rnd() < 0.5 ? null : `98${String(Math.floor(10000000 + rnd() * 89999999))}`,
          missingContact ? null : `${first}.parent${roll}@gmail.com`,
          Number(batch) + (sec.sem >= 5 ? 2 : 0),
          midJoiner ? '2026-08-24' : '2026-07-21',
          isInactive ? 'inactive' : 'active', now,
        ).lastInsertRowid;
        // performance band → drives realistic attendance patterns
        const bandRoll = rnd();
        const p = bandRoll < 0.20 ? 0.97 : bandRoll < 0.40 ? 0.88 : bandRoll < 0.55 ? 0.80
          : bandRoll < 0.70 ? 0.72 : bandRoll < 0.85 ? 0.64 : 0.52;
        students.push({ id, sectionKey: sec.key, roll: String(roll), name: full, p, active: !isInactive, joined: midJoiner ? '2026-08-24' : '2026-07-21', enrollment: enr });
      }
    }

    /* ------------------------------- attendance ----------------------------- */
    const insAtt = db.prepare(`INSERT INTO attendance_records(student_id, subject_id, date, period, status, source, created_by, created_at)
                               VALUES (?,?,?,?,?,?,?,?)`);
    const HOLIDAYS = new Set(['2026-08-15']); // Independence Day
    const CANCELLED = new Set(['CS301|2026-09-08', 'EC301|2026-09-08']); // demo cancelled classes
    const termStart = new Date('2026-07-20T00:00:00Z');
    const termEnd = new Date(today + 'T00:00:00Z');
    let recordCount = 0;
    for (let d = new Date(termStart); d <= termEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const weekday = (d.getUTCDay() + 6) % 7;
      for (const sub of subjects) {
        if (!sub.days.includes(weekday)) continue;
        const sectionStudents = students.filter((s) => s.sectionKey === sub.sectionKey);
        for (const st of sectionStudents) {
          if (!st.active && iso > '2026-09-10') continue; // stopped attending after leaving
          if (st.joined > iso) continue; // joined mid-semester
          let status;
          if (HOLIDAYS.has(iso)) status = 'H';
          else if (CANCELLED.has(`${sub.code}|${iso}`)) status = 'C';
          else {
            const roll = rnd();
            status = roll < st.p ? 'P' : 'A';
            if (status === 'P' && rnd() < 0.02) status = 'E';
          }
          insAtt.run(st.id, sub.id, iso, sub.period, status, 'import', tIds[sub.t], now);
          recordCount++;
        }
      }
    }
    console.log(`[seed] attendance_records: ${recordCount}`);

    // keep subjects.total_classes in sync for display purposes
    for (const sub of subjects) {
      const c = db.prepare(`SELECT COUNT(DISTINCT date || '-' || period) c FROM attendance_records
                            WHERE subject_id = ? AND status NOT IN ('H','C')`).get(sub.id).c;
      db.prepare('UPDATE subjects SET total_classes = ? WHERE id = ?').run(c, sub.id);
    }

    /* ---------------------- notification history + state --------------------- */
    // compute who is below 75 right now and write a believable history
    const belowPairs = db.prepare(`
      SELECT a.student_id, a.subject_id,
        SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
        SUM(CASE WHEN a.status IN ('P','A') THEN 1 ELSE 0 END) applicable
      FROM attendance_records a JOIN students s ON s.id = a.student_id AND s.status='active'
      GROUP BY a.student_id, a.subject_id
      HAVING applicable > 0 AND present * 100 < 75 * applicable
      LIMIT 60`).all();
    const insEvent = db.prepare(`INSERT INTO notification_events(student_id, subject_id, channel, recipient, message,
      attendance_bp, type, status, provider, provider_response, error, rule, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insState = db.prepare(`INSERT INTO notification_state(student_id, subject_id, below, last_pct_bp, crossing_notified,
      last_notified_at, last_attempt_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
    const getStu = db.prepare('SELECT * FROM students WHERE id = ?');
    const getSub = db.prepare('SELECT * FROM subjects WHERE id = ?');
    belowPairs.forEach((pair, i) => {
      const stu = getStu.get(pair.student_id);
      const sub = getSub.get(pair.subject_id);
      const bp = calc.pctBp(pair.present, pair.applicable);
      const hasEvent = i < 14;
      let eventAt = null;
      if (hasEvent && stu) {
        const daysAgo = 1 + Math.floor(rnd() * 13);
        eventAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
        const channel = i % 5 === 4 ? 'sms' : 'email';
        const recipient = channel === 'email' ? stu.parent_email : stu.parent_phone;
        const st = !recipient ? 'skipped' : i % 6 === 5 ? 'failed' : i % 7 === 6 ? 'delivered' : 'sent';
        const msg = `Dear Parent/Guardian,\n\nThis is to inform you that your ward ${stu.full_name}, Roll No. ${stu.roll_no}, currently has an attendance of ${calc.fmtPct(bp)} in ${sub.name} (${sub.code}) (${pair.present}/${pair.applicable} classes attended).\n\nThe minimum required attendance is 75%.\n\nPlease take the necessary action.\n\nRegards,\nGreenfield Institute of Technology (Demo)`;
        insEvent.run(
          pair.student_id, pair.subject_id, channel, recipient || null, recipient ? msg : null,
          bp, 'threshold', st, st === 'skipped' ? null : 'log',
          st === 'skipped' ? null : JSON.stringify({ simulated: true, sink: 'notifications.log', status: 200 }),
          st === 'skipped' ? 'no_parent_contact' : st === 'failed' ? 'provider_http_502' : null,
          'first_crossing', adminId, eventAt,
        );
      }
      insState.run(
        pair.student_id, pair.subject_id, 1, bp, hasEvent || !stu?.parent_email ? 1 : 0,
        eventAt, eventAt, now,
      );
    });

    auditSeed(adminId);
    console.log('[seed] complete:');
    console.log('       departments=3 sections=5 subjects=10 students=' + students.length);
    console.log('       users: admin@git.edu / Admin@123  ·  anil.verma@git.edu (+4 teachers) / Teacher@123');
  });
}

function auditSeed(adminId) {
  db.prepare(`INSERT INTO audit_logs(user_id, action, entity, entity_id, new_value, created_at)
              VALUES (?,?,?,?,?,?)`)
    .run(adminId, 'seed.completed', 'system', null, JSON.stringify({ demo: true }), nowIso());
}

/* Standalone: npm run seed / node src/seed.js --reset */
if (require.main === module) {
  const reset = process.argv.includes('--reset') || process.argv.includes('--force');
  execSeed(reset);
}

module.exports = { execSeed };
