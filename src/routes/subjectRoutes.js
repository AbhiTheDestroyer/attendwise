'use strict';
/** Subject management. */
const { db } = require('../db');
const { ApiError, reqStr, optStr, reqInt, optInt, reqEnum, nowIso, pageParams } = require('../util');
const { audit } = require('../audit');

function subjectAccess(user, subjectId) {
  const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId);
  if (!subject) throw new ApiError(404, 'not_found', 'Subject not found');
  if (user.role === 'teacher' && subject.teacher_id !== user.id) {
    throw new ApiError(403, 'forbidden', 'You are not assigned to this subject');
  }
  return subject;
}

module.exports = function register(r) {
  r.get('/api/subjects', async (ctx) => {
    const where = [`sb.status != 'archived'`];
    const args = [];
    if (ctx.user.role === 'teacher') { where.push('sb.teacher_id = ?'); args.push(ctx.user.id); }
    if (ctx.query.department_id) { where.push('sb.department_id = ?'); args.push(Number(ctx.query.department_id)); }
    if (ctx.query.semester) { where.push('sb.semester = ?'); args.push(Number(ctx.query.semester)); }
    if (ctx.query.section_id) { where.push('sb.section_id = ?'); args.push(Number(ctx.query.section_id)); }
    if (ctx.query.teacher_id) { where.push('sb.teacher_id = ?'); args.push(Number(ctx.query.teacher_id)); }
    if (ctx.query.q) { where.push('(sb.name LIKE ? OR sb.code LIKE ?)'); args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`); }
    const { size, offset, page } = pageParams(ctx.query, 100, 500);
    const w = 'WHERE ' + where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM subjects sb ${w}`).get(...args).c;
    const rows = db.prepare(`
      SELECT sb.*, d.name AS department_name, sec.name AS section_name, u.name AS teacher_name,
        (SELECT COUNT(*) FROM students st WHERE st.section_id = sb.section_id AND st.status='active') AS student_count,
        (SELECT COUNT(DISTINCT date || '-' || period) FROM attendance_records ar WHERE ar.subject_id = sb.id) AS classes_held
      FROM subjects sb
      JOIN departments d ON d.id = sb.department_id
      JOIN sections sec ON sec.id = sb.section_id
      LEFT JOIN users u ON u.id = sb.teacher_id
      ${w} ORDER BY sb.code LIMIT ? OFFSET ?`).all(...args, size, offset);
    ctx.json(200, { rows, total, page, size });
  });

  r.post('/api/subjects', async (ctx) => {
    const code = reqStr(ctx.body.code, 'code', { max: 20 }).toUpperCase();
    const name = reqStr(ctx.body.name, 'name', { max: 120 });
    const departmentId = reqInt(ctx.body.department_id, 'department_id', { min: 1 });
    const semester = reqInt(ctx.body.semester, 'semester', { min: 1, max: 12 });
    const sectionId = reqInt(ctx.body.section_id, 'section_id', { min: 1 });
    const teacherId = optInt(ctx.body.teacher_id, 'teacher_id', { min: 1 });
    const credits = optInt(ctx.body.credits, 'credits', { min: 0, max: 30 }) ?? 3;
    const academicYear = optStr(ctx.body.academic_year, 'academic_year', { max: 12 });
    const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(sectionId);
    if (!section) throw new ApiError(400, 'bad_request', 'Section does not exist');
    if (section.department_id !== departmentId) throw new ApiError(400, 'bad_request', 'Section belongs to a different department');
    if (teacherId && !db.prepare(`SELECT id FROM users WHERE id = ? AND role='teacher' AND active=1`).get(teacherId)) {
      throw new ApiError(400, 'bad_request', 'Teacher does not exist or is inactive');
    }
    try {
      const info = db.prepare(`
        INSERT INTO subjects(code, name, department_id, semester, section_id, teacher_id, credits, academic_year, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(code, name, departmentId, semester, sectionId, teacherId, credits, academicYear, nowIso());
      audit({ userId: ctx.user.id, action: 'subject.created', entity: 'subjects', entityId: info.lastInsertRowid, newValue: { code, name, sectionId, teacherId }, req: ctx.req });
      ctx.json(201, { id: info.lastInsertRowid });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'duplicate', `Subject ${code} already exists for this section`);
      throw e;
    }
  });

  r.put('/api/subjects/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const sb = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!sb) throw new ApiError(404, 'not_found', 'Subject not found');
    const patch = {
      name: ctx.body.name !== undefined ? reqStr(ctx.body.name, 'name', { max: 120 }) : sb.name,
      code: ctx.body.code !== undefined ? reqStr(ctx.body.code, 'code', { max: 20 }).toUpperCase() : sb.code,
      teacher_id: ctx.body.teacher_id !== undefined ? optInt(ctx.body.teacher_id, 'teacher_id', { min: 1 }) : sb.teacher_id,
      credits: ctx.body.credits !== undefined ? optInt(ctx.body.credits, 'credits', { min: 0, max: 30 }) : sb.credits,
      total_classes: ctx.body.total_classes !== undefined ? Math.max(0, Number(ctx.body.total_classes) || 0) : sb.total_classes,
      status: ctx.body.status !== undefined ? reqEnum(ctx.body.status, 'status', ['active', 'archived']) : sb.status,
    };
    if (patch.teacher_id && !db.prepare(`SELECT id FROM users WHERE id = ? AND role='teacher' AND active=1`).get(patch.teacher_id)) {
      throw new ApiError(400, 'bad_request', 'Teacher does not exist or is inactive');
    }
    db.prepare(`UPDATE subjects SET name=?, code=?, teacher_id=?, credits=?, total_classes=?, status=? WHERE id=?`)
      .run(patch.name, patch.code, patch.teacher_id, patch.credits, patch.total_classes, patch.status, id);
    audit({ userId: ctx.user.id, action: 'subject.updated', entity: 'subjects', entityId: id, oldValue: { name: sb.name, teacher_id: sb.teacher_id, status: sb.status }, newValue: patch, req: ctx.req });
    ctx.json(200, { ok: true });
  });
};

module.exports.subjectAccess = subjectAccess;
