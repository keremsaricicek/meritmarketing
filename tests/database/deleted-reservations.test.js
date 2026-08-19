'use strict';
/* DELETED RESERVATIONS — the Phase 75 matrix, A through N.
 *
 * Deletion became non-destructive. The row survives so the audit trail and the
 * historical Invited By attribution survive with it; what changes is that the
 * booking stops counting for anything operational, and stops being visible to
 * MARKETING by any route at all.
 *
 * "Not visible" here means the API, not the tab. A hidden tab is a usability
 * decision; the assertions below call the services directly.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const domain = require('../../src/main/services/domain');
const { today, addDays } = require('../../src/shared/contracts/dates');

const attempt = async (fn) => {
  try { return { ok: true, data: await fn() }; }
  catch (err) { return { ok: false, code: err.code, message: err.message }; }
};

module.exports = async function () {
  const s = new Suite('database/deleted-reservations');
  const app = new TestApp('mmh-deleted');

  try {
    await app.bootstrapAdmin();
    const ctx = app.ctx();
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'KEREM SARICICEK' });
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    await app.createManagerUser();

    // A guest of KEREM with an upcoming stay, plus a second guest for controls.
    const guest = customers.create(ctx, { code: 'DEL-1', fullName: 'DELETE MATRIX GUEST', marketingProfileId: kerem.profileId });
    const soon = addDays(today(), 20);
    const soonOut = addDays(today(), 23);
    const upcoming = reservations.create(ctx, {
      customerId: guest.id, checkIn: soon, checkOut: soonOut, invitedByProfileId: kerem.profileId,
    });
    const past = reservations.create(ctx, {
      customerId: guest.id, checkIn: addDays(today(), -30), checkOut: addDays(today(), -27),
      invitedByProfileId: kerem.profileId,
    });

    const kpiBefore = {
      active: reservations.list(ctx, { pageSize: 500 }).total,
      upcoming: reservations.list(ctx, { status: 'UPCOMING', pageSize: 500 }).total,
      calendar: reservations.list(ctx, { pageSize: 500 }).rows.filter((r) => r.check_in === soon).length,
    };
    const guestBefore = customers.get(ctx, { id: guest.id });

    // ------------------------------------------------------------------- A
    const deleted = reservations.remove(ctx, { id: upcoming.id, reason: 'Duplicate booking' });
    s.check('A: ADMIN can soft-delete a reservation', deleted.status === 'DELETED', JSON.stringify(deleted));

    const raw = app.db.prepare('SELECT * FROM reservations WHERE id = ?').get(upcoming.id);
    s.check('M: the row is NOT physically deleted', !!raw, 'row disappeared from the table');
    s.check('A: deleted_at is set', !!raw.deleted_at, String(raw.deleted_at));
    s.check('A: deleted_by is set', !!raw.deleted_by, String(raw.deleted_by));
    s.check('A: the deletion reason is stored', raw.deletion_reason === 'Duplicate booking', String(raw.deletion_reason));

    s.check('A: the normal reservation list excludes it',
      !reservations.list(ctx, { pageSize: 500 }).rows.some((r) => r.id === upcoming.id));
    s.check('A: the deleted list includes it',
      reservations.listDeleted(ctx, { pageSize: 500 }).rows.some((r) => r.id === upcoming.id));

    // ------------------------------------------------------------------- N
    const auditRow = app.db.prepare(
      "SELECT * FROM audit_log WHERE action = 'RESERVATION_DELETE' AND entity_id = ?").get(upcoming.id);
    s.check('N: deletion is audited', !!auditRow, 'no audit row');
    s.check('N: the audit records the actor', !!auditRow.actor_user_id, String(auditRow.actor_user_id));
    s.check('N: the audit records the time', !!auditRow.created_at, String(auditRow.created_at));
    s.check('N: the audit records the reason', /Duplicate booking/.test(auditRow.description), auditRow.description);
    s.check('N: the audit records the previous lifecycle state',
      /was UPCOMING/.test(auditRow.description), auditRow.description);

    // ------------------------------------------------------------------- B
    await app.login('manager', 'oversight-console-key');
    const mgrDeleted = await attempt(() => reservations.listDeleted(app.ctx(), { pageSize: 500 }));
    s.check('B: MANAGER can view deleted history', mgrDeleted.ok === true, JSON.stringify(mgrDeleted));
    s.check('B: MANAGER sees the deleted reservation in it',
      mgrDeleted.data.rows.some((r) => r.id === upcoming.id));

    // MANAGER may VIEW deleted history but is NOT thereby granted deletion.
    const mgrDelete = await attempt(() => reservations.remove(app.ctx(), { id: past.id, reason: 'trying' }));
    s.check('MANAGER viewing deleted history does not grant them deletion',
      mgrDelete.ok === false && mgrDelete.code === 'FORBIDDEN', JSON.stringify(mgrDelete));

    // ---------------------------------------------------------------- C / D
    await app.login('sena', sena.password);
    const senaCtx = app.ctx();
    s.check('C: MARKETING cannot see the Deleted destination at all',
      domain.canSeeDeleted(app.sessions.get()) === false);

    const senaDeletedList = await attempt(() => reservations.listDeleted(senaCtx, { pageSize: 500 }));
    s.check('D: MARKETING asking for the deleted list is refused',
      senaDeletedList.ok === false, JSON.stringify(senaDeletedList));

    // ------------------------------------------------------------------- E
    const senaById = await attempt(() => reservations.get(senaCtx, { id: upcoming.id }));
    s.check('E: MARKETING with the exact deleted id is refused',
      senaById.ok === false, JSON.stringify(senaById));
    const senaMissing = await attempt(() => reservations.get(senaCtx, { id: 987654 }));
    s.check('E: the refusal is indistinguishable from a nonexistent id (no oracle)',
      senaById.code === senaMissing.code && senaById.message === senaMissing.message,
      `${senaById.code}/${senaById.message} vs ${senaMissing.code}/${senaMissing.message}`);

    // Even KEREM, who owns the booking, cannot reach it — the record is gone
    // operationally regardless of whose scope it used to sit in.
    await app.login('kerem', kerem.password);
    const ownerById = await attempt(() => reservations.get(app.ctx(), { id: upcoming.id }));
    s.check('E: even the owning marketer cannot read the deleted reservation',
      ownerById.ok === false, JSON.stringify(ownerById));

    // ------------------------------------------------------------- F / G / H
    await app.loginAdmin();
    const adminCtx = app.ctx();
    const kpiAfter = {
      active: reservations.list(adminCtx, { pageSize: 500 }).total,
      upcoming: reservations.list(adminCtx, { status: 'UPCOMING', pageSize: 500 }).total,
    };
    s.check('F: a deleted reservation leaves the active total',
      kpiAfter.active === kpiBefore.active - 1, JSON.stringify({ kpiBefore, kpiAfter }));
    s.check('F: a deleted reservation leaves Upcoming Check-ins',
      kpiAfter.upcoming === kpiBefore.upcoming - 1, JSON.stringify({ kpiBefore, kpiAfter }));

    const reservationsRepo = require('../../src/main/repositories/reservations');
    const [y, m] = soon.split('-').map(Number);
    const buckets = reservationsRepo.calendarMonth(app.db, y, m, null);
    s.check('G: a deleted reservation occupies no calendar bucket',
      !buckets[soon] || buckets[soon].arrivals === 0, JSON.stringify(buckets[soon] || {}));
    const day = reservationsRepo.calendarDay(app.db, soon, null);
    s.check('G: the calendar day view excludes it',
      !day.arrivals.some((r) => r.id === upcoming.id), JSON.stringify(day.arrivals.map((r) => r.id)));

    const guestAfter = customers.get(adminCtx, { id: guest.id });
    s.check('H: a deleted reservation is not the guest\'s next visit',
      guestAfter.next_visit === null, String(guestAfter.next_visit));
    s.check('H: the guest\'s qualifying count drops',
      guestAfter.qualifying_reservation_count === guestBefore.qualifying_reservation_count - 1,
      JSON.stringify([guestBefore.qualifying_reservation_count, guestAfter.qualifying_reservation_count]));
    s.check('H: a deleted reservation is not counted in the historical total either',
      guestAfter.reservation_count === guestBefore.reservation_count - 1,
      JSON.stringify([guestBefore.reservation_count, guestAfter.reservation_count]));

    // ------------------------------------------------------------------- I
    // A guest whose ONLY qualifying activity is deleted must not stay locked.
    const lonely = customers.create(adminCtx, { code: 'DEL-2', fullName: 'ONLY DELETED GUEST' });
    const onlyRes = reservations.create(adminCtx, {
      customerId: lonely.id, checkIn: addDays(today(), -5), checkOut: addDays(today(), -3),
      invitedByProfileId: kerem.profileId,
    });
    const protectedBefore = customers.protectionState(adminCtx, { id: lonely.id });
    reservations.remove(adminCtx, { id: onlyRes.id, reason: 'Entered in error' });
    const protectedAfter = customers.protectionState(adminCtx, { id: lonely.id });
    s.check('I: before deletion the stay did extend protection',
      protectedBefore.active === true, JSON.stringify(protectedBefore));
    s.check('I: a deleted reservation does not extend protection',
      protectedAfter.active === false, JSON.stringify(protectedAfter));

    // ------------------------------------------------------------------- J
    const lonelyAfter = customers.get(adminCtx, { id: lonely.id });
    s.check('J: a guest with only deleted reservations and no notes is NO_RECORD',
      lonelyAfter.status === 'NO_RECORD', JSON.stringify({ status: lonelyAfter.status,
        qualifying: lonelyAfter.qualifying_reservation_count, notes: lonelyAfter.note_count }));
    s.check('J: and appears in the No Record list',
      customers.list(adminCtx, { noRecord: true, registeredOnly: true, pageSize: 500 })
        .rows.some((r) => r.id === lonely.id));

    // ------------------------------------------------------------------- K
    const cancelledThenDeleted = reservations.create(adminCtx, {
      customerId: guest.id, checkIn: addDays(today(), 60), checkOut: addDays(today(), 62),
      invitedByProfileId: kerem.profileId,
    });
    reservations.cancel(adminCtx, { id: cancelledThenDeleted.id, reason: 'Guest changed plans' });
    const cancelledRow = app.db.prepare('SELECT * FROM reservations WHERE id = ?').get(cancelledThenDeleted.id);
    reservations.remove(adminCtx, { id: cancelledThenDeleted.id, reason: 'Cleared from the book' });
    const bothRow = app.db.prepare('SELECT * FROM reservations WHERE id = ?').get(cancelledThenDeleted.id);

    s.check('K: cancellation metadata survives the deletion',
      bothRow.cancelled_at === cancelledRow.cancelled_at
      && bothRow.cancellation_reason === 'Guest changed plans', JSON.stringify(bothRow));
    s.check('K: DELETED is the reported state, not CANCELLED',
      domain.reservationStatus(bothRow) === 'DELETED', domain.reservationStatus(bothRow));
    s.check('K: it appears in Deleted',
      reservations.listDeleted(adminCtx, { pageSize: 500 }).rows.some((r) => r.id === cancelledThenDeleted.id));
    s.check('K: it does NOT also appear in Cancelled',
      !reservations.list(adminCtx, { view: 'cancelled', pageSize: 500 }).rows.some((r) => r.id === cancelledThenDeleted.id));

    // ------------------------------------------------------------------- L
    s.check('L: historical Invited By is preserved on the deleted row',
      bothRow.invited_by_profile_id === kerem.profileId, String(bothRow.invited_by_profile_id));
    const deletedView = reservations.listDeleted(adminCtx, { pageSize: 500 }).rows
      .find((r) => r.id === upcoming.id);
    s.check('L: the Deleted view still shows who invited the guest',
      deletedView.invited_by_name === 'KEREM SARICICEK', String(deletedView.invited_by_name));

    // ------------------------------------------------- delete hygiene rules
    const noReason = await attempt(() => reservations.remove(adminCtx, { id: past.id }));
    s.check('a deletion without a reason is refused',
      noReason.ok === false && noReason.code === 'VALIDATION', JSON.stringify(noReason));

    const twice = reservations.remove(adminCtx, { id: upcoming.id, reason: 'again' });
    s.check('deleting an already-deleted reservation is idempotent', twice.status === 'DELETED');
    const stillOriginal = app.db.prepare('SELECT deletion_reason FROM reservations WHERE id = ?').get(upcoming.id);
    s.check('a repeat deletion does not overwrite the original reason',
      stillOriginal.deletion_reason === 'Duplicate booking', String(stillOriginal.deletion_reason));

    const editDeleted = await attempt(() => reservations.update(adminCtx, {
      id: upcoming.id, checkIn: addDays(today(), 5), checkOut: addDays(today(), 7) }));
    s.check('a deleted reservation cannot be edited back into life',
      editDeleted.ok === false, JSON.stringify(editDeleted));

    const cancelDeleted = await attempt(() => reservations.cancel(adminCtx, { id: upcoming.id, reason: 'x' }));
    s.check('a deleted reservation cannot be cancelled', cancelDeleted.ok === false, JSON.stringify(cancelDeleted));

    // There is deliberately no undelete verb: soft delete exists to preserve
    // history, not to add a restore feature nobody asked for.
    s.check('no undelete/restore verb is exposed',
      typeof reservations.restore === 'undefined' && typeof reservations.undelete === 'undefined');
    s.check('no permanent-purge verb is exposed',
      typeof reservations.purge === 'undefined' && typeof reservations.hardDelete === 'undefined');
  } finally {
    app.close();
  }

  return s.finish();
};
