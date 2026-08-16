'use strict';
/* LEGITIMATE ACCESS — the other half of authorization.
 *
 * A boundary that blocks everything is not secure, it is broken. These tests
 * exist so that tightening scope can never silently take away work people are
 * supposed to be able to do. Every failure here means a real user lost a
 * capability they need.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('authorization/legitimate-access');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // ------------------------------------------------- MARKETING on own records
  await s.loginSena();
  const own = await s.page.evaluate(async (senaId) => {
    const o = {};
    const c = await window.api.customers.create({
      code: 'LA-OWN', fullName: 'SENA OWN GUEST', registered: true, marketingProfileId: senaId,
    });
    o.create = c.ok; const id = c.data.id;
    o.get = (await window.api.customers.get({ id })).ok;
    o.update = (await window.api.customers.update({ id, phone: '+90 555 000 00 00' })).ok;
    // echoing back the unchanged owner must be tolerated, not treated as a takeover
    o.updateEchoOwner = (await window.api.customers.update({ id, marketingProfileId: senaId, phone: '+90 555 111 11 11' })).ok;
    o.noteCreate = (await window.api.crmNotes.create({ customerId: id, note: 'my note' })).ok;
    o.noteList = (await window.api.crmNotes.list({ customerId: id })).ok;
    const r = await window.api.reservations.create({ customerId: id, checkIn: '2027-06-01', checkOut: '2027-06-04' });
    o.resCreate = r.ok; const rid = r.data.id;
    o.resGet = (await window.api.reservations.get({ id: rid })).ok;
    o.resUpdate = (await window.api.reservations.update({ id: rid, checkIn: '2027-06-02', checkOut: '2027-06-05' })).ok;
    o.invitedBySelf = (await window.api.reservations.get({ id: rid })).data.invited_by_name;
    o.resCancel = (await window.api.reservations.cancel({ id: rid, reason: 'Guest request' })).ok;
    o.dashboard = (await window.api.dashboard.load({})).ok;
    o.calendar = (await window.api.calendar.month({ year: 2027, month: 6 })).ok;
    o.reports = (await window.api.reports.access({})).ok;
    o.export = (await window.api.export.filtered({ entity: 'customerlist', params: {} })).ok;
    o.ownProfileRelated = (await window.api.profiles.relatedCustomers({ id: senaId })).ok;
    o.settingsRead = (await window.api.settings.all({})).ok;
    o.themeWrite = (await window.api.settings.set({ key: 'appearance.theme', value: 'light' })).ok;
    o.notifications = (await window.api.notifications.list({})).ok;
    return o;
  }, ids.senaId);

  for (const [k, v] of Object.entries(own)) {
    if (k === 'invitedBySelf') {
      s.check('MARKETING reservation is attributed to self', v === 'SENA NUR AKMUT', String(v));
    } else {
      s.check(`MARKETING may ${k} on their own record`, v === true, String(v));
    }
  }

  // ------------------------------------------------------- MANAGER breadth
  await s.loginManager();
  const mgr = await s.page.evaluate(async (keremId) => {
    const o = {};
    const all = (await window.api.customers.list({ pageSize: 5000 })).data;
    o.seesEveryGuest = all.total > 1;
    const id = all.rows[0].id;
    o.getAny = (await window.api.customers.get({ id })).ok;
    o.updateAny = (await window.api.customers.update({ id, phone: '+90 500 123 45 67' })).ok;
    o.assignAny = (await window.api.customers.assign({ id, profileId: keremId })).ok;
    o.auditRead = (await window.api.audit.list({})).ok;
    o.profileCreate = (await window.api.profiles.create({ fullName: 'MGR MADE PROFILE' })).ok;
    o.relatedAnyProfile = (await window.api.profiles.relatedCustomers({ id: keremId })).ok;
    o.exportAudit = (await window.api.export.filtered({ entity: 'audit_logs', params: {} })).ok;
    o.reservationsAll = (await window.api.reservations.list({ pageSize: 5000 })).ok;
    return o;
  }, ids.keremId);
  for (const [k, v] of Object.entries(mgr)) {
    s.check(`MANAGER may ${k}`, v === true, String(v));
  }

  // ------------------------------------------------------------ ADMIN: all
  await s.loginAdmin();
  const adm = await s.page.evaluate(async () => {
    const o = {};
    const c = (await window.api.customers.create({ code: 'LA-ADM', fullName: 'ADMIN GUEST', registered: true })).data;
    o.custCreate = !!c.id;
    o.custUpdate = (await window.api.customers.update({ id: c.id, fullName: 'ADMIN GUEST EDITED' })).ok;
    const p = (await window.api.profiles.create({ fullName: 'TEMP PROFILE' })).data;
    o.profCreate = !!p.id;
    o.profDeactivate = (await window.api.profiles.update({ id: p.id, inactive: true })).ok;
    o.profActivate = (await window.api.profiles.update({ id: p.id, inactive: false })).ok;
    o.assign = (await window.api.customers.assign({ id: c.id, profileId: p.id })).ok;
    const r = (await window.api.reservations.create({
      customerId: c.id, checkIn: '2027-07-01', checkOut: '2027-07-03', invitedByProfileId: p.id })).data;
    o.resCreate = !!r.id;
    o.resUpdate = (await window.api.reservations.update({ id: r.id, checkIn: '2027-07-02', checkOut: '2027-07-04' })).ok;
    o.resCancel = (await window.api.reservations.cancel({ id: r.id, reason: 'Other' })).ok;
    o.resDelete = (await window.api.reservations.delete({ id: r.id })).ok;
    const n = (await window.api.crmNotes.create({ customerId: c.id, note: 'admin note' })).data;
    o.noteCreate = !!n.id;
    o.noteUpdate = (await window.api.crmNotes.update({ id: n.id, note: 'edited' })).ok;
    o.noteDelete = (await window.api.crmNotes.delete({ id: n.id })).ok;
    const u = (await window.api.users.create({ username: 'tempuser', password: 'temppass1', role: 'MANAGER' })).data;
    o.userCreate = !!u.id;
    o.userDisable = (await window.api.users.update({ id: u.id, active: false })).ok;
    o.custDelete = (await window.api.customers.delete({ id: c.id })).ok;
    o.backupCreate = (await window.api.backup.create({})).ok;
    o.backupList = (await window.api.backup.list({})).ok;
    o.setPermissions = (await window.api.settings.setPermissions({ matrix: {} })).ok;
    return o;
  });
  for (const [k, v] of Object.entries(adm)) {
    s.check(`ADMIN may ${k}`, v === true, String(v));
  }

  await s.close();
  return s.finish();
};
