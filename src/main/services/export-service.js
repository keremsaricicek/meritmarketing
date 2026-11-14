'use strict';
/* CSV and Excel export.
 *
 * Two hazards live here and both are easy to get wrong:
 *
 * 1. SCOPE. An export reads the same scoped datasets the screens do. Building a
 *    separate query "just for the report" is how a marketer's export quietly
 *    contains the whole book.
 *
 * 2. FORMULA INJECTION. Excel treats a cell beginning =, +, - or @ as a
 *    formula. A guest named `=cmd|'/c calc'!A1` becomes code when the file is
 *    opened. Quoting is not enough — the guard is prefixing the value so the
 *    spreadsheet reads it as text.
 *
 * The renderer never chooses a path: a native Save dialog runs in the main
 * process and the file is written there.
 */

const fs = require('fs');
const path = require('path');
const customersRepo = require('../repositories/customers');
const reservationsRepo = require('../repositories/reservations');
const customerService = require('./customer-service');
const reservationService = require('./reservation-service');
const domain = require('./domain');
const guard = require('./guard');
const { validation, forbidden } = require('../../shared/errors');

const RISKY_START = /^[=+\-@\t\r]/;

/** One CSV cell: neutralised against formula execution, then quoted. */
function cell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  /* A leading apostrophe makes Excel and LibreOffice treat the rest as text.
     Applied before quoting so the guard survives the escaping. */
  if (RISKY_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  const head = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(',')).join('\n');
  /* The BOM is what makes Excel open a UTF-8 file with Turkish characters
     correctly instead of mangling them. */
  return `﻿${head}\n${body}\n`;
}

const DATASETS = {
  customerlist: {
    capability: 'customers.read',
    columns: [
      { label: 'Guest ID', value: (r) => r.code },
      { label: 'Name', value: (r) => r.full_name },
      { label: 'Status', value: (r) => r.status || '' },
      { label: 'Marketing', value: (r) => r.marketing_name || '' },
      { label: 'Phone', value: (r) => r.phone || '' },
      { label: 'Email', value: (r) => r.email || '' },
      { label: 'Passport', value: (r) => r.passport_no || '' },
      { label: 'Nationality', value: (r) => r.nationality || '' },
      { label: 'Reservations', value: (r) => r.qualifying_reservation_count },
      { label: 'Last Visit', value: (r) => r.last_visit || '' },
      { label: 'Next Visit', value: (r) => r.next_visit || '' },
      { label: 'Notes', value: (r) => r.note_count },
      { label: 'Latest CRM note', value: (r) => r.last_note_text || '' },
      { label: 'Latest note date', value: (r) => r.last_note_date || '' },
      { label: 'Latest note by', value: (r) => r.last_note_by || '' },
      { label: 'Created', value: (r) => r.created_at },
    ],
    guests: true,
    /* An explicit selection ("Export selected") can include unregistered
       leads from the Overview, so it is not narrowed to registered guests. It
       still runs through the scoped list: an id outside the caller's book is
       simply not found. */
    fetch: (ctx, params) => customerService.list(ctx, params.ids
      ? { ...params, pageSize: 5000 }
      : { ...params, registeredOnly: true, pageSize: 5000 }).rows,
  },
  norecord: {
    capability: 'customers.read',
    columns: [
      { label: 'Guest ID', value: (r) => r.code },
      { label: 'Name', value: (r) => r.full_name },
      { label: 'Marketing', value: (r) => r.marketing_name || '' },
      { label: 'Created', value: (r) => r.created_at },
    ],
    fetch: (ctx, params) => customerService.list(ctx, { ...params, noRecord: true, registeredOnly: true, pageSize: 5000 }).rows,
    guests: true,
  },
  reservations: {
    capability: 'reservations.read',
    columns: [
      { label: 'Guest ID', value: (r) => r.customer_code },
      { label: 'Name', value: (r) => r.customer_name },
      { label: 'Check In', value: (r) => r.check_in },
      { label: 'Check Out', value: (r) => r.check_out },
      { label: 'Status', value: (r) => r.status },
      { label: 'Invited By', value: (r) => r.invited_by_name || '' },
      { label: 'Note', value: (r) => r.reservation_note || '' },
      { label: 'Created', value: (r) => r.created_at },
    ],
    fetch: (ctx, params) => reservationService.list(ctx, { ...params, pageSize: 5000 }).rows,
  },
  cancelled: {
    capability: 'reservations.read',
    columns: [
      { label: 'Guest ID', value: (r) => r.customer_code },
      { label: 'Name', value: (r) => r.customer_name },
      { label: 'Check In', value: (r) => r.check_in },
      { label: 'Check Out', value: (r) => r.check_out },
      { label: 'Invited By', value: (r) => r.invited_by_name || '' },
      { label: 'Cancelled', value: (r) => r.cancelled_at || '' },
      { label: 'Reason', value: (r) => r.cancellation_reason || '' },
    ],
    fetch: (ctx, params) => reservationService.list(ctx, { ...params, view: 'cancelled', pageSize: 5000 }).rows,
  },
  /* Deleted history is management-only, and the capability check inside
     listDeleted is what enforces that — not this table. */
  deleted: {
    capability: 'reservations.deleted.read',
    columns: [
      { label: 'Guest ID', value: (r) => r.customer_code },
      { label: 'Name', value: (r) => r.customer_name },
      { label: 'Check In', value: (r) => r.check_in },
      { label: 'Check Out', value: (r) => r.check_out },
      { label: 'Invited By', value: (r) => r.invited_by_name || '' },
      { label: 'Deleted', value: (r) => r.deleted_at || '' },
      { label: 'Deleted By', value: (r) => r.deleted_by_username || '' },
      { label: 'Reason', value: (r) => r.deletion_reason || '' },
    ],
    fetch: (ctx, params) => reservationService.listDeleted(ctx, { ...params, pageSize: 5000 }).rows,
  },
  profiles: {
    capability: 'profiles.read',
    columns: [
      { label: 'Name', value: (r) => r.full_name },
      { label: 'Status', value: (r) => r.employment_status },
      { label: 'Phone', value: (r) => r.phone || '' },
      { label: 'Email', value: (r) => r.email || '' },
      { label: 'Guests', value: (r) => (r.customer_count === null ? '' : r.customer_count) },
      { label: 'Reservations Invited', value: (r) => (r.reservation_count === null ? '' : r.reservation_count) },
    ],
    fetch: (ctx, params) => require('./support-services').profiles.list(ctx, params),
  },
  audit: {
    capability: 'audit.read',
    columns: [
      { label: 'When', value: (r) => r.created_at },
      { label: 'User', value: (r) => r.actor_username || '' },
      { label: 'Action', value: (r) => r.action },
      { label: 'Entity', value: (r) => r.entity_type || '' },
      { label: 'Detail', value: (r) => r.description || '' },
    ],
    fetch: (ctx, params) => require('./support-services').audit.list(ctx, { ...params, pageSize: 1000 }).rows,
  },
};

