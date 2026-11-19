'use strict';
/** Dashboard aggregations — every chart answers a decision-relevant question. */
const { db, getSetting } = require('../db');
const { todayInTz } = require('../util');
const { pctBp } = require('./calc');

function dashboard() {
  const tz = getSetting('timezone', 'UTC');
  const today = todayInTz(tz);
  const threshold = Number(getSetting('threshold', '75')) || 75;
  const countExcused = getSetting('count_excused_as_applicable', '0') === '1';
  const appSql = countExcused
    ? `SUM(CASE WHEN a.status IN ('P','A','E') THEN 1 ELSE 0 END)`
    : `SUM(CASE WHEN a.status IN ('P','A') THEN 1 ELSE 0 END)`;

  const cards = {
    students: db.prepare(`SELECT COUNT(*) c FROM students WHERE status='active'`).get().c,
    teachers: db.prepare(`SELECT COUNT(*) c FROM users WHERE role='teacher' AND active=1`).get().c,
    subjects: db.prepare(`SELECT COUNT(*) c FROM subjects WHERE status='active'`).get().c,
    records: db.prepare('SELECT COUNT(*) c FROM attendance_records').get().c,
  };

  const todayRows = db.prepare(`
    SELECT a.status, COUNT(DISTINCT a.student_id) c
    FROM attendance_records a JOIN students s ON s.id=a.student_id AND s.status='active'
    WHERE a.date = ? GROUP BY a.status`).all(today);
  const todayByStatus = { P: 0, A: 0, E: 0, H: 0, C: 0 };
  for (const r of todayRows) todayByStatus[r.status] = r.c;

  // institution-wide weighted average + defaulter counts (student-level overall)
  const overall = db.prepare(`
    WITH agg AS (
      SELECT a.student_id,
        SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
        ${appSql} applicable
      FROM attendance_records a
      JOIN students s ON s.id = a.student_id AND s.status='active'
      GROUP BY a.student_id
    )
    SELECT
      SUM(present) tp, SUM(applicable) ta,
      SUM(CASE WHEN applicable > 0 AND present * 100 < ? * applicable THEN 1 ELSE 0 END) below
    FROM agg`).get(threshold);
  cards.average_bp = overall.ta ? pctBp(overall.tp, overall.ta) : null;
  cards.below_threshold = overall.below || 0;

  const notif = db.prepare(`
    SELECT status, COUNT(*) c FROM notification_events GROUP BY status`).all()
    .reduce((o, r) => ({ ...o, [r.status]: r.c }), {});
  cards.notifications_sent = (notif.sent || 0) + (notif.delivered || 0);
  cards.notifications_failed = notif.failed || 0;

  // attendance distribution (per-student overall), buckets of decision value
  const dist = db.prepare(`
    WITH agg AS (
      SELECT a.student_id,
        SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
        ${appSql} applicable
      FROM attendance_records a
      JOIN students s ON s.id = a.student_id AND s.status='active'
      GROUP BY a.student_id
    )
    SELECT
      SUM(CASE WHEN applicable>0 AND present*100 < 50*applicable THEN 1 ELSE 0 END) b50,
      SUM(CASE WHEN applicable>0 AND present*100 >= 50*applicable AND present*100 < 60*applicable THEN 1 ELSE 0 END) b60,
      SUM(CASE WHEN applicable>0 AND present*100 >= 60*applicable AND present*100 < 70*applicable THEN 1 ELSE 0 END) b70,
      SUM(CASE WHEN applicable>0 AND present*100 >= 70*applicable AND present*100 < 75*applicable THEN 1 ELSE 0 END) b75,
      SUM(CASE WHEN applicable>0 AND present*100 >= 75*applicable AND present*100 < 80*applicable THEN 1 ELSE 0 END) b80,
      SUM(CASE WHEN applicable>0 AND present*100 >= 80*applicable AND present*100 < 90*applicable THEN 1 ELSE 0 END) b90,
      SUM(CASE WHEN applicable>0 AND present*100 >= 90*applicable THEN 1 ELSE 0 END) b100
    FROM agg`).get();

  // 14-day daily presence-rate trend
  const trend = db.prepare(`
    SELECT a.date,
      SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
      ${appSql} applicable
    FROM attendance_records a
    JOIN students s ON s.id = a.student_id AND s.status='active'
    WHERE a.date >= date(?, '-21 days') AND a.date <= ?
    GROUP BY a.date ORDER BY a.date`).all(today, today)
    .map((r) => ({ date: r.date, pct_bp: pctBp(r.present, r.applicable), present: r.present, applicable: r.applicable }));

  // department comparison
  const departments = db.prepare(`
    SELECT d.name,
      SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
      ${appSql} applicable
    FROM attendance_records a
    JOIN students s ON s.id = a.student_id AND s.status='active'
    JOIN departments d ON d.id = s.department_id
    GROUP BY d.id ORDER BY d.name`).all()
    .map((r) => ({ name: r.name, pct_bp: pctBp(r.present, r.applicable) }));

  // weakest subjects (avg below 100 sorted ascending) — "which subjects need attention"
  const subjects = db.prepare(`
    SELECT sb.code, sb.name,
      SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
      ${appSql} applicable
    FROM attendance_records a
    JOIN subjects sb ON sb.id = a.subject_id
    JOIN students s ON s.id = a.student_id AND s.status='active'
    GROUP BY sb.id HAVING applicable > 0 ORDER BY (present*1.0/applicable) ASC LIMIT 8`).all()
    .map((r) => ({ code: r.code, name: r.name, pct_bp: pctBp(r.present, r.applicable) }));

  // monthly trend (decision: are we getting better?)
  const monthly = db.prepare(`
    SELECT substr(a.date, 1, 7) ym,
      SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) present,
      ${appSql} applicable
    FROM attendance_records a
    JOIN students s ON s.id = a.student_id AND s.status='active'
    GROUP BY ym ORDER BY ym DESC LIMIT 6`).all().reverse()
    .map((r) => ({ month: r.ym, pct_bp: pctBp(r.present, r.applicable) }));

  return {
    today, threshold,
    cards: { ...cards, present_today: todayByStatus.P, absent_today: todayByStatus.A },
    distribution: dist,
    trend, departments, subjects, monthly,
    notifications: notif,
  };
}

module.exports = { dashboard };
