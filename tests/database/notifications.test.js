'use strict';
/* NOTIFICATIONS — the feature that existed everywhere except where it counted.
 *
 * The migration carried the table, its index, five IPC channels and all of the
 * scope logic, and left every producer behind. Everything about the feature
 * was present except a single row ever being written, and no test noticed
 * because every test asserted on how notifications are READ.
 *
 * So the first assertion here is the one that was missing: does anything write?
 * The rest cover what the prototype's four producers did, and the two things
 * the scope predicate got wrong.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const notificationService = require('../../src/main/services/notification-service');
const { today, addDays, nowIso } = require('../../src/shared/contracts/dates');

const rows = (app) => app.db.prepare('SELECT * FROM notifications ORDER BY id').all();
const ofType = (app, type) => rows(app).filter((n) => n.type === type);

module.exports = async function () {
  const s = new Suite('database/notifications');
  const app = new TestApp('mmh-notif');

  try {
    await app.bootstrapAdmin();
    const manager = await app.createManagerUser({ username: 'manager' });
    /* A MANAGER only receives the feed if they have a profile — the feed is
       addressed by profile, not by user. */
    const managerProfile = app.createProfile('OPERATIONS MANAGER', { kind: 'staff' });
    app.db.prepare('UPDATE users SET profile_id = ? WHERE id = ?').run(managerProfile, manager.userId);

    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });

    // ------------------------------------------------ 1. anything writes at all
    s.check('a fresh installation has no notifications', rows(app).length === 0);

    const guest = customers.create(app.ctx(), {
      code: 'N-1', fullName: 'NOTIFY GUEST', registered: true,
    });
    s.check('creating a guest reaches the manager activity feed',
      ofType(app, 'activity').length > 0, JSON.stringify(rows(app).map((n) => n.type)));

    const activity = ofType(app, 'activity')[0];
    s.check('the feed entry is addressed to the manager profile',
      activity.target_profile_id === managerProfile, String(activity.target_profile_id));
    s.check('it names who did it',
      activity.message.startsWith('admin:'), activity.message);
    s.check('and links to the record it is about',
      activity.related_customer_id === guest.id, String(activity.related_customer_id));

    // -------------------------------------- 2. the actor never notifies themself
    const before = ofType(app, 'activity').length;
    await app.login('manager', manager.password);
    support.crmNotes.create(app.ctx(), { customerId: guest.id, note: 'Manager wrote this.' });
    s.check('a manager is not notified about their own action',
      ofType(app, 'activity').length === before,
      `${before} → ${ofType(app, 'activity').length}`);

    // ---------------------------------------------- 3. assignment reaches the owner
    await app.loginAdmin();
    customers.assign(app.ctx(), { id: guest.id, profileId: sena.profileId });
    const assigned = ofType(app, 'assignment');
    s.check('assigning a guest notifies the marketer receiving them',
      assigned.length === 1, String(assigned.length));
    s.check('addressed to the receiving profile',
      assigned[0].target_profile_id === sena.profileId, String(assigned[0].target_profile_id));
    s.check('and names the guest', assigned[0].message.includes('NOTIFY GUEST'), assigned[0].message);

    // --------------------------------- 4. derived: an imminent arrival is flagged
    const tomorrow = addDays(today(), 1);
    const soonStay = reservations.create(app.ctx(), {
      customerId: guest.id, checkIn: tomorrow, checkOut: addDays(tomorrow, 2),
      invitedByProfileId: sena.profileId,
    });
    const laterStay = reservations.create(app.ctx(), {
      customerId: guest.id, checkIn: addDays(today(), 5), checkOut: addDays(today(), 6),
      invitedByProfileId: sena.profileId, force: true,
    });
    /* Far enough out that it must NOT produce a reminder. */
    reservations.create(app.ctx(), {
      customerId: guest.id, checkIn: addDays(today(), 60), checkOut: addDays(today(), 61),
      invitedByProfileId: sena.profileId, force: true,
    });

    await app.login('sena', sena.password);
    support.notifications.list(app.ctx());

    const urgent = ofType(app, 'checkin_urgent');
    const soon = ofType(app, 'checkin_soon');
    s.check('an arrival tomorrow raises an urgent check-in reminder',
      urgent.length === 1 && urgent[0].related_reservation_id === soonStay.id,
      JSON.stringify(urgent.map((n) => n.related_reservation_id)));
    s.check('an arrival inside the week raises an ordinary one',
      soon.length === 1 && soon[0].related_reservation_id === laterStay.id,
      JSON.stringify(soon.map((n) => n.related_reservation_id)));
    s.check('an arrival two months out raises nothing',
      urgent.length + soon.length === 2, `${urgent.length} urgent, ${soon.length} soon`);

    // ------------------------- 5. derived conditions are reconciled, not appended
    for (let i = 0; i < 4; i++) support.notifications.list(app.ctx());
    s.check('opening the panel repeatedly does not duplicate a standing reminder',
      ofType(app, 'checkin_urgent').length === 1 && ofType(app, 'checkin_soon').length === 1,
      `${ofType(app, 'checkin_urgent').length} urgent, ${ofType(app, 'checkin_soon').length} soon`);

    /* Cancel the imminent stay: the condition has lifted, so the reminder must
       go. A reminder for a booking that is no longer happening is worse than no
       reminder — somebody acts on it. */
    await app.loginAdmin();
    reservations.cancel(app.ctx(), { id: soonStay.id, reason: 'Guest cancelled' });
    await app.login('sena', sena.password);
    support.notifications.list(app.ctx());
    s.check('cancelling the booking removes its reminder',
      ofType(app, 'checkin_urgent').length === 0,
      JSON.stringify(ofType(app, 'checkin_urgent').map((n) => n.related_reservation_id)));

    // --------------------------------------------------- 6. cold guests
    const cold = customers.create(app.ctx(), {
      code: 'N-COLD', fullName: 'COLD GUEST', registered: true, marketingProfileId: sena.profileId,
    });
    /* One real visit, long enough ago to be cold — not "no activity", which is
       No Record and a different condition entirely. */
    app.db.prepare(`INSERT INTO reservations (customer_id, check_in, check_out, invited_by_profile_id,
        created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1)`)
      .run(cold.id, addDays(today(), -200), addDays(today(), -198), sena.profileId, nowIso(), nowIso());

    support.notifications.list(app.ctx());
    const coldRows = ofType(app, 'cold_guest');
    s.check('a guest who has gone cold is raised once',
      coldRows.length === 1 && coldRows[0].related_customer_id === cold.id,
      JSON.stringify(coldRows.map((n) => n.related_customer_id)));
    s.check('and the message says how long it has been',
      /\d+ days since last visit/.test(coldRows[0].message), coldRows[0].message);

    /* A booking makes them active again, so the condition lifts. */
    await app.loginAdmin();
    reservations.create(app.ctx(), {
      customerId: cold.id, checkIn: addDays(today(), 30), checkOut: addDays(today(), 32),
      invitedByProfileId: sena.profileId,
    });
    await app.login('sena', sena.password);
    support.notifications.list(app.ctx());
    s.check('booking them again clears the cold notification',
      ofType(app, 'cold_guest').length === 0,
      JSON.stringify(ofType(app, 'cold_guest').map((n) => n.related_customer_id)));

    // ------------------------------------------------------- 7. scope and reach
    /* The old predicate carried an `OR 1=1`, which made "unscoped sees
       everything" unconditional and silently decided a marketer never sees a
       broadcast. Both halves are asserted here. */
    app.db.prepare(`INSERT INTO notifications (type, title, message, target_profile_id, created_at)
                    VALUES ('activity', 'Everyone', 'A broadcast', NULL, ?)`).run(nowIso());
    const senaSees = support.notifications.list(app.ctx());
    s.check('a marketer receives a broadcast addressed to nobody in particular',
      senaSees.some((n) => n.title === 'Everyone'), JSON.stringify(senaSees.map((n) => n.title)));
    s.check('but never another profile\'s notification',
      senaSees.every((n) => n.target_profile_id === sena.profileId || n.target_profile_id === null),
      JSON.stringify(senaSees.map((n) => n.target_profile_id)));

    const senaUnread = support.notifications.unreadCount(app.ctx());
    s.check('the unread badge counts exactly what the list shows',
      senaUnread === senaSees.filter((n) => !n.read_at).length,
      `badge ${senaUnread}, list ${senaSees.filter((n) => !n.read_at).length}`);

    support.notifications.markAllRead(app.ctx());
    s.check('marking all read clears the badge',
      support.notifications.unreadCount(app.ctx()) === 0);
    s.check('and leaves other profiles\' notifications unread',
      app.db.prepare('SELECT COUNT(*) n FROM notifications WHERE target_profile_id = ? AND read_at IS NULL')
        .get(managerProfile).n > 0);

    // ---------------------------------------- 8. a notification failure is not fatal
    let threw = null;
    try {
      notificationService.emitActivity(app.db, { action: 'NOT_IN_THE_FEED', description: 'x' }, null);
    } catch (err) { threw = err; }
    s.check('an action outside the feed writes nothing and does not throw',
      threw === null && !rows(app).some((n) => n.message === 'x'), String(threw));

    /* The feed can be switched off, and switching it off must actually stop it. */
    app.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('notifications.manager_feed', 'false', ?)
                    ON CONFLICT(key) DO UPDATE SET value = 'false'`).run(nowIso());
    await app.loginAdmin();
    const beforeOff = ofType(app, 'activity').length;
    customers.create(app.ctx(), { code: 'N-2', fullName: 'QUIET GUEST', registered: true });
    s.check('turning the manager feed off stops it',
      ofType(app, 'activity').length === beforeOff,
      `${beforeOff} → ${ofType(app, 'activity').length}`);
  } finally {
    app.close();
  }

  return s.finish();
};