/* Columns chosen in the export dialog, by label. Unknown labels are dropped;
   an empty choice means every column. Order follows the dataset, not the
   request, so a crafted list cannot reorder or repeat columns. */
function chooseColumns(dataset, wanted) {
  if (!Array.isArray(wanted) || !wanted.length) return dataset.columns;
  const set = new Set(wanted);
  const picked = dataset.columns.filter((c) => set.has(c.label));
  return picked.length ? picked : dataset.columns;
}

/* Every CRM note of the exported guests, for the second sheet. The guest ids
   come from the scoped dataset just fetched, never from the request. */
function notesFor(db, guestIds) {
  if (!guestIds.length) return [];
  return db.prepare(`
    SELECT c.code, c.full_name, COALESCE(n.note_date, date(n.created_at,'localtime')) AS note_date,
           n.note, COALESCE(u.full_name, u.username) AS author, n.created_at
    FROM crm_notes n
    JOIN customers c ON c.id = n.customer_id
    LEFT JOIN users u ON u.id = n.created_by
    WHERE n.deleted_at IS NULL AND n.customer_id IN (SELECT value FROM json_each(?))
    ORDER BY c.full_name COLLATE NOCASE, note_date DESC, n.created_at DESC`).all(JSON.stringify(guestIds));
}

const NOTE_COLUMNS = [
  { label: 'Guest ID', value: (r) => r.code },
  { label: 'Name', value: (r) => r.full_name },
  { label: 'Note date', value: (r) => r.note_date || '' },
  { label: 'Note', value: (r) => r.note },
  { label: 'Author', value: (r) => r.author || '' },
  { label: 'Written', value: (r) => r.created_at },
];

/* An .xlsx cell written as a string is a string: Excel never evaluates it, so
   the CSV formula guard is not needed here. Values are always plain strings or
   numbers — never an object with a `formula` key, which is the one shape
   ExcelJS would write as a formula. */
function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((c) => ({
    header: c.label, key: c.label, width: Math.min(Math.max(c.label.length + 4, 12), 60),
  }));
  for (const row of rows) {
    const values = {};
    for (const c of columns) {
      const v = c.value(row);
      values[c.label] = v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v));
    }
    sheet.addRow(values);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

