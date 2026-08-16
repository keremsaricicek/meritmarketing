'use strict';
/* SECURITY REVIEW FINDINGS — one regression test per defect ever found.
 *
 * Every check in this file corresponds to a real defect that shipped into the
 * working tree at some point and was caught by code review or by an attack
 * probe. They are kept as named findings (C1..C4, I1..I8) so that a future
 * regression is reported in the same vocabulary the review used.
 *
 * Adding a test here is cheap. Re-discovering one of these holes in production
 * is not.
 */

const { Suite } = require('../lib/harness');

const PROTECTED = 'Guest protection period has not expired.';

module.exports = async function () {
  const s = new Suite('regression/security-review-findings');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  const fx = await s.page.evaluate(async (o) => {
    // C1 fixture: KEREM's guest with NO visit at all, explicitly assigned.
    const nv = (await window.api.customers.create({
      code: 'SRF-NEVERVISIT', fullName: 'NEVER VISITED GUEST',
      registered: true, phone: 'SRF-PHONE', passportNo: 'SRF-PASS' })).data;
    await window.api.customers.assign({ id: nv.id, profileId: o.keremId });

    // I1 fixture: explicitly assigned long ago, visit long expired -> takeover
    // MUST be allowed AND must actually transfer ownership.
    //
    // The invite is attributed to ALEYNA so the later assign to KEREM is a REAL
    // ownership change. Assigning to the profile who already owns the guest
    // early-returns without writing history, which would leave the rollback
    // guard untested while the assertions below still passed.
    const old = (await window.api.customers.create({
      code: 'SRF-OLDGUEST', fullName: 'OLD GUEST', registered: true })).data;
    const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 3);
    const ci = d.toISOString().slice(0, 10);
    const co = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);
    await window.api.reservations.create({
      customerId: old.id, checkIn: ci, checkOut: co, invitedByProfileId: o.aleynaId });
    await window.api.customers.assign({ id: old.id, profileId: o.keremId });
    const oldAfter = (await window.api.customers.get({ id: old.id })).data;
    return {
      nvId: nv.id, oldId: old.id,
      oldOwner: oldAfter.marketing_name,
      oldExplicit: (oldAfter.assignment_history || []).filter(h => !h.derived).length,
    };
  }, ids);

  // The fixture only tests what it claims if the assignment really happened.
  s.check('I1 fixture: the guest was explicitly reassigned (guard is under test)',
    fx.oldExplicit === 1 && fx.oldOwner === 'KEREM SARICICEK', JSON.stringify(fx));

  // Backdate the OLD guest's assignment anchor so BOTH anchors are expired.
  // Written through the same store the app reads, then reloaded, so the app
  // parses it exactly as it would parse a real aged database.
  await s.page.evaluate(async (oldId) => {
    const KEY = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('"customers"'));
    const d = JSON.parse(localStorage.getItem(KEY));
    const c = d.customers.find(x => x.id === oldId);
    const old = new Date(); old.setUTCFullYear(old.getUTCFullYear() - 3);
    (c.assignment_history || []).forEach(h => { h.changed_at = old.toISOString(); });
    localStorage.setItem(KEY, JSON.stringify(d));
    location.reload();
  }, fx.oldId);
  await s.page.waitForTimeout(700);
  await s.page.evaluate(() => {
    document.getElementById('loginUser').value = 'admin';
    document.getElementById('loginPass').value = 'admin123';
  });
  await s.page.evaluate(() => window.doLogin());
  await s.page.waitForTimeout(500);

  // ==================================================================== C1
  // A guest who has never visited but WAS explicitly assigned is protected.
  // The original rule anchored only on the latest visit, so an assigned guest
  // with no visit history had no expiry and therefore no protection at all.
  await s.loginSena();
  const c1 = await s.page.evaluate(async (nvId) => {
    const r = await window.api.reservations.create({ customerId: nvId, checkIn: '2027-11-01', checkOut: '2027-11-03' });
    const after = await window.api.customers.get({ id: nvId });
    return { book: r.ok ? 'ALLOWED' : r.error.message, read: after.ok ? 'READABLE' : after.error.code };
  }, fx.nvId);
  s.check('C1: never-visited but assigned guest is protected from another marketer',
    c1.book === PROTECTED, c1.book);
  s.check('C1: that guest\'s record stays unreadable', c1.read === 'FORBIDDEN', c1.read);

  const c1b = await s.page.evaluate(async (o) => {
    const own = (await window.api.customers.create({
      code: 'SRF-SOWN', fullName: 'SENA OWN 2', registered: true, marketingProfileId: o.senaId })).data;
    const r = (await window.api.reservations.create({
      customerId: own.id, checkIn: '2027-12-01', checkOut: '2027-12-03' })).data;
    const up = await window.api.reservations.update({ id: r.id, customerId: o.nvId });
    return up.ok ? 'ALLOWED' : up.error.message;
  }, { senaId: ids.senaId, nvId: fx.nvId });
  s.check('C1: retargeting an own reservation onto a protected guest is blocked',
    c1b === PROTECTED || c1b === 'You do not have access to this record.', c1b);

  // ==================================================================== I1
  // The C1 fix must not strand guests. Once BOTH anchors expire, takeover works
  // and the guest is genuinely usable afterwards — not owned-but-unreadable.
  const i1 = await s.page.evaluate(async (oldId) => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 60);
    const ci = d.toISOString().slice(0, 10);
    const co = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);
    const r = await window.api.reservations.create({ customerId: oldId, checkIn: ci, checkOut: co });
    if (!r.ok) return { book: r.error.message };
    const g = await window.api.customers.get({ id: oldId });
    const n = await window.api.crmNotes.create({ customerId: oldId, note: 'now mine' });
    const inList = (await window.api.customers.list({ pageSize: 5000 })).data.rows.some(x => x.id === oldId);
    return {
      book: 'ALLOWED', read: g.ok ? g.data.marketing_name : g.error.code,
      note: n.ok ? 'ok' : n.error.code, inList,
    };
  }, fx.oldId);
  s.check('I1: fully expired protection lets a new marketer take over', i1.book === 'ALLOWED', JSON.stringify(i1));
  s.check('I1: after takeover the guest is actually usable, not stranded',
    i1.read === 'SENA NUR AKMUT' && i1.note === 'ok', JSON.stringify(i1));
  // The strand this catches: booking succeeds but ownership never moves, so the
  // marketer holds a reservation for a guest missing from their own book.
  s.check('I1: the taken-over guest appears in the new owner\'s list',
    i1.inList === true, JSON.stringify(i1));

  // ==================================================================== C2
  // profiles.relatedCustomers returned another profile's whole guest book.
  const c2 = await s.api('profiles', 'relatedCustomers', { id: ids.keremId });
  s.denied('C2: profiles.relatedCustomers for another profile is blocked', c2, 'FORBIDDEN');

  // ==================================================================== C3
  // export.filtered guarded the wrapper but not the per-entity datasets.
  const c3 = await s.page.evaluate(async (o) => ({
    audit: (await window.api.export.filtered({ entity: 'audit_logs', params: {} })).error?.code || 'ALLOWED',
    profCust: (await window.api.export.filtered({ entity: 'profile_customers', params: { profileId: o.keremId } })).error?.code || 'ALLOWED',
    ownProfCust: (await window.api.export.filtered({ entity: 'profile_customers', params: { profileId: o.senaId } })).ok ? 'ok' : 'blocked',
  }), ids);
  s.check('C3: export of audit_logs is blocked for MARKETING', c3.audit === 'FORBIDDEN', c3.audit);
  s.check('C3: export of another profile\'s customers is blocked', c3.profCust === 'FORBIDDEN', c3.profCust);
  s.check('C3: export of OWN profile customers still works', c3.ownProfCust === 'ok', c3.ownProfCust);

  // ============================================================ I4 / I6
  const misc = await s.page.evaluate(async (nvId) => {
    const picker = (await window.api.customers.picker({ search: 'NEVER', pageSize: 50 })).data;
    const foreign = picker.find(x => x.id === nvId);
    return {
      pickerVisible: !!foreign,
      pickerPhone: foreign ? String(foreign.phone) : 'not-found',
      notifDelete: (await window.api.notifications.delete({ id: 999999 })).error?.code || 'ALLOWED',
      notifMarkRead: (await window.api.notifications.markRead({ id: 999999 })).error?.code || 'ALLOWED',
    };
  }, fx.nvId);
  s.check('I4: the finder still surfaces out-of-scope guests, so duplicates are not created',
    misc.pickerVisible, JSON.stringify(misc));
  s.check('I4: but the finder does not hand over their phone number',
    misc.pickerPhone === 'null', misc.pickerPhone);
  s.check('I6: notifications.delete for a foreign or absent id is refused',
    misc.notifDelete !== 'ALLOWED', misc.notifDelete);
  s.check('I6: notifications.markRead answers uniformly, so it is not an existence oracle',
    misc.notifMarkRead === misc.notifDelete, JSON.stringify(misc));

  // ================================================ unauthenticated surface
  await s.page.evaluate(() => window.doLogout());
  await s.page.waitForTimeout(300);
  const anon = await s.page.evaluate(async () => ({
    'photos.read': (await window.api.photos.read({ name: 'photo_1' })).error?.code || 'ALLOWED',
    'photos.remove': (await window.api.photos.remove({ name: 'photo_1' })).error?.code || 'ALLOWED',
    'settings.all': (await window.api.settings.all({})).error?.code || 'ALLOWED',
    'settings.permissions': (await window.api.settings.permissions({})).error?.code || 'ALLOWED',
    'settings.set': (await window.api.settings.set({ key: 'backup.keep', value: '99' })).error?.code || 'ALLOWED',
    'notifications.markAllRead': (await window.api.notifications.markAllRead({})).error?.code || 'ALLOWED',
    'notifications.unreadCount': (await window.api.notifications.unreadCount({})).error?.code || 'ALLOWED',
    // photos.pick ends by writing db.photos and calling save(). The enforcement
    // suite cannot probe it (the native picker blocks), so its guard is checked
    // here — it must refuse before it ever opens a dialog.
    'photos.pick': (await window.api.photos.pick({})).error?.code || 'ALLOWED',
  }));
  for (const [verb, code] of Object.entries(anon)) {
    s.check(`unauthenticated ${verb} is refused`, code !== 'ALLOWED', String(code));
  }

  // ==================================================================== C4
  // A backup is a full database dump including db.users credentials.
  await s.loginManager();
  const c4 = await s.page.evaluate(async () => ({
    create: (await window.api.backup.create({})).error?.code || 'ALLOWED',
    list: (await window.api.backup.list({})).error?.code || 'ALLOWED',
    restore: (await window.api.backup.restore({ name: 'x' })).error?.code || 'ALLOWED',
  }));
  s.check('C4: MANAGER cannot create a backup (credential dump)', c4.create === 'FORBIDDEN', c4.create);
  s.check('C4: MANAGER cannot list backups', c4.list === 'FORBIDDEN', c4.list);
  s.check('C4: MANAGER cannot restore a backup', c4.restore === 'FORBIDDEN', c4.restore);
  const c4cfg = await s.page.evaluate(async () => {
    const m = await window.api.settings.permissions({});
    return m.ok ? Object.keys(m.data.labels).includes('backup.create') : 'unreadable';
  });
  s.check('C4: backup.create is not grantable through the permission matrix',
    c4cfg === false, String(c4cfg));

  // ==================================================================== I3
  // reservations.update accepted any customerId, including one that does not
  // exist, quietly orphaning the reservation out of every list.
  await s.loginAdmin();
  const i3 = await s.page.evaluate(async () => {
    const before = (await window.api.reservations.list({ pageSize: 5000 })).data.total;
    const r = (await window.api.reservations.list({ pageSize: 1 })).data.rows[0];
    const up = await window.api.reservations.update({ id: r.id, customerId: 99999 });
    const after = (await window.api.reservations.list({ pageSize: 5000 })).data.total;
    return { res: up.ok ? 'ALLOWED' : up.error.code, before, after };
  });
  s.check('I3: retargeting a reservation onto a nonexistent guest is rejected',
    i3.res === 'VALIDATION', JSON.stringify(i3));
  s.check('I3: no reservation silently vanished from the dataset',
    i3.before === i3.after, JSON.stringify(i3));

  // ==================================================================== I7
  // backup.restore replaced the whole db object, so a snapshot taken before a
  // collection existed left the app without that collection entirely.
  const snapName = await s.page.evaluate(async () => {
    const b = (await window.api.backup.create({})).data;
    const KEY = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('"customers"'));
    const d = JSON.parse(localStorage.getItem(KEY));
    const snap = d.backups.find(x => x.name === b.name);
    const parsed = JSON.parse(snap.data);
    delete parsed.userPrefs; delete parsed.photos;
    snap.data = JSON.stringify(parsed);
    localStorage.setItem(KEY, JSON.stringify(d));
    location.reload();
    return b.name;
  });
  await s.page.waitForTimeout(700);
  await s.page.evaluate(() => {
    document.getElementById('loginUser').value = 'admin';
    document.getElementById('loginPass').value = 'admin123';
  });
  await s.page.evaluate(() => window.doLogin());
  await s.page.waitForTimeout(500);
  const i7 = await s.page.evaluate(async (name) => {
    const r = await window.api.backup.restore({ name });
    if (!r.ok) return { restore: r.error.code };
    const set = await window.api.settings.set({ key: 'appearance.theme', value: 'dark' });
    const all = await window.api.settings.all({});
    const dash = await window.api.dashboard.load({});
    return {
      restore: 'ok',
      setAfter: set.ok ? 'ok' : set.error.code,
      theme: all.data?.['appearance.theme'],
      kpiOk: dash.ok && typeof dash.data.stats.totalGuests === 'number',
    };
  }, snapName);
  s.check('I7: restoring a snapshot missing top-level collections still works',
    i7.restore === 'ok', JSON.stringify(i7));
  s.check('I7: writes after such a restore do not break',
    i7.setAfter === 'ok' && i7.theme === 'dark', JSON.stringify(i7));
  s.check('I7: the app is still queryable after a restore (migrations re-ran)',
    i7.kpiOk === true, JSON.stringify(i7));

  await s.close();
  return s.finish();
};
