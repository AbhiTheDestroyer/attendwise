'use strict';
/** Student management: CRUD, search/filter, soft delete, bulk CSV import/export. */
const { db, withTx, getSetting } = require('../db');
const {
  ApiError, reqStr, optStr, optEmail, reqInt, optInt, reqEnum, optDate,
  nowIso, pageParams, parseCSV, toCSV,
} = require('../util');
const { audit } = require('../audit');
const calc = require('../services/calc');
const { sendJson } = require('../router');

const SORTABLE = { full_name: 'full_name', roll_no: 'roll_no', enrollment_no: 'enrollment_no', created_at: 'created_at' };

function studentFilters(query) {
  const where = ['s.deleted_at IS NULL'];
  const args = [];
  if (query.q) {
    where.push(`(s.full_name LIKE ? OR s.roll_no LIKE ? OR s.enrollment_no LIKE ? OR s.parent_name LIKE ?)`);
    const like = `%${query.q}%`;
    args.push(like, like, like, like);
  }
  if (query.department_id) { where.push('s.department_id = ?'); args.push(Number(query.department_id)); }
  if (query.semester) { where.push('s.semester = ?'); args.push(Number(query.semester)); }
  if (query.section_id) { where.push('s.section_id = ?'); args.push(Number(query.section_id)); }
  if (query.batch) { where.push('s.batch = ?'); args.push(query.batch); }
  if (query.status) {
    where.push('s.status = ?');
    args.push(reqEnum(query.status, 'status', ['active', 'inactive', 'graduated', 'transferred']));
  }
  return { where: where.join(' AND '), args };
}

function readStudentBody(body, existing = {}) {
  const out = {};
  out.enrollment_no = reqStr(body.enrollment_no ?? existing.enrollment_no, 'enrollment_no', { max: 40 });
  out.roll_no = reqStr(body.roll_no ?? existing.roll_no, 'roll_no', { max: 20 });
  out.full_name = reqStr(body.full_name ?? existing.full_name, 'full_name', { max: 120 });
  out.dob = optDate(body.dob ?? existing.dob, 'dob');
  out.gender = body.gender !== undefined || existing.gender !== undefined
    ? (body.gender === null || body.gender === '' ? null : reqEnum(body.gender ?? existing.gender, 'gender', ['male', 'female', 'other']))
    : null;
  out.department_id = reqInt(body.department_id ?? existing.department_id, 'department_id', { min: 1 });
  out.course_id = optInt(body.course_id ?? existing.course_id, 'course_id', { min: 1 });
  out.semester = reqInt(body.semester ?? existing.semester, 'semester', { min: 1, max: 12 });
  out.section_id = reqInt(body.section_id ?? existing.section_id, 'section_id', { min: 1 });
  out.batch = optStr(body.batch ?? existing.batch, 'batch', { max: 20 });
  out.email = optEmail(body.email ?? existing.email, 'email');
  out.phone = optStr(body.phone ?? existing.phone, 'phone', { max: 25 });
  out.parent_name = optStr(body.parent_name ?? existing.parent_name, 'parent_name', { max: 120 });
  out.parent_phone = optStr(body.parent_phone ?? existing.parent_phone, 'parent_phone', { max: 25 });
  out.parent_email = optEmail(body.parent_email ?? existing.parent_email, 'parent_email');
  out.admission_year = optInt(body.admission_year ?? existing.admission_year, 'admission_year', { min: 1950, max: 2100 });
  out.joined_date = optDate(body.joined_date ?? existing.joined_date, 'joined_date');
  out.status = body.status !== undefined || existing.status !== undefined
    ? reqEnum(body.status ?? existing.status ?? 'active', 'status', ['active', 'inactive', 'graduated', 'transferred'])
    : 'active';
  // referential validation with actionable errors
  if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(out.department_id)) {
    throw new ApiError(400, 'bad_request', `Department ${out.department_id} does not exist`);
  }
  const sec = db.prepare('SELECT * FROM sections WHERE id = ?').get(out.section_id);
  if (!sec) throw new ApiError(400, 'bad_request', `Section ${out.section_id} does not exist`);
  if (sec.department_id !== out.department_id) {
    throw new ApiError(400, 'bad_request', `Section ${sec.name} belongs to a different department`);
  }
  if (out.course_id && !db.prepare('SELECT id FROM courses WHERE id = ?').get(out.course_id)) {
    throw new ApiError(400, 'bad_request', `Course ${out.course_id} does not exist`);
  }
  const dupRoll = db.prepare('SELECT id FROM students WHERE section_id = ? AND roll_no = ? AND id != ?')
    .get(out.section_id, out.roll_no, existing.id || 0);
  if (dupRoll) throw new ApiError(409, 'duplicate', `Roll No ${out.roll_no} is already used in this section`);
  return out;
}

