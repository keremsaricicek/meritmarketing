'use strict';
/* Guest import from .xlsx and .csv.
 *
 * The flow is choose → sheet → mapping → preview → import, and the file never
 * leaves the main process. The renderer gets a token, the sheet names, a few
 * sample rows and the preview verdicts; the path itself comes from a native
 * Open dialog run here, exactly as export-service runs its Save dialog.
 *
 * Rules that hold whatever the spreadsheet says:
 *
 *   - CAPABILITY. Importing creates guests, so it needs customers.create.
 *     Filling empty fields on existing guests additionally needs
 *     customers.update.
 *   - SCOPE. A marketer's imported guests are theirs — the owner column is
 *     ignored for MARKETING, as customers:create ignores a foreign owner — and
 *     a marketer can only ever update a guest in their own book. A duplicate
 *     owned by somebody else is reported by Guest ID and name only, the same
 *     identity customers:summary already discloses.
 *   - ATOMICITY. The whole import is one transaction: a crash halfway leaves
 *     the book as it was.
 *   - ONE AUDIT ROW per import, with the counts, rather than a few thousand
 *     CUSTOMER_CREATE rows nobody can read.
 */

const crypto = require('crypto');
const customersRepo = require('../repositories/customers');
const guard = require('./guard');
const spreadsheet = require('./import/spreadsheet');
const rules = require('./import/rules');
const { nowIso, today } = require('../../shared/contracts/dates');
const { validation, notFound } = require('../../shared/errors');

const PENDING_TTL_MS = 30 * 60 * 1000;
const SAMPLE_ROWS = 8;
const TEMPLATE_KEY = 'import.templates';
const MAX_TEMPLATES = 30;

/* ------------------------------------------------------------- pending */

/* One parsed file per signed-in user, held in memory between steps. Keyed by
   user id AND token, so a token from another account (or a stale one from an
   earlier session) resolves to nothing. */
const pending = new Map();

function remember(userId, file) {
  const token = crypto.randomUUID();
  pending.set(userId, { token, file, at: Date.now() });
  return token;
}

function recall(ctx, token) {
  const session = guard.requireCapability(ctx, 'customers.create');
  const entry = pending.get(session.id);
  if (!entry || entry.token !== token || Date.now() - entry.at > PENDING_TTL_MS) {
    throw notFound('That file is no longer open. Choose it again.');
  }
  entry.at = Date.now();
  return { session, entry };
}

function sheetAt(file, index) {
  const sheet = file.sheets[index];
  if (!sheet) throw validation('That sheet does not exist.', 'sheet');
  return sheet;
}

function sheetView(file, index) {
  const sheet = sheetAt(file, index);
  const headers = sheet.rows[0] || [];
  return {
    sheet: index,
    headers: headers.map((h, i) => h || `Column ${i + 1}`),
    sample: sheet.rows.slice(1, 1 + SAMPLE_ROWS),
    rowCount: Math.max(sheet.rows.length - 1, 0),
    mapping: rules.guessMapping(headers),
  };
}

/* ------------------------------------------------------------- analysis */

function nextCodeFactory(db) {
  const stamp = today().replace(/-/g, '').slice(2);
  const prefix = `IMP-${stamp}-`;
  /* Archived guests keep their Guest ID forever, so they count too. */
  const used = db.prepare('SELECT code FROM customers WHERE code LIKE ?').all(`${prefix}%`)
    .map((r) => Number(String(r.code).slice(prefix.length)) || 0);
  let n = used.length ? Math.max(...used) : 0;
  return () => `${prefix}${String(++n).padStart(4, '0')}`;
}

function profileIndex(db) {
  const byName = new Map();
  for (const p of db.prepare("SELECT id, full_name, employment_status FROM profiles WHERE COALESCE(kind,'marketing') = 'marketing'").all()) {
    byName.set(rules.fold(p.full_name), p);
  }
  return byName;
}

