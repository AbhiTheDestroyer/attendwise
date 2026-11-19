'use strict';
/**
 * Notification subsystem.
 *
 * Design:
 *  ┌ NotificationService ──────────────┐
 *  │ rules engine (when to notify)     │ → never spams: state machine per
 *  │ template rendering                │   (student × subject), policies:
 *  │ delivery via pluggable providers  │   first_crossing | on_decrease |
 *  └──────────┬────────────────────────┘   daily | weekly | manual
 *             ▼
 *   Provider registry:
 *     - webhook (real HTTPS delivery, env-configured, per channel)
 *     - log     (dev/demo sink: writes data/notifications.log, response
 *                is honestly marked {"simulated": true})
 * A channel whose provider is not configured FAILS honestly — the UI then
 * shows "provider_not_configured", it never pretends a message went out.
 */
const fs = require('fs');
const path = require('path');
const { db, getSetting, DATA_DIR } = require('../db');
const { nowIso, clampStr } = require('../util');
const calc = require('./calc');
const { audit } = require('../audit');

/* ------------------------------- templates -------------------------------- */
const DEFAULT_TEMPLATE = `Dear Parent/Guardian,

This is to inform you that your ward [Student Name], Roll No. [Roll No], currently has an attendance of [Attendance %] in [Subject] ([Present Classes]/[Total Classes] classes attended).

The minimum required attendance is [Threshold]%.

Please take the necessary action.

Regards,
[Institution Name]`;

function renderTemplate(template, vars) {
  return String(template || DEFAULT_TEMPLATE).replace(/\[([^\]]+)\]/g, (m, key) => {
    const k = key.trim().toLowerCase();
    return vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m;
  });
}

function settings() {
  let channels = { email: true, sms: false, whatsapp: false };
  try { channels = { ...channels, ...JSON.parse(getSetting('notification_channels', '{}')) }; } catch { /* keep defaults */ }
  return {
    threshold: Number(getSetting('threshold', '75')) || 75,
    policy: getSetting('notification_policy', 'first_crossing'),
    channels,
    template: getSetting('message_template', DEFAULT_TEMPLATE),
    institution: getSetting('institution_name', 'Institution'),
    countExcused: getSetting('count_excused_as_applicable', '0') === '1',
    simulate: process.env.SIMULATE_NOTIFICATIONS !== 'false',
  };
}

/* -------------------------------- providers ------------------------------- */
const { nativeProvider, toE164 } = require('./providers');
const WEBHOOK_ENV = {
  email: ['EMAIL_WEBHOOK_URL', 'EMAIL_WEBHOOK_AUTH'],
  sms: ['SMS_WEBHOOK_URL', 'SMS_WEBHOOK_AUTH'],
  whatsapp: ['WHATSAPP_WEBHOOK_URL', 'WHATSAPP_WEBHOOK_AUTH'],
};

function providerStatus() {
  const s = settings();
  const out = {};
  for (const ch of ['email', 'sms', 'whatsapp']) {
    const [urlEnv] = WEBHOOK_ENV[ch];
    const native = nativeProvider(ch);
    const webhookConfigured = !!process.env[urlEnv];
    out[ch] = {
      enabled: !!s.channels[ch],
      webhook_configured: webhookConfigured,
      log_fallback: s.simulate && !native && !webhookConfigured,
      provider: native ? native.name : (webhookConfigured ? 'webhook' : (s.simulate ? 'log' : 'none')),
    };
  }
  return out;
}

