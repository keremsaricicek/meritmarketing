'use strict';
/* The remaining entity services: CRM notes, profiles, users, settings,
 * notifications, audit, dashboard and calendar.
 *
 * They share one shape — capability check, then record scope, then work, then
 * audit — so they are kept together rather than spread across eight files that
 * would each be forty lines.
 */

const customersRepo = require('../repositories/customers');
const reservationsRepo = require('../repositories/reservations');
const domain = require('./domain');
const guard = require('./guard');
const passwords = require('../auth/passwords');
const notificationService = require('./notification-service');
const { nowIso, today, addDays } = require('../../shared/contracts/dates');
const { ROLES, CONFIGURABLE, ADMIN_ONLY } = require('../../shared/contracts/roles');
const { validation, forbidden, notFound } = require('../../shared/errors');

/* ============================================================== CRM notes */

const crmNotes = {
  list(ctx, { customerId }) {
    guard.requireCapability(ctx, 'crm.read');
    const customer = customersRepo.findById(ctx.db, Number(customerId));
    guard.requireCustomerInScope(ctx, customer);
    return ctx.db.prepare(`
      SELECT n.*, u.username AS created_by_username FROM crm_notes n
      LEFT JOIN users u ON u.id = n.created_by
      WHERE n.customer_id = ? AND n.deleted_at IS NULL
      ORDER BY n.created_at DESC`).all(Number(customerId));
  },

  create(ctx, { customerId, note }) {
    const session = guard.requireCapability(ctx, 'crm.create');
    const customer = customersRepo.findById(ctx.db, Number(customerId));
    guard.requireCustomerInScope(ctx, customer);
    const text = String(note || '').trim();
    if (!text) throw validation('A note cannot be empty.', 'note');
    const now = nowIso();
    const id = ctx.db.prepare(`
      INSERT INTO crm_notes (customer_id, note, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)`).run(Number(customerId), text, now, session.id, now, session.id).lastInsertRowid;
    ctx.audit({ action: 'CRM_NOTE_CREATE', entity_type: 'crm_note', entity_id: id,
      description: `Note added for ${customer.full_name}` });
    return { id };
  },

  update(ctx, { id, note }) {
    const session = guard.requireCapability(ctx, 'crm.update');
    const row = ctx.db.prepare('SELECT * FROM crm_notes WHERE id = ? AND deleted_at IS NULL').get(Number(id));
    if (!row) throw notFound('Note not found.');
    guard.requireCustomerInScope(ctx, customersRepo.findById(ctx.db, row.customer_id));
    const text = String(note || '').trim();
    if (!text) throw validation('A note cannot be empty.', 'note');
    ctx.db.prepare('UPDATE crm_notes SET note = ?, updated_at = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?')
      .run(text, nowIso(), session.id, row.id);
    ctx.audit({ action: 'CRM_NOTE_UPDATE', entity_type: 'crm_note', entity_id: row.id, description: 'Note edited' });
    return { id: row.id };
  },

  remove(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'crm.delete');
    const row = ctx.db.prepare('SELECT * FROM crm_notes WHERE id = ? AND deleted_at IS NULL').get(Number(id));
    if (!row) throw notFound('Note not found.');
    guard.requireCustomerInScope(ctx, customersRepo.findById(ctx.db, row.customer_id));
    ctx.db.prepare('UPDATE crm_notes SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), session.id, row.id);
    ctx.audit({ action: 'CRM_NOTE_DELETE', entity_type: 'crm_note', entity_id: row.id, description: 'Note deleted' });
    return { ok: true };
  },
};

/* =============================================================== profiles */

/* Another marketer's guest and reservation counts are their performance data,
   and their passport number, phone, email and the free-text `notes` field are
   personnel data — that is where management records things like an employment
   warning. A marketer can see that colleagues exist, because the app would be
   baffling otherwise; everything else about a colleague is management's.
   Masking the metrics while returning `SELECT p.*` handed over the rest. */
const PROFILE_PERSONAL = Object.freeze(['passport_no', 'phone', 'email', 'nationality', 'notes']);

function maskProfiles(session, rows) {
  const scope = domain.scopeProfileId(session);
  if (scope === null) return rows;
  return rows.map((p) => {
    if (p.id === scope) return p;
    const masked = { ...p, customer_count: null, reservation_count: null };
    for (const field of PROFILE_PERSONAL) delete masked[field];
    return masked;
  });
}

