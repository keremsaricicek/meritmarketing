'use strict';
/* CSV export.
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
      { label: 'Created', value: (r) => r.created_at },
    ],
    fetch: (ctx, params) => customerService.list(ctx, { ...params, registeredOnly: true, pageSize: 5000 }).rows,
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

function build({ dialog, getWindow }) {
  return {
    async run(ctx, { entity, params = {} }) {
      guard.requireCapability(ctx, 'export.run');
      const dataset = DATASETS[entity];
      if (!dataset) throw validation('Unknown export.', 'entity');
      /* The per-dataset capability is checked in addition to export.run, so
         export cannot become a side door around audit.read or deleted history. */
      guard.requireCapability(ctx, dataset.capability);

      const rows = dataset.fetch(ctx, params);
      const csv = toCsv(dataset.columns, rows);

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const suggested = `${entity}_${stamp}.csv`;
      const result = await dialog.showSaveDialog(getWindow(), {
        title: 'Export',
        defaultPath: suggested,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) return { cancelled: true, rows: rows.length };

      fs.writeFileSync(result.filePath, csv, 'utf8');
      ctx.audit({ action: 'EXPORT', entity_type: entity,
        description: `Exported ${rows.length} rows from ${entity}` });
      return { cancelled: false, rows: rows.length, name: suggested };
    },

    /* Exposed for tests: builds the exact bytes without touching a dialog. */
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

module.exports = { build, toCsv, cell, DATASETS, RISKY_START };
