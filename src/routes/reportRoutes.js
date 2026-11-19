'use strict';
/** Reports: CSV/XLSX exports, all generated server-side with a report header. */
const { db, getSetting } = require('../db');
const { ApiError, optDate, nowIso, toCSV } = require('../util');
const calc = require('../services/calc');
const { buildXlsx } = require('../services/xlsx');
const { audit } = require('../audit');

function reportHeader(reportName, user, extra = []) {
  return [
    [getSetting('institution_name', 'Institution')],
    [reportName],
    [`Generated: ${nowIso()}`, `By: ${user.name} (${user.email})`],
    ...extra,
    [],
  ];
}
function sendCsv(ctx, filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  ctx.res.end('﻿' + csv);
}
function sendXlsx(ctx, filename, rows, sheetName) {
  const buf = buildXlsx(rows, sheetName);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buf.length,
  });
  ctx.res.end(buf);
}
const wantsXlsx = (ctx) => (ctx.query.format || '').toLowerCase() === 'xlsx';

module.exports = function register(r) {
  /* ------------------------------ defaulters ------------------------------ */
  r.get('/api/reports/defaulters', async (ctx) => {
    const threshold = Number(getSetting('threshold', '75')) || 75;
    const countExcused = getSetting('count_excused_as_applicable', '0') === '1';
    const { rows } = calc.listDefaulters({
      threshold, countExcused,
      filters: {
        department_id: ctx.query.department_id ? Number(ctx.query.department_id) : null,
        semester: ctx.query.semester ? Number(ctx.query.semester) : null,
        section_id: ctx.query.section_id ? Number(ctx.query.section_id) : null,
        subject_id: ctx.query.subject_id ? Number(ctx.query.subject_id) : null,
        band: ctx.query.band || null,
        q: ctx.query.q || null,
      },
      page: 1, size: 10000, user: ctx.user,
    });
    const headers = ['Roll No', 'Enrollment No', 'Student', 'Department', 'Semester', 'Section',
      'Subject Code', 'Subject', 'Present', 'Absent', 'Excused', 'Applicable Classes',
      'Attendance %', 'Threshold %', 'Parent Name', 'Parent Phone', 'Parent Email',
      'Last Notification', 'Notification Status'];
    const body = rows.map((x) => [
      x.roll_no, x.enrollment_no, x.full_name, x.department_name, x.semester, x.section_name,
      x.subject_code, x.subject_name, x.present, x.absent, x.excused, x.applicable,
      (x.pct_bp / 100).toFixed(2), threshold, x.parent_name || '', x.parent_phone || '',
      x.parent_email || '', x.notif_at || '', x.notif_status || '',
    ]);
    const all = [...reportHeader('Attendance Defaulter Report', ctx.user, [[`Threshold: ${threshold}%`]]), headers, ...body];
    audit({ userId: ctx.user.id, action: 'report.defaulters', newValue: { rows: rows.length }, req: ctx.req });
    if (wantsXlsx(ctx)) sendXlsx(ctx, 'defaulters.xlsx', all, 'Defaulters');
    else sendCsv(ctx, 'defaulters.csv', all);
  });

  /* --------------------------- register (long) ---------------------------- */
  r.get('/api/reports/attendance', async (ctx) => {
    const where = ['1=1'];
    const args = [];
    if (ctx.user.role === 'teacher') { where.push('a.subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?)'); args.push(ctx.user.id); }
    if (ctx.query.subject_id) { where.push('a.subject_id = ?'); args.push(Number(ctx.query.subject_id)); }
    if (ctx.query.section_id) { where.push('s.section_id = ?'); args.push(Number(ctx.query.section_id)); }
    const from = optDate(ctx.query.from, 'from');
    const to = optDate(ctx.query.to, 'to');
    if (from) { where.push('a.date >= ?'); args.push(from); }
    if (to) { where.push('a.date <= ?'); args.push(to); }
    const rows = db.prepare(`
      SELECT s.roll_no, s.enrollment_no, s.full_name, sb.code AS subject_code, sb.name AS subject_name,
             sec.name AS section_name, a.date, a.period, a.status, a.source, a.updated_at
      FROM attendance_records a
      JOIN students s ON s.id = a.student_id
      JOIN subjects sb ON sb.id = a.subject_id
      JOIN sections sec ON sec.id = s.section_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.date, CAST(s.roll_no AS INTEGER) LIMIT 200000`).all(...args);
    const headers = ['Roll No', 'Enrollment No', 'Student', 'Section', 'Subject Code', 'Subject', 'Date', 'Period', 'Status', 'Source', 'Last Updated'];
    const label = { P: 'Present', A: 'Absent', E: 'Excused', H: 'Holiday', C: 'Cancelled' };
    const body = rows.map((x) => [x.roll_no, x.enrollment_no, x.full_name, x.section_name, x.subject_code, x.subject_name, x.date, x.period, label[x.status] || x.status, x.source, x.updated_at || '']);
    const all = [...reportHeader('Attendance Register', ctx.user, [[`Range: ${from || '…'} → ${to || '…'}`]]), headers, ...body];
    audit({ userId: ctx.user.id, action: 'report.attendance', newValue: { rows: rows.length }, req: ctx.req });
    if (wantsXlsx(ctx)) sendXlsx(ctx, 'attendance.csv.xlsx', all, 'Register');
    else sendCsv(ctx, 'attendance.csv', all);
  });

  /* ----------------------- summary (student × subject) --------------------- */
  r.get('/api/reports/student-summary', async (ctx) => {
    const countExcused = getSetting('count_excused_as_applicable', '0') === '1';
    const app = countExcused
      ? `SUM(CASE WHEN a.status IN ('P','A','E') THEN 1 ELSE 0 END)`
      : `SUM(CASE WHEN a.status IN ('P','A') THEN 1 ELSE 0 END)`;
    const where = ['1=1'];
    const args = [];
    if (ctx.user.role === 'teacher') { where.push('a.subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?)'); args.push(ctx.user.id); }
    if (ctx.query.department_id) { where.push('s.department_id = ?'); args.push(Number(ctx.query.department_id)); }
    if (ctx.query.semester) { where.push('s.semester = ?'); args.push(Number(ctx.query.semester)); }
    if (ctx.query.section_id) { where.push('s.section_id = ?'); args.push(Number(ctx.query.section_id)); }
    const threshold = Number(getSetting('threshold', '75')) || 75;
    const rows = db.prepare(`
      SELECT s.roll_no, s.enrollment_no, s.full_name, d.code AS dept, s.semester, sec.name AS section_name,
             sb.code AS subject_code, sb.name AS subject_name,
             SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
             SUM(CASE WHEN a.status='A' THEN 1 ELSE 0 END) absent,
             SUM(CASE WHEN a.status='E' THEN 1 ELSE 0 END) excused,
             ${app} applicable
      FROM attendance_records a
      JOIN students s ON s.id = a.student_id
      JOIN departments d ON d.id = s.department_id
      JOIN sections sec ON sec.id = s.section_id
      JOIN subjects sb ON sb.id = a.subject_id
      WHERE ${where.join(' AND ')}
      GROUP BY a.student_id, a.subject_id
      ORDER BY d.code, s.semester, sec.name, CAST(s.roll_no AS INTEGER), sb.code LIMIT 100000`).all(...args);
    const headers = ['Roll No', 'Enrollment No', 'Student', 'Dept', 'Sem', 'Section', 'Subject Code', 'Subject',
      'Present', 'Absent', 'Excused', 'Applicable', 'Attendance %', 'Status vs Threshold'];
    const body = rows.map((x) => {
      const bp = calc.pctBp(x.present, x.applicable);
      const rel = calc.thresholdRelation(x.present, x.applicable, threshold);
      return [x.roll_no, x.enrollment_no, x.full_name, x.dept, x.semester, x.section_name,
        x.subject_code, x.subject_name, x.present, x.absent, x.excused, x.applicable,
        bp === null ? '' : (bp / 100).toFixed(2),
        rel === 'na' ? 'No classes' : rel === 'below' ? `BELOW ${threshold}%` : rel === 'at' ? `AT ${threshold}%` : 'OK'];
    });
    const all = [...reportHeader('Attendance Summary (Student × Subject)', ctx.user, [[`Threshold: ${threshold}%`]]), headers, ...body];
    audit({ userId: ctx.user.id, action: 'report.summary', newValue: { rows: rows.length }, req: ctx.req });
    if (wantsXlsx(ctx)) sendXlsx(ctx, 'attendance-summary.xlsx', all, 'Summary');
    else sendCsv(ctx, 'attendance-summary.csv', all);
  });

  /* ------------------------------ single student --------------------------- */
  r.get('/api/reports/student/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const s = db.prepare(`SELECT s.*, d.name AS department_name, sec.name AS section_name
                          FROM students s JOIN departments d ON d.id=s.department_id
                          JOIN sections sec ON sec.id=s.section_id
                          WHERE s.id = ? AND s.deleted_at IS NULL`).get(id);
    if (!s) throw new ApiError(404, 'not_found', 'Student not found');
    const rows = db.prepare(`
      SELECT sb.code, sb.name AS subject, a.date, a.period, a.status, a.source
      FROM attendance_records a JOIN subjects sb ON sb.id = a.subject_id
      WHERE a.student_id = ? ORDER BY a.date, sb.code`).all(id);
    const label = { P: 'Present', A: 'Absent', E: 'Excused', H: 'Holiday', C: 'Cancelled' };
    const head = reportHeader('Student Attendance Report', ctx.user, [
      [`Student: ${s.full_name}`, `Roll No: ${s.roll_no}`, `Enrollment: ${s.enrollment_no}`],
      [`${s.department_name} — Semester ${s.semester}, Section ${s.section_name}`],
      [`Parent: ${s.parent_name || ''}`, `Parent Contact: ${s.parent_phone || ''} / ${s.parent_email || ''}`],
    ]);
    const all = [...head, ['Subject Code', 'Subject', 'Date', 'Period', 'Status', 'Source'],
      ...rows.map((x) => [x.code, x.subject, x.date, x.period, label[x.status] || x.status, x.source])];
    audit({ userId: ctx.user.id, action: 'report.student', entity: 'students', entityId: id, req: ctx.req });
    sendCsv(ctx, `student-${s.roll_no}.csv`, all);
  });

  /* ------------------------------ notifications ---------------------------- */
  r.get('/api/reports/notifications', async (ctx) => {
    const rows = db.prepare(`
      SELECT n.id, s.roll_no, s.full_name, sb.code AS subject_code, n.channel, n.recipient,
             n.status, n.rule, n.attendance_bp, n.error, n.created_at, u.name AS sent_by
      FROM notification_events n
      JOIN students s ON s.id = n.student_id
      LEFT JOIN subjects sb ON sb.id = n.subject_id
      LEFT JOIN users u ON u.id = n.created_by
      ORDER BY n.id DESC LIMIT 50000`).all();
    const headers = ['ID', 'Roll No', 'Student', 'Subject', 'Channel', 'Recipient', 'Status', 'Rule', 'Attendance %', 'Error', 'Date', 'Sent By'];
    const body = rows.map((x) => [x.id, x.roll_no, x.full_name, x.subject_code || 'ALL', x.channel, x.recipient || '',
      x.status, x.rule, x.attendance_bp === null ? '' : (x.attendance_bp / 100).toFixed(2), x.error || '', x.created_at, x.sent_by || 'system']);
    const all = [...reportHeader('Parent Notification Report', ctx.user), headers, ...body];
    audit({ userId: ctx.user.id, action: 'report.notifications', newValue: { rows: rows.length }, req: ctx.req });
    sendCsv(ctx, 'notifications.csv', all);
  });

  /* -------------------------------- monthly -------------------------------- */
  r.get('/api/reports/monthly', async (ctx) => {
    const where = ['1=1'];
    const args = [];
    if (ctx.query.section_id) { where.push('s.section_id = ?'); args.push(Number(ctx.query.section_id)); }
    if (ctx.query.subject_id) { where.push('a.subject_id = ?'); args.push(Number(ctx.query.subject_id)); }
    const rows = db.prepare(`
      SELECT substr(a.date,1,7) ym,
        SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
        SUM(CASE WHEN a.status='A' THEN 1 ELSE 0 END) absent,
        SUM(CASE WHEN a.status='E' THEN 1 ELSE 0 END) excused,
        SUM(CASE WHEN a.status='H' THEN 1 ELSE 0 END) holiday,
        SUM(CASE WHEN a.status='C' THEN 1 ELSE 0 END) cancelled,
        COUNT(DISTINCT a.date) days, COUNT(DISTINCT a.student_id) students
      FROM attendance_records a JOIN students s ON s.id=a.student_id
      WHERE ${where.join(' AND ')}
      GROUP BY ym ORDER BY ym`).all(...args);
    const headers = ['Month', 'Present', 'Absent', 'Excused', 'Holiday', 'Cancelled', 'Class Days', 'Students', 'Attendance %'];
    const body = rows.map((x) => {
      const applicable = x.present + x.absent;
      const bp = calc.pctBp(x.present, applicable);
      return [x.ym, x.present, x.absent, x.excused, x.holiday, x.cancelled, x.days, x.students, bp === null ? '' : (bp / 100).toFixed(2)];
    });
    const all = [...reportHeader('Monthly Attendance Report', ctx.user), headers, ...body];
    audit({ userId: ctx.user.id, action: 'report.monthly', req: ctx.req });
    if (wantsXlsx(ctx)) sendXlsx(ctx, 'monthly.xlsx', all, 'Monthly');
    else sendCsv(ctx, 'monthly.csv', all);
  });

  /* --------------------------- full data backup ---------------------------- */
  r.get('/api/admin/backup', async (ctx) => {
    if (ctx.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only admins can export system backups');
    const tables = ['users', 'departments', 'courses', 'sections', 'students', 'subjects',
      'attendance_records', 'attendance_audit', 'imports', 'notification_events',
      'notification_state', 'settings', 'audit_logs'];
    const dump = { generated_at: nowIso(), generated_by: ctx.user.email, institution: getSetting('institution_name', ''), tables: {} };
    for (const t of tables) {
      dump.tables[t] = t === 'users'
        ? db.prepare('SELECT id, name, email, role, active, created_at FROM users').all() // never export password hashes
        : db.prepare(`SELECT * FROM ${t}`).all();
    }
    audit({ userId: ctx.user.id, action: 'admin.backup_export', req: ctx.req });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="attendance-backup-${nowIso().slice(0, 10)}.json"`,
    });
    ctx.res.end(JSON.stringify(dump, null, 1));
  });
};