const profiles = {
  list(ctx, params = {}) {
    const session = guard.requireCapability(ctx, 'profiles.read');
    const rows = ctx.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM customers c WHERE c.marketing_profile_id = p.id AND c.deleted_at IS NULL) AS customer_count,
        (SELECT COUNT(*) FROM reservations r JOIN customers rc ON rc.id = r.customer_id
           WHERE r.invited_by_profile_id = p.id AND r.deleted_at IS NULL AND rc.deleted_at IS NULL) AS reservation_count
      FROM profiles p
      WHERE (@includeStaff = 1 OR p.kind = 'marketing') AND p.archived_at IS NULL
      ORDER BY p.full_name COLLATE NOCASE`).all({ includeStaff: params.includeStaff ? 1 : 0 });
    return maskProfiles(session, rows);
  },

  get(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'profiles.read');
    const row = ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(id));
    if (!row) throw notFound('Profile not found.');
    return maskProfiles(session, [row])[0];
  },

  /* A profile's guest book is that marketer's book. Handing it to another
     marketer is the same disclosure as handing over the customer list. */
  relatedCustomers(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'profiles.read');
    const scope = domain.scopeProfileId(session);
    if (scope !== null && Number(id) !== scope) throw forbidden();
    return customersRepo.list(ctx.db, { assignedTo: Number(id), pageSize: 500 }, scope).rows
      .map((r) => require('./customer-service').decorate(r));
  },

  create(ctx, params) {
    const session = guard.requireCapability(ctx, 'profiles.create');
    const name = String(params.fullName || '').trim();
    if (!name) throw validation('Name is required.', 'fullName');
    const now = nowIso();
    const id = ctx.db.prepare(`
      INSERT INTO profiles (full_name, kind, employment_status, passport_no, phone, nationality, email, notes,
                            photo_name, created_at, created_by, updated_at, updated_by)
      VALUES (@full_name, @kind, 'active', @passport_no, @phone, @nationality, @email, @notes,
              @photo_name, @now, @by, @now, @by)`).run({
      full_name: name, kind: params.kind === 'staff' ? 'staff' : 'marketing',
      passport_no: params.passportNo || null, phone: params.phone || null,
      nationality: params.nationality || null, email: params.email || null,
      notes: params.notes || null, photo_name: params.photoName || null, now, by: session.id,
    }).lastInsertRowid;
    ctx.audit({ action: 'PROFILE_CREATE', entity_type: 'profile', entity_id: id, description: `Created profile ${name}` });
    return { id };
  },

  update(ctx, params) {
    const session = guard.requireCapability(ctx, 'profiles.update');
    const row = ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(params.id));
    if (!row) throw notFound('Profile not found.');
    const patch = {};
    if (params.fullName !== undefined) {
      const name = String(params.fullName).trim();
      if (!name) throw validation('Name is required.', 'fullName');
      patch.full_name = name;
    }
    for (const [input, column] of Object.entries({
      passportNo: 'passport_no', phone: 'phone', nationality: 'nationality', email: 'email', notes: 'notes',
      photoName: 'photo_name',
    })) if (params[input] !== undefined) patch[column] = params[input] || null;
    if (params.inactive !== undefined) patch.employment_status = params.inactive ? 'inactive' : 'active';
    if (!Object.keys(patch).length) return { id: row.id };

    patch.updated_at = nowIso(); patch.updated_by = session.id;
    const sets = Object.keys(patch).map((c) => `${c} = @${c}`).join(', ');
    ctx.db.prepare(`UPDATE profiles SET ${sets}, row_version = row_version + 1 WHERE id = @id`)
      .run({ ...patch, id: row.id });
    ctx.audit({ action: 'PROFILE_UPDATE', entity_type: 'profile', entity_id: row.id,
      description: `Updated profile ${row.full_name}` });
    return { id: row.id };
  },

  /* Archive, not delete. A profile is referenced by every reservation they ever
     invited; destroying it would either cascade that history away or be refused
     by ON DELETE RESTRICT. Archiving keeps the attribution readable. */
  remove(ctx, { id }) {
    guard.requireCapability(ctx, 'profiles.delete');
    const row = ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(id));
    if (!row) throw notFound('Profile not found.');
    const linked = ctx.db.prepare('SELECT COUNT(*) n FROM users WHERE profile_id = ? AND active = 1').get(row.id).n;
    if (linked) throw validation('That profile is linked to an active account. Disable the account first.');
    ctx.db.prepare("UPDATE profiles SET archived_at = ?, employment_status = 'inactive' WHERE id = ?")
      .run(nowIso(), row.id);
    ctx.audit({ action: 'PROFILE_DELETE', entity_type: 'profile', entity_id: row.id,
      description: `Archived profile ${row.full_name}` });
    return { ok: true };
  },
};

/* ================================================================== users */

const SAFE_USER = `id, username, role, profile_id, full_name, active, last_login_at, created_at`;

const users = {
  list(ctx) {
    guard.requireCapability(ctx, 'users.read');
    /* The password hash is never in this projection. It is not secret enough to
       hand to a renderer, and there is no screen that needs it. */
    return ctx.db.prepare(`SELECT ${SAFE_USER},
      (SELECT full_name FROM profiles p WHERE p.id = users.profile_id) AS profile_name
      FROM users ORDER BY username`).all();
  },

  async create(ctx, params) {
    const session = guard.requireCapability(ctx, 'users.create');
    if (session.role !== 'ADMIN') throw forbidden('Only an administrator can create accounts.');
    const username = String(params.username || '').trim().toLowerCase();
    if (username.length < 3) throw validation('Username must be at least 3 characters.', 'username');
    if (!ROLES.includes(params.role)) throw validation('Select a valid role.', 'role');
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
      throw validation('That username is already taken.', 'username');
    }
    const strength = passwords.validateStrength(params.password, { username });
    if (!strength.ok) throw validation(strength.message, 'password');
    if (params.role === 'MARKETING' && !params.profileId) {
      throw validation('A marketing account must be linked to a profile.', 'profileId');
    }
    if (params.profileId) {
      const taken = ctx.db.prepare('SELECT username FROM users WHERE profile_id = ? AND active = 1').get(Number(params.profileId));
      if (taken) throw validation(`That profile is already linked to "${taken.username}".`, 'profileId');
    }
    const hash = await passwords.hash(params.password);
    const now = nowIso();
    const id = ctx.db.prepare(`
      INSERT INTO users (username, password_hash, role, profile_id, full_name, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(username, hash, params.role,
      params.profileId ? Number(params.profileId) : null,
      params.fullName || null, params.active === false ? 0 : 1, now, now).lastInsertRowid;
    ctx.audit({ action: 'USER_CREATE', entity_type: 'user', entity_id: id,
      description: `Created account ${username} (${params.role})` });
    return { id };
  },

  async update(ctx, params) {
    const session = guard.requireCapability(ctx, 'users.update');
    if (session.role !== 'ADMIN') throw forbidden('Only an administrator can change accounts.');
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id));
    if (!row) throw notFound('Account not found.');

    /* Locking every administrator out of the application is unrecoverable
       without a database editor, so the last active one cannot be demoted or
       disabled. */
    const otherAdmins = ctx.db.prepare(
      "SELECT COUNT(*) n FROM users WHERE role = 'ADMIN' AND active = 1 AND id <> ?").get(row.id).n;
    const losingAdmin = row.role === 'ADMIN'
      && ((params.role && params.role !== 'ADMIN') || params.active === false);
    if (losingAdmin && otherAdmins === 0) {
      throw validation('At least one active administrator must remain.');
    }

    const patch = {};
    if (params.role !== undefined) {
      if (!ROLES.includes(params.role)) throw validation('Select a valid role.', 'role');
      patch.role = params.role;
    }
    if (params.fullName !== undefined) patch.full_name = params.fullName || null;
    if (params.profileId !== undefined) patch.profile_id = params.profileId ? Number(params.profileId) : null;
    if (params.active !== undefined) patch.active = params.active ? 1 : 0;
    if (params.password) {
      const strength = passwords.validateStrength(params.password, { username: row.username });
      if (!strength.ok) throw validation(strength.message, 'password');
      patch.password_hash = await passwords.hash(params.password);
    }
    const nextRole = patch.role || row.role;
    const nextProfile = patch.profile_id !== undefined ? patch.profile_id : row.profile_id;
    if (nextRole === 'MARKETING' && !nextProfile) {
      throw validation('A marketing account must be linked to a profile.', 'profileId');
    }
    if (!Object.keys(patch).length) return { id: row.id };

    patch.updated_at = nowIso();
    const sets = Object.keys(patch).map((c) => `${c} = @${c}`).join(', ');
    ctx.db.prepare(`UPDATE users SET ${sets}, row_version = row_version + 1 WHERE id = @id`).run({ ...patch, id: row.id });

    /* A role change or a disable has to take effect now. Waiting for the next
       login means a demoted manager keeps manager powers for the rest of the
       shift. */
    if (patch.role !== undefined || patch.active === 0 || patch.profile_id !== undefined) {
      ctx.sessions.invalidateIfAffected(row.id);
    }
    ctx.audit({ action: 'USER_UPDATE', entity_type: 'user', entity_id: row.id,
      description: `Updated account ${row.username}` });
    return { id: row.id };
  },

  remove(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'users.delete');
    if (session.role !== 'ADMIN') throw forbidden('Only an administrator can disable accounts.');
    if (Number(id) === session.id) throw validation('You cannot disable your own account.');
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!row) throw notFound('Account not found.');
    const otherAdmins = ctx.db.prepare(
      "SELECT COUNT(*) n FROM users WHERE role = 'ADMIN' AND active = 1 AND id <> ?").get(row.id).n;
    if (row.role === 'ADMIN' && otherAdmins === 0) throw validation('At least one active administrator must remain.');
    ctx.db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), row.id);
    ctx.sessions.invalidateIfAffected(row.id);
    ctx.audit({ action: 'USER_DISABLE', entity_type: 'user', entity_id: row.id,
      description: `Disabled account ${row.username}` });
    return { ok: true };
  },
};

