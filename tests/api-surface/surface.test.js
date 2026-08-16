'use strict';
/* API SURFACE ENFORCEMENT
 *
 * This suite is the reason a new verb cannot ship without a security decision.
 * It discovers the REAL window.api surface at runtime and cross-checks it
 * against tests/api-surface/surface.js. Adding `api.foo.bar = ...` without a
 * matrix entry fails here — loudly — before anyone has to notice it in review.
 *
 * It then proves, per verb, the properties the matrix claims:
 *   - session required
 *   - MARKETING denied where the matrix says denied
 *   - record-level scope actually enforced (not just query filtering)
 *   - guest protection actually runs on ownership-changing verbs
 *   - crafted payloads cannot widen scope
 */

const { Suite } = require('../lib/harness');
const {
  SURFACE, REQUIRES_SESSION, FORBIDDEN_FOR_MARKETING, FORBIDDEN_FOR_MANAGER,
  RECORD_SCOPED, PROTECTION_ENFORCING,
} = require('./surface');

/* Payloads that are structurally valid enough to reach the authorization
   check. A verb must be denied on authorization grounds, not because the
   payload was malformed — otherwise the test proves nothing. */
const PROBE = {
  'auth.changePassword': { currentPassword: 'x', newPassword: 'yyyyyy' },
  'users.create':   { username: 'probe1', password: 'probepass', role: 'MANAGER' },
  'users.update':   { id: 1, active: true },
  'users.delete':   { id: 999999 },
  'customers.get':  { id: 1 },
  'customers.summary': { id: 1 },
  'customers.create': { code: 'PROBE1', fullName: 'PROBE GUEST' },
  'customers.update': { id: 1, phone: '1' },
  'customers.assign': { id: 1, profileId: 2 },
  'customers.delete': { id: 999999 },
  'customers.picker': { search: '' },
  'reservations.get': { id: 1 },
  'reservations.create': { customerId: 1, checkIn: '2027-01-01', checkOut: '2027-01-02' },
  'reservations.update': { id: 1, checkIn: '2027-01-01', checkOut: '2027-01-02' },
  'reservations.cancel': { id: 1, reason: 'Other' },
  'reservations.delete': { id: 999999 },
  'profiles.get': { id: 1 },
  'profiles.create': { fullName: 'PROBE PROFILE' },
  'profiles.update': { id: 1, inactive: false },
  'profiles.delete': { id: 999999 },
  'profiles.relatedCustomers': { id: 1 },
  'crmNotes.list':   { customerId: 1 },
  'crmNotes.create': { customerId: 1, note: 'probe' },
  'crmNotes.update': { id: 1, note: 'probe' },
  'crmNotes.delete': { id: 999999 },
  'notifications.markRead': { id: 999999 },
  'notifications.delete':   { id: 999999 },
  'calendar.month': { year: 2027, month: 1 },
  'calendar.day':   { date: '2027-01-01' },
  'settings.set':   { key: 'appearance.theme', value: 'dark' },
  'settings.setPermissions': { matrix: {} },
  'photos.read':   { name: 'photo_1' },
  'photos.save':   { dataUrl: 'data:,x' },
  'photos.remove': { name: 'photo_1' },
  'backup.restore': { name: 'nonexistent' },
  'export.run':      { entity: 'customerlist' },
  'export.filtered': { entity: 'customerlist', params: {} },
  'dialog.confirm':  { title: 'x', message: 'y' },
};

/* Verbs we must not actually invoke, because doing so would end the session
   the probe is running under, or block forever on a native dialog.
   Keep this set as small as it can possibly be: every entry is a verb whose
   contract this suite stops enforcing. `backup.create` was excluded here once
   for "triggers a download" — but its guard and its ADMIN check both return
   long before any download happens, so the exclusion was silently retiring the
   checks on the single most sensitive verb in the matrix (a full database dump
   including credentials). Verify before adding. */