function existingIndex(db) {
  const rows = db.prepare(`SELECT id, code, full_name, phone, email, passport_no, nationality, notes,
    marketing_profile_id FROM customers WHERE deleted_at IS NULL`).all();
  const byPhone = new Map();
  const byPassport = new Map();
  const byCode = new Map();
  for (const r of rows) {
    const pk = rules.phoneKey(r.phone);
    if (pk && !byPhone.has(pk)) byPhone.set(pk, r);
    const ppk = rules.passportKey(r.passport_no);
    if (ppk && !byPassport.has(ppk)) byPassport.set(ppk, r);
    byCode.set(String(r.code).toUpperCase(), r);
  }
  return { byPhone, byPassport, byCode };
}

const FILLABLE = Object.freeze({
  phone: 'phone', email: 'email', passportNo: 'passport_no', nationality: 'nationality', notes: 'notes',
});

function fillPatch(existing, values) {
  const patch = {};
  for (const [field, column] of Object.entries(FILLABLE)) {
    if (values[field] && !String(existing[column] || '').trim()) patch[column] = values[field];
  }
  return patch;
}

/**
 * Every data row of a sheet → a verdict. Shared by preview and import, so what
 * the operator approved is what gets written.
 */
function analyse(ctx, session, sheet, rawMapping, duplicates) {
  const width = (sheet.rows[0] || []).length;
  const mapping = rules.cleanMapping(rawMapping, width);
  if (mapping.fullName === undefined && mapping.firstName === undefined && mapping.lastName === undefined) {
    throw validation('Map a Full name column, or Name and Surname columns, before previewing.', 'mapping');
  }
  const scopeId = guard.scopeOf(ctx);
  const canUpdate = ctx.sessions.can('customers.update');
  const existing = existingIndex(ctx.db);
  const profiles = profileIndex(ctx.db);
  const ownProfile = session.role === 'MARKETING' && session.profile_id
    ? ctx.db.prepare('SELECT full_name FROM profiles WHERE id = ?').get(session.profile_id) : null;

  const seenPhone = new Map();
  const seenPassport = new Map();
  const seenCode = new Map();
  const out = [];

  sheet.rows.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2;            // spreadsheet row, header is row 1
    const { values, problems } = rules.interpretRow(cells, mapping);
    const verdict = {
      row: rowNumber, name: values.fullName, phone: values.phone, passportNo: values.passportNo,
      code: values.code, status: 'new', action: 'create', reason: '', warnings: [], match: null,
      values, ownerId: null, patch: null,
    };

    if (problems.length) {
      verdict.status = 'invalid'; verdict.action = 'skip'; verdict.reason = problems.join('; ');
      out.push(verdict); return;
    }

    /* Owner. A marketer's import is always theirs. */
    if (session.role === 'MARKETING') {
      verdict.ownerId = session.profile_id;
      if (values.owner && ownProfile && rules.fold(values.owner) !== rules.fold(ownProfile.full_name)) {
        verdict.warnings.push('Owner column ignored: imported guests are assigned to you');
      }
    } else if (values.owner) {
      const profile = profiles.get(rules.fold(values.owner));
      if (!profile) verdict.warnings.push(`No marketing profile named “${values.owner}”: imported unassigned`);
      else if (profile.employment_status !== 'active') verdict.warnings.push(`${profile.full_name} is inactive: imported unassigned`);
      else verdict.ownerId = profile.id;
    }

    /* Duplicates inside the file itself. */
    const pk = rules.phoneKey(values.phone);
    const ppk = rules.passportKey(values.passportNo);
    const ck = values.code ? values.code.toUpperCase() : '';
    const earlier = (pk && seenPhone.get(pk)) || (ppk && seenPassport.get(ppk)) || (ck && seenCode.get(ck));
    if (pk && !seenPhone.has(pk)) seenPhone.set(pk, rowNumber);
    if (ppk && !seenPassport.has(ppk)) seenPassport.set(ppk, rowNumber);
    if (ck && !seenCode.has(ck)) seenCode.set(ck, rowNumber);
    if (earlier) {
      verdict.status = 'duplicate'; verdict.action = 'skip';
      verdict.reason = `Same guest as row ${earlier} of this file`;
      out.push(verdict); return;
    }

    /* Duplicates of guests already in the book. */
    const match = (ck && existing.byCode.get(ck)) || (pk && existing.byPhone.get(pk)) || (ppk && existing.byPassport.get(ppk));
    if (match) {
      const inScope = scopeId === null || match.marketing_profile_id === scopeId;
      const by = ck && existing.byCode.get(ck) === match ? 'Guest ID'
        : pk && existing.byPhone.get(pk) === match ? 'phone' : 'passport';
      verdict.status = 'duplicate';
      verdict.match = { code: match.code, name: match.full_name };
      verdict.action = 'skip';
      verdict.reason = `Matches #${match.code} ${match.full_name} by ${by}`;
      if (duplicates === 'update') {
        if (!inScope) verdict.reason += ' — belongs to another marketer, skipped';
        else if (!canUpdate) verdict.reason += ' — you cannot edit guests, skipped';
        else {
          const patch = fillPatch(match, values);
          if (Object.keys(patch).length) {
            verdict.action = 'update'; verdict.patch = patch; verdict.matchId = match.id;
            verdict.reason += ` — will fill ${Object.keys(patch).map((c) => c.replace('_', ' ')).join(', ')}`;
          } else verdict.reason += ' — nothing empty to fill';
        }
      }
      out.push(verdict); return;
    }

    if (ck && customersRepo.findArchivedByCode(ctx.db, values.code)) {
      verdict.status = 'invalid'; verdict.action = 'skip';
      verdict.reason = 'That Guest ID belongs to an archived guest';
    }
    out.push(verdict);
  });
  return { mapping, rows: out };
}

