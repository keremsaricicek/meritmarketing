'use strict';
/* THE CLEAN-START WORKFLOW, end to end.
 *
 * Production ships with no accounts and no data, so this path is not a nicety —
 * it is the only way anybody ever gets in. If it breaks, a fresh install is a
 * brick, and no amount of correctness elsewhere matters.
 *
 * Every step is what a real operator does on day one, in order, with nothing
 * pre-seeded and no file edited by hand.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const auth = require('../../src/main/services/auth-service');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const { today, addDays } = require('../../src/shared/contracts/dates');

const ADMIN_PW = 'quiet-oxblood-lantern';
const MARKETER_PW = 'graphite-evening-ledger';

module.exports = async function () {
  const s = new Suite('database/first-run-workflow');
  const app = new TestApp('mmh-firstrun');

  try {
    // ------------------------------------------------- 0. an empty install
    const tables = ['users', 'profiles', 'customers', 'reservations', 'crm_notes',
      'notifications', 'audit_log', 'settings', 'photos'];
    const counts = {};
    for (const t of tables) counts[t] = app.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    s.check('a fresh installation has no data in any table',
      Object.values(counts).every((n) => n === 0), JSON.stringify(counts));
    s.check('a fresh installation asks for setup', auth.needsSetup(app.db) === true);

    // --------------------------------------------- 1. create the first ADMIN
    const created = await auth.setup(app.db,
      { username: 'owner', password: ADMIN_PW, passwordConfirm: ADMIN_PW, fullName: 'Kerem' }, app.ctx());
    s.check('the first administrator is created', created.id > 0, JSON.stringify(created));

    // ------------------------------------------------------------ 2. sign in
    const session = await auth.login(app.db, { username: 'owner', password: ADMIN_PW }, app.ctx());
    s.check('the new administrator can sign in', session.role === 'ADMIN', JSON.stringify(session));
    const ctx = app.ctx();

    // ------------------------------------------- 3. create a marketing profile
    const profile = support.profiles.create(ctx, { fullName: 'SENA NUR AKMUT', phone: '+90 555 111 22 33' });
    s.check('a marketing profile can be created', profile.id > 0, JSON.stringify(profile));

    // ------------------------------------------------ 4. create a marketing user
    const marketer = await support.users.create(ctx, {
      username: 'sena', password: MARKETER_PW, role: 'MARKETING',
      profileId: profile.id, fullName: 'SENA NUR AKMUT', active: true,
    });
    s.check('a marketing account can be created and linked to the profile',
      marketer.id > 0, JSON.stringify(marketer));

    // -------------------------------------------------- 5. create a guest
    const guest = customers.create(ctx, {
      code: 'MSF-0001', fullName: 'MEHMET YILMAZ', registered: true,
      phone: '+90 532 000 11 22', passportNo: 'U12345678', nationality: 'Türkiye',
      marketingProfileId: profile.id,
    });
    s.check('the first guest can be created', guest.id > 0, JSON.stringify(guest));

    const fresh = customers.get(ctx, { id: guest.id });
    s.check('a brand-new registered guest is NO_RECORD',
      fresh.status === 'NO_RECORD', String(fresh.status));
    s.check('and is owned by the marketing profile',
      fresh.marketing_name === 'SENA NUR AKMUT', String(fresh.marketing_name));

    // ------------------------------------------------ 6. create a reservation
    const stay = reservations.create(ctx, {
      customerId: guest.id, checkIn: addDays(today(), 14), checkOut: addDays(today(), 17),
      invitedByProfileId: profile.id, note: 'Suite requested',
    });
    s.check('the first reservation can be created', stay.id > 0, JSON.stringify(stay));
    const stayRow = reservations.get(ctx, { id: stay.id });
    s.check('it is UPCOMING', stayRow.status === 'UPCOMING', String(stayRow.status));
    s.check('it is attributed to the marketing profile',
      stayRow.invited_by_name === 'SENA NUR AKMUT', String(stayRow.invited_by_name));

    const afterStay = customers.get(ctx, { id: guest.id });
    s.check('the guest leaves NO_RECORD once they have a booking',
      afterStay.status !== 'NO_RECORD', String(afterStay.status));
    s.check('and the booking shows as their next visit',
      afterStay.next_visit === addDays(today(), 14), String(afterStay.next_visit));

    // ------------------------------------------------------- 7. add a CRM note
    const note = support.crmNotes.create(ctx, { customerId: guest.id, note: 'Called to confirm arrival time.' });
    s.check('a CRM note can be added', note.id > 0, JSON.stringify(note));
    s.check('the note count is reflected on the guest',
      customers.get(ctx, { id: guest.id }).note_count === 1);

    // ---------------------------------------------------------- 8. dashboard
    const dash = support.dashboard.load(ctx, { periodDays: 30 });
    s.check('the dashboard reports one guest', dash.stats.totalGuests === 1, JSON.stringify(dash.stats));
    s.check('the dashboard reports one upcoming check-in', dash.stats.upcomingIn === 1, JSON.stringify(dash.stats));
    s.check('the dashboard reports no No Record guests', dash.stats.noRecord === 0, JSON.stringify(dash.stats));
    s.check('the dashboard reports one active marketing profile',
      dash.stats.activeMarketing === 1, JSON.stringify(dash.stats));

    // ---------------------------------------------------------- 9. calendar
    const arrival = addDays(today(), 14);
    const [y, m] = arrival.split('-').map(Number);
    const month = support.calendar.month(ctx, { year: y, month: m });
    s.check('the arrival appears in the calendar month view',
      month.buckets[arrival] && month.buckets[arrival].arrivals === 1,
      JSON.stringify(month.buckets[arrival] || {}));
    const day = support.calendar.day(ctx, { date: arrival });
    s.check('and in the day view', day.arrivals.length === 1, JSON.stringify(day.arrivals.length));

    // ----------------------------------------------------------- 10. reports
    const exporter = require('../../src/main/services/export-service')
      .build({ dialog: null, getWindow: () => null });
    const csv = exporter.render(ctx, { entity: 'customerlist', params: {} });
    s.check('the guest list exports', csv.rows === 1 && csv.csv.includes('MEHMET YILMAZ'), JSON.stringify(csv.rows));

    // ------------------------------------------------------------- 11. audit
    const audit = support.audit.list(ctx, { pageSize: 100 });
    const actions = audit.rows.map((r) => r.action);
    for (const expected of ['SETUP_COMPLETE', 'LOGIN', 'PROFILE_CREATE', 'USER_CREATE',
      'CUSTOMER_CREATE', 'RESERVATION_CREATE', 'CRM_NOTE_CREATE']) {
      s.check(`the audit log records ${expected}`, actions.includes(expected), actions.join(','));
    }
    s.check('every audit row names the actor',
      audit.rows.every((r) => r.actor_username), JSON.stringify(audit.rows.map((r) => r.actor_username)));

    // ------------------------------------------- 12. the marketer signs in
    await app.login('sena', MARKETER_PW);
    const mctx = app.ctx();
    s.check('the marketing user can sign in', mctx.sessions.get().role === 'MARKETING');
    s.check('and sees the guest assigned to them',
      customers.list(mctx, { pageSize: 50 }).total === 1);
    s.check('and sees their own reservation',
      reservations.list(mctx, { pageSize: 50 }).total === 1);
    s.check('but cannot reach the deleted history',
      (() => { try { reservations.listDeleted(mctx, {}); return false; } catch (_) { return true; } })());

    // ------------------------------------------------ 13. sign out, sign back in
    app.sessions.end();
    s.check('signing out clears the session', app.sessions.get() === null);
    const back = await app.login('owner', ADMIN_PW);
    s.check('the administrator can sign back in', back.role === 'ADMIN');
    s.check('and the data is all still there',
      customers.list(app.ctx(), { pageSize: 50 }).total === 1
      && reservations.list(app.ctx(), { pageSize: 50 }).total === 1);

    /* "No manual database edit" has to be checked, not asserted. Every write in
       this suite went through a service, and each one leaves an audit row naming
       its actor — so a row that exists with no audit trail behind it is exactly
       what a hand-edit looks like. `s.check(..., true)` here used to make the
       claim without testing it. */
    const audited = support.audit.list(app.ctx(), { pageSize: 500 }).rows;
    const createdEntities = new Set(audited
      .filter((r) => r.action.endsWith('_CREATE') && r.entity_id)
      .map((r) => `${r.entity_type}:${r.entity_id}`));
    const liveEntities = [
      ...app.db.prepare("SELECT 'customer' t, id FROM customers").all(),
      ...app.db.prepare("SELECT 'reservation' t, id FROM reservations").all(),
      ...app.db.prepare("SELECT 'profile' t, id FROM profiles").all(),
      ...app.db.prepare("SELECT 'crm_note' t, id FROM crm_notes").all(),
    ].map((r) => `${r.t}:${r.id}`);
    const unexplained = liveEntities.filter((k) => !createdEntities.has(k));
    s.check('every row in the database was created through the application, not by hand',
      unexplained.length === 0, `no audit trail for: ${unexplained.join(', ')}`);
    s.check('and the audit log is not empty, so the check above could have failed',
      createdEntities.size >= 4, String(createdEntities.size));
  } finally {
    app.close();
  }

  return s.finish();
};
