'use strict';
/* Oversight: the activity feed, global search and Team control.
 *
 * All three are READ-ONLY views over data the product already records. Nothing
 * here writes, and nothing here widens what a caller may see:
 *
 *   activity.feed  — everyone's actions only with `activity.team`; otherwise the
 *                    caller's own actions, whatever they ask for.
 *   search.global  — guests, notes and reservations through the same record
 *                    scope the lists use, so a MARKETING caller finds only what
 *                    is already theirs.
 *   team.overview  — requires `team.control`, which no non-admin role holds
 *                    until an administrator grants it.
 */

const guard = require('./guard');
const { today } = require('../../shared/contracts/dates');

/* The audit actions that describe work on guests and stays. Sign-ins, settings
   and photo housekeeping are real events but not "what the team did today". */
const WORK_ACTIONS = Object.freeze({
  CUSTOMER_CREATE: 'guest', CUSTOMER_UPDATE: 'guest', CUSTOMER_ASSIGN: 'assign', CUSTOMER_DELETE: 'guest',
  CRM_NOTE_CREATE: 'note', CRM_NOTE_UPDATE: 'note', CRM_NOTE_DELETE: 'note',
  RESERVATION_CREATE: 'stay', RESERVATION_UPDATE: 'stay', RESERVATION_CANCEL: 'stay', RESERVATION_DELETE: 'stay',
});
const KINDS = ['guest', 'note', 'stay', 'assign'];

/* Actions an administrator wants surfaced without going looking for them. */
const SENSITIVE = Object.freeze(['RESERVATION_DELETE', 'CUSTOMER_DELETE', 'CRM_NOTE_DELETE', 'EXPORT',
  'USER_CREATE', 'USER_UPDATE', 'USER_DISABLE', 'PERMISSIONS_UPDATE', 'BACKUP_CREATE', 'LOGIN_BLOCKED',
  'UPDATE_INSTALL', 'CUSTOMER_ASSIGN']);

