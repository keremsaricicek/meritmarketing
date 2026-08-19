'use strict';
/* Roles and capabilities — the single source for "may this ROLE call this verb".
 *
 * This is the capability half of authorization only. It answers nothing about
 * WHICH records a call may touch; that is record scope, enforced separately in
 * the services. A verb that checks only this is how horizontal escalation
 * happens: the role is allowed to call customers.get, so the call succeeds —
 * for anybody's guest.
 */

const ROLES = Object.freeze(['ADMIN', 'MANAGER', 'MARKETING']);

/* Capabilities an ADMIN always holds and which are NOT configurable, because
   they can escalate privilege or exfiltrate the whole database. Making these
   grantable through the permission matrix would let an administrator hand the
   keys to a role and then be unable to take them back safely. */
const ADMIN_ONLY = Object.freeze([
  'users.read', 'users.create', 'users.update', 'users.delete',
  'backup.create', 'backup.read', 'backup.restore',
  'settings.permissions.write',
  'reservations.delete',
]);

const DEFAULTS = Object.freeze({
  ADMIN: Object.freeze({ '*': true }),
  MANAGER: Object.freeze({
    'customers.read': true, 'customers.create': true, 'customers.update': true,
    'customers.delete': true, 'customers.assign': true,
    'reservations.read': true, 'reservations.create': true, 'reservations.update': true,
    'reservations.deleted.read': true,
    'crm.read': true, 'crm.create': true, 'crm.update': true, 'crm.delete': true,
    'profiles.read': true, 'profiles.create': true, 'profiles.update': true, 'profiles.delete': true,
    'audit.read': true,
    'reports.read': true, 'export.run': true,
    'settings.read': true, 'settings.write': true,
    'notifications.read': true, 'notifications.update': true,
    'dashboard.read': true, 'calendar.read': true,
  }),
  MARKETING: Object.freeze({
    'customers.read': true, 'customers.create': true, 'customers.update': true,
    'reservations.read': true, 'reservations.create': true, 'reservations.update': true,
    'crm.read': true, 'crm.create': true, 'crm.update': true,
    'reports.read': true, 'export.run': true,
    'settings.read': true,
    'notifications.read': true, 'notifications.update': true,
    'dashboard.read': true, 'calendar.read': true,
    'profiles.read': true,
  }),
});

/* Which capabilities an administrator may actually toggle in Settings. Anything
   absent from this list is fixed by the product, not by configuration. */
const CONFIGURABLE = Object.freeze({
  'customers.delete': 'Delete guests',
  'customers.assign': 'Reassign guest ownership',
  'crm.delete': 'Delete CRM notes',
  'profiles.create': 'Create marketing profiles',
  'profiles.update': 'Edit marketing profiles',
  'profiles.delete': 'Delete marketing profiles',
  'audit.read': 'View the audit log',
  'export.run': 'Export data',
  'reservations.deleted.read': 'View deleted reservations',
  'settings.write': 'Change shared settings',
});

/** Resolve a role's effective capability map, applying stored overrides. */
function capabilitiesFor(role, overrides = {}) {
  if (role === 'ADMIN') return { '*': true };
  const base = { ...(DEFAULTS[role] || {}) };
  const forRole = overrides[role] || {};
  for (const [cap, granted] of Object.entries(forRole)) {
    /* An override may only move a capability the product says is configurable.
       Anything else is ignored rather than honoured, so a crafted or corrupted
       settings row cannot widen a role. */
    if (!Object.prototype.hasOwnProperty.call(CONFIGURABLE, cap)) continue;
    if (ADMIN_ONLY.includes(cap)) continue;
    base[cap] = !!granted;
  }
  return base;
}

function can(session, capability, overrides = {}) {
  if (!session || !session.role) return false;
  if (ADMIN_ONLY.includes(capability)) return session.role === 'ADMIN';
  if (session.role === 'ADMIN') return true;
  return capabilitiesFor(session.role, overrides)[capability] === true;
}

module.exports = { ROLES, ADMIN_ONLY, DEFAULTS, CONFIGURABLE, capabilitiesFor, can };
