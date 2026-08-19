'use strict';
/* Customer data access.
 *
 * Two projections, deliberately different sizes:
 *
 *   listRow    what a table row needs — no assignment history, no notes
 *   detail     what the inspector needs — everything, for ONE guest
 *
 * The previous architecture returned the full assignment history on every row
 * of every list. On a book of 10,000 guests that is a nested array per row
 * crossing the process boundary to render a name and a status chip.
 */

const { isQualifying } = require('../services/domain');

/* Role scope is applied to the SQL, before any caller-supplied filter. A filter
   narrows the caller's own set; it never chooses which set is read from. */
function scopeClause(scopeId, alias = 'c') {
  return scopeId === null ? '' : ` AND ${alias}.marketing_profile_id = @scopeId`;
}

/* Derived facts every projection needs, computed in SQL so the whole book is
   never pulled into memory to count it. Deleted and cancelled reservations are
   excluded from qualifying activity; the historical total keeps everything
   except deleted rows, because a deleted booking is not history the operator
   should still be counting. */
const DERIVED = `
  (SELECT COUNT(*) FROM reservations r
     WHERE r.customer_id = c.id AND r.deleted_at IS NULL) AS reservation_count,
  (SELECT COUNT(*) FROM reservations r
     WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL) AS qualifying_reservation_count,
  (SELECT COUNT(*) FROM crm_notes n
     WHERE n.customer_id = c.id AND n.deleted_at IS NULL) AS note_count,
  (SELECT MAX(r.check_in) FROM reservations r
     WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL
       AND r.check_in <= date('now','localtime')) AS last_visit,
  (SELECT MIN(r.check_in) FROM reservations r
     WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL
       AND r.check_in > date('now','localtime')) AS next_visit,
  (SELECT MAX(substr(n.created_at,1,10)) FROM crm_notes n
     WHERE n.customer_id = c.id AND n.deleted_at IS NULL) AS last_note_date,
  p.full_name AS marketing_name
`;

/* Sorting happens on the OUTER query, where the derived columns live and the
   `c.` alias is out of scope — so these are bare names, and the map is a
   whitelist: a sort field is never interpolated from caller input. */
const SORTABLE = Object.freeze({
  name: 'full_name COLLATE NOCASE',
  code: 'code COLLATE NOCASE',
  created: 'created_at',
  updated: 'updated_at',
  last_visit: 'last_visit',
});

function buildFilters(q, scopeId) {
  const where = ['c.deleted_at IS NULL'];
  const params = { scopeId };

  if (scopeId !== null) where.push('c.marketing_profile_id = @scopeId');

  if (q.search) {
    /* Phone stays searchable — an operator with a number on a sticky note must
       be able to find the guest — but it is not returned in finder rows. */
    where.push('(c.full_name LIKE @search OR c.code LIKE @search OR c.phone LIKE @search OR c.passport_no LIKE @search)');
    params.search = `%${q.search}%`;
  }
  if (q.registeredOnly) where.push('c.registered = 1');
  if (q.unregisteredOnly) where.push('c.registered = 0');
  if (q.assignedTo !== undefined && q.assignedTo !== null && q.assignedTo !== '') {
    where.push('c.marketing_profile_id = @assignedTo');
    params.assignedTo = Number(q.assignedTo);
  }
  if (q.createdBy !== undefined && q.createdBy !== null && q.createdBy !== '') {
    where.push('c.created_by = @createdBy');
    params.createdBy = Number(q.createdBy);
  }
  return { where, params };
}

function create(db, row) {
  const stmt = db.prepare(`
    INSERT INTO customers (code, full_name, registered, phone, email, passport_no, nationality,
                           photo_name, notes, marketing_profile_id, created_at, created_by, updated_at, updated_by)
    VALUES (@code, @full_name, @registered, @phone, @email, @passport_no, @nationality,
            @photo_name, @notes, @marketing_profile_id, @created_at, @created_by, @updated_at, @updated_by)`);
  return stmt.run(row).lastInsertRowid;
}

