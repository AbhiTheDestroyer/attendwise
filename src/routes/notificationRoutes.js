'use strict';
/** Notifications: history, manual send to defaulters, retry, provider status. */
const { db, getSetting } = require('../db');
const { ApiError, reqInt, reqEnum, optStr, nowIso, pageParams, optDate } = require('../util');
const { audit } = require('../audit');
const calc = require('../services/calc');
const notify = require('../services/notify');

module.exports = function register(r) {
  r.get('/api/notifications', async (ctx) => {
    const { page, size, offset } = pageParams(ctx.query, 25);
    const where = ['1=1'];
    const args = [];
    if (ctx.user.role === 'teacher') {
      where.push('(n.subject_id IS NULL OR n.subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?))');
      args.push(ctx.user.id);
    }
    if (ctx.query.status) { where.push('n.status = ?'); args.push(reqEnum(ctx.query.status, 'status', ['pending', 'sent', 'delivered', 'failed', 'skipped'])); }
    if (ctx.query.channel) { where.push('n.channel = ?'); args.push(reqEnum(ctx.query.channel, 'channel', ['email', 'sms', 'whatsapp'])); }
    if (ctx.query.student_id) { where.push('n.student_id = ?'); args.push(Number(ctx.query.student_id)); }
    if (ctx.query.from) { where.push('n.created_at >= ?'); args.push(optDate(ctx.query.from, 'from') + 'T00:00:00'); }
    if (ctx.query.to) { where.push('n.created_at <= ?'); args.push(optDate(ctx.query.to, 'to') + 'T23:59:59'); }
    if (ctx.query.q) {
      where.push('(s.full_name LIKE ? OR s.roll_no LIKE ? OR n.recipient LIKE ?)');
      args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`, `%${ctx.query.q}%`);
    }
    const w = 'WHERE ' + where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM notification_events n JOIN students s ON s.id = n.student_id ${w}`).get(...args).c;
    const rows = db.prepare(`
      SELECT n.*, s.full_name AS student_name, s.roll_no, s.parent_name, sb.code AS subject_code, sb.name AS subject_name,
             u.name AS created_by_name
      FROM notification_events n
      JOIN students s ON s.id = n.student_id
      LEFT JOIN subjects sb ON sb.id = n.subject_id
      LEFT JOIN users u ON u.id = n.created_by
      ${w} ORDER BY n.id DESC LIMIT ? OFFSET ?`).all(...args, size, offset);
    const counts = db.prepare('SELECT status, COUNT(*) c FROM notification_events GROUP BY status').all()
      .reduce((o, x) => ({ ...o, [x.status]: x.c }), {});
    ctx.json(200, { rows, total, page, size, counts });
  });

  /** Provider configuration status (honest UI: shows what can actually send). */
  r.get('/api/notifications/providers', async (ctx) => {
    ctx.json(200, { providers: notify.providerStatus(), settings: {
      policy: getSetting('notification_policy', 'first_crossing'),
      threshold: Number(getSetting('threshold', '75')) || 75,
    } });
  });

  /**
   * Manual send, e.g. from the defaulters page. Safety checks per student:
   * active enrollment, parent contact on file, and genuinely below the
   * configured threshold right now. Each outcome is recorded truthfully.
   */
  r.post('/api/notifications/send', async (ctx) => {
    const channel = reqEnum(ctx.body.channel, 'channel', ['email', 'sms', 'whatsapp']);
    const items = Array.isArray(ctx.body.items) ? ctx.body.items : null;
    if (!items || !items.length) throw new ApiError(400, 'bad_request', 'items must be a non-empty array of {student_id, subject_id}');
    if (items.length > 500) throw new ApiError(400, 'bad_request', 'Too many recipients (max 500 per batch)');

    const s = notify.settings();
    if (!s.channels[channel]) {
      throw new ApiError(400, 'bad_request', `The ${channel} channel is disabled in Settings. Enable it first.`);
    }
    const countExcused = s.countExcused;
    const results = [];
    for (const it of items) {
      const studentId = reqInt(it.student_id, 'student_id', { min: 1 });
      const subjectId = it.subject_id ? reqInt(it.subject_id, 'subject_id', { min: 1 }) : null;
      const student = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(studentId);
      if (!student) { results.push({ student_id: studentId, ok: false, status: 'skipped', error: 'student_not_found' }); continue; }
      if (student.status !== 'active') { results.push({ student_id: studentId, ok: false, status: 'skipped', error: `student_${student.status}` }); continue; }
      const sum = subjectId
        ? calc.studentSubjectSummary(studentId, subjectId, countExcused)
        : calc.studentOverall(studentId, countExcused);
      if (sum.applicable === 0) { results.push({ student_id: studentId, ok: false, status: 'skipped', error: 'no_applicable_classes' }); continue; }
      if (!calc.isBelow(sum.present, sum.applicable, s.threshold)) {
        results.push({
          student_id: studentId, ok: false, status: 'skipped', error: 'not_below_threshold',
          pct_bp: sum.pct_bp,
        });
        continue;
      }
      const event = await notify.sendNotification({
        studentId, subjectId, channel, type: 'manual', rule: 'manual', userId: ctx.user.id,
      });
      results.push({ student_id: studentId, ok: event.status === 'sent', status: event.status, error: event.error || null, event_id: event.id });
    }
    const summary = {
      sent: results.filter((x) => x.ok).length,
      skipped: results.filter((x) => x.status === 'skipped').length,
      failed: results.filter((x) => x.status === 'failed').length,
    };
    audit({ userId: ctx.user.id, action: 'notification.manual_send', entity: 'notification_events', newValue: { channel, ...summary }, req: ctx.req });
    ctx.json(200, { results, summary });
  });

  r.post('/api/notifications/:id/retry', async (ctx) => {
    const id = reqInt(ctx.params.id, 'id', { min: 1 });
    const out = await notify.retryEvent(id, ctx.user.id);
    if (!out.ok && !out.event) throw new ApiError(400, 'bad_request', `Cannot retry: ${out.error}`);
    ctx.json(200, out);
  });
};
