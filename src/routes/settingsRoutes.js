'use strict';
/** Admin settings, audit log, dashboard, global search. */
const { db, allSettings, setSetting, getSetting } = require('../db');
const { ApiError, reqStr, optStr, reqInt, optInt, reqEnum, nowIso, pageParams, optDate } = require('../util');
const { audit } = require('../audit');
const { dashboard } = require('../services/dashboard');

const SETTING_KEYS = {
  institution_name: (v) => reqStr(v, 'institution_name', { max: 160 }),
  threshold: (v) => reqInt(v, 'threshold', { min: 1, max: 100 }),
  academic_year: (v) => optStr(v, 'academic_year', { max: 12 }) || '',
  timezone: (v) => {
    const tz = reqStr(v, 'timezone', { max: 60 });
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new ApiError(400, 'bad_request', `Unknown timezone "${tz}"`); }
    return tz;
  },
  upload_max_mb: (v) => reqInt(v, 'upload_max_mb', { min: 1, max: 50 }),
  count_excused_as_applicable: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  notification_policy: (v) => reqEnum(v, 'notification_policy', ['first_crossing', 'on_decrease', 'daily', 'weekly', 'manual']),
  notification_channels: (v) => {
    if (typeof v !== 'object' || !v) throw new ApiError(400, 'bad_request', 'notification_channels must be an object');
    return JSON.stringify({
      email: !!v.email, sms: !!v.sms, whatsapp: !!v.whatsapp,
    });
  },
  message_template: (v) => {
    const t = reqStr(v, 'message_template', { max: 2000 });
    return t;
  },
  demo_mode: (v) => (v === true || v === '1' ? '1' : '0'),
};

module.exports = function register(r) {
  r.get('/api/settings', async (ctx) => {
    if (ctx.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only admins can view system settings');
    ctx.json(200, { settings: allSettings() });
  });

  r.put('/api/settings', async (ctx) => {
    const changes = {};
    const errors = [];
    for (const [key, value] of Object.entries(ctx.body || {})) {
      const validator = SETTING_KEYS[key];
      if (!validator) { errors.push(`Unknown setting "${key}"`); continue; }
      try {
        const v = validator(value);
        const old = getSetting(key, null);
        if (String(v) !== String(old)) {
          setSetting(key, v);
          changes[key] = { old, new: v };
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (errors.length) throw new ApiError(400, 'bad_request', `Invalid settings: ${errors.join('; ')}`);
    if (Object.keys(changes).length) {
      audit({ userId: ctx.user.id, action: 'settings.changed', entity: 'settings', newValue: changes, req: ctx.req });
    }
    ctx.json(200, { ok: true, changed: Object.keys(changes) });
  });

  r.get('/api/audit-logs', async (ctx) => {
    if (ctx.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only admins can view audit logs');
    const { page, size, offset } = pageParams(ctx.query, 50);
    const where = ['1=1'];
    const args = [];
    if (ctx.query.action) { where.push('a.action LIKE ?'); args.push(`${ctx.query.action}%`); }
    if (ctx.query.entity) { where.push('a.entity = ?'); args.push(ctx.query.entity); }
    if (ctx.query.user_id) { where.push('a.user_id = ?'); args.push(Number(ctx.query.user_id)); }
    if (ctx.query.from) { where.push('a.created_at >= ?'); args.push(optDate(ctx.query.from, 'from') + 'T00:00:00'); }
    if (ctx.query.to) { where.push('a.created_at <= ?'); args.push(optDate(ctx.query.to, 'to') + 'T23:59:59'); }
    const w = 'WHERE ' + where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs a ${w}`).get(...args).c;
    const rows = db.prepare(`
      SELECT a.*, u.name AS user_name, u.email AS user_email
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, size, offset);
    ctx.json(200, { rows, total, page, size });
  });

  r.get('/api/dashboard', async (ctx) => {
    ctx.json(200, dashboard());
  });

  /** Global search: students, subjects, parents. */
  r.get('/api/search', async (ctx) => {
    const q = optStr(ctx.query.q, 'q', { max: 80 });
    if (!q || q.length < 2) { ctx.json(200, { students: [], subjects: [] }); return; }
    const like = `%${q}%`;
    const students = db.prepare(`
      SELECT s.id, s.full_name, s.roll_no, s.enrollment_no, s.parent_name, s.status,
             d.name AS department_name, sec.name AS section_name
      FROM students s JOIN departments d ON d.id=s.department_id JOIN sections sec ON sec.id=s.section_id
      WHERE s.deleted_at IS NULL AND (
        s.full_name LIKE ? COLLATE NOCASE OR s.roll_no LIKE ? OR s.enrollment_no LIKE ? OR s.parent_name LIKE ? COLLATE NOCASE)
      ORDER BY s.full_name LIMIT 12`).all(like, like, like, like);
    const subWhere = ctx.user.role === 'teacher' ? 'AND (sb.teacher_id = ' + Number(ctx.user.id) + ')' : '';
    const subjects = db.prepare(`
      SELECT sb.id, sb.code, sb.name, sec.name AS section_name, sb.semester
      FROM subjects sb JOIN sections sec ON sec.id = sb.section_id
      WHERE (sb.name LIKE ? COLLATE NOCASE OR sb.code LIKE ?) ${subWhere} LIMIT 6`).all(like, like);
    ctx.json(200, { students, subjects });
  });
};