function findById(db, id) {
  return db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

function findByCode(db, code) {
  return db.prepare('SELECT * FROM customers WHERE code = ? COLLATE NOCASE AND deleted_at IS NULL').get(code) || null;
}

/** One decorated guest, with the derived facts the inspector shows. */
function detail(db, id) {
  return db.prepare(`
    SELECT c.*, ${DERIVED}
    FROM customers c LEFT JOIN profiles p ON p.id = c.marketing_profile_id
    WHERE c.id = ? AND c.deleted_at IS NULL`).get(id) || null;
}

/** Narrow rows for a table, plus a total for the pager. */
function list(db, q = {}, scopeId = null) {
  const { where, params } = buildFilters(q, scopeId);
  const whereSql = where.join(' AND ');

  const order = SORTABLE[q.sort] || SORTABLE.updated;
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 25, 1), 5000);
  const page = Math.max(Number(q.page) || 1, 1);

  /* Status and No Record are derived facts, so they cannot be a plain WHERE on
     a stored column. They are filtered on the computed values in an outer
     query rather than recomputed per row in JavaScript. */
  const inner = `
    SELECT c.id, c.code, c.full_name, c.registered, c.phone, c.email, c.passport_no,
           c.nationality, c.photo_name, c.marketing_profile_id, c.created_at, c.created_by,
           c.updated_at, ${DERIVED}
    FROM customers c LEFT JOIN profiles p ON p.id = c.marketing_profile_id
    WHERE ${whereSql}`;

  const outerWhere = [];
  if (q.noRecord) outerWhere.push('registered = 1 AND qualifying_reservation_count = 0 AND note_count = 0');
  if (q.status === 'NO_RECORD') outerWhere.push('registered = 1 AND qualifying_reservation_count = 0 AND note_count = 0');
  if (q.status === 'COLD') {
    outerWhere.push(`registered = 1 AND NOT (qualifying_reservation_count = 0 AND note_count = 0)
      AND julianday(date('now','localtime')) - julianday(COALESCE(next_visit, last_visit, last_note_date, '1900-01-01')) > 90`);
  }
  if (q.status === 'ACTIVE') {
    outerWhere.push(`registered = 1 AND NOT (qualifying_reservation_count = 0 AND note_count = 0)
      AND julianday(date('now','localtime')) - julianday(COALESCE(next_visit, last_visit, last_note_date, '1900-01-01')) <= 90`);
  }
  const outerSql = outerWhere.length ? ` WHERE ${outerWhere.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${inner})${outerSql}`).get(params).n;
  const rows = db.prepare(
    `SELECT * FROM (${inner})${outerSql} ORDER BY ${order} ${dir} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return { rows, total, page, pageSize };
}

/* The finder is deliberately UNSCOPED: an operator must be able to discover
   that a guest already exists before creating a duplicate record. It returns
   identity only — never the phone number of a guest outside the caller's
   scope, which is the line between "this person is already in the book" and
   "here are their contact details". */
function picker(db, q = {}, scopeId = null) {
  const params = { limit: Math.min(Number(q.pageSize) || 50, 200) };
  let where = 'c.deleted_at IS NULL';
  if (q.search) {
    where += ' AND (c.full_name LIKE @search OR c.code LIKE @search OR c.phone LIKE @search OR c.passport_no LIKE @search)';
    params.search = `%${q.search}%`;
  }
  const rows = db.prepare(`
    SELECT c.id, c.code, c.full_name, c.registered, c.phone, c.marketing_profile_id,
      (SELECT MAX(r.check_in) FROM reservations r
        WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL
          AND r.check_in <= date('now','localtime')) AS last_visit
    FROM customers c WHERE ${where}
    ORDER BY c.full_name COLLATE NOCASE LIMIT @limit`).all(params);

  return rows.map((r) => {
    const inScope = scopeId === null || r.marketing_profile_id === scopeId;
    return {
      id: r.id, code: r.code, full_name: r.full_name, registered: r.registered,
      last_visit: r.last_visit,
      phone: inScope ? r.phone : null,
      in_scope: inScope,
    };
  });
}

function update(db, id, patch) {
  const columns = Object.keys(patch);
  if (!columns.length) return;
  const sets = columns.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE customers SET ${sets}, row_version = row_version + 1 WHERE id = @id`)
    .run({ ...patch, id });
}

function softDelete(db, id, { deleted_at, deleted_by }) {
  db.prepare('UPDATE customers SET deleted_at = ?, deleted_by = ?, row_version = row_version + 1 WHERE id = ?')
    .run(deleted_at, deleted_by, id);
}

/** Reservations for a guest, newest stay first, used by the domain rules. */
function reservationsFor(db, customerId, { includeDeleted = false } = {}) {
  const sql = `SELECT * FROM reservations WHERE customer_id = ?
    ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY check_in DESC`;
  return db.prepare(sql).all(customerId);
}

function qualifyingFor(db, customerId) {
  return db.prepare(`SELECT * FROM reservations
    WHERE customer_id = ? AND deleted_at IS NULL AND cancelled_at IS NULL
    ORDER BY check_in DESC`).all(customerId);
}

function assignmentHistory(db, customerId) {
  return db.prepare(`
    SELECT h.*, pp.full_name AS previous_profile_name, np.full_name AS new_profile_name, u.username AS actor_username
    FROM assignment_history h
    LEFT JOIN profiles pp ON pp.id = h.previous_profile_id
    LEFT JOIN profiles np ON np.id = h.new_profile_id
    LEFT JOIN users u ON u.id = h.actor_user_id
    WHERE h.customer_id = ? ORDER BY h.changed_at ASC, h.id ASC`).all(customerId);
}

function recordAssignment(db, entry) {
  db.prepare(`
    INSERT INTO assignment_history
      (customer_id, previous_profile_id, new_profile_id, event_type, source, reservation_id, actor_user_id, changed_at)
    VALUES (@customer_id, @previous_profile_id, @new_profile_id, @event_type, @source, @reservation_id, @actor_user_id, @changed_at)`)
    .run(entry);
}

module.exports = {
  create, findById, findByCode, detail, list, picker, update, softDelete,
  reservationsFor, qualifyingFor, assignmentHistory, recordAssignment,
  SORTABLE, scopeClause, isQualifying,
};
