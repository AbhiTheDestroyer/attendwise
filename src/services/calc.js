'use strict';
/**
 * Attendance mathematics.
 *
 * Accuracy rules:
 *  - Percentages are stored/passed as basis points (1/100 of a percent):
 *    77.5% === 7750 bp. This avoids every floating point comparison issue.
 *  - Threshold comparisons use exact integer cross-multiplication:
 *      below  ⇔  present*100  <  threshold*applicable
 *      at     ⇔  present*100 === threshold*applicable
 *    so 75.0 (3 of 4) is *at* threshold, never below it.
 *  - 'Applicable' classes = Present + Absent (+ Excused only when the
 *    `count_excused_as_applicable` setting is enabled). Holidays and
 *    Cancelled classes never count.
 */
const { db } = require('../db');

const STATUSES = ['P', 'A', 'E', 'H', 'C'];
const STATUS_LABEL = { P: 'Present', A: 'Absent', E: 'Excused', H: 'Holiday', C: 'Cancelled' };

function pctBp(present, applicable) {
  if (!applicable || applicable <= 0) return null; // no applicable classes → undefined, not 0%
  return Math.round((present * 10000) / applicable);
}
/** exact: below / at / above */
function thresholdRelation(present, applicable, threshold) {
  if (!applicable || applicable <= 0) return 'na';
  const lhs = present * 100;
  const rhs = threshold * applicable;
  if (lhs < rhs) return 'below';
  if (lhs === rhs) return 'at';
  return 'above';
}
const isBelow = (present, applicable, threshold) =>
  thresholdRelation(present, applicable, threshold) === 'below';

function fmtPct(bp) {
  if (bp === null || bp === undefined) return '—';
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return `${whole}%`;
  if (frac % 10 === 0) return `${whole}.${frac / 10}%`;
  return `${whole}.${String(frac).padStart(2, '0')}%`;
}

function applicableExpr(countExcused) {
  return countExcused
    ? `SUM(CASE WHEN a.status IN ('P','A','E') THEN 1 ELSE 0 END)`
    : `SUM(CASE WHEN a.status IN ('P','A') THEN 1 ELSE 0 END)`;
}

/** Per-subject counters for one student. */
function studentSubjectSummary(studentId, subjectId, countExcused = false) {
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN status='A' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN status='E' THEN 1 ELSE 0 END) AS excused,
      SUM(CASE WHEN status='H' THEN 1 ELSE 0 END) AS holiday,
      SUM(CASE WHEN status='C' THEN 1 ELSE 0 END) AS cancelled
    FROM attendance_records
    WHERE student_id = ? AND subject_id = ?`).get(studentId, subjectId);
  const present = r.present || 0;
  const applicable = present + (r.absent || 0) + (countExcused ? (r.excused || 0) : 0);
  return {
    present,
    absent: r.absent || 0,
    excused: r.excused || 0,
    holiday: r.holiday || 0,
    cancelled: r.cancelled || 0,
    applicable,
    pct_bp: pctBp(present, applicable),
  };
}

/** Overall (all subjects) counters for one student. */
function studentOverall(studentId, countExcused = false, { from = null, to = null } = {}) {
  const where = ['student_id = ?'];
  const args = [studentId];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN status='A' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN status='E' THEN 1 ELSE 0 END) AS excused
    FROM attendance_records WHERE ${where.join(' AND ')}`).get(...args);
  const present = r.present || 0;
  const applicable = present + (r.absent || 0) + (countExcused ? (r.excused || 0) : 0);
  return { present, absent: r.absent || 0, excused: r.excused || 0, applicable, pct_bp: pctBp(present, applicable) };
}

/** Subject-wise breakdown for a student profile. */
function studentBySubject(studentId, countExcused = false) {
  const rows = db.prepare(`
    SELECT a.subject_id, s.code, s.name,
      SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status='A' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status='E' THEN 1 ELSE 0 END) AS excused,
      SUM(CASE WHEN a.status='H' THEN 1 ELSE 0 END) AS holiday,
      SUM(CASE WHEN a.status='C' THEN 1 ELSE 0 END) AS cancelled
    FROM attendance_records a JOIN subjects s ON s.id = a.subject_id
    WHERE a.student_id = ?
    GROUP BY a.subject_id ORDER BY s.code`).all(studentId);
  return rows.map((r) => {
    const applicable = r.present + r.absent + (countExcused ? r.excused : 0);
    return { ...r, applicable, pct_bp: pctBp(r.present, applicable) };
  });
}

/**
 * Defaulters: every (student × subject) pair whose attendance is strictly
 * below the threshold. Filtering & pagination happen in SQL (scales to
 * millions of records); band and notified filters too.
 */
