'use strict';
/**
 * Minimal, dependency-free XLSX support.
 *  - readXlsxGrid(buffer): unzips the workbook (ZIP STORED/DEFLATE) and reads
 *    the first worksheet into a string grid (shared strings + inline strings).
 *  - buildXlsx(rows, sheetName): writes a valid single-sheet workbook using
 *    inline strings and STORED zip entries (with proper CRC-32).
 * This covers institutional attendance sheets without native dependencies.
 */
const zlib = require('zlib');
const { ApiError } = require('../util');

/* --------------------------------- CRC-32 -------------------------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------- ZIP reading ------------------------------ */
function unzip(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(0) !== 0x02014b50) {
    // check for EOCD instead of assuming first record
  }
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ApiError(400, 'bad_xlsx', 'Invalid XLSX file (not a ZIP archive)');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else { pos += 46 + nameLen + extraLen + commentLen; continue; }
    files.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* -------------------------------- XML utils ------------------------------- */
const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function colToIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref)[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ---------------------------- worksheet reading --------------------------- */
function readXlsxGrid(buf) {
  let files;
  try { files = unzip(buf); } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(400, 'bad_xlsx', 'Could not read XLSX archive. The file may be corrupt.');
  }
  const shared = [];
  const sst = files.get('xl/sharedStrings.xml');
  if (sst) {
    const xml = sst.toString('utf8');
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]));
      shared.push(parts.join(''));
    }
  }
  // find first worksheet path
  let sheetPath = null;
  for (const name of files.keys()) {
    if (/^xl\/worksheets\/sheet\d*\.xml$/.test(name)) { sheetPath = sheetPath || name; }
    if (name === 'xl/worksheets/sheet1.xml') { sheetPath = name; break; }
  }
  if (!sheetPath) throw new ApiError(400, 'bad_xlsx', 'XLSX contains no worksheet');
  const xml = files.get(sheetPath).toString('utf8');

  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*?r="?(\d+)"?[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowNum = rowMatch[1] ? Number(rowMatch[1]) : rows.length + 1;
    const inner = rowMatch[2] !== undefined ? rowMatch[2] : rowMatch[3];
    const cells = rows[rowNum - 1] || (rows[rowNum - 1] = []);
    for (const cm of inner.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cm[1] || cm[3] || '';
      const body = cm[2] || '';
      const refM = /r="([A-Z]+\d+)"/i.exec(attrs);
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      let value = '';
      if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = t ? unescapeXml(t[1]) : '';
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? v[1] : '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = unescapeXml(raw);
      }
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      cells[idx] = value;
    }
  }
  // normalize: array of dense rows, padded to uniform width
  const maxRow = rows.length;
  const dense = [];
  let maxW = 0;
  for (let i = 0; i < maxRow; i++) {
    const r = rows[i] || [];
    const row = [];
    for (let j = 0; j < r.length; j++) row.push(r[j] ?? '');
    dense.push(row);
    if (row.length > maxW) maxW = row.length;
  }
  for (const row of dense) while (row.length < maxW) row.push('');
  return dense;
}

/* ---------------------------- worksheet writing --------------------------- */
function colName(idx) {
  let s = '';
  idx += 1;
  while (idx > 0) { const r = (idx - 1) % 26; s = String.fromCharCode(65 + r) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}
function buildXlsx(rows, sheetName = 'Sheet1') {
  const sheetRows = rows.map((r, ri) => {
    const cells = r.map((c, ci) => {
      if (c === null || c === undefined || c === '') return '';
      if (typeof c === 'number' && Number.isFinite(c)) {
        return `<c r="${colName(ci)}${ri + 1}"><v>${c}</v></c>`;
      }
      return `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(c))}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const files = new Map(Object.entries({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  }));

  // ZIP with STORED entries
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

module.exports = { readXlsxGrid, buildXlsx, crc32 };
