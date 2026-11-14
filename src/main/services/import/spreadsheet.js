'use strict';
/* Reading a spreadsheet the operator picked, in the main process only.
 *
 * The file is untrusted input from somebody's laptop, so three things are
 * refused before any parser sees it:
 *
 *   - a file over MAX_FILE_BYTES (a guest list is kilobytes, not megabytes)
 *   - an .xlsx whose archive would inflate past MAX_INFLATED_BYTES — the zip
 *     bomb case, checked against the central directory before ExcelJS unpacks
 *     anything into memory
 *   - an .xlsx carrying a VBA project: macros are never executed here, but a
 *     guest list has no reason to contain one, so it is turned away rather
 *     than half-read
 *
 * Formulas are never evaluated. A formula cell contributes the result Excel
 * cached when the file was saved, or nothing.
 *
 * Every cell comes out as a trimmed string; typing happens later, in the
 * import rules, against the guest schema.
 */

const fs = require('fs');
const path = require('path');
const { validation } = require('../../../shared/errors');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_INFLATED_BYTES = 80 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 60;
const MAX_CELL_CHARS = 4000;

/* ------------------------------------------------------------ cell text */

function ymd(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/* Excel stores long numbers (a phone typed without a leading zero) as numbers.
   Printing them through String() would give 9.0532e+11 for big ones. */
function numberText(n) {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return BigInt(Math.trunc(n)).toString();
  return String(n);
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : ymd(value);
  if (typeof value === 'object') {
    /* Formula cells: { formula | sharedFormula, result }. Only the cached
       result is ever read. */
    if ('formula' in value || 'sharedFormula' in value) return cellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((r) => String(r.text || '')).join('');
    if ('text' in value) return cellText(value.text);            // hyperlink
    if ('error' in value) return '';
  }
  return '';
}

function clean(text) {
  return String(text).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CELL_CHARS);
}

/* ------------------------------------------------------------ zip guard */

/* Reads the zip central directory without inflating anything. Returns the
   entry names and the total uncompressed size the archive claims. */
function inspectZip(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw validation('That file is not a valid Excel workbook.');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  let inflated = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw validation('That file is not a valid Excel workbook.');
    }
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLen));
    /* 0xFFFFFFFF means a ZIP64 size we do not read: treat it as too big. */
    inflated += size === 0xffffffff ? Infinity : size;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { names, inflated };
}

/* ------------------------------------------------------------------ CSV */

function decodeText(buffer) {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  /* A file saved by Turkish Excel as "CSV" is usually Windows-1254, not UTF-8.
     Replacement characters are the tell. */
  if (text.includes('�')) {
    try { text = new TextDecoder('windows-1254').decode(buffer); } catch (_) { /* keep utf-8 */ }
  }
  return text.replace(/^﻿/, '');
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** RFC 4180, plus the semicolon and tab dialects spreadsheet programs write. */
function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length > MAX_ROWS + 1) break;
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ------------------------------------------------------------------ read */

function normaliseRows(raw) {
  const rows = raw
    .map((r) => r.slice(0, MAX_COLUMNS).map(clean))
    .filter((r) => r.some((c) => c !== ''));
  if (rows.length > MAX_ROWS + 1) {
    throw validation(`That sheet has more than ${MAX_ROWS} rows. Split it into smaller files and import them one at a time.`);
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length < width ? r.concat(Array(width - r.length).fill('')) : r));
}

async function readXlsx(buffer) {
  const { names, inflated } = inspectZip(buffer);
  if (inflated > MAX_INFLATED_BYTES) throw validation('That workbook is too large to import.');
  if (names.some((n) => /vbaProject\.bin$/i.test(n))) {
    throw validation('That workbook contains macros. Save it as a plain .xlsx without macros and try again.');
  }
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (_) {
    throw validation('That file could not be read as an Excel workbook.');
  }
  const sheets = [];
  workbook.eachSheet((worksheet) => {
    if (worksheet.state && worksheet.state !== 'visible') return;
    const raw = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (raw.length > MAX_ROWS + 1) return;
      const cells = [];
      const last = Math.min(row.cellCount, MAX_COLUMNS);
      for (let c = 1; c <= last; c++) cells.push(cellText(row.getCell(c).value));
      raw[rowNumber - 1] = cells;
    });
    sheets.push({ name: String(worksheet.name).slice(0, 100), rows: normaliseRows(raw.filter(Boolean)) });
  });
  if (!sheets.length) throw validation('That workbook has no visible sheets.');
  return sheets;
}

/** Reads a file chosen through the native dialog. Returns { name, sheets }. */
async function readFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.xlsx', '.csv'].includes(ext)) throw validation('Choose an .xlsx or .csv file.');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw validation('Choose a file.');
  if (stat.size === 0) throw validation('That file is empty.');
  if (stat.size > MAX_FILE_BYTES) throw validation('That file is larger than 10 MB. Split it into smaller files.');
  const buffer = fs.readFileSync(filePath);
  const sheets = ext === '.csv'
    ? [{ name: 'CSV', rows: normaliseRows(parseCsv(decodeText(buffer))) }]
    : await readXlsx(buffer);
  return { name: path.basename(filePath), sheets };
}

module.exports = {
  readFile, readXlsx, parseCsv, decodeText, cellText, inspectZip,
  MAX_FILE_BYTES, MAX_INFLATED_BYTES, MAX_ROWS,
};
