'use strict';
/**
 * Student matching for imports.
 *
 * Conservative by design: only unambiguous matches are automatic.
 * Anything ambiguous returns `possible` with a candidate list and the
 * teacher MUST pick — low-confidence rows are never silently assigned.
 */
const { db } = require('../db');
const { levenshtein } = require('../util');

function normalizeName(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/[.*_|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const normKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').trim();

function nameScore(imported, candidate) {
  const a = normalizeName(imported);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  const sim = 1 - dist / Math.max(a.length, b.length);
  // Same first token (e.g. "Abhishek ...") → always surface as a candidate:
  // abbreviations like "Abhishek Kr." must be REVIEWED, never silently dropped
  // or silently assigned (§9).
  const at = a.split(' '), bt = b.split(' ');
  if (at[0] === bt[0] && at[0].length >= 3) {
    if (at.length >= 2 && bt.length >= 2) {
      const lastA = at[at.length - 1], lastB = bt[bt.length - 1];
      if (lastB.startsWith(lastA[0]) || lastA.startsWith(lastB[0])) {
        return Math.max(sim, 0.85); // plausible abbreviation (Kumar ↔ Kr.) — manual pick below the auto-match bar
      }
      return Math.max(sim, 0.7);
    }
    // One side is a bare first name ("Aarav") — never auto-match, but DO surface
    // for manual selection; a missing candidate here silently strands the row.
    return Math.max(sim, 0.72);
  }
  return sim;
}

/**
 * @returns {{status:'matched'|'possible'|'none', student?|candidates?, reason?}}
 */
function matchStudent({ rollNo, enrollmentNo, name, sectionId = null }) {
  const students = sectionId
    ? db.prepare('SELECT id, enrollment_no, roll_no, full_name, status, section_id FROM students WHERE section_id = ?').all(sectionId)
    : db.prepare('SELECT id, enrollment_no, roll_no, full_name, status, section_id FROM students').all();

  const cand = (rows, score) => rows.map((s) => ({
    id: s.id, roll_no: s.roll_no, enrollment_no: s.enrollment_no,
    full_name: s.full_name, status: s.status, score: Math.round(score(s) * 100) / 100,
  })).sort((x, y) => y.score - x.score);

  // 1) roll number (exact, case/space-insensitive)
  if (rollNo && normKey(rollNo)) {
    const hits = students.filter((s) => normKey(s.roll_no) === normKey(rollNo));
    if (hits.length) return { status: 'matched', student: cand(hits, () => 1)[0], via: 'roll_no' };
    // roll might actually be an enrollment number
    const eHits = students.filter((s) => normKey(s.enrollment_no) === normKey(rollNo));
    if (eHits.length) return { status: 'matched', student: cand(eHits, () => 1)[0], via: 'enrollment_no' };
  }
  // 2) enrollment number (explicit field)
  if (enrollmentNo && normKey(enrollmentNo)) {
    const hits = students.filter((s) => normKey(s.enrollment_no) === normKey(enrollmentNo));
    if (hits.length) return { status: 'matched', student: cand(hits, () => 1)[0], via: 'enrollment_no' };
  }
  // 3) exact normalized name
  if (name) {
    const nName = normalizeName(name);
    const exact = students.filter((s) => normalizeName(s.full_name) === nName);
    if (exact.length === 1) return { status: 'matched', student: cand(exact, () => 1)[0], via: 'name_exact' };
    if (exact.length > 1) {
      return { status: 'possible', candidates: cand(exact, () => 0.95), reason: 'Duplicate name — choose the right student' };
    }
    // 4) fuzzy name — never auto-assign unless essentially certain AND unique
    const scored = students
      .map((s) => ({ s, score: nameScore(name, s.full_name) }))
      .filter((x) => x.score >= 0.68)
      .sort((x, y) => y.score - x.score)
      .slice(0, 5);
    if (scored.length) {
      if (scored[0].score >= 0.97 && (scored.length === 1 || scored[1].score < 0.9)) {
        return { status: 'matched', student: cand([scored[0].s], () => scored[0].score)[0], via: 'name_fuzzy' };
      }
      return {
        status: 'possible',
        candidates: cand(scored.map((x) => x.s), (s) => scored.find((x) => x.s === s).score),
        reason: 'Name is similar to more than one student — confirm manually',
      };
    }
  }
  return { status: 'none', reason: 'No matching student found' };
}

module.exports = { matchStudent, normalizeName, nameScore };
