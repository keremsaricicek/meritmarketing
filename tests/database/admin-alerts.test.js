'use strict';
/* ADMINISTRATOR ALERTS — who hears about the sensitive things.
 *
 * Every ADMIN, plus anyone whose role an administrator granted
 * 'notifications.admin', is alerted when a reservation or guest is deleted, an
 * account is locked after failed sign-ins, a role changes, or data is
 * exported. Each recipient has their own row: one person reading an alert must
 * not mark it read for the others, and nobody else — not an unscoped MANAGER,
 * not a marketer — may read, mark or delete it.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const exportService = require('../../src/main/services/export-service');
const authService = require('../../src/main/services/auth-service');
const { today, addDays } = require('../../src/shared/contracts/dates');

async function attempt(fn) {
  try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
}
const alertsFor = (app, userId) => app.db.prepare(
  "SELECT * FROM notifications WHERE type = 'admin_alert' AND target_user_id = ? ORDER BY id").all(userId);
const titles = (rows) => rows.map((n) => n.title);

module.exports = async function () {
  const s = new Suite('database/admin-alerts');
  const app = new TestApp('mmh-alerts');

  try {
    const adminSession = await app.bootstrapAdmin();
    const admin2Pass = 'second-admin-console-key';
    await support.users.create(app.ctx(), { username: 'admin2', password: admin2Pass, role: 'ADMIN', fullName: 'Second Admin' });
    const admin2 = app.db.prepare("SELECT id FROM users WHERE username = 'admin2'").get().id;
    const manager = await app.createManagerUser({ username: 'manager' });
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });

    s.check('migration 003 added notifications.target_user_id',
      app.db.prepare('PRAGMA table_info(notifications)').all().some((c) => c.name === 'target_user_id'));

    // --------------------------------------------- 1. reservation deleted
    const guest = customers.create(app.ctx(), { code: 'AL-1', fullName: 'ALERT GUEST', registered: true,
      marketingProfileId: sena.profileId });
    const stay = reservations.create(app.ctx(), { customerId: guest.id, checkIn: addDays(today(), 5),
      checkOut: addDays(today(), 7), invitedByProfileId: sena.profileId });
    s.check('ordinary work raises no administrator alert',
      app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE type = 'admin_alert'").get().n === 0);

    reservations.remove(app.ctx(), { id: stay.id, reason: 'Entered twice' });
    let a2 = alertsFor(app, admin2);
    s.check('deleting a reservation alerts the other administrator',
      a2.length === 1 && a2[0].title === 'Reservation deleted' && a2[0].related_reservation_id === stay.id
      && a2[0].related_customer_id === guest.id && a2[0].target_role === 'ADMIN', JSON.stringify(a2));
    s.check('… naming who did it', a2[0] && a2[0].message.startsWith('admin:'), a2[0] && a2[0].message);
    s.check('the administrator who acted is not alerted about themselves', alertsFor(app, adminSession.id).length === 0);
    s.check('a MANAGER without notifications.admin receives nothing', alertsFor(app, manager.userId).length === 0);
    s.check('a marketer receives nothing', alertsFor(app, sena.userId).length === 0);

    // ------------------------------------- 2. granting the capability
    support.settings.setPermissions(app.ctx(), { matrix: { MANAGER: { 'notifications.admin': true } } });
    customers.remove(app.ctx(), { id: guest.id });
    s.check('deleting a guest alerts admin2', titles(alertsFor(app, admin2)).includes('Guest deleted'));
    const mAlerts = alertsFor(app, manager.userId);
    s.check('a MANAGER granted notifications.admin is alerted too',
      mAlerts.length === 1 && mAlerts[0].title === 'Guest deleted' && mAlerts[0].message.includes('ALERT GUEST'),
      JSON.stringify(mAlerts));

    // ------------------------------------------------ 3. role change
    await support.users.update(app.ctx(), { id: manager.userId, role: 'MARKETING', profileId: sena.profileId });
    const roleAlert = alertsFor(app, admin2).find((n) => n.title === 'Role changed');
    s.check('changing a role alerts administrators',
      !!roleAlert && roleAlert.message.includes('from MANAGER to MARKETING'), JSON.stringify(roleAlert));
    const audited = app.db.prepare("SELECT * FROM audit_log WHERE action = 'USER_UPDATE' ORDER BY id DESC").get();
    s.check('the audit entry records the old and new role',
      JSON.parse(audited.metadata).role_from === 'MANAGER' && JSON.parse(audited.metadata).role_to === 'MARKETING', audited.metadata);
    const before = alertsFor(app, admin2).length;
    await support.users.update(app.ctx(), { id: manager.userId, role: 'MANAGER', profileId: null });
    await support.users.update(app.ctx(), { id: manager.userId, fullName: 'Renamed Manager' });
    s.check('an edit that does not change the role raises no role alert',
      alertsFor(app, admin2).length === before + 1, `${before} → ${alertsFor(app, admin2).length}`);

    // ---------------------------------------------- 4. account locked
    for (let i = 0; i < authService.MAX_ATTEMPTS; i++) {
      await attempt(() => app.login('sena', 'definitely-wrong-password'));
    }
    const locked = app.db.prepare('SELECT locked_until FROM users WHERE id = ?').get(sena.userId).locked_until;
    s.check('five wrong passwords lock the account', !!locked && Date.parse(locked) > Date.now(), locked);
    s.check('the lockout is its own audit action',
      app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'ACCOUNT_LOCKED' AND entity_id = ?").get(sena.userId).n === 1);
    const lockAlerts = (id) => alertsFor(app, id).filter((n) => n.title === 'Account locked');
    s.check('a lockout alerts every administrator (no acting session to exclude)',
      lockAlerts(adminSession.id).length === 1 && lockAlerts(admin2).length === 1
      && lockAlerts(adminSession.id)[0].message.includes('"sena"'), JSON.stringify(lockAlerts(adminSession.id)));
    s.check('… and the granted manager', lockAlerts(manager.userId).length === 1);
    s.check('the locked marketer is not alerted', alertsFor(app, sena.userId).length === 0);

    // ----------------------------------------------------- 5. export
    await app.loginAdmin();
    const out = path.join(app.root, 'export.csv');
    const exporter = exportService.build({
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: out }) }, getWindow: () => null,
    });
    await exporter.run(app.ctx(), { entity: 'customerlist', params: {} });
    s.check('the export was written', fs.existsSync(out));
    s.check('exporting data alerts administrators', titles(alertsFor(app, admin2)).includes('Data exported'));
    const cancelled = exportService.build({
      dialog: { showSaveDialog: async () => ({ canceled: true }) }, getWindow: () => null,
    });
    const n = alertsFor(app, admin2).length;
    await cancelled.run(app.ctx(), { entity: 'customerlist', params: {} });
    s.check('a cancelled export (nothing written) raises no alert', alertsFor(app, admin2).length === n);

    // ------------------------------------------- 6. who can see them
    await app.login('admin2', admin2Pass);
    let list = support.notifications.list(app.ctx());
    const mine = alertsFor(app, admin2).map((x) => x.id);
    s.check('an administrator sees their own alerts in the bell',
      mine.every((id) => list.some((x) => x.id === id)), `${mine} / ${list.map((x) => x.id)}`);
    s.check("… and not another administrator's copies",
      !list.some((x) => x.type === 'admin_alert' && x.target_user_id !== admin2), JSON.stringify(list.map((x) => x.target_user_id)));
    const unreadBefore = support.notifications.unreadCount(app.ctx());
    support.notifications.markRead(app.ctx(), { id: mine[0] });
    s.check('marking one read lowers the count by one', support.notifications.unreadCount(app.ctx()) === unreadBefore - 1);
    s.check("… and does not mark the other administrator's copy",
      app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='admin_alert' AND target_user_id = ? AND read_at IS NOT NULL")
        .get(adminSession.id).n === 0);

    await app.login('manager', manager.password);
    list = support.notifications.list(app.ctx());
    s.check('the granted manager sees only their own alerts',
      list.filter((x) => x.type === 'admin_alert').every((x) => x.target_user_id === manager.userId)
      && list.some((x) => x.type === 'admin_alert'));
    const foreign = alertsFor(app, admin2)[1].id;
    let r = await attempt(() => support.notifications.markRead(app.ctx(), { id: foreign }));
    s.check("an unscoped MANAGER cannot mark an administrator's alert read", !r.ok && r.code === 'FORBIDDEN', r.code);
    r = await attempt(() => support.notifications.remove(app.ctx(), { id: foreign }));
    s.check("… nor delete it", !r.ok && r.code === 'FORBIDDEN', r.code);
    support.notifications.markAllRead(app.ctx());
    s.check("mark-all-read leaves the administrators' alerts untouched",
      app.db.prepare('SELECT read_at FROM notifications WHERE id = ?').get(foreign).read_at === null);

    /* Revoking the grant hides the alerts already delivered. */
    await app.loginAdmin();
    support.settings.setPermissions(app.ctx(), { matrix: {} });
    await app.login('manager', manager.password);
    list = support.notifications.list(app.ctx());
    s.check('after notifications.admin is revoked the manager no longer sees alerts',
      !list.some((x) => x.type === 'admin_alert'), JSON.stringify(list.map((x) => x.type)));
    const own = alertsFor(app, manager.userId)[0].id;
    r = await attempt(() => support.notifications.markRead(app.ctx(), { id: own }));
    s.check('… nor can touch them', !r.ok && r.code === 'FORBIDDEN', r.code);

    /* Marketers never see administrator alerts, even though they look like
       broadcasts to the old profile predicate (target_profile_id IS NULL). */
    app.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(sena.userId);
    await app.login('sena', sena.password);
    list = support.notifications.list(app.ctx());
    s.check('a marketer sees no administrator alerts', !list.some((x) => x.type === 'admin_alert'),
      JSON.stringify(list.map((x) => x.type)));
    s.check('… and they do not count toward the marketer\'s unread badge',
      support.notifications.unreadCount(app.ctx()) === list.filter((x) => !x.read_at).length);
    r = await attempt(() => support.notifications.markRead(app.ctx(), { id: foreign }));
    s.check('a marketer cannot mark an administrator alert read', !r.ok && r.code === 'FORBIDDEN', r.code);

    /* Still a working broadcast for everybody. */
    app.db.prepare(`INSERT INTO notifications (type, title, message, created_at) VALUES ('system', 'Broadcast', 'hi', ?)`)
      .run(new Date().toISOString());
    s.check('broadcasts still reach marketers', support.notifications.list(app.ctx()).some((x) => x.title === 'Broadcast'));
    s.check('no audit or notification step failed', app.auditErrors.length === 0, JSON.stringify(app.auditErrors));
  } catch (e) {
    s.check('suite ran without crashing', false, e && e.stack);
  } finally {
    app.close();
  }
  return s.finish();
};