/* =============================================================== settings */

const PERSONAL_KEYS = Object.freeze(['appearance.theme', 'appearance.density']);

const settings = {
  /* Personal keys resolve to the CALLING user's own choice, falling back to the
     shared default only until they have picked one. One operator's theme must
     never become everybody's theme on a shift-shared workstation. */
  all(ctx) {
    const session = guard.requireCapability(ctx, 'settings.read');
    const shared = {};
    for (const row of ctx.db.prepare('SELECT key, value FROM settings').all()) shared[row.key] = row.value;
    const mine = ctx.db.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?').all(session.id);
    for (const row of mine) if (PERSONAL_KEYS.includes(row.key)) shared[row.key] = row.value;
    return shared;
  },

  set(ctx, { key, value }) {
    const session = guard.requireCapability(ctx, 'settings.read');
    const name = String(key || '');
    if (PERSONAL_KEYS.includes(name)) {
      ctx.db.prepare(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(session.id, name, String(value), nowIso());
      return { ok: true };
    }
    if (!ctx.sessions.can('settings.write')) throw forbidden('Only an administrator can change this setting.');
    ctx.db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(name, String(value), nowIso(), session.id);
    ctx.audit({ action: 'SETTING_UPDATE', entity_type: 'setting', description: `Changed setting ${name}` });
    return { ok: true };
  },

  permissions(ctx) {
    guard.requireCapability(ctx, 'settings.read');
    const overrides = settings.overrides(ctx.db);
    const { capabilitiesFor } = require('../../shared/contracts/roles');
    const matrix = {};
    for (const role of ['MANAGER', 'MARKETING']) {
      const caps = capabilitiesFor(role, overrides);
      matrix[role] = {};
      for (const cap of Object.keys(CONFIGURABLE)) matrix[role][cap] = caps[cap] === true;
    }
    return { labels: CONFIGURABLE, matrix, adminOnly: ADMIN_ONLY };
  },

  setPermissions(ctx, { matrix }) {
    guard.requireCapability(ctx, 'settings.permissions.write');
    const clean = {};
    for (const [role, caps] of Object.entries(matrix || {})) {
      if (!['MANAGER', 'MARKETING'].includes(role)) continue;
      clean[role] = {};
      for (const [cap, granted] of Object.entries(caps || {})) {
        /* Only capabilities the product says are configurable, and never one on
           the ADMIN-only list — otherwise the matrix becomes a privilege
           escalation form. */
        if (!Object.prototype.hasOwnProperty.call(CONFIGURABLE, cap)) continue;
        if (ADMIN_ONLY.includes(cap)) continue;
        clean[role][cap] = !!granted;
      }
    }
    ctx.db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('permissions.overrides', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(JSON.stringify(clean), nowIso(), ctx.sessions.get().id);
    ctx.sessions.setPermissionOverrides(clean);
    ctx.audit({ action: 'PERMISSIONS_UPDATE', entity_type: 'setting', description: 'Role permissions changed' });
    return { ok: true };
  },

  overrides(db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'permissions.overrides'").get();
    if (!row) return {};
    try { return JSON.parse(row.value) || {}; } catch (_) { return {}; }
  },
};

/* ========================================================== notifications */

/* Two audiences, one table.
 *
 * A broadcast notification has no target profile and is meant for everybody; a
 * targeted one belongs to exactly one profile. The old predicate read
 * `(@scope IS NULL AND (target_profile_id IS NULL OR 1=1)) OR target_profile_id = @scope`
 * — the `OR 1=1` makes the first half unconditional, so it said "unscoped sees
 * everything", which is right, while silently deciding that a MARKETING session
 * never sees a broadcast, which is not. Written out plainly the bug has nowhere
 * to hide. */
const VISIBLE_TO_SCOPE = '(@scope IS NULL OR target_profile_id = @scope OR target_profile_id IS NULL)';

const notifications = {
  list(ctx) {
    const session = guard.requireCapability(ctx, 'notifications.read');
    const scope = domain.scopeProfileId(session);
    /* Standing conditions — cold guests, imminent arrivals — are recomputed on
       read rather than stored, because they stop being true on their own as
       the calendar moves. */
    notificationService.refreshDerived(ctx.db, scope ?? session.profile_id ?? null);
    return ctx.db.prepare(`
      SELECT * FROM notifications
      WHERE ${VISIBLE_TO_SCOPE}
      ORDER BY created_at DESC LIMIT 100`).all({ scope });
  },

  unreadCount(ctx) {
    const session = guard.requireCapability(ctx, 'notifications.read');
    const scope = domain.scopeProfileId(session);
    return ctx.db.prepare(`
      SELECT COUNT(*) n FROM notifications
      WHERE read_at IS NULL AND ${VISIBLE_TO_SCOPE}`).get({ scope }).n;
  },

  /* A foreign id and a missing id answer identically, so this cannot be walked
     to discover which notification ids exist. */
  markRead(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'notifications.update');
    const scope = domain.scopeProfileId(session);
    const row = ctx.db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(id));
    if (!row || (scope !== null && row.target_profile_id !== scope)) throw forbidden();
    ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(nowIso(), row.id);
    return { ok: true };
  },

  markAllRead(ctx) {
    const session = guard.requireCapability(ctx, 'notifications.update');
    const scope = domain.scopeProfileId(session);
    ctx.db.prepare(`UPDATE notifications SET read_at = @now
      WHERE read_at IS NULL AND ${VISIBLE_TO_SCOPE}`).run({ now: nowIso(), scope });
    return { ok: true };
  },

  remove(ctx, { id }) {
    const session = guard.requireCapability(ctx, 'notifications.update');
    const scope = domain.scopeProfileId(session);
    const row = ctx.db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(id));
    if (!row || (scope !== null && row.target_profile_id !== scope)) throw forbidden();
    ctx.db.prepare('DELETE FROM notifications WHERE id = ?').run(row.id);
    return { ok: true };
  },
};

