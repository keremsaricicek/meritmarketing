'use strict';
/* Reservation data access.
 *
 * Three views of one table, and keeping them disjoint is the whole point:
 *   active     not cancelled, not deleted
 *   cancelled  cancelled, NOT deleted
 *   deleted    deleted (ADMIN/MANAGER only — enforced in the service, not here)
 *
 * A cancelled reservation that is later deleted belongs to `deleted` alone. If
 * it appeared in both, the operator would cancel it twice, and the Cancelled
 * count would never agree with the Cancelled list.
 */

const SORTABLE = Object.freeze({
  customer: 'customer_name COLLATE NOCASE',
  check_in: 'r.check_in',
  check_out: 'r.check_out',
  created: 'r.created_at',
  invited: 'invited_by_name COLLATE NOCASE',
});

const SELECT = `
  SELECT r.id, r.customer_id, r.check_in, r.check_out, r.invited_by_profile_id,
         r.reservation_note, r.created_at, r.created_by, r.updated_at,
         r.cancelled_at, r.cancelled_by, r.cancellation_reason,
         r.deleted_at, r.deleted_by, r.deletion_reason, r.row_version,
         c.full_name AS customer_name, c.code AS customer_code, c.registered AS customer_registered,
         p.full_name AS invited_by_name,
         du.username AS deleted_by_username, cu.username AS cancelled_by_username
  FROM reservations r
  JOIN customers c ON c.id = r.customer_id
  LEFT JOIN profiles p ON p.id = r.invited_by_profile_id
  LEFT JOIN users du ON du.id = r.deleted_by
  LEFT JOIN users cu ON cu.id = r.cancelled_by`;

/**
 * @param {'active'|'cancelled'|'deleted'|'all'} view
 * `scopeId` narrows to one marketing profile before any caller filter applies.
 */
function list(db, q = {}, scopeId = null, view = 'active') {
  const where = [];
  const params = {};

  if (view === 'active') where.push('r.deleted_at IS NULL AND r.cancelled_at IS NULL');
  else if (view === 'cancelled') where.push('r.deleted_at IS NULL AND r.cancelled_at IS NOT NULL');
  else if (view === 'deleted') where.push('r.deleted_at IS NOT NULL');
  else where.push('r.deleted_at IS NULL');

  if (scopeId !== null) { where.push('r.invited_by_profile_id = @scopeId'); params.scopeId = scopeId; }

  if (q.search) {
    where.push('(c.full_name LIKE @search OR c.code LIKE @search)');
    params.search = `%${q.search}%`;
  }
  if (q.customerId) { where.push('r.customer_id = @customerId'); params.customerId = Number(q.customerId); }
  if (q.invitedBy !== undefined && q.invitedBy !== null && q.invitedBy !== '') {
    where.push('r.invited_by_profile_id = @invitedBy'); params.invitedBy = Number(q.invitedBy);
  }
  if (q.from) { where.push('r.check_in >= @from'); params.from = q.from; }
  if (q.to) { where.push('r.check_in <= @to'); params.to = q.to; }

  /* Lifecycle is derived from dates, so filtering by it is a date predicate —
     never a stored status column a client could have set. */
  if (q.status === 'UPCOMING') where.push("r.check_in > date('now','localtime')");
  else if (q.status === 'CHECKED_IN') where.push("r.check_in <= date('now','localtime') AND r.check_out >= date('now','localtime')");
  else if (q.status === 'COMPLETED') where.push("r.check_out < date('now','localtime')");

  const whereSql = where.join(' AND ');
  const order = SORTABLE[q.sort] || SORTABLE.check_in;
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 25, 1), 5000);
  const page = Math.max(Number(q.page) || 1, 1);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM reservations r
    JOIN customers c ON c.id = r.customer_id WHERE ${whereSql}`).get(params).n;
  const rows = db.prepare(`${SELECT} WHERE ${whereSql} ORDER BY ${order} ${dir} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize });

  return { rows, total, page, pageSize };
}

function findById(db, id, { includeDeleted = false } = {}) {
  const sql = `${SELECT} WHERE r.id = ?${includeDeleted ? '' : ' AND r.deleted_at IS NULL'}`;
  return db.prepare(sql).get(id) || null;
}

/** The raw row, including tombstones — services need this to decide access. */
function findRaw(db, id) {
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id) || null;
}

function create(db, row) {
  return db.prepare(`
    INSERT INTO reservations (customer_id, check_in, check_out, invited_by_profile_id, reservation_note,
                              created_at, created_by, updated_at, updated_by)
    VALUES (@customer_id, @check_in, @check_out, @invited_by_profile_id, @reservation_note,
            @created_at, @created_by, @updated_at, @updated_by)`).run(row).lastInsertRowid;
}

function update(db, id, patch) {
  const columns = Object.keys(patch);
  if (!columns.length) return;
  const sets = columns.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE reservations SET ${sets}, row_version = row_version + 1 WHERE id = @id`)
    .run({ ...patch, id });
}

/** Overlapping non-cancelled, non-deleted stays for the same guest. */
function overlapping(db, customerId, checkIn, checkOut, excludeId = null) {
  return db.prepare(`
    SELECT id, check_in, check_out FROM reservations
    WHERE customer_id = @customerId AND deleted_at IS NULL AND cancelled_at IS NULL
      AND check_in <= @checkOut AND check_out >= @checkIn
      AND (@excludeId IS NULL OR id <> @excludeId)`)
    .all({ customerId, checkIn, checkOut, excludeId });
}

/* Calendar buckets, computed in SQL and mutually exclusive by construction —
   a stay is an arrival, OR in-house, OR a departure on any given day. */
function calendarMonth(db, year, month, scopeId = null) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = `${year}-${String(month).padStart(2, '0')}-31`;
  const params = { first, last, scopeId };
  const scope = scopeId === null ? '' : ' AND r.invited_by_profile_id = @scopeId';
  const rows = db.prepare(`
    SELECT r.check_in, r.check_out FROM reservations r
    WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL
      AND r.check_in <= @last AND r.check_out >= @first${scope}`).all(params);

  const buckets = {};
  const touch = (d) => (buckets[d] = buckets[d] || { arrivals: 0, active: 0, departures: 0 });
  for (const r of rows) {
    if (r.check_in >= first && r.check_in <= last) touch(r.check_in).arrivals++;
    if (r.check_out >= first && r.check_out <= last) touch(r.check_out).departures++;
    let d = r.check_in;
    for (;;) {
      const [y, m, dd] = d.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
      if (next >= r.check_out) break;
      if (next >= first && next <= last) touch(next).active++;
      d = next;
    }
  }
  return buckets;
}

function calendarDay(db, date, scopeId = null) {
  const scope = scopeId === null ? '' : ' AND r.invited_by_profile_id = @scopeId';
  const q = (predicate) => db.prepare(
    `${SELECT} WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL AND ${predicate}${scope}
     ORDER BY c.full_name COLLATE NOCASE`).all({ date, scopeId });
  return {
    arrivals: q('r.check_in = @date'),
    departures: q('r.check_out = @date'),
    active: q('r.check_in < @date AND r.check_out > @date'),
  };
}

module.exports = { list, findById, findRaw, create, update, overlapping, calendarMonth, calendarDay, SORTABLE };