const DO_NOT_INVOKE = new Set([
  'auth.setup', 'auth.login', 'auth.logout',   // would change session mid-suite
  'photos.pick',                               // opens a native file picker
  'dialog.confirm',                            // opens a blocking modal
]);

/* Payloads addressing a record that belongs to ANOTHER marketer. Every verb the
   matrix marks `scope: 'record'` needs one; the suite fails if one is missing,
   so a new record-scoped row cannot be added without also proving it.
   `ctx` carries the foreign fixture ids. */
const FOREIGN_PROBE = {
  'customers.get':             c => ({ id: c.customerId }),
  'customers.update':          c => ({ id: c.customerId, phone: 'HACKED' }),
  'customers.delete':          c => ({ id: c.customerId }),
  'customers.assign':          c => ({ id: c.customerId, profileId: c.senaId }),
  'customers.create':          c => ({ code: 'SURF-CROSS', fullName: 'CROSS OWNED', marketingProfileId: c.keremId }),
  'crmNotes.list':             c => ({ customerId: c.customerId }),
  'crmNotes.create':           c => ({ customerId: c.customerId, note: 'x' }),
  'crmNotes.update':           c => ({ id: c.noteId, note: 'x' }),
  'crmNotes.delete':           c => ({ id: c.noteId }),
  'reservations.get':          c => ({ id: c.reservationId }),
  'reservations.create':       c => ({ customerId: c.customerId, checkIn: '2027-02-01', checkOut: '2027-02-03' }),
  'reservations.update':       c => ({ id: c.reservationId, checkIn: '2027-02-01', checkOut: '2027-02-03' }),
  'reservations.cancel':       c => ({ id: c.reservationId, reason: 'Other' }),
  'reservations.delete':       c => ({ id: c.reservationId }),
  'profiles.relatedCustomers': c => ({ id: c.keremId }),
  'notifications.markRead':    c => ({ id: c.foreignNotificationId }),
  'notifications.delete':      c => ({ id: c.foreignNotificationId }),
};

/* Calls that would MOVE a guest between marketers. Every verb the matrix marks
   `protection: true` needs one, for the same reason. */
const PROTECTION_PROBE = {
  'customers.assign':    c => ({ id: c.customerId, profileId: c.senaId }),
  'customers.update':    c => ({ id: c.customerId, marketingProfileId: c.senaId }),
  'reservations.create': c => ({ customerId: c.customerId, checkIn: '2027-04-01', checkOut: '2027-04-03' }),
  'reservations.update': c => ({ id: c.ownReservationId, customerId: c.customerId }),
};

