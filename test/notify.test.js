'use strict';
/**
 * Notification rules engine tests (§19/20/22):
 * no duplicate sends on refresh, policy variants, missing contacts,
 * honest failure when no provider is configured.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir, makeFixtures, addStudent, setAttend } = require('./helpers');
freshDataDir();
process.env.SIMULATE_NOTIFICATIONS = 'true';
const { db, setSetting } = require('../src/db');
const notify = require('../src/services/notify');

const fx = (() => {
  const { hashPassword } = require('../src/auth');
  return makeFixtures(db, { hashPassword });
})();

setSetting('institution_name', 'Test Institute');
setSetting('threshold', '75');
setSetting('notification_channels', JSON.stringify({ email: true, sms: true, whatsapp: false }));
setSetting('notification_policy', 'first_crossing');

const events = (sid) => db.prepare('SELECT * FROM notification_events WHERE student_id = ? ORDER BY id').all(sid);

function mkStudent(roll, name, present, total, opts = {}) {
  const sid = addStudent(db, { section: fx.section, dept: fx.dept, roll, name, ...opts });
  const specs = [];
  for (let i = 0; i < total; i++) specs.push([`2026-09-${String(10 + i).padStart(2, '0')}`, i < present ? 'P' : 'A']);
  setAttend(db, sid, fx.subject, specs, fx.teacher);
  return sid;
}

test('first_crossing: notify once, then silence on re-evaluation (refresh-safe)', async () => {
  const sid = mkStudent('51', 'Borderline Student', 14, 20); // 70%
  const r1 = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r1, 'sent');
  const r2 = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r2, 'not_due');
  const r3 = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r3, 'not_due');
  assert.equal(events(sid).length, 1);
  const ev = events(sid)[0];
  assert.equal(ev.status, 'sent');
  assert.equal(ev.provider, 'log');
  assert.match(ev.provider_response, /simulated/); // honestly labeled
  assert.match(ev.message, /Borderline Student/);
  assert.match(ev.message, /70%/);
  assert.match(ev.message, /75%/);
  assert.match(ev.message, /Test Institute/);
});

test('crossing state resets when student recovers above threshold', async () => {
  const sid = mkStudent('52', 'Recovery Student', 14, 20);
  await notify.evaluateThreshold(sid, fx.subject);
  // student attends the next 10 classes → 24/30 = 80%
  setAttend(db, sid, fx.subject, Array.from({ length: 10 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, 'P']), fx.teacher);
  const r = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r, 'above');
  const st = notify.getState(sid, fx.subject);
  assert.equal(st.below, 0);
  assert.equal(st.crossing_notified, 0); // a NEW crossing will re-notify once
});

test('on_decrease policy fires on genuine decreases only', async () => {
  setSetting('notification_policy', 'on_decrease');
  const sid = mkStudent('53', 'Declining Student', 14, 20); // 70%
  assert.equal(await notify.evaluateThreshold(sid, fx.subject), 'sent'); // first crossing
  assert.equal(await notify.evaluateThreshold(sid, fx.subject), 'not_due'); // same pct → silence
  setAttend(db, sid, fx.subject, [['2026-10-01', 'A']], fx.teacher); // 14/21 ≈ 66.7%
  assert.equal(await notify.evaluateThreshold(sid, fx.subject), 'sent'); // decreased → notify
  setAttend(db, sid, fx.subject, [['2026-10-02', 'P']], fx.teacher); // 15/22 ≈ 68.2% (still below, but improved)
  assert.equal(await notify.evaluateThreshold(sid, fx.subject), 'not_due');
  setSetting('notification_policy', 'first_crossing');
});

test('missing parent contact → skipped, never faked as sent, no spam', async () => {
  const sid = mkStudent('54', 'No Contact Student', 10, 20, { parent_email: null, parent_phone: null });
  const r = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r, 'skipped');
  const evs = events(sid);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].status, 'skipped');
  assert.equal(evs[0].error, 'no_parent_contact');
  assert.equal(evs[0].recipient, null);
  assert.equal(await notify.evaluateThreshold(sid, fx.subject), 'not_due'); // once per crossing
});

test('above-threshold student generates no event at all', async () => {
  const sid = mkStudent('55', 'Safe Student', 18, 20); // 90%
  const r = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r, 'above');
  assert.equal(events(sid).length, 0);
});

test('manual policy never auto-sends but keeps state fresh', async () => {
  setSetting('notification_policy', 'manual');
  const sid = mkStudent('56', 'Manual Policy Student', 10, 20);
  const r = await notify.evaluateThreshold(sid, fx.subject);
  assert.equal(r, 'manual_policy');
  assert.equal(events(sid).length, 0);
  assert.equal(notify.getState(sid, fx.subject).below, 1);
  setSetting('notification_policy', 'first_crossing');
});

test('no provider configured → honest failure, recorded as failed', async () => {
  const saved = process.env.SIMULATE_NOTIFICATIONS;
  process.env.SIMULATE_NOTIFICATIONS = 'false';
  const sid = mkStudent('57', 'Unsendable Student', 5, 20);
  const ev = await notify.sendNotification({ studentId: sid, subjectId: fx.subject, channel: 'email', type: 'manual', rule: 'manual' });
  assert.equal(ev.status, 'failed');
  assert.equal(ev.error, 'provider_not_configured');
  assert.equal(events(sid).filter((e) => e.status === 'sent').length, 0);
  process.env.SIMULATE_NOTIFICATIONS = saved;
});

test('inactive student is skipped', async () => {
  const sid = mkStudent('58', 'Left Student', 5, 20, { status: 'transferred' });
  const ev = await notify.sendNotification({ studentId: sid, subjectId: fx.subject, channel: 'email' });
  assert.equal(ev.status, 'skipped');
  assert.match(ev.error, /transferred/);
});