async function deliverViaWebhook(url, authHeader, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: `Bearer ${authHeader}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = clampStr(await res.text(), 400) || '';
    return { ok: res.ok, status: res.status, response: text };
  } finally {
    clearTimeout(timer);
  }
}

function deliverViaLog(payload) {
  const line = JSON.stringify({ at: nowIso(), ...payload }) + '\n';
  fs.appendFileSync(path.join(DATA_DIR, 'notifications.log'), line);
  return { ok: true, status: 200, response: JSON.stringify({ simulated: true, sink: 'notifications.log' }) };
}

/** Route one message through the configured provider. Never throws. */
async function deliver(channel, payload) {
  const [urlEnv, authEnv] = WEBHOOK_ENV[channel];
  const native = nativeProvider(channel);
  if (native) {
    try {
      return { provider: native.name, ...(await native.send(payload)) };
    } catch (e) {
      return { provider: native.name, ok: false, status: 0, response: '', networkError: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 200) };
    }
  }
  if (process.env[urlEnv]) {
    try {
      return { provider: 'webhook', ...(await deliverViaWebhook(process.env[urlEnv], process.env[authEnv], payload)) };
    } catch (e) {
      return { provider: 'webhook', ok: false, status: 0, response: '', networkError: e.name === 'AbortError' ? 'timeout' : String(e.message || e).slice(0, 200) };
    }
  }
  if (process.env.SIMULATE_NOTIFICATIONS !== 'false') {
    return { provider: 'log', ...deliverViaLog(payload) };
  }
  return { provider: 'none', ok: false, status: 0, response: '', errorCode: 'provider_not_configured' };
}

/* ------------------------------ core sending ------------------------------ */
function recipientFor(student, channel) {
  if (channel === 'email') return student.parent_email;
  return student.parent_phone; // sms & whatsapp
}

/**
 * Create + attempt one notification event with full safety checks.
 * Returns the event row. Never throws on delivery problems — records them.
 */
async function sendNotification({ studentId, subjectId, channel, type = 'threshold', rule = 'manual', userId = null, messageOverride = null }) {
  const s = settings();
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  const subject = subjectId ? db.prepare('SELECT * FROM subjects WHERE id = ?').get(subjectId) : null;
  const insert = db.prepare(`INSERT INTO notification_events
    (student_id, subject_id, channel, recipient, message, attendance_bp, type, status, provider, provider_response, error, rule, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const base = {
    student_id: studentId, subject_id: subjectId || null, channel,
    type, rule, created_by: userId, created_at: nowIso(),
  };
  const finish = (fields) => {
    const info = insert.run(
      base.student_id, base.subject_id, channel, fields.recipient ?? null,
      fields.message ?? null, fields.attendance_bp ?? null, type, fields.status,
      fields.provider ?? null, fields.provider_response ?? null, fields.error ?? null,
      rule, userId, base.created_at,
    );
    return { id: info.lastInsertRowid, ...base, ...fields };
  };

  // ── safety gates ──
  if (!student) return finish({ status: 'skipped', error: 'student_not_found' });
  if (student.status !== 'active') {
    return finish({ recipient: null, status: 'skipped', error: `student_${student.status}` });
  }
  const recipient = recipientFor(student, channel);
  if (!recipient) {
    return finish({ status: 'skipped', error: 'no_parent_contact' });
  }

  const summary = subjectId
    ? calc.studentSubjectSummary(studentId, subjectId, s.countExcused)
    : calc.studentOverall(studentId, s.countExcused);
  if (summary.applicable === 0) {
    return finish({ recipient, attendance_bp: null, status: 'skipped', error: 'no_applicable_classes' });
  }

  const vars = {
    'student name': student.full_name,
    'roll no': student.roll_no,
    'enrollment no': student.enrollment_no,
    'subject': subject ? `${subject.name} (${subject.code})` : 'all subjects',
    'attendance %': calc.fmtPct(summary.pct_bp),
    'threshold': s.threshold,
    'present classes': summary.present,
    'total classes': summary.applicable,
    'institution name': s.institution,
  };
  const message = messageOverride ? renderTemplate(messageOverride, vars) : renderTemplate(s.template, vars);

  const payload = {
    channel, to: recipient, message,
    student: { id: student.id, name: student.full_name, roll_no: student.roll_no, enrollment_no: student.enrollment_no },
    meta: { subject_id: subjectId || null, attendance_bp: summary.pct_bp, threshold: s.threshold, rule, type },
  };

  const result = await deliver(channel, payload);
  const providerResponse = clampStr(
    JSON.stringify({ status: result.status, body: result.response, ...(result.networkError ? { network_error: result.networkError } : {}) }),
    900,
  );
  if (result.ok) {
    return finish({
      recipient, message, attendance_bp: summary.pct_bp,
      status: 'sent', provider: result.provider, provider_response: providerResponse,
    });
  }
  return finish({
    recipient, message, attendance_bp: summary.pct_bp,
    status: 'failed', provider: result.provider === 'none' ? null : result.provider,
    provider_response: providerResponse,
    error: result.errorCode || (result.networkError ? `network:${result.networkError}` : `provider_http_${result.status}`),
  });
}

/* ------------------------------- rules engine ----------------------------- */
function getState(studentId, subjectId) {
  return db.prepare('SELECT * FROM notification_state WHERE student_id = ? AND subject_id = ?')
    .get(studentId, subjectId) || null;
}
function upsertState(studentId, subjectId, patch) {
  const existing = getState(studentId, subjectId);
  if (existing) {
    const next = { ...existing, ...patch, updated_at: nowIso() };
    db.prepare(`UPDATE notification_state SET below=?, last_pct_bp=?, crossing_notified=?,
                last_notified_at=?, last_attempt_at=?, updated_at=?
                WHERE student_id=? AND subject_id=?`)
      .run(next.below, next.last_pct_bp, next.crossing_notified, next.last_notified_at,
        next.last_attempt_at, next.updated_at, studentId, subjectId);
  } else {
    db.prepare(`INSERT INTO notification_state
      (student_id, subject_id, below, last_pct_bp, crossing_notified, last_notified_at, last_attempt_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(studentId, subjectId, patch.below ?? 0, patch.last_pct_bp ?? null,
        patch.crossing_notified ?? 0, patch.last_notified_at ?? null,
        patch.last_attempt_at ?? null, nowIso());
  }
}

/**
 * Evaluate one (student × subject) after its attendance changed and send a
 * notification if the configured policy demands it. Idempotent across
 * refreshes/restarts because everything is DB state, never memory.
 *
 * @returns {string} 'sent' | 'skipped_*' | 'not_due' | 'failed' | 'above'
 */
async function evaluateThreshold(studentId, subjectId, { userId = null } = {}) {
  const s = settings();
  if (s.policy === 'manual') {
    // still track state so manual send has accurate context
    const sum0 = calc.studentSubjectSummary(studentId, subjectId, s.countExcused);
    if (sum0.applicable > 0) {
      upsertState(studentId, subjectId, {
        below: calc.isBelow(sum0.present, sum0.applicable, s.threshold) ? 1 : 0,
        last_pct_bp: sum0.pct_bp,
      });
    }
    return 'manual_policy';
  }
  const sum = calc.studentSubjectSummary(studentId, subjectId, s.countExcused);
  if (sum.applicable === 0) return 'not_due';
  const below = calc.isBelow(sum.present, sum.applicable, s.threshold);
  const state = getState(studentId, subjectId);

  if (!below) {
    // recovered: reset crossing flag so a *future* crossing re-triggers once
    upsertState(studentId, subjectId, { below: 0, last_pct_bp: sum.pct_bp, crossing_notified: 0 });
    return 'above';
  }

  const now = nowIso();
  let due = false;
  let rule = s.policy;
  switch (s.policy) {
    case 'first_crossing':
      due = !state || !state.crossing_notified;
      break;
    case 'on_decrease':
      due = !state || !state.below || state.last_pct_bp === null || sum.pct_bp < state.last_pct_bp;
      rule = state && state.below && state.last_pct_bp !== null && sum.pct_bp < state.last_pct_bp
        ? 'on_decrease' : 'first_crossing';
      break;
    case 'daily':
      due = !state || !state.last_attempt_at || state.last_attempt_at.slice(0, 10) < now.slice(0, 10);
      break;
    case 'weekly':
      due = !state || !state.last_attempt_at ||
        (Date.parse(now) - Date.parse(state.last_attempt_at)) >= 7 * 86400000;
      break;
    default:
      due = !state || !state.crossing_notified;
      rule = 'first_crossing';
  }

  if (!due) {
    upsertState(studentId, subjectId, { below: 1, last_pct_bp: sum.pct_bp });
    return 'not_due';
  }

  // pick first enabled channel that yields a recipient, else first enabled
  const channelOrder = ['email', 'sms', 'whatsapp'];
  const enabled = channelOrder.filter((c) => s.channels[c]);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  const channel = enabled.find((c) => recipientFor(student, c)) || enabled[0] || 'email';

  const event = await sendNotification({
    studentId, subjectId, channel, type: 'threshold', rule, userId,
  });
  const attempted = now;
  const patch = { below: 1, last_pct_bp: sum.pct_bp, last_attempt_at: attempted };
  if (event.status === 'sent' || event.status === 'delivered') {
    patch.last_notified_at = attempted;
    patch.crossing_notified = 1;
  } else if (event.status === 'skipped') {
    patch.last_notified_at = state?.last_notified_at ?? null;
    patch.crossing_notified = 1; // do not spam skipped rows every save
  }
  upsertState(studentId, subjectId, patch);
  audit({ userId, action: `notification.${event.status}`, entity: 'notification_events', entityId: event.id, newValue: { studentId, subjectId, channel, rule, error: event.error } });
  return event.status === 'sent' ? 'sent' : event.status;
}

/** Evaluate many students for one subject (e.g., after an import/attendance save). */
async function evaluateBulk(studentIds, subjectId, opts = {}) {
  const results = { sent: 0, skipped: 0, failed: 0, not_due: 0, above: 0, manual_policy: 0 };
  const uniq = [...new Set(studentIds)];
  for (const id of uniq) {
    const r = await evaluateThreshold(id, subjectId, opts);
    if (r === 'sent') results.sent++;
    else if (r === 'failed') results.failed++;
    else if (r === 'above') results.above++;
    else if (r === 'manual_policy') results.manual_policy++;
    else if (String(r).startsWith('skipped')) results.skipped++;
    else results.not_due++;
  }
  return results;
}

/** Retry a previously failed/skipped event through the same channel. */
async function retryEvent(eventId, userId) {
  const ev = db.prepare('SELECT * FROM notification_events WHERE id = ?').get(eventId);
  if (!ev) return { ok: false, error: 'not_found' };
  if (ev.status !== 'failed' && ev.status !== 'skipped') {
    return { ok: false, error: `cannot_retry_status_${ev.status}` };
  }
  const event = await sendNotification({
    studentId: ev.student_id, subjectId: ev.subject_id, channel: ev.channel,
    type: ev.type, rule: 'retry', userId,
  });
  audit({
    userId, action: `notification.retry.${event.status}`, entity: 'notification_events',
    entityId: ev.id, oldValue: { status: ev.status, error: ev.error },
    newValue: { new_event_id: event.id, status: event.status, error: event.error },
  });
  return { ok: event.status === 'sent', event };
}

module.exports = {
  DEFAULT_TEMPLATE, renderTemplate, settings, providerStatus,
  sendNotification, evaluateThreshold, evaluateBulk, retryEvent, getState,
};
