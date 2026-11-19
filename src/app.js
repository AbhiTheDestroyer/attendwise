'use strict';
/**
 * Application assembly: security headers, static files, SPA fallback, routes.
 * Permission model is explicit per verb:
 *   api.any   → any authenticated user (session + CSRF enforced)
 *   api.admin → admin role required
 * Handlers that need object-level checks (e.g. teacher may only write
 * attendance for subjects assigned to them) enforce those themselves.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Router, sendError } = require('./router');
const { attachSession, csrfCheck, requireAuth, requireRole } = require('./auth');
const { ApiError } = require('./util');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function buildRouter() {
  const r = new Router();
  const any = [attachSession, csrfCheck, requireAuth];
  const admin = [...any, requireRole('admin')];
  const wrap = (middleware, method) => (pattern, opts, ...handlers) => {
    const hs = typeof opts === 'function' ? [opts, ...handlers] : handlers;
    const os = typeof opts === 'object' && opts !== null ? opts : {};
    r[method](pattern, os, ...middleware, ...hs);
  };
  const api = { any: {}, admin: {} };
  for (const m of ['get', 'post', 'put', 'delete']) {
    api.any[m] = wrap(any, m);
    api.admin[m] = wrap(admin, m);
  }
  const mix = (def) => ({ get: def.get || api.any.get, post: def.post || api.admin.post, put: def.put || api.admin.put, delete: def.delete || api.admin.delete });

  // auth routes are special: login/forgot/reset are public (rate-limited in
  // the handler), logout/me/password only need session attachment + CSRF.
  const pub = { get: wrap([], 'get'), post: wrap([], 'post'), put: wrap([], 'put') };
  const self = {
    get: wrap([attachSession], 'get'),
    post: wrap([attachSession, csrfCheck], 'post'),
    put: wrap([attachSession, csrfCheck], 'put'),
  };
  require('./routes/authRoutes')({
    get: self.get,
    post: (p, ...h) => (p.endsWith('/logout') ? self.post(p, ...h) : pub.post(p, ...h)),
    put: self.put,
  });
  require('./routes/publicRoutes')(pub);              // self-service parent/student lookup (no login, hard rate-limit)
  require('./routes/userRoutes')(api.admin);          // user management: admin
  require('./routes/metaRoutes')(mix({}));            // org structure: read all, write admin
  require('./routes/studentRoutes')(mix({}));         // students: read all, write admin
  require('./routes/subjectRoutes')(mix({}));         // subjects: read all, write admin
  require('./routes/attendanceRoutes')(mix({ post: api.any.post, put: api.any.put, delete: api.any.delete })); // object-level checks inside
  require('./routes/importRoutes')({ get: api.any.get, post: api.any.post, put: api.any.put, delete: api.any.delete });
  require('./routes/notificationRoutes')({ get: api.any.get, post: api.any.post, put: api.any.put });
  require('./routes/reportRoutes')({ get: api.any.get });                                   // backup handler self-checks admin
  require('./routes/settingsRoutes')({ get: api.any.get, put: api.admin.put });             // sensitive GETs self-check admin
  return r;
}

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname);
  if (rel.includes('..')) { sendError(res, new ApiError(400, 'bad_path', 'Invalid path')); return; }
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { sendError(res, new ApiError(403, 'forbidden', 'Forbidden')); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (req.method === 'GET' && !pathname.startsWith('/api/') && !path.extname(rel)) {
      file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
    } else {
      sendError(res, new ApiError(404, 'not_found', 'Not found'));
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function createServer() {
  const router = buildRouter();
  return http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    const started = Date.now();
    res.on('finish', () => {
      if (process.env.REQUEST_LOG !== 'false') {
        console.log(`${req.method} ${new URL(req.url, 'http://x').pathname} → ${res.statusCode} (${Date.now() - started}ms)`);
      }
    });
    try {
      const url = new URL(req.url, 'http://internal');
      if (url.pathname === '/api/health') {
        // Liveness probe for the SPA login screen (no auth, no CSRF) — lets the
        // UI distinguish "server restarting" from "session problem" instead of
        // misleadingly showing "Session expired" for every failure.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        router.handle(req, res).catch((e) => sendError(res, e));
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
        return;
      }
      sendError(res, new ApiError(404, 'not_found', 'Not found'));
    } catch (e) {
      sendError(res, e);
    }
  });
}

module.exports = { createServer };