async function toXlsx(sheets) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Merit Marketing Hub';
  workbook.created = new Date();
  for (const s of sheets) addSheet(workbook, s.name, s.columns, s.rows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const SHEET_NAMES = {
  customerlist: 'Guests', norecord: 'No record', reservations: 'Reservations', cancelled: 'Cancelled',
  deleted: 'Deleted', profiles: 'Profiles', audit: 'Audit log',
};

/** Shared by run() and renderFile(): the checks, the scoped rows, the bytes. */
async function produce(ctx, { entity, params = {}, format = 'csv', columns, includeAllNotes = false }) {
  guard.requireCapability(ctx, 'export.run');
  const dataset = DATASETS[entity];
  if (!dataset) throw validation('Unknown export.', 'entity');
  /* The per-dataset capability is checked in addition to export.run, so
     export cannot become a side door around audit.read or deleted history. */
  guard.requireCapability(ctx, dataset.capability);
  if (params.ids && !dataset.guests) throw validation('A selection can only be exported from a guest list.', 'ids');
  if (includeAllNotes) {
    if (!dataset.guests) throw validation('Notes can only be added to a guest export.', 'includeAllNotes');
    if (format !== 'xlsx') throw validation('All notes need the Excel format.', 'includeAllNotes');
    guard.requireCapability(ctx, 'crm.read');
  }

  const rows = dataset.fetch(ctx, params);
  const cols = chooseColumns(dataset, columns);
  if (format === 'xlsx') {
    const sheets = [{ name: SHEET_NAMES[entity] || 'Export', columns: cols, rows }];
    let noteCount = 0;
    if (includeAllNotes) {
      const notes = notesFor(ctx.db, rows.map((r) => r.id));
      noteCount = notes.length;
      sheets.push({ name: 'CRM notes', columns: NOTE_COLUMNS, rows: notes });
    }
    return { bytes: await toXlsx(sheets), rows: rows.length, notes: noteCount, ext: 'xlsx' };
  }
  const csv = toCsv(cols, rows);
  return { bytes: Buffer.from(csv, 'utf8'), csv, rows: rows.length, notes: 0, ext: 'csv' };
}

function build({ dialog, getWindow }) {
  return {
    async run(ctx, payload) {
      const { entity } = payload;
      const out = await produce(ctx, payload);

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const suggested = `${entity}_${stamp}.${out.ext}`;
      const result = await dialog.showSaveDialog(getWindow(), {
        title: 'Export',
        defaultPath: suggested,
        filters: out.ext === 'xlsx'
          ? [{ name: 'Excel workbook', extensions: ['xlsx'] }]
          : [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) return { cancelled: true, rows: out.rows };

      fs.writeFileSync(result.filePath, out.bytes);
      const selected = payload.params && Array.isArray(payload.params.ids) ? ' (selected guests)' : '';
      ctx.audit({ action: 'EXPORT', entity_type: entity,
        description: `Exported ${out.rows} rows from ${entity}${selected} as ${out.ext.toUpperCase()}`
          + (out.notes ? ` with ${out.notes} CRM notes` : ''),
        metadata: { format: out.ext, rows: out.rows, notes: out.notes } });
      return { cancelled: false, rows: out.rows, notes: out.notes, name: path.basename(result.filePath) };
    },

    /* The columns a dataset offers, for the export dialog's checklist. */
    columns(ctx, { entity }) {
      guard.requireCapability(ctx, 'export.run');
      const dataset = DATASETS[entity];
      if (!dataset) throw validation('Unknown export.', 'entity');
      guard.requireCapability(ctx, dataset.capability);
      return {
        columns: dataset.columns.map((c) => c.label),
        guests: !!dataset.guests,
        notes: !!dataset.guests && ctx.sessions.can('crm.read'),
      };
    },

    /* Exposed for tests: the exact bytes, without a dialog. */
    renderFile(ctx, payload) {
      return produce(ctx, payload);
    },

    /* The original synchronous CSV path the existing suites use. */
    render(ctx, { entity, params = {} }) {
      guard.requireCapability(ctx, 'export.run');
      const dataset = DATASETS[entity];
      if (!dataset) throw validation('Unknown export.', 'entity');
      guard.requireCapability(ctx, dataset.capability);
      const rows = dataset.fetch(ctx, params);
      return { csv: toCsv(dataset.columns, rows), rows: rows.length };
    },
  };
}

module.exports = { build, toCsv, toXlsx, cell, DATASETS, RISKY_START, NOTE_COLUMNS };
