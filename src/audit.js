'use strict';
/** Audit trail writer. Old/new values are stored as JSON (truncated). */
const { db } = require('./db');
const { nowIso, clampStr } = require('./util');
const { clientIp } = require('./auth');

const MAX = 4000;
const pack = (v) => (v === undefined ? null : clampStr(JSON.stringify(v), MAX));

/**
 * @param {object} p userId, action, entity, entityId, oldValue, newValue, req
 */
function audit({ userId = null, action, entity = null, entityId = null, oldValue, newValue, req = null }) {
  db.prepare(`INSERT INTO audit_logs(user_id, action, entity, entity_id, old_value, new_value, ip, user_agent, created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(
      userId, action, entity, entityId === null ? null : String(entityId),
      pack(oldValue), pack(newValue),
      req ? clientIp(req) : null,
      req ? clampStr(req.headers['user-agent'] || '', 300) : null,
      nowIso(),
    );
}

/** Per-record attendance change history (powers the "who changed what" view). */
function attendanceAudit({ recordId = null, studentId, subjectId, date, period, oldStatus, newStatus, reason = null, userId }) {
  db.prepare(`INSERT INTO attendance_audit(record_id, student_id, subject_id, date, period, old_status, new_status, reason, changed_by, created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(recordId, studentId, subjectId, date, period, oldStatus, newStatus, clampStr(reason, 500), userId, nowIso());
}

module.exports = { audit, attendanceAudit };
