'use strict';
/* Who gets told what.
 *
 * The migration carried the notifications TABLE, its index, five IPC channels
 * and all the scope logic across — and left every producer behind, so the
 * feature was complete and inert. The bell never rang because nothing ever
 * wrote a row.
 *
 * There are two kinds of notification here, and the difference decides how each
 * one is stored:
 *
 *   EVENT      something happened once, at a known moment — a guest was
 *              assigned, somebody recorded a booking. Written when it happens.
 *   DERIVED    a standing condition — this guest has gone cold, that arrival is
 *              tomorrow. Recomputed on read, because the condition changes on
 *              its own as the calendar moves and a row written yesterday would
 *              go on being true after it stopped being true.
 *
 * Derived rows are reconciled rather than appended: one row per live condition,
 * removed when the condition lifts. That is what stops a marketer opening the
 * panel on Monday to forty copies of the same cold guest.
 */

const domain = require('./domain');
const { nowIso, today, daysBetween } = require('../../shared/contracts/dates');

/* Audit actions that a manager should see in the activity feed. Deliberately a
   subset: a feed that carries everything is a feed nobody reads. */
const FEED = new Set([
  'RESERVATION_CREATE', 'RESERVATION_UPDATE', 'RESERVATION_CANCEL', 'RESERVATION_DELETE',
  'CUSTOMER_CREATE', 'CUSTOMER_UPDATE', 'CUSTOMER_ASSIGN', 'CUSTOMER_DELETE', 'CUSTOMER_MERGE',
  'PROFILE_CREATE', 'PROFILE_UPDATE', 'PROFILE_DELETE',
  'CRM_NOTE_CREATE', 'USER_CREATE', 'USER_UPDATE', 'USER_DELETE',
]);

const COLD_DAYS = 90;
const UPCOMING_DAYS = 7;
const URGENT_DAYS = 1;

function feedEnabled(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'notifications.manager_feed'").get();
  return !row || row.value !== 'false';
}

function insert(db, row) {
  return db.prepare(`
    INSERT INTO notifications (type, title, message, target_profile_id, target_role, target_user_id,
                               related_customer_id, related_reservation_id, read_at, created_at)
    VALUES (@type, @title, @message, @target_profile_id, @target_role, @target_user_id,
            @related_customer_id, @related_reservation_id, NULL, @created_at)`).run({
    target_profile_id: null, target_role: null, target_user_id: null,
    related_customer_id: null, related_reservation_id: null,
    message: null, created_at: nowIso(), ...row,
  }).lastInsertRowid;
}

/* ------------------------------------------------- administrator alerts */

/* EVENT — something an administrator would want to hear about without going
   looking in the audit log. Each recipient gets their own row (target_user_id),
   so one person reading an alert does not mark it read for the others; the row
   is also marked target_role 'ADMIN' so it can never be mistaken for a
   broadcast. Recipients are every active ADMIN plus every active account whose
   role an administrator has granted 'notifications.admin'. The capability is
   checked again when the bell is read, so revoking it hides alerts at once. */
const ADMIN_ALERT_TYPE = 'admin_alert';

function adminAlertFor(entry) {
  switch (entry.action) {
    case 'RESERVATION_DELETE': return 'Reservation deleted';
    case 'CUSTOMER_DELETE': return 'Guest deleted';
    case 'CUSTOMER_MERGE': return 'Guests merged';
    case 'ACCOUNT_LOCKED': return 'Account locked';
    case 'EXPORT': return 'Data exported';
    case 'USER_UPDATE': return entry.metadata && entry.metadata.role_changed ? 'Role changed' : null;
    default: return null;
  }
}

function permissionOverrides(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'permissions.overrides'").get();
  if (!row) return {};
  try { return JSON.parse(row.value) || {}; } catch (_) { return {}; }
}

/** Active accounts that receive administrator alerts right now. */
function adminRecipients(db) {
  const { can } = require('../../shared/contracts/roles');
  const overrides = permissionOverrides(db);
  return db.prepare('SELECT id, role, profile_id FROM users WHERE active = 1').all()
    .filter((u) => can(u, 'notifications.admin', overrides));
}

function emitAdminAlert(db, entry, session) {
  if (!entry) return;
  const title = adminAlertFor(entry);
  if (!title) return;
  /* The person who did it is not alerted about their own action. A lockout has
     no acting session, so an administrator whose own account is being guessed
     at is told. */
  const actorId = session ? session.id : null;
  const recipients = adminRecipients(db).filter((u) => u.id !== actorId);
  if (!recipients.length) return;

  const who = session && session.username ? `${session.username}: ` : '';
  const meta = entry.metadata || {};
  const customerId = entry.entity_type === 'customer' ? entry.entity_id
    : (entry.entity_type === 'reservation' && meta.customer_id) || null;
  for (const user of recipients) {
    insert(db, {
      type: ADMIN_ALERT_TYPE,
      title,
      message: who + (entry.description || entry.action),
      target_role: 'ADMIN',
      target_user_id: user.id,
      related_customer_id: customerId || null,
      related_reservation_id: entry.entity_type === 'reservation' ? entry.entity_id : null,
    });
  }
}

