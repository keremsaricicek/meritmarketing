'use strict';
/* THE AUTHORITATIVE API SECURITY SURFACE.
 *
 * Every operation exposed on `window.api` must have an entry here. The
 * enforcement suite (surface.test.js) reads this file, discovers the real
 * surface from the running app, and FAILS if the two disagree — so adding a
 * new verb without deciding its security posture breaks the build rather than
 * shipping silently. Three of the four Critical findings in the last security
 * review were verbs nobody had visited; this file exists so that cannot recur.
 *
 * Field meanings
 *   permission   the guard(...) capability the handler must check, or null if
 *                the verb is intentionally reachable without one.
 *   roles        which roles may successfully call it. 'anon' means callable
 *                with no session (only pre-auth verbs should list it).
 *   scope        'record'  handler must verify THIS session may touch THIS
 *                          record (customerInScope / reservationInScope /
 *                          target-profile check).
 *                'query'   results are filtered to the caller's scope by a
 *                          shared helper (filteredCustomers/Reservations).
 *                'self'    operates only on the caller's own rows.
 *                'none'    genuinely global data, safe for every allowed role.
 *   protection   true when the verb can change guest ownership and must run
 *                the one-year guest-protection rule for MARKETING callers.
 *   validation   true when the handler must validate payload fields itself
 *                (never trusting the client form).
 *   denial       the error code an unauthorized caller must receive.
 *   notes        anything a future reader needs to not re-break it.
 */

