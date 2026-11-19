'use strict';
/**
 * Shared utilities: validation, errors, CSV, dates, multipart parsing.
 * Every validator throws ApiError(400) with an actionable message.
 */
const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (msg, details) => new ApiError(400, 'bad_request', msg, details);

/* ------------------------------- validators ------------------------------ */
function reqStr(v, name, { min = 1, max = 500 } = {}) {
  if (typeof v !== 'string') throw bad(`${name} is required`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} is required`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters`);
  return s;
}
function optStr(v, name, opts = {}) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return reqStr(String(v), name, { ...opts, min: 0 });
}
function reqEmail(v, name = 'email') {
  const s = reqStr(v, name, { max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad(`Invalid ${name}: ${s}`);
  return s;
}
function optEmail(v, name = 'email') {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return reqEmail(v, name);
}
function reqInt(v, name, { min = -2147483647, max = 2147483647 } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be an integer`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
  return n;
}
function optInt(v, name, opts) {
  if (v === undefined || v === null || v === '') return null;
  return reqInt(v, name, opts);
}
function reqEnum(v, name, allowed) {
  if (!allowed.includes(v)) throw bad(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}
function reqDate(v, name = 'date') {
  const s = reqStr(v, name, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${name} must be in YYYY-MM-DD format`);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw bad(`${name} ("${s}") is not a real calendar date`);
  }
  return s;
}
function optDate(v, name = 'date') {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return reqDate(v, name);
}
function optPhone(v, name = 'phone') {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!/^\+?[0-9][0-9\s-]{4,19}$/.test(s)) throw bad(`Invalid ${name}: "${s}"`);
  return s;
}
function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw bad(`Missing required field(s): ${missing.join(', ')}`);
}
const nowIso = () => new Date().toISOString();
const genId = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** YYYY-MM-DD of "now" in a given IANA timezone. */
function todayInTz(tz = 'UTC') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/* --------------------------------- CSV ----------------------------------- */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(headers, rows) {
  return '﻿' + [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
}
/** RFC-4180-ish CSV parser. Returns array of rows (arrays of strings). */
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n') {
      row.push(cur); rows.push(row); row = []; cur = '';
    } else if (c === '\r') {
      // ignore
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ------------------------------- multipart -------------------------------- */
/** Minimal, memory-bounded multipart/form-data parser (files ≤ limit enforced upstream). */
function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const fields = {};
  const files = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) throw bad('Malformed multipart request (boundary not found)');
  pos += delim.length;
  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing --
    if (buf[pos] === 0x0d) pos += 2; // CRLF
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    const cd = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(head);
    if (!cd) { pos = headEnd + 4; continue; }
    const name = (/name="([^"]*)"/i.exec(cd[1]) || [])[1];
    const filename = (/filename="([^"]*)"/i.exec(cd[1]) || [])[1];
    const ctype = ((/content-type:\s*([^\r\n;]+)/i.exec(head) || [])[1] || '').trim().toLowerCase();
    const dataStart = headEnd + 4;
    let next = buf.indexOf(delim, dataStart);
    if (next < 0) next = buf.length;
    let data = buf.slice(dataStart, next);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.slice(0, data.length - 2);
    }
    if (filename !== undefined && filename !== '') {
      files.push({ field: name, filename, contentType: ctype || null, data });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

/* --------------------------------- misc ---------------------------------- */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Deterministic PRNG for reproducible seed data. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pageParams(query, defSize = 25, maxSize = 200) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const size = Math.min(maxSize, Math.max(1, Number.parseInt(query.page_size, 10) || defSize));
  return { page, size, offset: (page - 1) * size };
}

function clampStr(s, max) {
  if (s === null || s === undefined) return null;
  s = String(s);
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = {
  ApiError, bad,
  reqStr, optStr, reqEmail, optEmail, reqInt, optInt, reqEnum, reqDate, optDate, optPhone,
  requireFields, nowIso, genId, sha256, todayInTz,
  csvCell, toCSV, parseCSV, parseMultipart,
  levenshtein, mulberry32, pageParams, clampStr,
};