function titleFor(action) {
  if (action.startsWith('RESERVATION')) return 'Reservation activity';
  if (action.startsWith('CUSTOMER')) return 'Guest activity';
  if (action.startsWith('PROFILE')) return 'Profile activity';
  if (action.startsWith('CRM')) return 'CRM note added';
  return 'Activity';
}

/* EVENT — the manager activity feed.
   Called from the audit sink, so anything worth auditing is automatically a
   candidate and a new verb cannot be forgotten. The actor never notifies
   themselves: being told what you just did is noise, not information. */
function emitActivity(db, entry, session) {
  if (!entry || !FEED.has(entry.action)) return;
  if (!feedEnabled(db)) return;

  const actorId = session ? session.id : null;
  const managers = db.prepare(`
    SELECT id, profile_id FROM users
    WHERE role = 'MANAGER' AND active = 1 AND profile_id IS NOT NULL AND (@actor IS NULL OR id <> @actor)`)
    .all({ actor: actorId });
  if (!managers.length) return;

  const who = session && session.username ? `${session.username}: ` : '';
  for (const manager of managers) {
    insert(db, {
      type: 'activity',
      title: titleFor(entry.action),
      message: who + (entry.description || entry.action),
      target_profile_id: manager.profile_id,
      related_customer_id: entry.entity_type === 'customer' ? entry.entity_id : null,
      related_reservation_id: entry.entity_type === 'reservation' ? entry.entity_id : null,
    });
  }
}

/* EVENT — a guest changed hands. The person receiving the guest is told; the
   person losing them is not, because that conversation belongs to management,
   not to a notification. */
function emitAssignment(db, { customer, profileId }) {
  if (!profileId || !customer) return;
  insert(db, {
    type: 'assignment',
    title: 'New guest assigned',
    message: `${customer.full_name} (${customer.code}) has been assigned to you`,
    target_profile_id: profileId,
    related_customer_id: customer.id,
  });
}

/* DERIVED — recomputed for one profile, then reconciled.
 *
 * Reconciliation is the whole design. Appending would mean a guest who has been
 * cold for six months generates a notification every time the panel opens, and
 * an arrival that gets cancelled keeps its reminder forever. Instead each pass
 * computes the set of conditions that are true NOW, inserts what is missing and
 * deletes what has lifted. */
function refreshDerived(db, profileId) {
  if (!profileId) return;
  const now = today();

  /* --- cold guests: the profile's own book, using the shared status rule --- */
  const guests = db.prepare(`
    SELECT c.id, c.full_name, c.registered,
      (SELECT COUNT(*) FROM reservations r
         WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL) AS qualifying,
      (SELECT COUNT(*) FROM crm_notes n WHERE n.customer_id = c.id AND n.deleted_at IS NULL) AS notes,
      (SELECT MAX(r.check_in) FROM reservations r
         WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL
           AND r.check_in <= date('now','localtime')) AS last_visit,
      (SELECT MIN(r.check_in) FROM reservations r
         WHERE r.customer_id = c.id AND r.deleted_at IS NULL AND r.cancelled_at IS NULL
           AND r.check_in > date('now','localtime')) AS next_visit,
      (SELECT MAX(date(n.created_at,'localtime')) FROM crm_notes n
         WHERE n.customer_id = c.id AND n.deleted_at IS NULL) AS last_note_date
    FROM customers c
    WHERE c.deleted_at IS NULL AND c.marketing_profile_id = @profileId`).all({ profileId });

  const coldNow = new Map();
  for (const g of guests) {
    const status = domain.customerStatus({
      registered: g.registered,
      qualifyingReservationCount: g.qualifying,
      noteCount: g.notes,
      lastVisit: g.last_visit,
      nextVisit: g.next_visit,
      lastNoteDate: g.last_note_date,
    });
    if (status === 'COLD') coldNow.set(g.id, g);
  }
  reconcile(db, profileId, 'cold_guest', 'related_customer_id', coldNow, (g) => ({
    type: 'cold_guest',
    title: 'Cold guest',
    message: g.last_visit
      ? `${g.full_name} — ${daysBetween(g.last_visit, now)} days since last visit`
      : `${g.full_name} — no recent activity`,
    target_profile_id: profileId,
    related_customer_id: g.id,
  }));

  /* --- upcoming check-ins the profile invited, inside the reminder window --- */
  const arrivals = db.prepare(`
    SELECT r.id, r.check_in, r.customer_id, c.full_name
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id AND c.deleted_at IS NULL
    WHERE r.deleted_at IS NULL AND r.cancelled_at IS NULL
      AND r.invited_by_profile_id = @profileId
      AND r.check_in >= date('now','localtime')`).all({ profileId });

  const soon = new Map();
  const urgent = new Map();
  for (const r of arrivals) {
    const away = daysBetween(now, r.check_in);
    if (away > UPCOMING_DAYS) continue;
    (away <= URGENT_DAYS ? urgent : soon).set(r.id, { ...r, away });
  }
  reconcile(db, profileId, 'checkin_urgent', 'related_reservation_id', urgent, (r) => ({
    type: 'checkin_urgent',
    title: 'Check-in within 24 hours',
    message: `${r.full_name} — ${r.check_in}`,
    target_profile_id: profileId,
    related_customer_id: r.customer_id,
    related_reservation_id: r.id,
  }));
  reconcile(db, profileId, 'checkin_soon', 'related_reservation_id', soon, (r) => ({
    type: 'checkin_soon',
    title: 'Upcoming check-in',
    message: `${r.full_name} — ${r.check_in} (in ${r.away} days)`,
    target_profile_id: profileId,
    related_customer_id: r.customer_id,
    related_reservation_id: r.id,
  }));

  refreshSpecialDates(db, profileId);
}