function counts(rows) {
  const c = { total: rows.length, new: 0, duplicate: 0, invalid: 0, create: 0, update: 0, skip: 0 };
  for (const r of rows) { c[r.status] += 1; c[r.action] += 1; }
  return c;
}

/* What the renderer sees of a verdict: no internal ids, no raw values. */
function publicRow(r) {
  return {
    row: r.row, name: r.name, phone: r.phone, passportNo: r.passportNo, code: r.code,
    status: r.status, action: r.action, reason: r.reason, warnings: r.warnings, match: r.match,
  };
}

/* ------------------------------------------------------------- templates */

function readTemplates(db, userId) {
  const row = db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(userId, TEMPLATE_KEY);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function writeTemplates(db, userId, list) {
  db.prepare(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(userId, TEMPLATE_KEY, JSON.stringify(list), nowIso());
}

/* --------------------------------------------------------------- service */

function build({ dialog, getWindow }) {
  return {
    async choose(ctx) {
      const session = guard.requireCapability(ctx, 'customers.create');
      const result = await dialog.showOpenDialog(getWindow(), {
        title: 'Import guests',
        properties: ['openFile'],
        filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'csv'] }],
      });
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return { cancelled: true };
      const file = await spreadsheet.readFile(result.filePaths[0]);
      return this.open(ctx, session, file);
    },

    /* Separate from choose() so tests can hand in a parsed file without a dialog. */
    open(ctx, session, file) {
      const token = remember(session.id, file);
      return {
        cancelled: false, token, fileName: file.name,
        sheets: file.sheets.map((s, index) => ({ index, name: s.name, rowCount: Math.max(s.rows.length - 1, 0) })),
        fields: rules.FIELDS.map(({ key, label }) => ({ key, label })),
        ...sheetView(file, 0),
      };
    },

    sheet(ctx, { token, sheet }) {
      const { entry } = recall(ctx, token);
      return sheetView(entry.file, sheet);
    },

    preview(ctx, { token, sheet, mapping, duplicates = 'skip' }) {
      const { session, entry } = recall(ctx, token);
      const result = analyse(ctx, session, sheetAt(entry.file, sheet), mapping, duplicates);
      return { counts: counts(result.rows), rows: result.rows.map(publicRow) };
    },

    commit(ctx, { token, sheet, mapping, duplicates = 'skip' }) {
      const { session, entry } = recall(ctx, token);
      const file = entry.file;
      const result = analyse(ctx, session, sheetAt(file, sheet), mapping, duplicates);
      const now = nowIso();
      const created = [];
      let updated = 0;

      ctx.db.transaction(() => {
        const nextCode = nextCodeFactory(ctx.db);
        for (const r of result.rows) {
          if (r.action === 'create') {
            let code = r.values.code;
            if (!code) {
              do { code = nextCode(); } while (customersRepo.findByCode(ctx.db, code) || customersRepo.findArchivedByCode(ctx.db, code));
            }
            const id = customersRepo.create(ctx.db, {
              code, full_name: r.values.fullName, registered: 1,
              phone: r.values.phone || null, email: r.values.email || null,
              passport_no: r.values.passportNo || null, nationality: r.values.nationality || null,
              photo_name: null, notes: r.values.notes || null,
              marketing_profile_id: r.ownerId,
              created_at: now, created_by: session.id, updated_at: now, updated_by: session.id,
            });
            if (r.ownerId) {
              customersRepo.recordAssignment(ctx.db, {
                customer_id: id, previous_profile_id: null, new_profile_id: r.ownerId,
                event_type: 'explicit', source: 'import', reservation_id: null,
                actor_user_id: session.id, changed_at: now,
              });
            }
            created.push(code);
          } else if (r.action === 'update') {
            customersRepo.update(ctx.db, r.matchId, { ...r.patch, updated_at: now, updated_by: session.id });
            updated += 1;
          }
        }
        const c = counts(result.rows);
        ctx.audit({
          action: 'CUSTOMER_IMPORT', entity_type: 'customer',
          description: `Imported ${file.name}: ${created.length} created, ${updated} updated, `
            + `${c.skip} skipped (${c.duplicate} duplicate, ${c.invalid} invalid) of ${c.total} rows`,
          metadata: { file: file.name, sheet: file.sheets[sheet].name, total: c.total, created: created.length,
            updated, skipped: c.skip, duplicate: c.duplicate, invalid: c.invalid, duplicates },
        });
      })();

      pending.delete(session.id);
      const c = counts(result.rows);
      return {
        fileName: file.name, total: c.total, created: created.length, updated,
        skipped: c.skip, duplicate: c.duplicate, invalid: c.invalid,
        firstCodes: created.slice(0, 5),
        problems: result.rows.filter((r) => r.action === 'skip').slice(0, 200).map(publicRow),
      };
    },

    templates(ctx) {
      const session = guard.requireCapability(ctx, 'customers.create');
      return readTemplates(ctx.db, session.id);
    },

    saveTemplate(ctx, { name, mapping }) {
      const session = guard.requireCapability(ctx, 'customers.create');
      const label = String(name || '').trim();
      if (!label) throw validation('Give the template a name.', 'name');
      const clean = {};
      for (const [field, header] of Object.entries(mapping || {})) {
        if (rules.FIELD_KEYS.includes(field) && typeof header === 'string' && header.trim()) clean[field] = header.trim().slice(0, 120);
      }
      if (!Object.keys(clean).length) throw validation('Map at least one column before saving a template.', 'mapping');
      const list = readTemplates(ctx.db, session.id).filter((t) => t.name !== label);
      if (list.length >= MAX_TEMPLATES) throw validation(`You can keep up to ${MAX_TEMPLATES} templates. Delete one first.`);
      list.push({ name: label, mapping: clean });
      list.sort((a, b) => a.name.localeCompare(b.name));
      writeTemplates(ctx.db, session.id, list);
      return list;
    },

    deleteTemplate(ctx, { name }) {
      const session = guard.requireCapability(ctx, 'customers.create');
      const list = readTemplates(ctx.db, session.id).filter((t) => t.name !== String(name || ''));
      writeTemplates(ctx.db, session.id, list);
      return list;
    },
  };
}

module.exports = { build, analyse, counts, pending, PENDING_TTL_MS };