function listDefaulters({
  threshold, countExcused = false, filters = {}, page = 1, size = 25, user = null,
}) {
  const app = applicableExpr(countExcused);
  const where = ['s.status = ?'];
  const args = ['active'];
  if (filters.department_id) { where.push('s.department_id = ?'); args.push(filters.department_id); }
  if (filters.semester) { where.push('s.semester = ?'); args.push(filters.semester); }
  if (filters.section_id) { where.push('s.section_id = ?'); args.push(filters.section_id); }
  if (filters.subject_id) { where.push('a.subject_id = ?'); args.push(filters.subject_id); }
  if (filters.from) { where.push('a.date >= ?'); args.push(filters.from); }
  if (filters.to) { where.push('a.date <= ?'); args.push(filters.to); }
  if (filters.q) {
    where.push('(s.full_name LIKE ? OR s.roll_no LIKE ? OR s.enrollment_no LIKE ?)');
    const like = `%${filters.q}%`;
    args.push(like, like, like);
  }
  if (user && user.role === 'teacher') {
    where.push('a.subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?)');
    args.push(user.id);
  }

  let sql = `
    WITH agg AS (
      SELECT a.student_id, a.subject_id,
        SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN a.status='A' THEN 1 ELSE 0 END) AS absent,
        SUM(CASE WHEN a.status='E' THEN 1 ELSE 0 END) AS excused,
        ${app} AS applicable
      FROM attendance_records a
      JOIN students s ON s.id = a.student_id
      WHERE ${where.join(' AND ')}
      GROUP BY a.student_id, a.subject_id
    )
    SELECT agg.student_id, agg.subject_id, agg.present, agg.absent, agg.excused, agg.applicable,
      CAST(agg.present * 10000 / agg.applicable AS INTEGER) AS pct_bp,
      s.roll_no, s.enrollment_no, s.full_name, s.semester,
      s.parent_name, s.parent_phone, s.parent_email, s.status AS student_status,
      d.name AS department_name, sec.name AS section_name,
      sb.code AS subject_code, sb.name AS subject_name, sb.teacher_id,
      na.last_status AS notif_status, na.last_at AS notif_at, na.last_channel AS notif_channel
    FROM agg
    JOIN students s ON s.id = agg.student_id
    JOIN departments d ON d.id = s.department_id
    JOIN sections sec ON sec.id = s.section_id
    JOIN subjects sb ON sb.id = agg.subject_id
    LEFT JOIN (
      SELECT student_id, subject_id, status AS last_status, created_at AS last_at, channel AS last_channel
      FROM (
        SELECT student_id, subject_id, status, created_at, channel,
          ROW_NUMBER() OVER (PARTITION BY student_id, subject_id ORDER BY id DESC) AS rn
        FROM notification_events
      ) WHERE rn = 1
    ) na ON na.student_id = agg.student_id AND na.subject_id = agg.subject_id
    WHERE agg.applicable > 0 AND agg.present * 100 < ? * agg.applicable`;
  const args2 = [...args, threshold];

  const band = filters.band;
  if (band === 'below50') { sql += ' AND agg.present * 100 < 50 * agg.applicable'; }
  else if (band === '50to60') { sql += ' AND agg.present * 100 >= 50 * agg.applicable AND agg.present * 100 < 60 * agg.applicable'; }
  else if (band === '60to75') { sql += ' AND agg.present * 100 >= 60 * agg.applicable AND agg.present * 100 < 75 * agg.applicable'; }
  else if (band === 'critical') { sql += ' AND agg.present * 2 < agg.applicable'; } // < 50%

  if (filters.notified === 'yes') sql += ` AND na.last_status IN ('sent','delivered','pending')`;
  else if (filters.notified === 'no') sql += ` AND (na.last_status IS NULL OR na.last_status IN ('failed','skipped'))`;
  else if (filters.notified === 'failed') sql += ` AND na.last_status = 'failed'`;

  const countSql = `SELECT COUNT(*) AS c FROM (${sql})`;
  const total = db.prepare(countSql).get(...args2).c;

  sql += ` ORDER BY (agg.present * 1.0 / NULLIF(agg.applicable,0)) ASC, s.full_name LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args2, size, (page - 1) * size)
    .map((r) => ({ ...r, pct_bp: pctBp(r.present, r.applicable) }));
  return { rows, total, page, size };
}

module.exports = {
  STATUSES, STATUS_LABEL,
  pctBp, thresholdRelation, isBelow, fmtPct,
  studentSubjectSummary, studentOverall, studentBySubject, listDefaulters,
};
