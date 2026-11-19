'use strict';
/**
 * Attendance sheet import pipeline.
 *
 *   UPLOAD → PARSE → NORMALIZE → VALIDATE → STAGE (import_rows)
 *          → teacher reviews/fixes → CONFIRM (single transaction)
 *
 * Nothing reaches attendance_records before confirmation, and confirmation
 * never silently overwrites — conflicts follow an explicit policy and every
 * replacement is recorded in the change history.
 */
const fs = require('fs');
const path = require('path');
const { db, withTx, getSetting, getSettingInt, DATA_DIR } = require('../db');
const {
  ApiError, reqInt, optStr, nowIso, genId, sha256, todayInTz, parseCSV,
} = require('../util');
const { audit, attendanceAudit } = require('../audit');
const { parseSheetGrid, parseDateCell, normalizeStatus } = require('../services/parsing');
const { readXlsxGrid } = require('../services/xlsx');
const { matchStudent } = require('../services/matching');
const notify = require('../services/notify');
const { subjectAccess } = require('./subjectRoutes');

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.txt']);

function refYear() {
  const ay = getSetting('academic_year', '') || '';
  const m = /(\d{4})/.exec(ay);
  return m ? Number(m[1]) : new Date().getFullYear();
}

/** Re-evaluate a staged row: matching, validation, conflicts. */
function validateRow({ row, subject }) {
  const issues = [];
  const parsed = typeof row.raw === 'string' ? JSON.parse(row.raw) : (row.raw || {});
  let studentId = row.student_id || null;
  let matchStatus = row.match_status;
  let candidates = row.match_candidates ? JSON.parse(row.match_candidates) : null;

  // (re)match student when not manually fixed
  if (!studentId) {
    const match = matchStudent({ rollNo: row.roll_no, name: row.name, sectionId: subject.section_id });
    if (match.status === 'matched') {
      studentId = match.student.id;
      matchStatus = 'matched';
      candidates = null;
      if (match.via === 'name_fuzzy') issues.push(`Matched by name similarity → ${match.student.full_name} (Roll ${match.student.roll_no}) — please verify`);
    } else if (match.status === 'possible') {
      matchStatus = 'possible';
      candidates = match.candidates;
      issues.push(match.reason || 'Multiple possible students — select manually');
    } else {
      matchStatus = 'none';
      candidates = null;
      issues.push('Student not found in this section');
    }
  } else {
    matchStatus = row.match_status === 'possible' ? 'matched' : (row.match_status || 'matched');
  }

  // status value
  const norm = normalizeStatus(row.status_value);
  if (!norm.valid) {
    if (parsed.noMarks) issues.push('Row contains a student but no attendance marks');
    else issues.push(norm.reason || 'Invalid attendance value');
  }
  // date
  let dateValid = true;
  if (!row.date) {
    dateValid = false;
    if (!parsed.noMarks) issues.push('Missing/invalid date');
  } else {
    const today = todayInTz(getSetting('timezone', 'UTC'));
    if (row.date > today) { issues.push(`Date ${row.date} is in the future`); }
    if (row.date < '2000-01-01') { issues.push(`Date ${row.date} looks wrong`); }
  }

  // duplicates within the file
  if (parsed.duplicateOf) issues.push(`Duplicate of row ${parsed.duplicateOf} (same student/date)`);
  if (parsed.duplicateDateColumn) issues.push('Duplicate date column in file');
  // sibling duplicates: two staged rows that resolve to the same student+date
  // (e.g. one keyed by roll, one by enrollment) — never silently coalesce:
  if (studentId && row.date && norm.valid && row.import_id != null) {
    const sib = db.prepare(
      "SELECT row_no FROM import_rows WHERE import_id=? AND student_id=? AND date=? AND action='import' AND id<>? ORDER BY row_no LIMIT 1",
    ).get(row.import_id, studentId, row.date, row.id || -1);
    if (sib) issues.push(`Duplicate in file: row ${sib.row_no} also maps to this student/date — ignore one of them`);
  }

  // student status
  let conflict = null;
  if (studentId) {
    const st = db.prepare('SELECT status FROM students WHERE id = ?').get(studentId);
    if (!st) { issues.push('Selected student no longer exists'); studentId = null; matchStatus = 'none'; }
    else if (st.status !== 'active') issues.push(`Student is ${st.status} — verify before importing`);
  }
  // conflict with existing attendance
  if (studentId && norm.valid && row.date) {
    const existing = db.prepare(
      'SELECT status FROM attendance_records WHERE student_id=? AND subject_id=? AND date=? AND period=?',
    ).get(studentId, subject.id, row.date, row.period || 1);
    if (existing && existing.status !== norm.status) {
      conflict = existing.status;
      issues.push(`Existing record says "${existing.status}" — confirmation will follow the chosen conflict policy`);
    }
  }

  const hasError =
    (!studentId && matchStatus === 'none') || !norm.valid || !row.date ||
    issues.some((i) => i.startsWith('Duplicate in file')) ||
    (issues.some((i) => i.startsWith('Student not found')));
  let validation;
  if (hasError && matchStatus !== 'possible') validation = 'error';
  else if (matchStatus === 'possible' || (!studentId && matchStatus !== 'none')) validation = 'needs_review';
  else if (!studentId) validation = 'error';
  else if (issues.length) validation = 'warning';
  else validation = 'valid';
  if (parsed.noMarks && action_autoIgnore(row)) validation = 'warning';

  return {
    student_id: studentId,
    match_status: matchStatus,
    match_candidates: candidates ? JSON.stringify(candidates) : null,
    validation,
    issues: JSON.stringify(issues),
    conflict_existing: conflict,
  };
}
const action_autoIgnore = () => false;

