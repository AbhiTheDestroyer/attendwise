'use strict';
/** Admin: manage teacher/admin accounts. */
const { db } = require('../db');
const { hashPassword, validatePasswordStrength, destroyUserSessions } = require('../auth');
const { ApiError, reqStr, reqEmail, reqEnum, nowIso, pageParams } = require('../util');
const { audit } = require('../audit');

module.exports = function register(r) {
  r.get('/api/users', async (ctx) => {
    const { size, offset, page } = pageParams(ctx.query, 50);
    const where = [];
    const args = [];
    if (ctx.query.role) { where.push('role = ?'); args.push(reqEnum(ctx.query.role, 'role', ['admin', 'teacher'])); }
    if (ctx.query.q) {
      where.push('(name LIKE ? OR email LIKE ?)');
      args.push(`%${ctx.query.q}%`, `%${ctx.query.q}%`);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM users ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT id, name, email, role, active, created_at FROM users ${w}
                             ORDER BY name LIMIT ? OFFSET ?`).all(...args, size, offset);
    ctx.json(200, { rows, total, page, size });
  });

  r.post('/api/users', async (ctx) => {
    const name = reqStr(ctx.body.name, 'name', { max: 120 });
    const email = reqEmail(ctx.body.email);
    const role = reqEnum(ctx.body.role, 'role', ['admin', 'teacher']);
    const password = reqStr(ctx.body.password, 'password', { max: 200 });
    validatePasswordStrength(password);
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      throw new ApiError(409, 'duplicate', `A user with email ${email} already exists`);
    }
    const info = db.prepare(`INSERT INTO users(name, email, password_hash, role, active, created_at)
                             VALUES(?,?,?,?,1,?)`)
      .run(name, email, hashPassword(password), role, nowIso());
    audit({ userId: ctx.user.id, action: 'user.created', entity: 'users', entityId: info.lastInsertRowid, newValue: { name, email, role }, req: ctx.req });
    ctx.json(201, { id: info.lastInsertRowid, name, email, role });
  });

  r.put('/api/users/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new ApiError(404, 'not_found', 'User not found');
    const patch = {};
    const changes = {};
    if (ctx.body.name !== undefined) { patch.name = reqStr(ctx.body.name, 'name', { max: 120 }); changes.name = patch.name; }
    if (ctx.body.role !== undefined) {
      patch.role = reqEnum(ctx.body.role, 'role', ['admin', 'teacher']);
      if (user.id === ctx.user.id && patch.role !== user.role) {
        throw new ApiError(400, 'bad_request', 'You cannot change your own role');
      }
      changes.role = patch.role;
    }
    if (ctx.body.active !== undefined) {
      patch.active = ctx.body.active ? 1 : 0;
      if (user.id === ctx.user.id && !patch.active) {
        throw new ApiError(400, 'bad_request', 'You cannot deactivate your own account');
      }
      changes.active = !!patch.active;
    }
    if (ctx.body.password) {
      validatePasswordStrength(String(ctx.body.password));
      patch.password_hash = hashPassword(String(ctx.body.password));
      changes.password = '(reset)';
    }
    if (patch.role || patch.active === 0 || patch.password_hash) destroyUserSessions(id);
    const fields = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    if (fields) {
      db.prepare(`UPDATE users SET ${fields}, updated_at = ? WHERE id = ?`)
        .run(...Object.values(patch), nowIso(), id);
    }
    audit({
      userId: ctx.user.id, action: 'user.updated', entity: 'users', entityId: id,
      oldValue: { name: user.name, role: user.role, active: !!user.active }, newValue: changes, req: ctx.req,
    });
    ctx.json(200, { ok: true });
  });
};