const SURFACE = {
  // ---------- auth ----------
  'auth.firstRun':        { permission: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: null,
                            notes: 'Boolean "has anyone been created yet"; leaks nothing.' },
  'auth.setup':           { permission: null, roles: ['anon'], scope: 'none', protection: false, validation: true, denial: 'VALIDATION',
                            notes: 'Refuses once any user exists, so it cannot mint a second admin.' },
  'auth.login':           { permission: null, roles: ['anon'], scope: 'none', protection: false, validation: true, denial: 'VALIDATION',
                            notes: 'Same generic message for bad user and bad password.' },
  'auth.session':         { permission: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, denial: null,
                            notes: 'Returns the caller\'s own session or null.' },
  'auth.logout':          { permission: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, denial: null },
  'auth.changePassword':  { permission: null, roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true, denial: 'VALIDATION',
                            notes: 'Must require the correct current password; only ever changes the caller\'s own.' },

  // ---------- users ----------
  'users.list':           { permission: 'users.read',   roles: ['ADMIN','MANAGER'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN' },
  'users.create':         { permission: 'users.create', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, denial: 'FORBIDDEN',
                            notes: 'Hard ADMIN check in addition to guard — account creation is never configurable.' },
  'users.update':         { permission: 'users.update', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, denial: 'FORBIDDEN' },
  'users.delete':         { permission: 'users.delete', roles: ['ADMIN'], scope: 'none', protection: false, validation: true, denial: 'FORBIDDEN' },

  // ---------- customers ----------
  'customers.list':       { permission: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, denial: 'FORBIDDEN',
                            notes: 'filteredCustomers applies role scope FIRST; crafted assignedTo/createdBy cannot widen it.' },
  'customers.picker':     { permission: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, denial: 'FORBIDDEN',
                            notes: 'Deliberately unscoped so the finder cannot breed duplicate records, but withholds phone for out-of-scope rows.' },
  'customers.get':        { permission: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN' },
  'customers.summary':    { permission: 'customers.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, denial: 'FORBIDDEN',
                            notes: 'Identity-only projection for out-of-scope guests: no phone, passport, status or owner.' },
  'customers.create':     { permission: 'customers.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  denial: 'FORBIDDEN',
                            notes: 'MARKETING may only create guests owned by themselves — scope is a two-way boundary.' },
  'customers.update':     { permission: 'customers.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: true,  validation: true,  denial: 'FORBIDDEN',
                            notes: 'Must REJECT marketingProfileId changes; ownership moves only through customers.assign.' },
  'customers.assign':     { permission: 'customers.assign', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: true,  validation: true,  denial: 'FORBIDDEN',
                            notes: 'The authorized reassignment override. Writes assignment_history; never rewrites historical invited_by.' },
  'customers.delete':     { permission: 'customers.delete', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: false, validation: true,  denial: 'FORBIDDEN' },

  // ---------- reservations ----------
  'reservations.list':    { permission: 'reservations.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query',  protection: false, validation: false, denial: 'FORBIDDEN',
                            notes: 'Active/Cancelled are two views of one scoped dataset.' },
  'reservations.get':     { permission: 'reservations.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN' },
  'reservations.create':  { permission: 'reservations.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: true,  validation: true,  denial: 'FORBIDDEN',
                            notes: 'Deliberately NOT record-scoped: any marketer may book any registered guest, ' +
                                   'which is how a guest whose protection has lapsed changes hands. Guest protection ' +
                                   'is the only gate, and it is the thing that must never be missing here. ' +
                                   'MARKETING is additionally forced to invitedBy=self.' },
  'reservations.update':  { permission: 'reservations.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: true,  validation: true,  denial: 'FORBIDDEN',
                            notes: 'Retargeting to another customerId re-validates existence, scope and protection.' },
  'reservations.cancel':  { permission: 'reservations.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN' },
  'reservations.delete':  { permission: 'reservations.delete', roles: ['ADMIN'],                       scope: 'none',   protection: false, validation: true,  denial: 'FORBIDDEN',
                            notes: 'No record check, and none is needed: the hard ADMIN check beyond the guard ' +
                                   'means the only callers are already unscoped. Permanent deletion is not configurable.' },

  // ---------- profiles ----------
  'profiles.list':            { permission: 'profiles.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, denial: 'FORBIDDEN',
                                notes: 'MARKETING needs the roster for name pickers, but other profiles\' business metrics are masked to null.' },
  'profiles.get':             { permission: 'profiles.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',   protection: false, validation: false, denial: 'FORBIDDEN' },
  'profiles.create':          { permission: 'profiles.create', roles: ['ADMIN','MANAGER'],             scope: 'none',   protection: false, validation: true,  denial: 'FORBIDDEN' },
  'profiles.update':          { permission: 'profiles.update', roles: ['ADMIN','MANAGER'],             scope: 'none',   protection: false, validation: true,  denial: 'FORBIDDEN' },
  'profiles.delete':          { permission: 'profiles.delete', roles: ['ADMIN'],                       scope: 'none',   protection: false, validation: true,  denial: 'FORBIDDEN' },
  'profiles.relatedCustomers':{ permission: 'profiles.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN',
                                notes: 'Returns decorated customer records — MARKETING may only ask about their own profile id.' },

  // ---------- crmNotes ----------
  'crmNotes.list':   { permission: 'crmNotes.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN',
                       notes: 'A note is exactly as sensitive as the guest it hangs off.' },
  'crmNotes.create': { permission: 'crmNotes.create', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: true,  denial: 'FORBIDDEN' },
  'crmNotes.update': { permission: 'crmNotes.update', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: false, validation: true,  denial: 'FORBIDDEN' },
  'crmNotes.delete': { permission: 'crmNotes.delete', roles: ['ADMIN','MANAGER'],             scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN',
                       notes: 'Same response for missing and out-of-scope, so it is not an id-existence oracle.' },

  // ---------- notifications ----------
  'notifications.list':        { permission: 'notifications.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, denial: 'FORBIDDEN' },
  'notifications.unreadCount': { permission: 'notifications.read',   roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, denial: 'FORBIDDEN',
                                 notes: 'Fails closed rather than returning 0 without a session — an unauthenticated ' +
                                        'count is still a signal about how much data exists.' },
  'notifications.markRead':    { permission: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN' },
  'notifications.markAllRead': { permission: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self',   protection: false, validation: false, denial: 'FORBIDDEN' },
  'notifications.delete':      { permission: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'record', protection: false, validation: false, denial: 'FORBIDDEN',
                                 notes: 'Suppressing the manager activity feed about your own actions must not be possible.' },
  'notifications.clearRead':   { permission: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self',   protection: false, validation: false, denial: 'FORBIDDEN' },
  'notifications.dismissAll':  { permission: 'notifications.update', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self',   protection: false, validation: false, denial: 'FORBIDDEN' },

  // ---------- read-only analytics ----------
  'dashboard.load':  { permission: 'dashboard.read',    roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: false, denial: 'FORBIDDEN',
                       notes: 'Every stat derives from filteredCustomers/filteredReservations, so KPIs are scoped by construction.' },
  'calendar.month':  { permission: 'reservations.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: false, denial: 'FORBIDDEN' },
  'calendar.day':    { permission: 'reservations.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: false, denial: 'FORBIDDEN' },
  'reports.access':  { permission: 'reports.read',      roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none',  protection: false, validation: false, denial: 'FORBIDDEN' },
  'audit.list':      { permission: 'audit.read',        roles: ['ADMIN','MANAGER'],             scope: 'none',  protection: false, validation: false, denial: 'FORBIDDEN' },

  // ---------- settings ----------
  'settings.all':            { permission: 'settings.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: false, denial: 'FORBIDDEN',
                               notes: 'Personal keys resolve to the caller\'s own stored preference, never a shared value.' },
  'settings.set':            { permission: 'settings.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'self', protection: false, validation: true,  denial: 'FORBIDDEN',
                               notes: 'Only appearance.* are personal; anything else is ADMIN-only, and an absent session is rejected outright.' },
  'settings.permissions':    { permission: 'settings.read', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN' },
  'settings.setPermissions': { permission: null,            roles: ['ADMIN'],                       scope: 'none', protection: false, validation: true,  denial: 'FORBIDDEN',
                               notes: 'Hard ADMIN check; the matrix cannot be used to grant itself away.' },

  // ---------- photos ----------
  'photos.pick':   { permission: 'customers.update',  roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: true,  denial: 'FORBIDDEN',
                     notes: 'Opens a local file dialog, but ends by writing db.photos and saving — so it is a ' +
                            'mutation and carries the same guard as photos.save. Not probed by the enforcement ' +
                            'suite (the native picker blocks); its guard is covered in regression/ instead.' },
  'photos.read':   { permission: 'customers.read',    roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN',
                     notes: 'Names are enumerable timestamps, so this must at least require a session.' },
  'photos.save':   { permission: 'customers.update',  roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN' },
  'photos.remove': { permission: 'customers.update',  roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN' },

  // ---------- backup ----------
  'backup.list':       { permission: 'backup.read',   roles: ['ADMIN'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN' },
  'backup.create':     { permission: 'backup.create', roles: ['ADMIN'], scope: 'none', protection: false, validation: false, denial: 'FORBIDDEN',
                         notes: 'A snapshot is the whole database including db.users credentials — ADMIN-equivalent, and deliberately NOT in CONFIGURABLE.' },
  'backup.restore':    { permission: 'backup.read',   roles: ['ADMIN'], scope: 'none', protection: false, validation: true,  denial: 'FORBIDDEN',
                         notes: 'Most destructive verb in the app. Re-runs migrations and backfills top-level schema.' },
  'backup.openFolder': { permission: null,            roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: null,
                         notes: 'Desktop-only stub; always returns a VALIDATION message in the browser build.' },

  // ---------- export ----------
  'export.run':       { permission: 'export.run', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: false, denial: 'FORBIDDEN',
                        notes: 'Thin wrapper over export.filtered; inherits its per-entity checks.' },
  'export.filtered':  { permission: 'export.run', roles: ['ADMIN','MANAGER','MARKETING'], scope: 'query', protection: false, validation: false, denial: 'FORBIDDEN',
                        notes: 'Per-entity: audit_logs additionally requires audit.read; profile_customers requires the caller\'s own profile id.' },
  'export.openFolder':{ permission: null, roles: ['ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: null,
                        notes: 'Desktop-only stub.' },

  // ---------- dialog ----------
  // ---------- top-level shims ----------
  // Not a namespaced verb — a bare function on window.api. Recorded because the
  // recursive discovery walk finds it, and because it is the placeholder the
  // Electron menu bridge will replace: when it becomes a real IPC subscription
  // it needs a real contract, and an undocumented verb is how that gets missed.
  'onMenuAction':  { permission: null,                roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: null,
                     notes: 'No-op returning a no-op unsubscribe. Touches no data in the browser build.' },

  'dialog.confirm': { permission: null, roles: ['anon','ADMIN','MANAGER','MARKETING'], scope: 'none', protection: false, validation: false, denial: null,
                      notes: 'Pure UI confirmation; touches no data and grants nothing.' },
};

/** Verbs that must reject a call made with no session at all. */
const REQUIRES_SESSION = Object.entries(SURFACE)
  .filter(([, v]) => !v.roles.includes('anon'))
  .map(([k]) => k);

/** Verbs MARKETING must never successfully call. */
const FORBIDDEN_FOR_MARKETING = Object.entries(SURFACE)
  .filter(([, v]) => !v.roles.includes('MARKETING'))
  .map(([k]) => k);

/** Verbs MANAGER must never successfully call. */
const FORBIDDEN_FOR_MANAGER = Object.entries(SURFACE)
  .filter(([, v]) => !v.roles.includes('MANAGER'))
  .map(([k]) => k);

/** Verbs that must enforce record-level scope. */
const RECORD_SCOPED = Object.entries(SURFACE)
  .filter(([, v]) => v.scope === 'record')
  .map(([k]) => k);

/** Verbs that must run the guest-protection rule. */
const PROTECTION_ENFORCING = Object.entries(SURFACE)
  .filter(([, v]) => v.protection)
  .map(([k]) => k);

module.exports = {
  SURFACE,
  REQUIRES_SESSION,
  FORBIDDEN_FOR_MARKETING,
  FORBIDDEN_FOR_MANAGER,
  RECORD_SCOPED,
  PROTECTION_ENFORCING,
};