function summarize(importId) {
  const rows = db.prepare('SELECT * FROM import_rows WHERE import_id = ?').all(importId);
  const s = {
    total_rows: rows.length,
    matched: 0, unmatched: 0, possible: 0,
    duplicates: 0, invalid_status: 0, invalid_date: 0, conflicts: 0,
    valid: 0, warning: 0, error: 0, needs_review: 0, ignored: 0,
  };
  for (const r of rows) {
    if (r.match_status === 'matched') s.matched++;
    else if (r.match_status === 'possible') s.possible++;
    else s.unmatched++;
    const raw = r.raw ? JSON.parse(r.raw) : {};
    const issues = r.issues ? JSON.parse(r.issues) : [];
    if (raw.duplicateOf || issues.some((i) => i.startsWith('Duplicate in file'))) s.duplicates++;
    if (!normalizeStatus(r.status_value).valid && !raw.noMarks) s.invalid_status++;
    if (raw.dateInvalid || (!r.date && !raw.noMarks)) s.invalid_date++;
    if (r.conflict_existing) s.conflicts++;
    s[r.validation]++;
    if (r.action === 'ignore') s.ignored++;
  }
  return s;
}

module.exports = function register(r) {
  /* ------------------------------- upload --------------------------------- */
  r.post('/api/attendance/import', { maxMB: 50 }, async (ctx) => {
    const maxMB = getSettingInt('upload_max_mb', Number(process.env.UPLOAD_MAX_MB) || 5);
    if (!ctx.multipart) throw new ApiError(400, 'bad_request', 'Expected multipart/form-data');
    const subjectId = reqInt(ctx.multipart.fields.subject_id, 'subject_id', { min: 1 });
    const period = reqInt(ctx.multipart.fields.period ?? 1, 'period', { min: 1, max: 12 });
    const subject = subjectAccess(ctx.user, subjectId);
    const files = ctx.multipart.files || [];
    if (!files.length) throw new ApiError(400, 'bad_request', 'Attach an attendance sheet (CSV or XLSX)');
    const file = files.find((f) => f.field === 'file') || files[0];

    // ── upload security: extension + magic bytes + size ──
    const originalName = String(file.filename || 'sheet').slice(0, 200);
    const ext = path.extname(originalName).toLowerCase();
    if (['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      throw new ApiError(415, 'unsupported_type',
        `${ext.toUpperCase()} sheets are not supported in this build (no OCR pipeline configured). Convert the sheet to CSV or XLSX first — the import will then be fully validated.`);
    }
    if (!ALLOWED_EXT.has(ext)) {
      throw new ApiError(415, 'unsupported_type', `File type "${ext || 'unknown'}" is not allowed. Use CSV or XLSX.`);
    }
    if (file.data.length > maxMB * 1024 * 1024) {
      throw new ApiError(413, 'too_large', `File is ${(file.data.length / 1048576).toFixed(1)} MB — the configured limit is ${maxMB} MB.`);
    }
    const isXlsx = ext === '.xlsx' || (file.data[0] === 0x50 && file.data[1] === 0x4b);
    if (ext === '.xlsx' && !(file.data[0] === 0x50 && file.data[1] === 0x4b)) {
      throw new ApiError(400, 'bad_file', 'The file is named .xlsx but is not a real Excel workbook');
    }
    if (!isXlsx && file.data.includes(0x00)) {
      throw new ApiError(400, 'bad_file', 'The file is named .csv but contains binary data');
    }

    // ── parse ──
    let grid;
    try {
      grid = isXlsx
        ? readXlsxGrid(file.data)
        : parseCSV(file.data.toString('utf8').replace(/^﻿/, ''));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'bad_file', `Could not parse the file: ${e.message}`);
    }
    const parsed = parseSheetGrid(grid, { refYear: refYear() });
    if (parsed.fileIssues.length && !parsed.entries.length) {
      throw new ApiError(422, 'unparseable', parsed.fileIssues.join(' '));
    }
    if (!parsed.entries.length) {
      throw new ApiError(422, 'unparseable', 'No attendance entries were detected in the file.');
    }
    if (parsed.entries.length > 20000) {
      throw new ApiError(400, 'too_large', 'Too many rows in one sheet (max 20,000). Split the file.');
    }

    // ── stage everything in ONE transaction ──
    const hash = sha256(file.data);
    const previous = db.prepare(`
      SELECT i.id, i.created_at, u.name AS by, i.status FROM imports i
      LEFT JOIN users u ON u.id = i.uploaded_by
      WHERE i.file_hash = ? AND i.status = 'confirmed' ORDER BY i.id DESC`).get(hash);
    const storedName = `import_${genId(8)}${isXlsx ? '.xlsx' : '.csv'}`;

    const importId = withTx(() => {
      const info = db.prepare(`
        INSERT INTO imports(filename, stored_name, file_hash, size, subject_id, period, uploaded_by, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(originalName, storedName, hash, file.data.length, subjectId, period, ctx.user.id, 'reviewed', nowIso());
      const impId = info.lastInsertRowid;
      fs.writeFileSync(path.join(DATA_DIR, 'uploads', storedName), file.data);

      const insRow = db.prepare(`
        INSERT INTO import_rows(import_id, row_no, raw, roll_no, name, date, status_value,
                                student_id, match_status, match_candidates, validation, issues, conflict_existing, action)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const e of parsed.entries) {
        const staged = validateRow({
          row: {
            import_id: impId, raw: JSON.stringify(e), roll_no: e.rollNo, name: e.name, date: e.date,
            status_value: e.statusRaw, period, student_id: null, match_status: 'none',
          },
          subject,
        });
        const v = staged.validation;
        const hasError = v === 'error' || v === 'needs_review';
        insRow.run(
          impId, e.rowNo, JSON.stringify(e), e.rollNo, e.name, e.date, String(e.statusRaw ?? ''),
          staged.student_id, staged.match_status, staged.match_candidates,
          v, staged.issues, staged.conflict_existing,
          v === 'error' ? 'ignore' : 'import',
        );
      }
      const summary = summarize(impId);
      summary.format = parsed.format;
      summary.file_issues = parsed.fileIssues;
      summary.empty_rows = parsed.emptyRows;
      summary.previous_import = previous
        ? `This exact file was already imported on ${previous.created_at.slice(0, 10)} by ${previous.by || 'unknown'} (import #${previous.id}). Review duplicates before confirming.`
        : null;
      db.prepare('UPDATE imports SET summary = ? WHERE id = ?').run(JSON.stringify(summary), impId);
      return impId;
    });

    audit({
      userId: ctx.user.id, action: 'attendance.import_uploaded', entity: 'imports', entityId: importId,
      newValue: { filename: originalName, subject: subject.code, rows: parsed.entries.length }, req: ctx.req,
    });
    const imp = db.prepare('SELECT summary FROM imports WHERE id = ?').get(importId);
    ctx.json(201, { import_id: importId, summary: JSON.parse(imp.summary) });
  });

  /* ------------------------------- listing -------------------------------- */
  r.get('/api/attendance/imports', async (ctx) => {
    const rows = db.prepare(`
      SELECT i.id, i.filename, i.size, i.status, i.summary, i.created_at, i.confirmed_at, i.period,
             sb.code AS subject_code, sb.name AS subject_name, u.name AS uploaded_by
      FROM imports i
      LEFT JOIN subjects sb ON sb.id = i.subject_id
      LEFT JOIN users u ON u.id = i.uploaded_by
      ${ctx.user.role === 'teacher' ? 'WHERE i.uploaded_by = ' + Number(ctx.user.id) : ''}
      ORDER BY i.id DESC LIMIT 100`).all()
      .map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null }));
    ctx.json(200, { rows });
  });

  r.get('/api/attendance/import/:id', async (ctx) => {
    const imp = db.prepare(`
      SELECT i.*, sb.code AS subject_code, sb.name AS subject_name, sb.section_id,
             u.name AS uploaded_by
      FROM imports i LEFT JOIN subjects sb ON sb.id = i.subject_id
      LEFT JOIN users u ON u.id = i.uploaded_by WHERE i.id = ?`).get(Number(ctx.params.id));
    if (!imp) throw new ApiError(404, 'not_found', 'Import not found');
    if (ctx.user.role === 'teacher' && imp.uploaded_by !== ctx.user.id && imp.subject_id) {
      const sb = db.prepare('SELECT teacher_id FROM subjects WHERE id = ?').get(imp.subject_id);
      if (sb && sb.teacher_id !== ctx.user.id) throw new ApiError(403, 'forbidden', 'Not your import');
    }
    const rows = db.prepare(`
      SELECT r.*, s.full_name AS student_name, s.roll_no AS student_roll
      FROM import_rows r LEFT JOIN students s ON s.id = r.student_id
      WHERE r.import_id = ? ORDER BY r.row_no`).all(imp.id)
      .map((r) => ({
        ...r,
        issues: r.issues ? JSON.parse(r.issues) : [],
        match_candidates: r.match_candidates ? JSON.parse(r.match_candidates) : null,
        raw: undefined,
      }));
    // students of the section for manual resolution dropdown
    const students = imp.section_id
      ? db.prepare(`SELECT id, roll_no, full_name, enrollment_no FROM students
                    WHERE section_id = ? AND deleted_at IS NULL
                    ORDER BY CAST(roll_no AS INTEGER), roll_no`).all(imp.section_id)
      : [];
    ctx.json(200, {
      import: { ...imp, summary: imp.summary ? JSON.parse(imp.summary) : null },
      rows, students,
    });
  });

  /* ----------------------------- row editing ------------------------------ */
  r.put('/api/attendance/import/:id/rows/:rowId', async (ctx) => {
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(Number(ctx.params.id));
    if (!imp) throw new ApiError(404, 'not_found', 'Import not found');
    if (imp.status === 'confirmed') throw new ApiError(409, 'locked', 'This import is already confirmed and locked');
    const row = db.prepare('SELECT * FROM import_rows WHERE id = ? AND import_id = ?')
      .get(Number(ctx.params.rowId), imp.id);
    if (!row) throw new ApiError(404, 'not_found', 'Row not found');
    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(imp.subject_id);

    const patch = { ...row };
    if (ctx.body.action !== undefined) {
      if (!['import', 'ignore'].includes(ctx.body.action)) throw new ApiError(400, 'bad_request', 'action must be import|ignore');
      patch.action = ctx.body.action;
    }
    if (ctx.body.student_id !== undefined) {
      if (ctx.body.student_id === null) { patch.student_id = null; patch.match_status = 'none'; }
      else {
        const sid = reqInt(ctx.body.student_id, 'student_id', { min: 1 });
        const st = db.prepare('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL').get(sid);
        if (!st) throw new ApiError(400, 'bad_request', 'Student does not exist');
        if (st.section_id !== subject.section_id) throw new ApiError(400, 'bad_request', 'Student is not in this subject\'s section');
        patch.student_id = sid;
        patch.match_status = 'matched';
      }
    }
    if (ctx.body.status !== undefined) {
      const norm = normalizeStatus(ctx.body.status);
      if (!norm.valid) throw new ApiError(400, 'bad_request', norm.reason);
      patch.status_value = ctx.body.status;
    }
    if (ctx.body.date !== undefined) {
      const iso = parseDateCell(ctx.body.date, { refYear: refYear() });
      if (!iso) throw new ApiError(400, 'bad_request', `Could not parse date "${ctx.body.date}"`);
      patch.date = iso;
    }
    // revalidate with manual overrides respected
    const staged = validateRow({ row: { ...patch, raw: row.raw, period: imp.period }, subject });
    if (patch.match_status === 'matched' && patch.student_id) staged.match_status = 'matched';
    db.prepare(`UPDATE import_rows SET student_id=?, match_status=?, match_candidates=?, validation=?,
                issues=?, conflict_existing=?, action=?, status_value=?, date=? WHERE id=?`)
      .run(patch.student_id, staged.match_status,
        patch.student_id ? null : staged.match_candidates,
        staged.validation, staged.issues, staged.conflict_existing,
        patch.action, patch.status_value, patch.date, row.id);
    const summary = summarize(imp.id);
    db.prepare('UPDATE imports SET summary = ? WHERE id = ?').run(JSON.stringify(summary), imp.id);
    ctx.json(200, { ok: true, validation: staged.validation, issues: JSON.parse(staged.issues), summary });
  });

  /* ------------------------------- confirm -------------------------------- */
  r.post('/api/attendance/import/:id/confirm', async (ctx) => {
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(Number(ctx.params.id));
    if (!imp) throw new ApiError(404, 'not_found', 'Import not found');
    if (imp.status === 'confirmed') throw new ApiError(409, 'locked', 'Import already confirmed');
    if (imp.status === 'cancelled') throw new ApiError(409, 'locked', 'Import was cancelled');
    const policy = ctx.body.conflict_policy === 'replace' ? 'replace' : 'skip';
    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(imp.subject_id);

    const rows = db.prepare('SELECT * FROM import_rows WHERE import_id = ? ORDER BY row_no').all(imp.id);
    const unresolved = rows.filter((x) => x.action === 'import' && (x.validation === 'error' || x.validation === 'needs_review'));
    if (unresolved.length && !ctx.body.force) {
      throw new ApiError(409, 'unresolved',
        `${unresolved.length} row(s) still have errors or need review. Fix them, mark them "ignore", or confirm with force=true to import only the valid rows.`,
        { unresolved_rows: unresolved.slice(0, 20).map((x) => x.row_no) });
    }

    const result = { inserted: 0, replaced: 0, skipped_conflict: 0, skipped_rows: 0 };
    const affected = new Set();
    withTx(() => {
      for (const row of rows) {
        if (row.action !== 'import' || !row.student_id || !row.date) { if (row.action === 'import') result.skipped_rows++; continue; }
        const norm = normalizeStatus(row.status_value);
        if (!norm.valid) { result.skipped_rows++; continue; }
        const existing = db.prepare(
          'SELECT id, status FROM attendance_records WHERE student_id=? AND subject_id=? AND date=? AND period=?',
        ).get(row.student_id, imp.subject_id, row.date, imp.period);
        if (existing) {
          if (existing.status === norm.status) { result.skipped_rows++; continue; }
          if (policy === 'skip') { result.skipped_conflict++; continue; }
          db.prepare('UPDATE attendance_records SET status=?, source=?, updated_at=? WHERE id=?')
            .run(norm.status, 'import', nowIso(), existing.id);
          attendanceAudit({
            recordId: existing.id, studentId: row.student_id, subjectId: imp.subject_id,
            date: row.date, period: imp.period, oldStatus: existing.status, newStatus: norm.status,
            reason: `Import #${imp.id} (${imp.filename})`, userId: ctx.user.id,
          });
          result.replaced++;
          affected.add(row.student_id);
        } else {
          db.prepare(`INSERT INTO attendance_records(student_id, subject_id, date, period, status, source, created_by, created_at)
                      VALUES (?,?,?,?,?,?,?,?)`)
            .run(row.student_id, imp.subject_id, row.date, imp.period, norm.status, 'import', ctx.user.id, nowIso());
          result.inserted++;
          affected.add(row.student_id);
        }
      }
      const summary = JSON.parse(imp.summary || '{}');
      summary.confirmed = result;
      db.prepare(`UPDATE imports SET status='confirmed', confirmed_at=?, summary=? WHERE id=?`)
        .run(nowIso(), JSON.stringify(summary), imp.id);
    });
    audit({
      userId: ctx.user.id, action: 'attendance.import_confirmed', entity: 'imports', entityId: imp.id,
      newValue: { ...result, policy, file: imp.filename, subject: subject && subject.code }, req: ctx.req,
    });
    const evalRes = await notify.evaluateBulk([...affected], imp.subject_id, { userId: ctx.user.id });
    ctx.json(200, { ...result, notifications: evalRes });
  });

  r.post('/api/attendance/import/:id/cancel', async (ctx) => {
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(Number(ctx.params.id));
    if (!imp) throw new ApiError(404, 'not_found', 'Import not found');
    if (imp.status === 'confirmed') throw new ApiError(409, 'locked', 'Import already confirmed');
    db.prepare(`UPDATE imports SET status='cancelled' WHERE id=?`).run(imp.id);
    audit({ userId: ctx.user.id, action: 'attendance.import_cancelled', entity: 'imports', entityId: imp.id, req: ctx.req });
    ctx.json(200, { ok: true });
  });
};
