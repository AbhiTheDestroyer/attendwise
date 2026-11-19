'use strict';
/** Attendance: records browser, manual/bulk entry, edit-with-reason, defaulters. */
const { db, withTx, getSetting } = require('../db');
const {
  ApiError, reqInt, reqDate, optDate, reqEnum, optStr, nowIso, pageParams, reqStr,
} = require('../util');
const { audit, attendanceAudit } = require('../audit');
const calc = require('../services/calc');
const notify = require('../services/notify');
const { subjectAccess } = require('./subjectRoutes');

const STATUSES = ['P', 'A', 'E', 'H', 'C'];

/** Upsert one record; writes change history; returns 'created'|'updated'|'unchanged'. Caller must be in a transaction. */
function upsertRecord({ studentId, subjectId, date, period, status, source, userId, reason }) {
  const existing = db.prepare(
    'SELECT * FROM attendance_records WHERE student_id=? AND subject_id=? AND date=? AND period=?',
  ).get(studentId, subjectId, date, period);
  if (!existing) {
    db.prepare(`INSERT INTO attendance_records(student_id, subject_id, date, period, status, source, created_by, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(studentId, subjectId, date, period, status, source, userId, nowIso());
    return 'created';
  }
  if (existing.status === status) return 'unchanged';
  db.prepare('UPDATE attendance_records SET status=?, source=?, updated_at=? WHERE id=?')
    .run(status, source, nowIso(), existing.id);
  attendanceAudit({
    recordId: existing.id, studentId, subjectId, date, period,
    oldStatus: existing.status, newStatus: status, reason, userId,
  });
  return 'updated';
}

module.exports = function register(r) {
  /** Roster for the take-attendance screen (includes already-saved values). */
  r.get('/api/attendance/roster', async (ctx) => {
    const subjectId = reqInt(ctx.query.subject_id, 'subject_id', { min: 1 });
    const date = reqDate(ctx.query.date, 'date');
    const period = reqInt(ctx.query.period ?? 1, 'period', { min: 1, max: 12 });
    const subject = subjectAccess(ctx.user, subjectId);
    const students = db.prepare(`
      SELECT s.id, s.roll_no, s.full_name, s.enrollment_no, s.status AS student_status,
        (SELECT ar.status FROM attendance_records ar
          WHERE ar.student_id = s.id AND ar.subject_id = ? AND ar.date = ? AND ar.period = ?) AS marked
      FROM students s
      WHERE s.section_id = ? AND s.status = 'active' AND s.deleted_at IS NULL
        AND (s.joined_date IS NULL OR s.joined_date <= ?)
      ORDER BY CAST(s.roll_no AS INTEGER), s.roll_no`).all(subjectId, date, period, subject.section_id, date);
    const takenBefore = students.some((s) => s.marked !== null);
    ctx.json(200, {
      subject: {
        id: subject.id, code: subject.code, name: subject.name,
        section_id: subject.section_id, semester: subject.semester,
      },
      date, period, taken_before: takenBefore, students,
    });
  });

  /** Manual/bulk save (take attendance screen). */
  r.post('/api/attendance/bulk', async (ctx) => {
    const subjectId = reqInt(ctx.body.subject_id, 'subject_id', { min: 1 });
    const date = reqDate(ctx.body.date, 'date');
    const period = reqInt(ctx.body.period ?? 1, 'period', { min: 1, max: 12 });
    const subject = subjectAccess(ctx.user, subjectId);
    const entries = Array.isArray(ctx.body.entries) ? ctx.body.entries : null;
    if (!entries || !entries.length) throw new ApiError(400, 'bad_request', 'entries must be a non-empty array');
    if (entries.length > 1000) throw new ApiError(400, 'bad_request', 'Too many entries (max 1000 per save)');
    const today = nowIso().slice(0, 10);
    if (date > today) throw new ApiError(400, 'bad_request', 'Cannot mark attendance for a future date');

    const counts = { created: 0, updated: 0, unchanged: 0, invalid: [] };
    const affectedStudents = new Set();
    withTx(() => {
      const validStudents = new Set(
        db.prepare(`SELECT id FROM students WHERE section_id = ? AND status = 'active' AND deleted_at IS NULL`)
          .all(subject.section_id).map((s) => s.id),
      );
      for (const e of entries) {
        const sid = Number(e.student_id);
        const status = String(e.status || '').toUpperCase();
        if (!STATUSES.includes(status)) { counts.invalid.push({ student_id: sid, reason: `Invalid status "${e.status}"` }); continue; }
        if (!validStudents.has(sid)) { counts.invalid.push({ student_id: sid, reason: 'Student not in this section or inactive' }); continue; }
        const res = upsertRecord({
          studentId: sid, subjectId, date, period, status,
          source: 'manual', userId: ctx.user.id, reason: e.reason || null,
        });
        counts[res]++;
        if (res !== 'unchanged') affectedStudents.add(sid);
      }
    });
    audit({
      userId: ctx.user.id, action: 'attendance.saved', entity: 'subjects', entityId: subjectId,
      newValue: { date, period, ...counts, invalid: counts.invalid.length }, req: ctx.req,
    });
    // threshold evaluation happens after commit, never blocking the save
    const evalRes = await notify.evaluateBulk([...affectedStudents], subjectId, { userId: ctx.user.id });
    ctx.json(200, { ...counts, notifications: evalRes });
  });

  /** Records browser with filters + pagination (server-side). */
  r.get('/api/attendance', async (ctx) => {
    const { page, size, offset } = pageParams(ctx.query, 50);
    const where = ['1=1'];
    const args = [];
    if (ctx.user.role === 'teacher') { where.push('a.subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?)'); args.push(ctx.user.id); }
    if (ctx.query.student_id) { where.push('a.student_id = ?'); args.push(Number(ctx.query.student_id)); }
    if (ctx.query.subject_id) { where.push('a.subject_id = ?'); args.push(Number(ctx.query.subject_id)); }
    if (ctx.query.section_id) { where.push('s.section_id = ?'); args.push(Number(ctx.query.section_id)); }
    if (ctx.query.department_id) { where.push('s.department_id = ?'); args.push(Number(ctx.query.department_id)); }
    if (ctx.query.semester) { where.push('s.semester = ?'); args.push(Number(ctx.query.semester)); }
    if (ctx.query.date) { where.push('a.date = ?'); args.push(reqDate(ctx.query.date)); }
    if (ctx.query.from) { where.push('a.date >= ?'); args.push(reqDate(ctx.query.from, 'from')); }
    if (ctx.query.to) { where.push('a.date <= ?'); args.push(reqDate(ctx.query.to, 'to')); }
    if (ctx.query.status) { where.push('a.status = ?'); args.push(reqEnum(ctx.query.status, 'status', STATUSES)); }
    if (ctx.query.q) {
      where.push('(s.full_name LIKE ? OR s.roll_no LIKE ?)');
      args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
    }
    const w = 'WHERE ' + where.join(' AND ');
    const base = `FROM attendance_records a
      JOIN students s ON s.id = a.student_id
      JOIN subjects sb ON sb.id = a.subject_id
      JOIN sections sec ON sec.id = s.section_id ${w}`;
    const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...args).c;
    const rows = db.prepare(`
      SELECT a.id, a.date, a.period, a.status, a.source, a.updated_at, a.created_at,
        s.id AS student_id, s.roll_no, s.full_name, s.enrollment_no,
        sb.id AS subject_id, sb.code AS subject_code, sb.name AS subject_name,
        sec.name AS section_name
      ${base}
      ORDER BY a.date DESC, a.period, CAST(s.roll_no AS INTEGER) LIMIT ? OFFSET ?`)
      .all(...args, size, offset);
    ctx.json(200, { rows, total, page, size });
  });

  /** Single record create (used by corrections). */
  r.post('/api/attendance', async (ctx) => {
    const studentId = reqInt(ctx.body.student_id, 'student_id', { min: 1 });
    const subjectId = reqInt(ctx.body.subject_id, 'subject_id', { min: 1 });
    const date = reqDate(ctx.body.date, 'date');
    const period = reqInt(ctx.body.period ?? 1, 'period', { min: 1, max: 12 });
    const status = reqEnum(String(ctx.body.status || '').toUpperCase(), 'status', STATUSES);
    subjectAccess(ctx.user, subjectId);
    const student = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(studentId);
    if (!student) throw new ApiError(404, 'not_found', 'Student not found');
    if (date > nowIso().slice(0, 10)) throw new ApiError(400, 'bad_request', 'Cannot mark attendance for a future date');
    let result;
    withTx(() => {
      result = upsertRecord({
        studentId, subjectId, date, period, status,
        source: 'manual', userId: ctx.user.id, reason: optStr(ctx.body.reason, 'reason', { max: 500 }),
      });
    });
    audit({ userId: ctx.user.id, action: `attendance.${result}`, entity: 'attendance_records', newValue: { studentId, subjectId, date, period, status }, req: ctx.req });
    if (result !== 'unchanged') await notify.evaluateThreshold(studentId, subjectId, { userId: ctx.user.id });
    ctx.json(result === 'created' ? 201 : 200, { result });
  });

  /** Edit a single record (old→new + reason is kept in change history). */
  r.put('/api/attendance/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const rec = db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(id);
    if (!rec) throw new ApiError(404, 'not_found', 'Attendance record not found');
    subjectAccess(ctx.user, rec.subject_id);
    const status = reqEnum(String(ctx.body.status || '').toUpperCase(), 'status', STATUSES);
    const reason = optStr(ctx.body.reason, 'reason', { max: 500 });
    if (status === rec.status) {
      ctx.json(200, { result: 'unchanged' });
      return;
    }
    withTx(() => {
      db.prepare('UPDATE attendance_records SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), id);
      attendanceAudit({
        recordId: id, studentId: rec.student_id, subjectId: rec.subject_id,
        date: rec.date, period: rec.period, oldStatus: rec.status, newStatus: status,
        reason, userId: ctx.user.id,
      });
    });
    audit({
      userId: ctx.user.id, action: 'attendance.modified', entity: 'attendance_records', entityId: id,
      oldValue: { status: rec.status }, newValue: { status, reason }, req: ctx.req,
    });
    await notify.evaluateThreshold(rec.student_id, rec.subject_id, { userId: ctx.user.id });
    ctx.json(200, { result: 'updated' });
  });

  r.delete('/api/attendance/:id', async (ctx) => {
    if (ctx.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only admins can delete attendance records');
    const id = Number(ctx.params.id);
    const rec = db.prepare('SELECT * FROM attendance_records WHERE id = ?').get(id);
    if (!rec) throw new ApiError(404, 'not_found', 'Attendance record not found');
    withTx(() => {
      db.prepare('DELETE FROM attendance_records WHERE id = ?').run(id);
      attendanceAudit({
        recordId: id, studentId: rec.student_id, subjectId: rec.subject_id,
        date: rec.date, period: rec.period, oldStatus: rec.status, newStatus: null,
        reason: optStr(ctx.body.reason, 'reason', { max: 500 }) || 'record deleted', userId: ctx.user.id,
      });
    });
    audit({ userId: ctx.user.id, action: 'attendance.deleted', entity: 'attendance_records', entityId: id, oldValue: rec, req: ctx.req });
    ctx.json(200, { ok: true });
  });

  /** Defaulter dashboard data. */
  r.get('/api/attendance/defaulters', async (ctx) => {
    const threshold = Number(getSetting('threshold', '75')) || 75;
    const countExcused = getSetting('count_excused_as_applicable', '0') === '1';
    const { page, size } = pageParams(ctx.query, 25, 200);
    const filters = {
      department_id: ctx.query.department_id ? Number(ctx.query.department_id) : null,
      semester: ctx.query.semester ? Number(ctx.query.semester) : null,
      section_id: ctx.query.section_id ? Number(ctx.query.section_id) : null,
      subject_id: ctx.query.subject_id ? Number(ctx.query.subject_id) : null,
      from: optDate(ctx.query.from, 'from'),
      to: optDate(ctx.query.to, 'to'),
      band: ctx.query.band || null,
      notified: ctx.query.notified || null,
      q: ctx.query.q || null,
    };
    const result = calc.listDefaulters({ threshold, countExcused, filters, page, size, user: ctx.user });
    ctx.json(200, { ...result, threshold });
  });

  /** Class-day list for one subject (dates already recorded). */
  r.get('/api/attendance/days', async (ctx) => {
    const subjectId = reqInt(ctx.query.subject_id, 'subject_id', { min: 1 });
    subjectAccess(ctx.user, subjectId);
    const rows = db.prepare(`
      SELECT a.date, a.period,
        SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
        SUM(CASE WHEN a.status='A' THEN 1 ELSE 0 END) absent,
        SUM(CASE WHEN a.status='E' THEN 1 ELSE 0 END) excused,
        COUNT(*) total
      FROM attendance_records a WHERE a.subject_id = ?
      GROUP BY a.date, a.period ORDER BY a.date DESC LIMIT 120`).all(subjectId);
    ctx.json(200, { rows });
  });
};