module.exports = function register(r) {
  r.get('/api/students', async (ctx) => {
    const { page, size, offset } = pageParams(ctx.query, 25, 200);
    const { where, args } = studentFilters(ctx.query);
    const sortCol = SORTABLE[ctx.query.sort] || 'full_name';
    const order = ctx.query.order === 'desc' ? 'DESC' : 'ASC';
    const total = db.prepare(`SELECT COUNT(*) c FROM students s WHERE ${where}`).get(...args).c;
    const rows = db.prepare(`
      SELECT s.id, s.enrollment_no, s.roll_no, s.full_name, s.semester, s.batch, s.status, s.email,
             s.parent_name, s.parent_phone, s.parent_email,
             d.name AS department_name, sec.name AS section_name
      FROM students s
      JOIN departments d ON d.id = s.department_id
      JOIN sections sec ON sec.id = s.section_id
      WHERE ${where}
      ORDER BY s.${sortCol} ${order} LIMIT ? OFFSET ?`).all(...args, size, offset);
    ctx.json(200, { rows, total, page, size });
  });

  r.post('/api/students', async (ctx) => {
    const data = readStudentBody(ctx.body);
    if (db.prepare('SELECT id FROM students WHERE enrollment_no = ?').get(data.enrollment_no)) {
      throw new ApiError(409, 'duplicate', `Enrollment number ${data.enrollment_no} already exists`);
    }
    const info = db.prepare(`
      INSERT INTO students(enrollment_no, roll_no, full_name, dob, gender, department_id, course_id,
        semester, section_id, batch, email, phone, parent_name, parent_phone, parent_email,
        admission_year, joined_date, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(data.enrollment_no, data.roll_no, data.full_name, data.dob, data.gender, data.department_id,
        data.course_id, data.semester, data.section_id, data.batch, data.email, data.phone,
        data.parent_name, data.parent_phone, data.parent_email, data.admission_year,
        data.joined_date, data.status, nowIso());
    audit({ userId: ctx.user.id, action: 'student.created', entity: 'students', entityId: info.lastInsertRowid, newValue: data, req: ctx.req });
    ctx.json(201, { id: info.lastInsertRowid });
  });

  r.get('/api/students/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const s = db.prepare(`
      SELECT s.*, d.name AS department_name, sec.name AS section_name, c.name AS course_name
      FROM students s
      JOIN departments d ON d.id = s.department_id
      JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN courses c ON c.id = s.course_id
      WHERE s.id = ? AND s.deleted_at IS NULL`).get(id);
    if (!s) throw new ApiError(404, 'not_found', 'Student not found');
    const countExcused = getSetting('count_excused_as_applicable', '0') === '1';
    const overall = calc.studentOverall(id, countExcused);
    const bySubject = calc.studentBySubject(id, countExcused);
    const recent = db.prepare(`
      SELECT a.id, a.date, a.period, a.status, a.source, a.updated_at, sb.code AS subject_code, sb.name AS subject_name
      FROM attendance_records a JOIN subjects sb ON sb.id = a.subject_id
      WHERE a.student_id = ? ORDER BY a.date DESC, a.id DESC LIMIT 40`).all(id);
    const monthRecords = db.prepare(`
      SELECT a.date, a.period, a.status, sb.code AS subject_code, sb.name AS subject_name, a.updated_at
      FROM attendance_records a JOIN subjects sb ON sb.id = a.subject_id
      WHERE a.student_id = ? AND a.date >= date('now', '-62 days')
      ORDER BY a.date`).all(id);
    const notifications = db.prepare(`
      SELECT n.id, n.channel, n.recipient, n.status, n.rule, n.attendance_bp, n.error, n.created_at,
             sb.code AS subject_code
      FROM notification_events n LEFT JOIN subjects sb ON sb.id = n.subject_id
      WHERE n.student_id = ? ORDER BY n.id DESC LIMIT 25`).all(id);
    const changes = db.prepare(`
      SELECT aa.date, aa.period, aa.old_status, aa.new_status, aa.reason, aa.created_at,
             u.name AS changed_by, sb.code AS subject_code
      FROM attendance_audit aa
      LEFT JOIN users u ON u.id = aa.changed_by
      JOIN subjects sb ON sb.id = aa.subject_id
      WHERE aa.student_id = ? ORDER BY aa.id DESC LIMIT 25`).all(id);
    delete s.password_hash;
    ctx.json(200, { student: s, overall, by_subject: bySubject, recent, month_records: monthRecords, notifications, changes });
  });

  r.put('/api/students/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) throw new ApiError(404, 'not_found', 'Student not found');
    const data = readStudentBody({ ...existing, ...ctx.body }, existing);
    if (data.enrollment_no !== existing.enrollment_no
      && db.prepare('SELECT id FROM students WHERE enrollment_no = ? AND id != ?').get(data.enrollment_no, id)) {
      throw new ApiError(409, 'duplicate', `Enrollment number ${data.enrollment_no} already exists`);
    }
    db.prepare(`
      UPDATE students SET enrollment_no=?, roll_no=?, full_name=?, dob=?, gender=?, department_id=?,
        course_id=?, semester=?, section_id=?, batch=?, email=?, phone=?, parent_name=?, parent_phone=?,
        parent_email=?, admission_year=?, joined_date=?, status=?, updated_at=?
      WHERE id = ?`)
      .run(data.enrollment_no, data.roll_no, data.full_name, data.dob, data.gender, data.department_id,
        data.course_id, data.semester, data.section_id, data.batch, data.email, data.phone,
        data.parent_name, data.parent_phone, data.parent_email, data.admission_year,
        data.joined_date, data.status, nowIso(), id);
    audit({
      userId: ctx.user.id, action: 'student.updated', entity: 'students', entityId: id,
      oldValue: { full_name: existing.full_name, roll_no: existing.roll_no, status: existing.status, section_id: existing.section_id },
      newValue: { full_name: data.full_name, roll_no: data.roll_no, status: data.status, section_id: data.section_id },
      req: ctx.req,
    });
    ctx.json(200, { ok: true });
  });

  /** Soft delete: historical attendance stays intact. */
  r.delete('/api/students/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) throw new ApiError(404, 'not_found', 'Student not found');
    db.prepare(`UPDATE students SET status='inactive', deleted_at=?, updated_at=? WHERE id=?`)
      .run(nowIso(), nowIso(), id);
    audit({ userId: ctx.user.id, action: 'student.deactivated', entity: 'students', entityId: id, oldValue: { status: existing.status }, newValue: { status: 'inactive' }, req: ctx.req });
    ctx.json(200, { ok: true, message: 'Student deactivated. Historical attendance is preserved.' });
  });

  r.post('/api/students/:id/restore', async (ctx) => {
    const id = Number(ctx.params.id);
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!existing) throw new ApiError(404, 'not_found', 'Student not found');
    db.prepare(`UPDATE students SET status='active', deleted_at=NULL, updated_at=? WHERE id=?`).run(nowIso(), id);
    audit({ userId: ctx.user.id, action: 'student.restored', entity: 'students', entityId: id, req: ctx.req });
    ctx.json(200, { ok: true });
  });

  /** Bulk import students from CSV (upsert by enrollment_no). */
  r.post('/api/students/import', { maxMB: 5 }, async (ctx) => {
    const files = ctx.multipart?.files || [];
    if (!files.length) throw new ApiError(400, 'bad_request', 'Attach a CSV file (field name "file")');
    const text = files[0].data.toString('utf8');
    const rows = parseCSV(text.replace(/^﻿/, '')).filter((r) => r.some((c) => String(c).trim() !== ''));
    if (rows.length < 2) throw new ApiError(400, 'bad_request', 'CSV needs a header row and at least one student row');
    const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[\s_]+/g, '_'));
    const col = (...names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    const idx = {
      enrollment_no: col('enrollment_no', 'enrollment', 'enrolment_no', 'student_id', 'enrollment_number'),
      roll_no: col('roll_no', 'roll', 'roll_number'),
      full_name: col('full_name', 'name', 'student_name'),
      dob: col('dob', 'date_of_birth'),
      gender: col('gender'),
      department_code: col('department_code', 'dept_code', 'department'),
      semester: col('semester', 'sem'),
      section_name: col('section_name', 'section'),
      batch: col('batch'),
      email: col('email', 'student_email'),
      phone: col('phone', 'student_phone', 'mobile'),
      parent_name: col('parent_name', 'guardian_name', 'parent'),
      parent_phone: col('parent_phone', 'guardian_phone', 'parent_mobile'),
      parent_email: col('parent_email', 'guardian_email'),
      admission_year: col('admission_year'),
    };
    if (idx.roll_no < 0 || idx.full_name < 0 || idx.department_code < 0 || idx.section_name < 0) {
      throw new ApiError(400, 'bad_request',
        'CSV must contain columns: roll_no, full_name, department_code, semester, section_name (enrollment_no recommended)');
    }
    const results = { total: rows.length - 1, inserted: 0, updated: 0, errors: [] };
    const finishRow = [];
    withTx(() => {
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const rowNo = i + 1;
        try {
          const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');
          const dept = db.prepare('SELECT * FROM departments WHERE code = ? OR name = ?')
            .get(get('department_code'), get('department_code'));
          if (!dept) throw new Error(`Unknown department "${get('department_code')}"`);
          const semester = Number(get('semester')) || null;
          if (!semester) throw new Error('Missing/invalid semester');
          const sec = db.prepare('SELECT * FROM sections WHERE department_id = ? AND semester = ? AND UPPER(name) = UPPER(?)')
            .get(dept.id, semester, get('section_name'));
          if (!sec) throw new Error(`No section ${get('section_name')} for ${dept.code} semester ${semester}`);
          const enrollment = get('enrollment_no') || `${dept.code}${get('admission_year') || ''}-AUTO-${get('roll_no')}`;
          const genderRaw = get('gender').toLowerCase();
          const data = {
            enrollment_no: enrollment,
            roll_no: get('roll_no'),
            full_name: get('full_name'),
            dob: get('dob') ? optDate(get('dob'), 'dob') : null,
            gender: ['male', 'female', 'other'].includes(genderRaw) ? genderRaw : null,
            department_id: dept.id,
            semester,
            section_id: sec.id,
            batch: get('batch') || sec.batch || null,
            email: get('email') || null,
            phone: get('phone') || null,
            parent_name: get('parent_name') || null,
            parent_phone: get('parent_phone') || null,
            parent_email: get('parent_email') || null,
            admission_year: Number(get('admission_year')) || null,
          };
          if (!data.roll_no || !data.full_name) throw new Error('Missing roll_no or full_name');
          const existing = db.prepare('SELECT id FROM students WHERE enrollment_no = ?').get(enrollment);
          if (existing) {
            db.prepare(`UPDATE students SET roll_no=?, full_name=?, dob=?, gender=?, department_id=?, semester=?,
                        section_id=?, batch=?, email=?, phone=?, parent_name=?, parent_phone=?, parent_email=?,
                        admission_year=?, updated_at=? WHERE id=?`)
              .run(data.roll_no, data.full_name, data.dob, data.gender, data.department_id, data.semester,
                data.section_id, data.batch, data.email, data.phone, data.parent_name, data.parent_phone,
                data.parent_email, data.admission_year, nowIso(), existing.id);
            results.updated++;
          } else {
            const dupRoll = db.prepare('SELECT id FROM students WHERE section_id=? AND roll_no=?').get(sec.id, data.roll_no);
            if (dupRoll) throw new Error(`Roll No ${data.roll_no} already exists in section`);
            db.prepare(`INSERT INTO students(enrollment_no, roll_no, full_name, dob, gender, department_id,
                        semester, section_id, batch, email, phone, parent_name, parent_phone, parent_email,
                        admission_year, status, created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)`)
              .run(data.enrollment_no, data.roll_no, data.full_name, data.dob, data.gender, data.department_id,
                data.semester, data.section_id, data.batch, data.email, data.phone, data.parent_name,
                data.parent_phone, data.parent_email, data.admission_year, nowIso());
            results.inserted++;
          }
        } catch (e) {
          results.errors.push({ row: rowNo, message: e.message });
        }
      }
    });
    audit({
      userId: ctx.user.id, action: 'student.bulk_import', entity: 'students',
      newValue: { inserted: results.inserted, updated: results.updated, errors: results.errors.length }, req: ctx.req,
    });
    ctx.json(200, results);
  });

  r.get('/api/students-export.csv', async (ctx) => {
    const { where, args } = studentFilters(ctx.query);
    const rows = db.prepare(`
      SELECT s.enrollment_no, s.roll_no, s.full_name, s.dob, s.gender, d.code AS department_code,
             s.semester, sec.name AS section_name, s.batch, s.email, s.phone,
             s.parent_name, s.parent_phone, s.parent_email, s.admission_year, s.status
      FROM students s
      JOIN departments d ON d.id = s.department_id
      JOIN sections sec ON sec.id = s.section_id
      WHERE ${where} ORDER BY d.code, s.semester, sec.name, CAST(s.roll_no AS INTEGER), s.roll_no`).all(...args);
    const headers = ['enrollment_no', 'roll_no', 'full_name', 'dob', 'gender', 'department_code', 'semester',
      'section_name', 'batch', 'email', 'phone', 'parent_name', 'parent_phone', 'parent_email', 'admission_year', 'status'];
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="students.csv"',
    });
    ctx.res.end(toCSV(headers, rows.map((r) => headers.map((h) => r[h]))));
  });
};
