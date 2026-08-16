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
const { SURFACE, REQUIRES_SESSION, FORBIDDEN_FOR_MARKETING } = require('./surface');

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

/* Verbs we must not actually invoke during discovery/probing because they
   would destroy the fixture or block on a UI dialog. They are covered by
   dedicated tests elsewhere. */
const DO_NOT_INVOKE = new Set([
  'auth.setup', 'auth.login', 'auth.logout',   // would change session mid-suite
  'photos.pick', 'dialog.confirm',             // open real dialogs
  'backup.create',                             // triggers a file download
]);

module.exports = async function () {
  const s = new Suite('api-surface/enforcement');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // ---------------------------------------------------------------- discovery
  const live = await s.page.evaluate(() => {
    const out = [];
    for (const ns of Object.keys(window.api)) {
      const group = window.api[ns];
      if (!group || typeof group !== 'object') continue;
      for (const verb of Object.keys(group)) {
        if (typeof group[verb] === 'function') out.push(ns + '.' + verb);
      }
    }
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

  // ----------------------------------------- record scope, verb by verb, live
  const scopeProbes = [
    ['customers.get',              { id: foreign.id }],
    ['customers.update',           { id: foreign.id, phone: 'HACKED' }],
    ['customers.delete',           { id: foreign.id }],
    ['customers.assign',           { id: foreign.id, profileId: ids.senaId }],
    ['crmNotes.list',              { customerId: foreign.id }],
    ['crmNotes.create',            { customerId: foreign.id, note: 'x' }],
    ['crmNotes.update',            { id: foreignNote, note: 'x' }],
    ['crmNotes.delete',            { id: foreignNote }],
    ['reservations.get',           { id: foreignRes }],
    ['reservations.update',        { id: foreignRes, checkIn: '2027-02-01', checkOut: '2027-02-03' }],
    ['reservations.cancel',        { id: foreignRes, reason: 'Other' }],
    ['profiles.relatedCustomers',  { id: ids.keremId }],
  ];
  for (const [verb, payload] of scopeProbes) {
    const [ns, m] = verb.split('.');
    const res = await s.api(ns, m, payload);
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
  s.check('crafted assignedTo cannot widen the customer export',
    !String(exportCust.csv).includes(SECRET), String(exportCust.csv).slice(0, 160));
  s.check('crafted invitedBy cannot widen the reservation export',
    !String(exportRes.csv).includes(SECRET), String(exportRes.csv).slice(0, 160));
  s.check('export profile_customers for a foreign profile is refused',
    exportProfCust.code === 'FORBIDDEN', JSON.stringify(exportProfCust).slice(0, 160));
  s.check('export audit_logs is refused without audit.read',
    exportAudit.code === 'FORBIDDEN', JSON.stringify(exportAudit).slice(0, 160));

  // ------------------------------- protection-enforcing verbs actually enforce
  const prot = await s.page.evaluate(async (o) => {
    const msg = r => r.ok ? 'ALLOWED' : r.error.message;
    const own = (await window.api.customers.create({ code: 'SURF-OWN', fullName: 'SURFACE OWN', marketingProfileId: o.senaId })).data;
    const ownRes = (await window.api.reservations.create({ customerId: own.id, checkIn: '2027-03-01', checkOut: '2027-03-03' })).data;
    return {
      create: msg(await window.api.reservations.create({ customerId: o.foreignId, checkIn: '2027-04-01', checkOut: '2027-04-03' })),
      update: msg(await window.api.reservations.update({ id: ownRes.id, customerId: o.foreignId })),
      assign: msg(await window.api.customers.assign({ id: o.foreignId, profileId: o.senaId })),
      custUpdate: msg(await window.api.customers.update({ id: o.foreignId, marketingProfileId: o.senaId })),
    };
  }, { ...ids, foreignId: foreign.id });
  for (const [k, v] of Object.entries(prot)) {
    s.check(`guest protection enforced on ${k}`, v !== 'ALLOWED', v);
  }

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
