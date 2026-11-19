'use strict';
/**
 * PUBLIC (no login) endpoints.
 *
 * POST /api/public/lookup — student/parent self-service attendance check using
 *   enrollment_no + dob. Design principles (deliberate, documented):
 *   - HEAVILY RATE-LIMITED: 5 attempts / 10 min / IP. Roll+DOB is a weak
 *     credential; enumeration must be unattractive and honestly punished.
 *   - ZERO PARTIAL LEAKAGE: a wrong enrollment or a wrong dob produces the
 *     SAME 'no_match' message — the response never reveals which part exists.
 *   - MINIMAL EXPOSURE: returns only attendance views a parent needs —
 *     no parent phone/email, no other students, no audit trails, no record ids.
 *   - SAME MATH: uses services/calc, identical to teacher dashboards.
 */
const { db, getSetting, getSettingInt } = require('../db');
const { ApiError, reqStr, nowIso } = require('../util');
const calc = require('../services/calc');

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const attempts = new Map(); // ip -> ms timestamps inside the window

function recordAttempt(ip) {
  const now = Date.now();
  const arr = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  // opportunistic hygiene so the map can't grow unbounded
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (!v.length || now - v[v.length - 1] >= WINDOW_MS) attempts.delete(k);
    }
  }
  if (arr.length >= MAX_ATTEMPTS) {
    attempts.set(ip, arr);
    return false;
  }
  arr.push(now);
  attempts.set(ip, arr);
  return true;
}

module.exports = (pub) => {
  pub.post('/api/public/lookup', async (ctx) => {
    const ip = (ctx.req.socket && ctx.req.socket.remoteAddress) || 'unknown';
    if (!recordAttempt(ip)) {
      throw new ApiError(429, 'too_many_attempts',
        'Too many attempts. Please wait a few minutes, or ask the class teacher to share the attendance.');
    }
    const enrollment = reqStr(ctx.body.enrollment_no, 'enrollment_no', { max: 40 }).trim();
    const dob = reqStr(ctx.body.dob, 'dob', { max: 12 }).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new ApiError(400, 'bad_request', 'Date of birth must be a valid date (YYYY-MM-DD).');
    }

    const s = db.prepare(`
      SELECT s.id, s.full_name, s.enrollment_no, s.roll_no, s.semester, s.batch,
             d.name AS department_name, sec.name AS section_name, c.name AS course_name
      FROM students s
      JOIN departments d ON d.id = s.department_id
      JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN courses c ON c.id = s.course_id
      WHERE s.enrollment_no = ? COLLATE NOCASE AND s.dob = ?
        AND s.status = 'active' AND s.deleted_at IS NULL`).get(enrollment, dob);

    if (!s) {
      // Identical answer for "no such enrollment" and "dob didn't match" — no hints.
      throw new ApiError(404, 'no_match',
        'No record matched that enrollment/roll number and date of birth. Please check the details, or ask the class teacher.');
    }

    const countExcused = getSetting('count_excused_as_applicable', '0') === '1';
    const overall = calc.studentOverall(s.id, countExcused);
    const bySubject = calc.studentBySubject(s.id, countExcused);
    const recentAbsences = db.prepare(`
      SELECT a.date, a.period, a.status, sb.code AS subject_code, sb.name AS subject_name
      FROM attendance_records a JOIN subjects sb ON sb.id = a.subject_id
      WHERE a.student_id = ? AND a.status = 'A'
      ORDER BY a.date DESC, a.id DESC LIMIT 10`).all(s.id);

    ctx.json(200, {
      ok: true,
      student: {
        name: s.full_name,
        enrollment_no: s.enrollment_no,
        roll_no: s.roll_no,
        department: s.department_name,
        course: s.course_name,
        section: s.section_name,
        semester: s.semester,
        batch: s.batch,
      },
      threshold: getSettingInt('threshold', 75),
      overall,
      by_subject: bySubject,
      recent_absences: recentAbsences,
      generated_at: nowIso(),
    });
  });
};