/* DERIVED — a birthday or special date of one of the profile's own guests,
   raised ON the day and gone the day after. Keyed by guest: two dates on the
   same day are one entry naming both. */
function refreshSpecialDates(db, profileId) {
  const { upcomingDates } = require('./guest-service');
  const todays = new Map();
  for (const d of upcomingDates(db, profileId, { days: 0 })) {
    const prev = todays.get(d.customer_id);
    if (prev) prev.labels.push(d.label);
    else todays.set(d.customer_id, { ...d, labels: [d.label] });
  }
  reconcile(db, profileId, 'special_date', 'related_customer_id', todays, (d) => ({
    type: 'special_date',
    title: d.kind === 'birthday' && d.labels.length === 1 ? 'Birthday today' : 'Special date today',
    message: `${d.full_name} — ${d.labels.join(', ')}`,
    target_profile_id: profileId,
    related_customer_id: d.customer_id,
  }));
}

/* DERIVED — follow-up reminders that are due today or overdue, addressed to
   the PERSON who set them (target_user_id), one entry per guest. A reminder
   for a guest who has left a marketer's book since is not raised to them. */
const REMINDER_TYPE = 'reminder_due';
function refreshUserDerived(db, session) {
  if (!session || !session.id) return;
  const scope = domain.scopeProfileId(session);
  const due = db.prepare(`
    SELECT rm.customer_id, MIN(rm.due_date) AS first_due, COUNT(*) AS n, c.full_name
    FROM reminders rm JOIN customers c ON c.id = rm.customer_id AND c.deleted_at IS NULL
    WHERE rm.created_by = @me AND rm.done_at IS NULL AND rm.deleted_at IS NULL AND rm.due_date <= @today
      AND (@scope IS NULL OR c.marketing_profile_id = @scope)
    GROUP BY rm.customer_id, c.full_name`).all({ me: session.id, today: today(), scope });
  const live = new Map(due.map((r) => [r.customer_id, r]));
  const existing = db.prepare('SELECT id, related_customer_id AS ref FROM notifications WHERE type = ? AND target_user_id = ?')
    .all(REMINDER_TYPE, session.id);
  const seen = new Set();
  for (const row of existing) {
    if (live.has(row.ref) && !seen.has(row.ref)) { seen.add(row.ref); continue; }
    db.prepare('DELETE FROM notifications WHERE id = ?').run(row.id);
  }
  const now = today();
  for (const [ref, r] of live) {
    if (seen.has(ref)) continue;
    const late = daysBetween(r.first_due, now);
    insert(db, {
      type: REMINDER_TYPE,
      title: 'Follow-up due',
      message: `${r.full_name} — ${late > 0 ? `overdue by ${late} day${late === 1 ? '' : 's'}` : 'due today'}`,
      target_user_id: session.id,
      related_customer_id: ref,
    });
  }
}

/* One row per live condition. `column` is the identity of the condition — the
   guest for a cold guest, the reservation for an arrival — so "already told
   them" is a lookup rather than a guess. */
function reconcile(db, profileId, type, column, liveById, build) {
  const existing = db.prepare(
    `SELECT id, ${column} AS ref FROM notifications WHERE type = ? AND target_profile_id = ?`)
    .all(type, profileId);

  const seen = new Set();
  for (const row of existing) {
    if (liveById.has(row.ref) && !seen.has(row.ref)) { seen.add(row.ref); continue; }
    /* Either the condition lifted, or this is a duplicate of one already kept. */
    db.prepare('DELETE FROM notifications WHERE id = ?').run(row.id);
  }
  for (const [ref, value] of liveById) {
    if (seen.has(ref)) continue;
    insert(db, build(value));
  }
}

module.exports = {
  emitActivity, emitAssignment, emitAdminAlert, adminRecipients, refreshDerived, refreshUserDerived,
  REMINDER_TYPE,
  FEED, COLD_DAYS, UPCOMING_DAYS, ADMIN_ALERT_TYPE,
};