module.exports = async function () {
  const s = new Suite('api-surface/enforcement');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // ---------------------------------------------------------------- discovery
  // Walks the whole object graph, not one level. A top-level function
  // (`api.onMenuAction` already has that shape) and a nested namespace
  // (`api.v2.customers.get`) are both real ways to expose a verb, and a
  // one-level scan silently misses both — which turns "you cannot add a verb
  // without a decision" into "you cannot add a verb shaped like the ones that
  // already exist".
  const live = await s.page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const walk = (obj, prefix) => {
      if (!obj || seen.has(obj)) return;
      seen.add(obj);
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        const name = prefix ? prefix + '.' + key : key;
        if (typeof value === 'function') out.push(name);
        else if (value && typeof value === 'object') walk(value, name);
      }
    };
    walk(window.api, '');
    return out.sort();
  });

  const documented = Object.keys(SURFACE).sort();
  const undocumented = live.filter(v => !documented.includes(v));
  const stale = documented.filter(v => !live.includes(v));

  s.check(
    'every live window.api verb has a security-surface entry',
    undocumented.length === 0,
    undocumented.length ? 'UNDOCUMENTED: ' + undocumented.join(', ') : ''
  );
  s.check(
    'security surface has no entries for verbs that no longer exist',
    stale.length === 0,
    stale.length ? 'STALE: ' + stale.join(', ') : ''
  );
  s.check('surface is non-trivial (discovery actually worked)', live.length >= 50, `found ${live.length}`);

  // ------------------------------------------------------ fixtures for probing
  // A guest owned by KEREM that SENA must never reach, plus one SENA owns.
  const foreign = await s.makeGuest({
    code: 'SURF-FOREIGN', name: 'SURFACE FOREIGN GUEST',
    phone: 'SECRET-PHONE', passport: 'SECRET-PASSPORT',
    visitMonthsAgo: 2, invitedBy: ids.keremId, assignTo: ids.keremId,
  });
  const foreignRes = await s.page.evaluate(async (cid) => {
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows;
    const r = rows.find(x => x.customer_id === cid);
    return r ? r.id : null;
  }, foreign.id);
  const foreignNote = await s.page.evaluate(async (cid) => {
    const n = await window.api.crmNotes.create({ customerId: cid, note: 'owner only' });
    return n.ok ? n.data.id : null;
  }, foreign.id);
  // A notification addressed to KEREM, so the notification probes act on
  // something that genuinely belongs to somebody else rather than on a
  // nonexistent id (which any handler refuses for the wrong reason).
  const foreignNotificationId = await s.page.evaluate(async (keremId) => {
    const KEY = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('"customers"'));
    const d = JSON.parse(localStorage.getItem(KEY));
    d.notifications = d.notifications || [];
    const id = Math.max(0, ...d.notifications.map(n => n.id || 0)) + 1;
    d.notifications.push({
      id, type: 'PROBE', title: 'kerem only', message: 'kerem only',
      target_profile_id: keremId, read: 0, created_at: new Date().toISOString(),
    });
    localStorage.setItem(KEY, JSON.stringify(d));
    location.reload();
    return id;
  }, ids.keremId);
  await s.page.waitForTimeout(700);
  await s.loginAdmin();

  // A reservation SENA owns, needed by the reservations.update takeover probe.
  const ownReservationId = await s.page.evaluate(async (senaId) => {
    const c = (await window.api.customers.create({
      code: 'SURF-OWN', fullName: 'SURFACE OWN', registered: true, marketingProfileId: senaId })).data;
    const r = await window.api.reservations.create({
      customerId: c.id, checkIn: '2027-03-01', checkOut: '2027-03-03', invitedByProfileId: senaId });
    return r.ok ? r.data.id : null;
  }, ids.senaId);

  const probeCtx = {
    ...ids,
    customerId: foreign.id,
    reservationId: foreignRes,
    noteId: foreignNote,
    foreignNotificationId,
    ownReservationId,
  };
  s.check('probe fixtures were all created',
    [foreign.id, foreignRes, foreignNote, foreignNotificationId, ownReservationId].every(Boolean),
    JSON.stringify(probeCtx));

  // ------------------------------------------------- unauthenticated behaviour
  await s.page.evaluate(() => window.doLogout());
  await s.page.waitForTimeout(250);

  for (const verb of REQUIRES_SESSION) {
    if (DO_NOT_INVOKE.has(verb)) continue;
    const [ns, m] = verb.split('.');
    const res = await s.api(ns, m, PROBE[verb] || {});
    const allowed = res && res.ok === true;
    s.check(`unauthenticated: ${verb} is refused`, !allowed,
      allowed ? 'ALLOWED WITHOUT SESSION' : '');
  }

  // ------------------------------------------------------- MARKETING behaviour
  await s.loginSena();

  for (const verb of FORBIDDEN_FOR_MARKETING) {
    if (DO_NOT_INVOKE.has(verb)) continue;
    const [ns, m] = verb.split('.');
    const res = await s.api(ns, m, PROBE[verb] || {});
    const allowed = res && res.ok === true;
    s.check(`MARKETING denied: ${verb}`, !allowed, allowed ? 'ALLOWED FOR MARKETING' : '');
  }

  // ---------------------------------------------------------- MANAGER behaviour
  // The roles column names three roles; checking only one of them leaves the
  // ADMIN-only rows (users.*, backup.*, settings.setPermissions,
  // reservations.delete) asserted against nobody.
  await s.loginManager();
  for (const verb of FORBIDDEN_FOR_MANAGER) {
    if (DO_NOT_INVOKE.has(verb)) continue;
    const [ns, m] = verb.split('.');
    const res = await s.api(ns, m, PROBE[verb] || {});
    const allowed = res && res.ok === true;
    s.check(`MANAGER denied: ${verb}`, !allowed, allowed ? 'ALLOWED FOR MANAGER' : '');
  }
  await s.loginSena();

  // ----------------------------------------- record scope, verb by verb, live
  // Driven by the matrix, not by a hand-kept list. A row claiming
  // `scope: 'record'` with no probe registered fails the suite, so the claim
  // cannot be made without being proved — which is the whole point of writing
  // the contract down. A hand-kept list lets a new row assert a check that
  // nothing verifies, and the resulting IDOR ships green.
  const missingScopeProbe = RECORD_SCOPED.filter(v => !FOREIGN_PROBE[v] && !DO_NOT_INVOKE.has(v));
  s.check('every record-scoped verb has a foreign-record probe registered',
    missingScopeProbe.length === 0,
    missingScopeProbe.length ? 'NO PROBE FOR: ' + missingScopeProbe.join(', ') : '');

  for (const verb of RECORD_SCOPED) {
    if (DO_NOT_INVOKE.has(verb) || !FOREIGN_PROBE[verb]) continue;
    const [ns, m] = verb.split('.');
    const res = await s.api(ns, m, FOREIGN_PROBE[verb](probeCtx));
    const allowed = res && res.ok === true;
    s.check(`record scope enforced: ${verb} on another marketer's record`, !allowed,
      allowed ? 'REACHED FOREIGN RECORD' : '');
  }

  // ------------------------------------ crafted payloads must not widen scope
  const widen = await s.page.evaluate(async (o) => {
    const names = r => JSON.stringify(r.ok ? r.data : r.error);
    return {
      listAssigned:  names(await window.api.customers.list({ assignedTo: o.keremId, pageSize: 5000 })),
      listCreated:   names(await window.api.customers.list({ createdBy: o.keremId, pageSize: 5000 })),
      resInvited:    names(await window.api.reservations.list({ invitedBy: o.keremId, pageSize: 5000 })),
    };
  }, ids);
  const SECRET = 'SURFACE FOREIGN GUEST';
  s.check('crafted assignedTo cannot widen customers.list', !widen.listAssigned.includes(SECRET), widen.listAssigned.slice(0, 120));
  s.check('crafted createdBy cannot widen customers.list', !widen.listCreated.includes(SECRET), widen.listCreated.slice(0, 120));
  s.check('crafted invitedBy cannot widen reservations.list', !widen.resInvited.includes(SECRET), widen.resInvited.slice(0, 120));

  // Exports are checked against the bytes actually written, not the { name,
  // rows } envelope — the envelope carries no guest data, so asserting on it
  // would pass no matter how badly the export leaked.
  const exportCust = await s.exportCsv('customerlist', { assignedTo: ids.keremId });
  const exportRes = await s.exportCsv('reservations', { invitedBy: ids.keremId });
  const exportProfCust = await s.exportCsv('profile_customers', { profileId: ids.keremId });
  const exportAudit = await s.exportCsv('audit_logs', {});
  // A crafted export SHOULD come back empty — the filter narrows the caller's
  // own scope, and nothing in it belongs to the other marketer. So emptiness
  // here is the correct answer, not evidence of anything.
  //
  // What must be established separately is that exporting works at all for this
  // caller. Otherwise a wholesale export failure (csv === null, and
  // "null".includes(SECRET) === false) would read as a clean pass.
  const exportOwn = await s.exportCsv('customerlist', {});
  s.check('exporting works for this caller (crafted-export checks are not vacuous)',
    exportOwn.ok && typeof exportOwn.csv === 'string' && exportOwn.csv.length > 0,
    JSON.stringify(exportOwn).slice(0, 160));
  s.check('crafted assignedTo cannot widen the customer export',
    exportCust.ok && !String(exportCust.csv).includes(SECRET), JSON.stringify(exportCust).slice(0, 160));
  s.check('crafted invitedBy cannot widen the reservation export',
    exportRes.ok && !String(exportRes.csv).includes(SECRET), JSON.stringify(exportRes).slice(0, 160));
  s.check('export profile_customers for a foreign profile is refused',
    exportProfCust.code === 'FORBIDDEN', JSON.stringify(exportProfCust).slice(0, 160));
  s.check('export audit_logs is refused without audit.read',
    exportAudit.code === 'FORBIDDEN', JSON.stringify(exportAudit).slice(0, 160));

  // ------------------------------- protection-enforcing verbs actually enforce
  // Matrix-driven for the same reason as record scope above.
  const missingProtProbe = PROTECTION_ENFORCING.filter(v => !PROTECTION_PROBE[v] && !DO_NOT_INVOKE.has(v));
  s.check('every protection-enforcing verb has a takeover probe registered',
    missingProtProbe.length === 0,
    missingProtProbe.length ? 'NO PROBE FOR: ' + missingProtProbe.join(', ') : '');

  for (const verb of PROTECTION_ENFORCING) {
    if (DO_NOT_INVOKE.has(verb) || !PROTECTION_PROBE[verb]) continue;
    const [ns, m] = verb.split('.');
    const res = await s.api(ns, m, PROTECTION_PROBE[verb](probeCtx));
    const allowed = res && res.ok === true;
    s.check(`guest protection enforced on ${verb}`, !allowed,
      allowed ? 'TOOK OVER A PROTECTED GUEST' : '');
  }

  // Ownership must be untouched after every one of those attempts.
  await s.loginAdmin();
  const ownerAfter = await s.page.evaluate(async (cid) =>
    (await window.api.customers.get({ id: cid })).data.marketing_name, foreign.id);
  s.check('no protection probe managed to move the guest',
    ownerAfter === 'KEREM SARICICEK', String(ownerAfter));
  await s.loginSena();

  // --------------------------------------- the foreign guest's PII never leaks
  const leak = await s.page.evaluate(async (cid) => {
    const sum = await window.api.customers.summary({ id: cid });
    const pick = (await window.api.customers.picker({ search: 'SURFACE FOREIGN', pageSize: 50 })).data || [];
    const row = pick.find(x => x.id === cid);
    return {
      summaryPhone: sum.ok ? String(sum.data.phone) : sum.error.code,
      summaryPassport: sum.ok ? String(sum.data.passport_no) : sum.error.code,
      summaryOwner: sum.ok ? String(sum.data.marketing_name) : sum.error.code,
      pickerVisible: !!row,
      pickerPhone: row ? String(row.phone) : 'absent',
    };
  }, foreign.id);
  s.check('finder still surfaces out-of-scope guests (prevents duplicates)', leak.pickerVisible, JSON.stringify(leak));
  s.check('finder withholds phone for out-of-scope guests', leak.pickerPhone === 'null', leak.pickerPhone);
  s.check('summary withholds phone for out-of-scope guests', leak.summaryPhone === 'null', leak.summaryPhone);
  s.check('summary withholds passport for out-of-scope guests', leak.summaryPassport === 'null', leak.summaryPassport);
  s.check('summary withholds owning marketer identity', leak.summaryOwner === 'null', leak.summaryOwner);

  await s.close();
  return s.finish();
};