/* ================================================================== audit */

const audit = {
  /* Read-only by design. There is no update or delete verb over audit_log
     anywhere in the IPC surface — the log is append-only from the
     application's point of view. This is not tamper-proof against a Windows
     administrator with a SQLite editor, and does not claim to be. */
  list(ctx, params = {}) {
    guard.requireCapability(ctx, 'audit.read');
    const pageSize = Math.min(Math.max(Number(params.pageSize) || 50, 1), 1000);
    const page = Math.max(Number(params.page) || 1, 1);
    const where = [];
    const bind = {};
    if (params.action) { where.push('action = @action'); bind.action = params.action; }
    if (params.entityType) { where.push('entity_type = @entityType'); bind.entityType = params.entityType; }
    if (params.from) { where.push('created_at >= @from'); bind.from = params.from; }
    if (params.to) { where.push('created_at <= @to'); bind.to = params.to; }
    const sql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = ctx.db.prepare(`SELECT COUNT(*) n FROM audit_log${sql}`).get(bind).n;
    const rows = ctx.db.prepare(
      `SELECT * FROM audit_log${sql} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...bind, limit: pageSize, offset: (page - 1) * pageSize });
    return { rows, total, page, pageSize };
  },
};

/* ============================================================== dashboard */

/* KPI semantics, unchanged from the verified baseline:
 *   STOCK  — a count of what exists now; the period filter must not move it
 *   PERIOD — activity inside the selected window
 *   FUTURE — looks forward; the period filter does not apply
 */
const dashboard = {
  load(ctx, params = {}) {
    const session = guard.requireCapability(ctx, 'dashboard.read');
    const scope = domain.scopeProfileId(session);
    const periodDays = params.periodDays === 'all' ? null : Number(params.periodDays || 30);
    const since = periodDays ? addDays(today(), -periodDays) : null;

    const customerList = customersRepo.list(ctx.db, { registeredOnly: true, pageSize: 1 }, scope);
    const cold = customersRepo.list(ctx.db, { status: 'COLD', pageSize: 1 }, scope);
    const noRecord = customersRepo.list(ctx.db, { noRecord: true, registeredOnly: true, pageSize: 1 }, scope);
    const upcoming = reservationsRepo.list(ctx.db, { status: 'UPCOMING', pageSize: 1 }, scope, 'active');
    const reservationsInPeriod = reservationsRepo.list(ctx.db,
      since ? { from: since, pageSize: 1 } : { pageSize: 1 }, scope, 'active');

    /* Active Marketing counts ACTIVE profiles of kind 'marketing'. Staff
       profiles exist for attribution and are not marketers, which is the
       overcounting bug this definition fixed. */
    const activeMarketing = ctx.db.prepare(
      "SELECT COUNT(*) n FROM profiles WHERE kind = 'marketing' AND employment_status = 'active' AND archived_at IS NULL").get().n;

    const stats = {
      totalGuests: customerList.total,      // STOCK
      cold: cold.total,                     // STOCK
      noRecord: noRecord.total,             // STOCK
      upcomingIn: upcoming.total,           // FUTURE
      reservations: reservationsInPeriod.total, // PERIOD
    };
    /* Active Marketing is a management figure. A marketer seeing headcount
       tells them nothing useful about their own book. */
    if (session.role === 'ADMIN' || session.role === 'MANAGER') stats.activeMarketing = activeMarketing;

    const recent = reservationsRepo.list(ctx.db, { pageSize: 8, sort: 'created', dir: 'desc' }, scope, 'active').rows;
    const pending = reservationsRepo.list(ctx.db, { status: 'UPCOMING', pageSize: 8, sort: 'check_in', dir: 'asc' }, scope, 'active').rows;
    const attention = customersRepo.list(ctx.db, { status: 'COLD', pageSize: 8, sort: 'last_visit', dir: 'asc' }, scope)
      .rows.map((r) => require('./customer-service').decorate(r));

    return { stats, recent, pending, attention };
  },
};

/* =============================================================== calendar */

const calendar = {
  month(ctx, { year, month }) {
    const session = guard.requireCapability(ctx, 'calendar.read');
    return { buckets: reservationsRepo.calendarMonth(ctx.db, Number(year), Number(month), domain.scopeProfileId(session)) };
  },
  day(ctx, { date }) {
    const session = guard.requireCapability(ctx, 'calendar.read');
    const res = reservationsRepo.calendarDay(ctx.db, String(date), domain.scopeProfileId(session));
    const decorate = require('./reservation-service').decorate;
    return {
      arrivals: res.arrivals.map(decorate),
      departures: res.departures.map(decorate),
      active: res.active.map(decorate),
    };
  },
};

module.exports = { crmNotes, profiles, users, settings, notifications, audit, dashboard, calendar, PERSONAL_KEYS };
