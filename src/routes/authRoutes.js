'use strict';
/** Auth endpoints: login, logout, me, forgot/reset, change password. */
const crypto = require('crypto');
const { db, setSetting, getSetting } = require('../db');
const {
  verifyPassword, hashPassword, validatePasswordStrength,
  createSession, destroySession, destroyUserSessions,
  sessionCookie, clearCookie,
  attachSession, csrfCheck, requireAuth,
  assertLoginAllowed, recordLoginFailure, recordLoginSuccess, loginThrottleKey,
} = require('../auth');
const { ApiError, reqEmail, reqStr, nowIso, genId, sha256 } = require('../util');
const { audit } = require('../audit');

function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role }; }

function publicSettings() {
  return {
    institution_name: getSetting('institution_name', 'Institution'),
    threshold: Number(getSetting('threshold', '75')) || 75,
    academic_year: getSetting('academic_year', ''),
    timezone: getSetting('timezone', 'UTC'),
    demo_mode: getSetting('demo_mode', '0') === '1',
    notification_policy: getSetting('notification_policy', 'first_crossing'),
  };
}

module.exports = function register(r) {
  r.post('/api/auth/login', async (ctx) => {
    const email = reqEmail(ctx.body.email);
    const password = reqStr(ctx.body.password, 'password', { max: 200 });
    const key = loginThrottleKey(ctx.req, email);
    assertLoginAllowed(key);

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordLoginFailure(key);
      audit({ action: 'auth.login_failed', entity: 'users', entityId: email, req: ctx.req });
      throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
    }
    if (!user.active) {
      throw new ApiError(403, 'account_disabled', 'This account has been deactivated. Contact the administrator.');
    }
    recordLoginSuccess(key);
    const session = createSession(user.id, ctx.req);
    audit({ userId: user.id, action: 'auth.login', entity: 'users', entityId: user.id, req: ctx.req });
    ctx.json(200, { user: publicUser(user), csrf: session.csrf, settings: publicSettings(), token: session.token }, {
      'Set-Cookie': sessionCookie(session.token, 12 * 3600, ctx.req),
    });
  });

  r.post('/api/auth/logout', attachSession, async (ctx) => {
    if (ctx.session) {
      destroySession(ctx.session.token);
      audit({ userId: ctx.user.id, action: 'auth.logout', entity: 'users', entityId: ctx.user.id, req: ctx.req });
    }
    ctx.json(200, { ok: true }, { 'Set-Cookie': clearCookie() });
  });

  r.get('/api/auth/me', attachSession, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, 'unauthorized', 'Not authenticated');
    ctx.json(200, { user: publicUser(ctx.user), csrf: ctx.session.csrf, settings: publicSettings(), token: ctx.session.token });
  });

  r.put('/api/auth/password', attachSession, csrfCheck, async (ctx) => {
    requireAuth(ctx);
    const current = reqStr(ctx.body.current_password, 'current_password', { max: 200 });
    const next = reqStr(ctx.body.new_password, 'new_password', { max: 200 });
    validatePasswordStrength(next);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    if (!verifyPassword(current, user.password_hash)) {
      throw new ApiError(400, 'bad_request', 'Current password is incorrect');
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), nowIso(), user.id);
    destroyUserSessions(user.id); // force re-login everywhere (new session below)
    const session = createSession(user.id, ctx.req);
    audit({ userId: user.id, action: 'auth.password_changed', entity: 'users', entityId: user.id, req: ctx.req });
    ctx.json(200, { ok: true, csrf: session.csrf, token: session.token }, {
      'Set-Cookie': sessionCookie(session.token, 12 * 3600, ctx.req),
    });
  });

  r.post('/api/auth/forgot', async (ctx) => {
    const email = reqEmail(ctx.body.email);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (user) {
      const token = genId(24);
      db.prepare('INSERT INTO password_resets(token_hash, user_id, expires_at, used, created_at) VALUES(?,?,?,0,?)')
        .run(sha256(Buffer.from(token)), user.id,
          new Date(Date.now() + 3600 * 1000).toISOString(), nowIso());
      audit({ userId: user.id, action: 'auth.reset_requested', entity: 'users', entityId: user.id, req: ctx.req });
      // Deliver through the email provider if one is configured; otherwise
      // surface it to the admin via the audit/notification log rather than
      // pretending an email was sent.
      const { sendNotification } = require('../services/notify');
      const link = `/reset?token=${token}`;
      if (process.env.EMAIL_WEBHOOK_URL) {
        await fetch(process.env.EMAIL_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: 'email', to: user.email,
            message: `Password reset requested. Open ${link} within 60 minutes to set a new password.`,
            meta: { kind: 'password_reset' },
          }),
        }).catch(() => {});
      }
      // In development/demo the token is also written to the data log so the
      // flow remains testable without a mail server. Never returned by API.
      if (process.env.SIMULATE_NOTIFICATIONS !== 'false') {
        const fs = require('fs'); const path = require('path');
        const { DATA_DIR } = require('../db');
        fs.appendFileSync(path.join(DATA_DIR, 'notifications.log'),
          JSON.stringify({ at: nowIso(), kind: 'password_reset', email: user.email, reset_link: link }) + '\n');
      }
    }
    ctx.json(200, { ok: true, message: 'If that email is registered, a reset link has been sent.' });
  });

  r.post('/api/auth/reset', async (ctx) => {
    const token = reqStr(ctx.body.token, 'token', { max: 200 });
    const next = reqStr(ctx.body.password, 'password', { max: 200 });
    validatePasswordStrength(next);
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(Buffer.from(token)));
    if (!row || row.used || row.expires_at < nowIso()) {
      throw new ApiError(400, 'bad_request', 'Reset link is invalid or has expired. Request a new one.');
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), nowIso(), row.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
    destroyUserSessions(row.user_id);
    audit({ userId: row.user_id, action: 'auth.password_reset', entity: 'users', entityId: row.user_id, req: ctx.req });
    ctx.json(200, { ok: true, message: 'Password updated. You can now log in.' });
  });
};
