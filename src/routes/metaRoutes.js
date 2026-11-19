'use strict';
/** Organization structure: departments, courses, sections (+ lookup bundle). */
const { db } = require('../db');
const { ApiError, reqStr, reqInt, optStr, optInt, nowIso, pageParams } = require('../util');
const { audit } = require('../audit');

module.exports = function register(r) {
  /** Everything the UI needs for filters/dropdowns in one round-trip. */
  r.get('/api/meta', async (ctx) => {
    const departments = db.prepare('SELECT id, name, code FROM departments ORDER BY name').all();
    const courses = db.prepare(`SELECT c.id, c.name, c.code, c.department_id, d.name AS department_name
                                FROM courses c JOIN departments d ON d.id = c.department_id ORDER BY c.name`).all();
    const sections = db.prepare(`SELECT s.id, s.name, s.semester, s.batch, s.academic_year, s.department_id,
                                        d.name AS department_name,
                                        (SELECT COUNT(*) FROM students st WHERE st.section_id = s.id AND st.status='active') AS student_count
                                 FROM sections s JOIN departments d ON d.id = s.department_id
                                 ORDER BY d.name, s.semester, s.name`).all();
    const semesters = [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b);
    const batches = [...new Set(sections.map((s) => s.batch).filter(Boolean))].sort();
    ctx.json(200, { departments, courses, sections, semesters, batches });
  });

  r.post('/api/departments', async (ctx) => {
    const name = reqStr(ctx.body.name, 'name', { max: 120 });
    const code = reqStr(ctx.body.code, 'code', { max: 12 }).toUpperCase();
    if (db.prepare('SELECT id FROM departments WHERE code = ? OR name = ?').get(code, name)) {
      throw new ApiError(409, 'duplicate', 'A department with that name or code already exists');
    }
    const info = db.prepare('INSERT INTO departments(name, code, created_at) VALUES(?,?,?)').run(name, code, nowIso());
    audit({ userId: ctx.user.id, action: 'department.created', entity: 'departments', entityId: info.lastInsertRowid, newValue: { name, code }, req: ctx.req });
    ctx.json(201, { id: info.lastInsertRowid, name, code });
  });

  r.put('/api/departments/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const dep = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!dep) throw new ApiError(404, 'not_found', 'Department not found');
    const name = reqStr(ctx.body.name ?? dep.name, 'name', { max: 120 });
    const code = reqStr(ctx.body.code ?? dep.code, 'code', { max: 12 }).toUpperCase();
    db.prepare('UPDATE departments SET name = ?, code = ? WHERE id = ?').run(name, code, id);
    audit({ userId: ctx.user.id, action: 'department.updated', entity: 'departments', entityId: id, oldValue: dep, newValue: { name, code }, req: ctx.req });
    ctx.json(200, { ok: true });
  });

  r.post('/api/courses', async (ctx) => {
    const name = reqStr(ctx.body.name, 'name', { max: 120 });
    const code = optStr(ctx.body.code, 'code', { max: 20 });
    const departmentId = reqInt(ctx.body.department_id, 'department_id', { min: 1 });
    const duration = optInt(ctx.body.duration_years, 'duration_years', { min: 1, max: 8 }) ?? 4;
    if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId)) {
      throw new ApiError(400, 'bad_request', 'Department does not exist');
    }
    try {
      const info = db.prepare('INSERT INTO courses(name, code, department_id, duration_years, created_at) VALUES(?,?,?,?,?)')
        .run(name, code, departmentId, duration, nowIso());
      audit({ userId: ctx.user.id, action: 'course.created', entity: 'courses', entityId: info.lastInsertRowid, newValue: { name, departmentId }, req: ctx.req });
      ctx.json(201, { id: info.lastInsertRowid });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'duplicate', 'That course already exists in the department');
      throw e;
    }
  });

  r.post('/api/sections', async (ctx) => {
    const name = reqStr(ctx.body.name, 'name', { max: 20 }).toUpperCase();
    const departmentId = reqInt(ctx.body.department_id, 'department_id', { min: 1 });
    const semester = reqInt(ctx.body.semester, 'semester', { min: 1, max: 12 });
    const courseId = optInt(ctx.body.course_id, 'course_id', { min: 1 });
    const batch = optStr(ctx.body.batch, 'batch', { max: 20 });
    const academicYear = optStr(ctx.body.academic_year, 'academic_year', { max: 12 }) || '';
    if (!db.prepare('SELECT id FROM departments WHERE id = ?').get(departmentId)) {
      throw new ApiError(400, 'bad_request', 'Department does not exist');
    }
    try {
      const info = db.prepare(`INSERT INTO sections(name, department_id, course_id, semester, batch, academic_year, created_at)
                               VALUES(?,?,?,?,?,?,?)`)
        .run(name, departmentId, courseId, semester, batch, academicYear, nowIso());
      audit({ userId: ctx.user.id, action: 'section.created', entity: 'sections', entityId: info.lastInsertRowid, newValue: { name, departmentId, semester }, req: ctx.req });
      ctx.json(201, { id: info.lastInsertRowid });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'duplicate', `Section ${name} already exists for this department/semester/year`);
      throw e;
    }
  });

  r.put('/api/sections/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const sec = db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
    if (!sec) throw new ApiError(404, 'not_found', 'Section not found');
    const patch = {
      name: ctx.body.name !== undefined ? reqStr(ctx.body.name, 'name', { max: 20 }).toUpperCase() : sec.name,
      semester: ctx.body.semester !== undefined ? reqInt(ctx.body.semester, 'semester', { min: 1, max: 12 }) : sec.semester,
      batch: ctx.body.batch !== undefined ? optStr(ctx.body.batch, 'batch', { max: 20 }) : sec.batch,
      academic_year: ctx.body.academic_year !== undefined ? optStr(ctx.body.academic_year, 'academic_year', { max: 12 }) : sec.academic_year,
    };
    db.prepare('UPDATE sections SET name=?, semester=?, batch=?, academic_year=? WHERE id=?')
      .run(patch.name, patch.semester, patch.batch, patch.academic_year, id);
    audit({ userId: ctx.user.id, action: 'section.updated', entity: 'sections', entityId: id, oldValue: sec, newValue: patch, req: ctx.req });
    ctx.json(200, { ok: true });
  });
};
