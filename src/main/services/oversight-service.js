'use strict';
/* Oversight: the activity feed, global search and Team control.
 *
 * All three are READ-ONLY views over data the product already records. Nothing
 * here writes, and nothing here widens what a caller may see:
 *
 *   activity.feed  — everyone's actions only with `activity.team`; otherwise the
 *                    caller's own actions, whatever they ask for. A MARKETING
 *                    caller granted `activity.team` sees who did how much, but
 *                    the guest-identifying detail of work on guests outside
 *                    their own book is withheld.
 *   search.global  — guests, notes and reservations through the same record
 *                    scope the lists use, so a MARKETING caller finds only what
 *                    is already theirs. Each section also needs the read
 *                    capability of the list it mirrors.
 *   team.overview  — requires `team.control`, which no non-admin role holds
 *                    until an administrator grants it.
 */

const guard = require('./guard');
const customersRepo = require('../repositories/customers');
const { today, addDays, isBusinessDate } = require('../../shared/contracts/dates');
const { validation } = require('../../shared/errors');

/* The audit actions that describe work on guests and stays. Sign-ins, settings
   and photo housekeeping are real events but not "what the team did today". */
const WORK_ACTIONS = Object.freeze({
  CUSTOMER_CREATE: 'guest', CUSTOMER_UPDATE: 'guest', CUSTOMER_ASSIGN: 'assign', CUSTOMER_DELETE: 'guest',
  CRM_NOTE_CREATE: 'note', CRM_NOTE_UPDATE: 'note', CRM_NOTE_DELETE: 'note',
  RESERVATION_CREATE: 'stay', RESERVATION_UPDATE: 'stay', RESERVATION_CANCEL: 'stay', RESERVATION_DELETE: 'stay',
});
const KINDS = Object.freeze(['guest', 'note', 'stay', 'assign']);

/* Actions an administrator wants surfaced without going looking for them. */
const SENSITIVE = Object.freeze(['RESERVATION_DELETE', 'CUSTOMER_DELETE', 'CRM_NOTE_DELETE', 'EXPORT',
  'USER_CREATE', 'USER_UPDATE', 'USER_DISABLE', 'PERMISSIONS_UPDATE', 'BACKUP_CREATE', 'LOGIN_BLOCKED',
  'ACCOUNT_LOCKED', 'UPDATE_INSTALL', 'CUSTOMER_ASSIGN']);

/* The widest window one feed request may cover. The feed is a "what happened
   lately" view, not an audit export; that is what audit:list is for. */
const MAX_FEED_DAYS = 92;
const FEED_LIMIT = 500;

/* Fixed literals from the constant above — never caller input. */
const inList = (actions) => actions.map((k) => `'${k}'`).join(',');
const actionsOfKind = (kind) => Object.keys(WORK_ACTIONS).filter((a) => !kind || WORK_ACTIONS[a] === kind);

/* Business dates are the operator's local calendar; audit timestamps are ISO
   UTC instants. The window is [local midnight of `from`, local midnight of the
   day after `to`), converted to UTC — exact, so the SQL limit never spends
   itself on rows outside the window. */
function instantBounds(from, to) {
  const lo = new Date(`${from}T00:00:00`);
  const hi = new Date(`${addDays(to, 1)}T00:00:00`);
  return { lo: lo.toISOString(), hi: hi.toISOString() };
}

