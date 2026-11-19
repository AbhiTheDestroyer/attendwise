'use strict';
/**
 * Tiny explicit router: pattern matching with :params, bounded body reading,
 * JSON & multipart parsing, consistent error responses.
 */
const { ApiError, parseMultipart, clampStr } = require('./util');

const MAX_DEFAULT_MB = 2;

class Router {
  constructor() { this.routes = []; }

  add(method, pattern, opts, ...handlers) {
    if (typeof opts === 'function') { handlers.unshift(opts); opts = {}; }
    const keys = [];
    const parts = pattern.split('/').filter(Boolean).map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    const rx = new RegExp('^/' + parts.join('/') + '$');
    this.routes.push({ method, rx, keys, opts: opts || {}, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://internal');
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    const query = Object.fromEntries(url.searchParams.entries());

    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const ctx = {
        req, res, params, query, opts: r.opts,
        user: null, session: null, body: {},
        json(status, data, headers) {
          sendJson(res, status, data, headers);
        },
      };
      try {
        await readBody(req, r.opts, ctx);
        for (const h of r.handlers) {
          await h(ctx);
          if (res.writableEnded) return;
        }
        if (!res.writableEnded) throw new ApiError(500, 'no_response', 'Route produced no response');
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    sendError(res, new ApiError(404, 'not_found', `No route: ${req.method} ${pathname}`));
  }
}

function sendJson(res, status, data, headers) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Never let an intermediary cache cacheable-by-default statuses (401/404/…):
    // a stale unauthenticated 401 for /api/meta was poisoning sessions forever.
    'Cache-Control': 'no-store',
    'Vary': 'Cookie, Authorization',
    ...headers,
  });
  res.end(body);
}

function sendError(res, err) {
  if (res.writableEnded) return;
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  if (err && err.type === 'entity.too.large') {
    sendJson(res, 413, { error: { code: 'too_large', message: err.message, details: null } });
    return;
  }
  if (err instanceof SyntaxError) {
    sendJson(res, 400, { error: { code: 'bad_json', message: 'Request body is not valid JSON', details: null } });
    return;
  }
  console.error('[unhandled]', err);
  sendJson(res, 500, { error: { code: 'internal', message: 'Unexpected server error. The incident has been logged.', details: null } });
}

function readBody(req, opts, ctx) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve();
    const maxMB = opts.maxMB || MAX_DEFAULT_MB;
    const limit = maxMB * 1024 * 1024;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      const e = new Error(`Request too large (limit ${maxMB} MB)`); e.type = 'entity.too.large';
      req.resume();
      return reject(e);
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error(`Request too large (limit ${maxMB} MB)`); e.type = 'entity.too.large';
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const ctype = String(req.headers['content-type'] || '');
        if (ctype.startsWith('multipart/form-data')) {
          const boundary = (/boundary=([^;]+)/.exec(ctype) || [])[1];
          if (!boundary) throw new ApiError(400, 'bad_request', 'Malformed multipart request');
          ctx.multipart = parseMultipart(buf, boundary.replace(/^"|"$/g, ''));
          ctx.body = ctx.multipart.fields;
        } else if (ctype.includes('application/json')) {
          ctx.body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
        } else {
          ctx.rawBody = buf;
          ctx.body = {};
        }
        resolve();
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = { Router, sendJson, sendError, clampStr };