function dayBounds(from, to) {
  /* Business dates are local; audit timestamps are ISO UTC. Widening by a day
     on each side and filtering on the local date afterwards keeps the SQL
     simple and the answer exact. */
  const lo = new Date(`${from}T00:00:00`); lo.setDate(lo.getDate() - 1);
  const hi = new Date(`${to}T00:00:00`); hi.setDate(hi.getDate() + 2);
  return { lo: lo.toISOString(), hi: hi.toISOString() };
}
function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const activity = {
  feed(ctx, params = {}) {
    const session = guard.requireCapability(ctx, 'dashboard.read');
    const teamWide = ctx.sessions.can('activity.team');
    const from = params.from || today();
    const to = params.to || from;
    const { lo, hi } = dayBounds(from, to);

    const where = ['a.created_at >= @lo', 'a.created_at < @hi',
      `a.action IN (${Object.keys(WORK_ACTIONS).map((k) => `'${k}'`).join(',')})`];
    const bind = { lo, hi };
    if (!teamWide) { where.push('a.actor_user_id = @me'); bind.me = session.id; }
    else if (params.actorUserId) { where.push('a.actor_user_id = @actor'); bind.actor = Number(params.actorUserId); }

    const rows = ctx.db.prepare(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_user_id, a.description, a.created_at,
             COALESCE(u.full_name, a.actor_username) AS actor_name,
             CASE WHEN a.entity_type = 'crm_note' THEN n.note END AS note_text,
             CASE WHEN a.entity_type = 'crm_note' THEN n.customer_id
                  WHEN a.entity_type = 'reservation' THEN r.customer_id
                  WHEN a.entity_type = 'customer' THEN a.entity_id END AS customer_id
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_user_id
      LEFT JOIN crm_notes n ON a.entity_type = 'crm_note' AND n.id = a.entity_id AND n.deleted_at IS NULL
      LEFT JOIN reservations r ON a.entity_type = 'reservation' AND r.id = a.entity_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 500`).all(bind);

    const kind = KINDS.includes(params.kind) ? params.kind : null;
    const events = rows
      .filter((r) => { const d = localDate(r.created_at); return d >= from && d <= to; })
      .map((r) => ({ ...r, kind: WORK_ACTIONS[r.action] }))
      .filter((r) => !kind || r.kind === kind);

    /* Per-person and per-kind tallies for the summary strip — over the whole
       window, before the kind filter, so the numbers never contradict the list. */
    const all = rows.filter((r) => { const d = localDate(r.created_at); return d >= from && d <= to; });
    const byKind = { guest: 0, note: 0, stay: 0, assign: 0 };
    const byActor = {};
    for (const r of all) {
      byKind[WORK_ACTIONS[r.action]] += 1;
      const key = r.actor_user_id ?? 0;
      byActor[key] = byActor[key] || { userId: r.actor_user_id, name: r.actor_name || 'System', total: 0, guest: 0, note: 0, stay: 0, assign: 0 };
      byActor[key].total += 1; byActor[key][WORK_ACTIONS[r.action]] += 1;
    }
    return { from, to, teamWide, total: all.length, byKind,
      byActor: Object.values(byActor).sort((x, y) => y.total - x.total), events };
  },
};

/* ============================================================ global search */
function likeTerm(q) {
  /* Partial and case-insensitive. LIKE is already case-insensitive for ASCII
     in SQLite; lower() on both sides extends that to what lower() covers. The
     wildcard characters a person types are escaped so they match literally. */
  return `%${String(q).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const search = {
  global(ctx, { q } = {}) {
    guard.requireCapability(ctx, 'customers.read');
    const term = String(q || '').trim();
    if (term.length < 2) return { q: term, guests: [], notes: [], reservations: [], profiles: [] };
    const like = likeTerm(term);
    const scope = guard.scopeOf(ctx);
    const scoped = scope === null ? '' : ' AND c.marketing_profile_id = @scope';
    const bind = scope === null ? { like } : { like, scope };
    const LIMIT = 8;

    const guests = ctx.db.prepare(`
      SELECT c.id, c.code, c.full_name, c.nationality, c.phone, p.full_name AS marketing_name, c.updated_at
      FROM customers c LEFT JOIN marketing_profiles p ON p.id = c.marketing_profile_id
      WHERE c.deleted_at IS NULL${scoped} AND (
        lower(c.full_name) LIKE @like ESCAPE '\\' OR lower(c.code) LIKE @like ESCAPE '\\'
        OR lower(COALESCE(c.phone,'')) LIKE @like ESCAPE '\\' OR lower(COALESCE(c.email,'')) LIKE @like ESCAPE '\\'
        OR lower(COALESCE(c.notes,'')) LIKE @like ESCAPE '\\' OR lower(COALESCE(p.full_name,'')) LIKE @like ESCAPE '\\')
      ORDER BY c.updated_at DESC LIMIT ${LIMIT}`).all(bind);

    const notes = ctx.db.prepare(`
      SELECT n.id, n.note, n.note_date, n.created_at, c.id AS customer_id, c.full_name, c.code,
             COALESCE(u.full_name, u.username) AS author
      FROM crm_notes n JOIN customers c ON c.id = n.customer_id
      LEFT JOIN users u ON u.id = n.created_by
      LEFT JOIN marketing_profiles p ON p.id = c.marketing_profile_id
      WHERE n.deleted_at IS NULL AND c.deleted_at IS NULL${scoped}
        AND (lower(n.note) LIKE @like ESCAPE '\\' OR lower(COALESCE(u.full_name, u.username, '')) LIKE @like ESCAPE '\\')
      ORDER BY COALESCE(n.note_date, date(n.created_at,'localtime')) DESC, n.created_at DESC LIMIT ${LIMIT}`).all(bind);

    const reservations = ctx.db.prepare(`
      SELECT r.id, r.check_in, r.check_out, r.note, r.cancelled_at, c.id AS customer_id, c.full_name, c.code,
             ip.full_name AS invited_by
      FROM reservations r JOIN customers c ON c.id = r.customer_id
      LEFT JOIN marketing_profiles ip ON ip.id = r.invited_by_profile_id
      WHERE r.deleted_at IS NULL AND c.deleted_at IS NULL${scoped}
        AND (lower(c.full_name) LIKE @like ESCAPE '\\' OR lower(COALESCE(r.note,'')) LIKE @like ESCAPE '\\'
             OR lower(COALESCE(ip.full_name,'')) LIKE @like ESCAPE '\\')
      ORDER BY r.check_in DESC LIMIT ${LIMIT}`).all(bind);

    const profiles = ctx.sessions.can('profiles.read') ? ctx.db.prepare(`
      SELECT p.id, p.full_name,
        (SELECT COUNT(*) FROM customers c WHERE c.marketing_profile_id = p.id AND c.deleted_at IS NULL) AS guests
      FROM marketing_profiles p
      WHERE p.deleted_at IS NULL AND lower(p.full_name) LIKE @like ESCAPE '\\'${scope === null ? '' : ' AND p.id = @scope'}
      ORDER BY p.full_name COLLATE NOCASE LIMIT ${LIMIT}`).all(bind) : [];

    return { q: term, guests, notes, reservations, profiles };
  },
};

/* ============================================================ Team control */
const team = {
  overview(ctx) {
    guard.requireCapability(ctx, 'team.control');
    const db = ctx.db;
    const now = today();
    const in48 = new Date(); in48.setDate(in48.getDate() + 2);
    const in48s = localDate(in48.toISOString());
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
    const { lo } = dayBounds(now, now);

    const customers = require('../repositories/customers');
    const listAll = (q) => customers.list(db, { ...q, pageSize: 200 }, null).rows;
    const decorate = (rows) => rows.map((r) => r.full_name);

    const unassigned = db.prepare(`SELECT id, full_name FROM customers
      WHERE deleted_at IS NULL AND marketing_profile_id IS NULL ORDER BY created_at DESC LIMIT 50`).all();
    const cold = listAll({ status: 'COLD' });
    const noRecord = listAll({ noRecord: true, registeredOnly: true });
    const arrivals = db.prepare(`SELECT r.id, r.check_in, c.id AS customer_id, c.full_name FROM reservations r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL AND r.check_in >= @now AND r.check_in <= @in48
      ORDER BY r.check_in`).all({ now, in48: in48s });
    const locked = db.prepare(`SELECT COUNT(*) n FROM users WHERE locked_until IS NOT NULL AND locked_until > @t`)
      .get({ t: new Date().toISOString() }).n;

    const members = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.role, u.active, u.last_login_at, u.profile_id,
        (SELECT COUNT(*) FROM audit_log a WHERE a.actor_user_id = u.id AND a.created_at >= @lo
           AND a.action IN (${Object.keys(WORK_ACTIONS).map((k) => `'${k}'`).join(',')})) AS actions_today,
        (SELECT COUNT(*) FROM crm_notes n WHERE n.created_by = u.id AND n.deleted_at IS NULL AND n.created_at >= @week) AS notes_7d,
        (SELECT COUNT(*) FROM reservations r WHERE u.profile_id IS NOT NULL AND r.invited_by_profile_id = u.profile_id
           AND r.deleted_at IS NULL AND r.cancelled_at IS NULL AND r.check_in >= @month) AS reservations_30d,
        (SELECT COUNT(*) FROM customers c WHERE u.profile_id IS NOT NULL AND c.marketing_profile_id = u.profile_id
           AND c.deleted_at IS NULL) AS guests
      FROM users u ORDER BY u.active DESC, u.full_name COLLATE NOCASE`)
      .all({ lo, week: weekAgo.toISOString(), month: localDate(monthAgo.toISOString()) });
    const coldByProfile = {};
    for (const c of [...cold, ...noRecord]) {
      if (c.marketing_profile_id) coldByProfile[c.marketing_profile_id] = (coldByProfile[c.marketing_profile_id] || 0) + 1;
    }

    const sensitive = db.prepare(`SELECT a.id, a.action, a.description, a.created_at,
        COALESCE(u.full_name, a.actor_username) AS actor_name
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.action IN (${SENSITIVE.map((k) => `'${k}'`).join(',')})
      ORDER BY a.created_at DESC, a.id DESC LIMIT 12`).all();

    return {
      alerts: {
        unassigned: { count: unassigned.length, names: unassigned.slice(0, 3).map((r) => r.full_name) },
        cold: { count: cold.length, names: decorate(cold.slice(0, 3)) },
        noRecord: { count: noRecord.length, names: decorate(noRecord.slice(0, 3)) },
        arrivals48h: { count: arrivals.length, items: arrivals.slice(0, 3) },
        lockedAccounts: locked,
      },
      members: members.map((m) => ({ ...m, attention: m.profile_id ? (coldByProfile[m.profile_id] || 0) : null })),
      sensitive,
    };
  },
};

module.exports = { activity, search, team, WORK_ACTIONS, SENSITIVE };
