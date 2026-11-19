'use strict';
/**
 * Authentication & session management.
 * - scrypt password hashing (Node crypto, no plaintext anywhere)
 * - server-side sessions in DB, httpOnly SameSite=Lax cookies
 * - per-session CSRF token required on all mutating requests
 * - in-memory brute-force protection for /login
 */
const crypto = require('crypto');
const { db, getSettingInt } = require('./db');
const { ApiError, nowIso, genId } = require('./util');

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(nStr) || SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    throw new ApiError(400, 'weak_password', 'Password must be at least 8 characters long');
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    throw new ApiError(400, 'weak_password', 'Password must contain both letters and numbers');
  }
}

/* -------------------------------- sessions -------------------------------- */
const SESSION_HOURS = () => getSettingInt('session_hours', Number(process.env.SESSION_HOURS) || 12);
const COOKIE_NAME = 'ams_session';

function createSession(userId, req) {
  const token = genId(32);
  const csrf = genId(24);
  const expires = new Date(Date.now() + SESSION_HOURS() * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions(token, user_id, csrf, expires_at, created_at, ip, user_agent)
              VALUES(?,?,?,?,?,?,?)`)
    .run(token, userId, csrf, expires, nowIso(), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300));
  return { token, csrf, expires };
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
function loadSession(token) {
  if (!token) return null;
  const s = db.prepare(`
    SELECT s.token, s.csrf, s.expires_at, u.id AS user_id, u.name, u.email, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!s) return null;
  if (s.expires_at < nowIso()) { destroySession(token); return null; }
  if (!s.active) return null;
  return s;
}
function sessionCookie(token, maxAgeSec, req) {
  // Served over HTTPS (e.g. behind a proxy that forwards https) the page may be
  // embedded in a cross-site iframe (live preview), where SameSite=Lax cookies
  // are never sent — silently killing every session. SameSite=None + Secure is
  // the standards-compliant answer for that legitimate embedding; the stateless
  // CSRF header (not cookie-reliant) still guards mutations.
  const secure = process.env.COOKIE_SECURE === 'true' || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}${secure ? '; SameSite=None; Secure' : '; SameSite=Lax'}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || null;
}

/* --------------------------- brute-force guard ---------------------------- */
const attempts = new Map(); // key -> {count, firstAt, lockUntil}
const WINDOW_MS = 10 * 60 * 1000, LOCK_MS = 15 * 60 * 1000, MAX_ATTEMPTS = 5;

function loginThrottleKey(req, email) {
  return `${clientIp(req)}|${String(email || '').toLowerCase()}`;
}
function assertLoginAllowed(key) {
  const rec = attempts.get(key);
  if (rec && rec.lockUntil && rec.lockUntil > Date.now()) {
    const mins = Math.ceil((rec.lockUntil - Date.now()) / 60000);
    throw new ApiError(429, 'too_many_attempts',
      `Too many failed login attempts. Try again in ${mins} minute(s).`);
  }
}
function recordLoginFailure(key) {
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) rec = { count: 0, firstAt: now, lockUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) { rec.lockUntil = now + LOCK_MS; rec.count = 0; rec.firstAt = now; }
  attempts.set(key, rec);
  if (attempts.size > 10000) { // crude memory bound
    for (const [k, v] of attempts) if (now - v.firstAt > WINDOW_MS && !(v.lockUntil > now)) attempts.delete(k);
  }
}
function recordLoginSuccess(key) { attempts.delete(key); }

/* ------------------------------ middleware -------------------------------- */
/** Populate ctx.user / ctx.session if a valid session cookie is present. */
function attachSession(ctx) {
  const cookieToken = readCookie(ctx.req, COOKIE_NAME);
  let bearerToken = null, customToken = null;
  const auth = ctx.req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) bearerToken = auth.slice(7).trim();
  const xt = ctx.req.headers['x-session-token'];
  if (typeof xt === 'string' && xt) customToken = xt.trim();
  const token = cookieToken || bearerToken || customToken;
  const s = loadSession(token);
  if (process.env.AUTH_LOG !== 'false') {
    const p = ctx.req.url.split('?')[0];
    if (!p.startsWith('/js/') && !p.startsWith('/styles')) {
      const src = s ? (token === cookieToken ? 'cookie' : token === bearerToken ? 'bearer' : 'x-token') : 'none';
      console.log(`[auth] ${ctx.req.method} ${p} cookie=${cookieToken ? 'yes' : 'no'} bearer=${bearerToken ? 'yes' : 'no'} xtoken=${customToken ? 'yes' : 'no'} session=${s ? 'ok' : 'null/invalid'} via=${src}`);
    }
  }
  if (s) {
    ctx.session = { token: s.token, csrf: s.csrf };
    ctx.user = { id: s.user_id, name: s.name, email: s.email, role: s.role };
  }
}
function requireAuth(ctx) {
  if (!ctx.user) throw new ApiError(401, 'unauthorized', 'Authentication required. Please log in.');
}
function requireRole(...roles) {
  return (ctx) => {
    requireAuth(ctx);
    if (!roles.includes(ctx.user.role)) {
      throw new ApiError(403, 'forbidden', `This action requires the ${roles.join(' or ')} role.`);
    }
  };
}
/** CSRF: any authenticated non-GET request must carry the session's token. */
function csrfCheck(ctx) {
  const method = ctx.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (!ctx.session) return; // login/forgot/reset are pre-auth; guarded by rate limits instead
  const token = ctx.req.headers['x-csrf-token'];
  if (!token || token !== ctx.session.csrf) {
    throw new ApiError(403, 'csrf_failed', 'Security token mismatch. Refresh the page and try again.');
  }
}

module.exports = {
  hashPassword, verifyPassword, validatePasswordStrength,
  createSession, destroySession, destroyUserSessions,
  sessionCookie, clearCookie, readCookie, clientIp,
  attachSession, requireAuth, requireRole, csrfCheck,
  assertLoginAllowed, recordLoginFailure, recordLoginSuccess, loginThrottleKey,
  COOKIE_NAME,
};