const activity = {
  feed(ctx, params = {}) {
    const session = guard.requireCapability(ctx, 'dashboard.read');
    const teamWide = ctx.sessions.can('activity.team');
    const scope = guard.scopeOf(ctx);
    const from = params.from || today();
    const to = params.to || from;
    if (!isBusinessDate(from)) throw validation('Choose a valid start date.', 'from');
    if (!isBusinessDate(to)) throw validation('Choose a valid end date.', 'to');
    if (to < from) throw validation('The end date is before the start date.', 'to');
    if (addDays(from, MAX_FEED_DAYS) < to) throw validation(`Choose a window of at most ${MAX_FEED_DAYS} days.`, 'to');
    const { lo, hi } = instantBounds(from, to);

    const where = ['a.created_at >= @lo', 'a.created_at < @hi', `a.action IN (${inList(actionsOfKind(null))})`];
    const bind = { lo, hi };
    /* Without activity.team the caller's own actions only — an actorUserId
       naming somebody else is ignored rather than honoured. */
    if (!teamWide) { where.push('a.actor_user_id = @me'); bind.me = session.id; }
    else if (params.actorUserId) { where.push('a.actor_user_id = @actor'); bind.actor = Number(params.actorUserId); }
    const whereSql = where.join(' AND ');

    /* Tallies over the whole window, before the kind filter, so the summary
       strip never contradicts the list and is never capped by its limit. */
    const tallies = ctx.db.prepare(`
      SELECT a.actor_user_id, COALESCE(u.full_name, u.username, a.actor_username) AS actor_name,
             a.action, COUNT(*) AS n
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${whereSql}
      GROUP BY a.actor_user_id, a.action`).all(bind);
    const byKind = { guest: 0, note: 0, stay: 0, assign: 0 };
    const byActor = {};
    let total = 0;
    for (const t of tallies) {
      const k = WORK_ACTIONS[t.action];
      total += t.n; byKind[k] += t.n;
      const key = t.actor_user_id ?? 0;
      byActor[key] = byActor[key] || { userId: t.actor_user_id, name: t.actor_name || 'System', total: 0, guest: 0, note: 0, stay: 0, assign: 0 };
      byActor[key].total += t.n; byActor[key][k] += t.n;
    }

    const kind = KINDS.includes(params.kind) ? params.kind : null;
    const eventWhere = kind ? `${whereSql} AND a.action IN (${inList(actionsOfKind(kind))})` : whereSql;
    const rows = ctx.db.prepare(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_user_id, a.description, a.created_at,
             COALESCE(u.full_name, u.username, a.actor_username) AS actor_name,
             CASE WHEN a.entity_type = 'crm_note' THEN n.note END AS note_text,
             CASE WHEN a.entity_type = 'crm_note' THEN n.customer_id
                  WHEN a.entity_type = 'reservation' THEN r.customer_id
                  WHEN a.entity_type = 'customer' THEN a.entity_id END AS customer_id
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_user_id
      LEFT JOIN crm_notes n ON a.entity_type = 'crm_note' AND n.id = a.entity_id AND n.deleted_at IS NULL
      LEFT JOIN reservations r ON a.entity_type = 'reservation' AND r.id = a.entity_id
      WHERE ${eventWhere}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${FEED_LIMIT + 1}`).all(bind);
    const truncated = rows.length > FEED_LIMIT;
    if (truncated) rows.length = FEED_LIMIT;

    /* Record scope still applies to the CONTENT of somebody else's action. A
       marketer allowed to watch the team learns that a colleague edited a guest,
       not which guest or what the note said, unless that guest is theirs. Their
       own actions are always shown in full. */
    const ownerOf = scope === null ? null : ctx.db.prepare('SELECT marketing_profile_id FROM customers WHERE id = ?');
    const events = rows.map((r) => {
      const event = { ...r, kind: WORK_ACTIONS[r.action] };
      if (scope === null || r.actor_user_id === session.id) return event;
      const owner = r.customer_id ? ownerOf.get(r.customer_id) : null;
      if (owner && owner.marketing_profile_id === scope) return event;
      return { ...event, description: null, note_text: null, customer_id: null, entity_id: null, redacted: true };
    });

    return { from, to, teamWide, total, truncated, byKind,
      byActor: Object.values(byActor).sort((x, y) => y.total - x.total || String(x.name).localeCompare(String(y.name))),
      events };
  },
};

/* ============================================================ global search */
function likeTerm(q) {
  /* Partial and case-insensitive. Both sides go through lower(), which SQLite
     applies to ASCII; the wildcard characters a person types are escaped so
     "50%" or "a_b" match literally. ESCAPE '\' is declared on every LIKE. */
  return `%${String(q).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const SEARCH_LIMIT = 8;
const MIN_QUERY = 2;

const search = {
  global(ctx, { q } = {}) {
    guard.requireCapability(ctx, 'customers.read');
    const term = String(q || '').trim();
    const empty = { q: term, guests: [], notes: [], reservations: [], profiles: [] };
    if (term.length < MIN_QUERY) return empty;
    const like = likeTerm(term);
    /* The same scope customers.list and reservations.list apply: a MARKETING
       session is confined to guests it owns, and to reservations it invited. */
    const scope = guard.scopeOf(ctx);
    const bind = scope === null ? { like } : { like, scope };
    const L = (expr) => `lower(${expr}) LIKE @like ESCAPE '\\'`;

    const guests = ctx.db.prepare(`
      SELECT c.id, c.code, c.full_name, c.nationality, c.registered, c.marketing_profile_id,
             p.full_name AS marketing_name, c.updated_at
      FROM customers c LEFT JOIN profiles p ON p.id = c.marketing_profile_id
      WHERE c.deleted_at IS NULL${scope === null ? '' : ' AND c.marketing_profile_id = @scope'} AND (
        ${L('c.full_name')} OR ${L('c.code')} OR ${L("COALESCE(c.phone,'')")}
        OR ${L("COALESCE(c.email,'')")} OR ${L("COALESCE(c.passport_no,'')")}
        OR ${L("COALESCE(c.notes,'')")} OR ${L("COALESCE(p.full_name,'')")})
      ORDER BY c.updated_at DESC, c.id DESC LIMIT ${SEARCH_LIMIT}`).all(bind);

    const notes = ctx.sessions.can('crm.read') ? ctx.db.prepare(`
      SELECT n.id, n.note, n.note_date, n.created_at, c.id AS customer_id, c.full_name, c.code,
             COALESCE(u.full_name, u.username) AS author
      FROM crm_notes n JOIN customers c ON c.id = n.customer_id
      LEFT JOIN users u ON u.id = n.created_by
      WHERE n.deleted_at IS NULL AND c.deleted_at IS NULL${scope === null ? '' : ' AND c.marketing_profile_id = @scope'}
        AND (${L('n.note')} OR ${L("COALESCE(u.full_name, u.username, '')")})
      ORDER BY COALESCE(n.note_date, date(n.created_at,'localtime')) DESC, n.created_at DESC, n.id DESC
      LIMIT ${SEARCH_LIMIT}`).all(bind) : [];

    const reservations = ctx.sessions.can('reservations.read') ? ctx.db.prepare(`
      SELECT r.id, r.check_in, r.check_out, r.reservation_note, r.cancelled_at,
             c.id AS customer_id, c.full_name, c.code, ip.full_name AS invited_by
      FROM reservations r JOIN customers c ON c.id = r.customer_id
      LEFT JOIN profiles ip ON ip.id = r.invited_by_profile_id
      WHERE r.deleted_at IS NULL AND c.deleted_at IS NULL${scope === null ? '' : ' AND r.invited_by_profile_id = @scope'}
        AND (${L('c.full_name')} OR ${L('c.code')} OR ${L("COALESCE(r.reservation_note,'')")}
             OR ${L("COALESCE(ip.full_name,'')")})
      ORDER BY r.check_in DESC, r.id DESC LIMIT ${SEARCH_LIMIT}`).all(bind) : [];

    /* A marketer can find only their own profile: a colleague's guest count is
       management data (see maskProfiles in support-services). */
    const profiles = ctx.sessions.can('profiles.read') ? ctx.db.prepare(`
      SELECT p.id, p.full_name, p.kind, p.employment_status,
        (SELECT COUNT(*) FROM customers c WHERE c.marketing_profile_id = p.id AND c.deleted_at IS NULL) AS guests
      FROM profiles p
      WHERE p.archived_at IS NULL AND ${L('p.full_name')}${scope === null ? '' : ' AND p.id = @scope'}
      ORDER BY p.full_name COLLATE NOCASE LIMIT ${SEARCH_LIMIT}`).all(bind) : [];

    return { q: term, guests, notes, reservations, profiles };
  },
};

/* ============================================================ Team control */
const team = {
  overview(ctx) {
    guard.requireCapability(ctx, 'team.control');
    const db = ctx.db;
    const now = today();
    const { lo: todayStart } = instantBounds(now, now);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const unassigned = db.prepare(`SELECT id, full_name FROM customers
      WHERE deleted_at IS NULL AND marketing_profile_id IS NULL ORDER BY created_at DESC, id DESC`).all();
    /* Whole book, unscoped: team.control is a management view. Counts come
       from the list totals so they agree with the Guests screen exactly. */
    const cold = customersRepo.list(db, { status: 'COLD', pageSize: 5000, sort: 'last_visit', dir: 'asc' }, null);
    const noRecord = customersRepo.list(db, { noRecord: true, registeredOnly: true, pageSize: 5000 }, null);
    const arrivals = db.prepare(`SELECT r.id, r.check_in, c.id AS customer_id, c.full_name FROM reservations r
      JOIN customers c ON c.id = r.customer_id AND c.deleted_at IS NULL
      WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL AND r.check_in >= @now AND r.check_in <= @in48
      ORDER BY r.check_in, r.id`).all({ now, in48: addDays(now, 2) });
    const locked = db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1 AND locked_until IS NOT NULL AND locked_until > @t')
      .get({ t: new Date().toISOString() }).n;

    const members = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.role, u.active, u.last_login_at, u.profile_id,
        p.full_name AS profile_name,
        CASE WHEN u.locked_until IS NOT NULL AND u.locked_until > @nowIso THEN 1 ELSE 0 END AS locked,
        (SELECT COUNT(*) FROM audit_log a WHERE a.actor_user_id = u.id AND a.created_at >= @todayStart
           AND a.action IN (${inList(actionsOfKind(null))})) AS actions_today,
        (SELECT COUNT(*) FROM crm_notes n WHERE n.created_by = u.id AND n.deleted_at IS NULL AND n.created_at >= @week) AS notes_7d,
        (SELECT COUNT(*) FROM reservations r WHERE u.profile_id IS NOT NULL AND r.invited_by_profile_id = u.profile_id
           AND r.deleted_at IS NULL AND r.cancelled_at IS NULL AND r.check_in >= @month) AS reservations_30d,
        (SELECT COUNT(*) FROM customers c WHERE u.profile_id IS NOT NULL AND c.marketing_profile_id = u.profile_id
           AND c.deleted_at IS NULL) AS guests
      FROM users u LEFT JOIN profiles p ON p.id = u.profile_id
      ORDER BY u.active DESC, COALESCE(u.full_name, u.username) COLLATE NOCASE`)
      .all({ todayStart, nowIso: new Date().toISOString(), week: weekAgo, month: addDays(now, -30) });

    const attentionByProfile = {};
    for (const c of [...cold.rows, ...noRecord.rows]) {
      if (c.marketing_profile_id) attentionByProfile[c.marketing_profile_id] = (attentionByProfile[c.marketing_profile_id] || 0) + 1;
    }

    const sensitive = db.prepare(`SELECT a.id, a.action, a.description, a.created_at, a.actor_user_id,
        COALESCE(u.full_name, u.username, a.actor_username) AS actor_name
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.action IN (${inList(SENSITIVE)})
      ORDER BY a.created_at DESC, a.id DESC LIMIT 12`).all();

    const names = (rows) => rows.slice(0, 3).map((r) => r.full_name);
    return {
      alerts: {
        unassigned: { count: unassigned.length, names: names(unassigned) },
        cold: { count: cold.total, names: names(cold.rows) },
        noRecord: { count: noRecord.total, names: names(noRecord.rows) },
        arrivals48h: { count: arrivals.length, items: arrivals.slice(0, 3) },
        lockedAccounts: locked,
      },
      members: members.map((m) => ({ ...m, attention: m.profile_id ? (attentionByProfile[m.profile_id] || 0) : null })),
      sensitive,
    };
  },
};

module.exports = { activity, search, team, WORK_ACTIONS, SENSITIVE, KINDS, MAX_FEED_DAYS, FEED_LIMIT, likeTerm };
