'use strict';
/* REGRESSION TESTS FOR THE INDEPENDENT REVIEW FINDINGS.
 *
 * Each block below reproduces one confirmed defect the adversarial backend
 * review found. Every assertion here was RED before the corresponding fix and
 * green after — that order matters more than the count, because a test written
 * after the fix only proves the code does what it does.
 *
 * The findings share one shape: a rule was implemented correctly in the place
 * everybody looks, and not implemented in the places nobody looks. Soft delete
 * was complete for reservations and absent for customers. Scope was checked in
 * `get` and skipped in `update`. The counts on the inspector were computed
 * without the scope the list underneath it applies.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const domain = require('../../src/main/services/domain');
const { today, addDays } = require('../../src/shared/contracts/dates');

/** Run something expected to fail; return the error code, or null if it did not. */
function denial(fn) {
  try { fn(); return null; } catch (err) { return err.code || 'THREW'; }
}

module.exports = async function () {
  const s = new Suite('database/review-findings');
  const app = new TestApp('mmh-review');

  try {
    await app.bootstrapAdmin();
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'KEREM SARICICEK' });
    const admin = app.ctx();

    /* ============================================================ FINDING 1
     * A refusal must not say WHY. `get` answered NOT_FOUND for anything a
     * marketer could not see; `update` and `cancel` branched on the row's
     * lifecycle first, so the error message told the caller whether an id they
     * had no access to was nonexistent, deleted, cancelled or live. Four
     * distinguishable answers is an enumeration oracle over the whole table.
     */
    const foreign = {};
    foreign.live = reservations.create(admin, {
      customerId: customers.create(admin, { code: 'F-LIVE', fullName: 'FOREIGN LIVE', registered: true, marketingProfileId: kerem.profileId }).id,
      checkIn: addDays(today(), 40), checkOut: addDays(today(), 42), invitedByProfileId: kerem.profileId,
    }).id;
    const cancelledGuest = customers.create(admin, { code: 'F-CANC', fullName: 'FOREIGN CANCELLED', registered: true, marketingProfileId: kerem.profileId });
    foreign.cancelled = reservations.create(admin, {
      customerId: cancelledGuest.id, checkIn: addDays(today(), 50), checkOut: addDays(today(), 52),
      invitedByProfileId: kerem.profileId,
    }).id;
    reservations.cancel(admin, { id: foreign.cancelled, reason: 'Guest changed plans' });
    const deletedGuest = customers.create(admin, { code: 'F-DEL', fullName: 'FOREIGN DELETED', registered: true, marketingProfileId: kerem.profileId });
    foreign.deleted = reservations.create(admin, {
      customerId: deletedGuest.id, checkIn: addDays(today(), 60), checkOut: addDays(today(), 62),
      invitedByProfileId: kerem.profileId,
    }).id;
    reservations.remove(admin, { id: foreign.deleted, reason: 'Entered against the wrong guest' });

    await app.login('sena', sena.password);
    const m = app.ctx();
    const NONEXISTENT = 999999;

    const updateAnswers = {
      nonexistent: denial(() => reservations.update(m, { id: NONEXISTENT, checkIn: addDays(today(), 5), checkOut: addDays(today(), 6) })),
      live: denial(() => reservations.update(m, { id: foreign.live, checkIn: addDays(today(), 5), checkOut: addDays(today(), 6) })),
      cancelled: denial(() => reservations.update(m, { id: foreign.cancelled, checkIn: addDays(today(), 5), checkOut: addDays(today(), 6) })),
      deleted: denial(() => reservations.update(m, { id: foreign.deleted, checkIn: addDays(today(), 5), checkOut: addDays(today(), 6) })),
    };
    s.check('every foreign reservation id is refused by update',
      Object.values(updateAnswers).every((c) => c !== null), JSON.stringify(updateAnswers));
    s.check('update cannot be used to tell a deleted reservation from a nonexistent one',
      updateAnswers.deleted === updateAnswers.nonexistent, JSON.stringify(updateAnswers));
    s.check('update cannot be used to tell a cancelled reservation from a live one',
      updateAnswers.cancelled === updateAnswers.live, JSON.stringify(updateAnswers));

    const cancelAnswers = {
      nonexistent: denial(() => reservations.cancel(m, { id: NONEXISTENT, reason: 'x' })),
      live: denial(() => reservations.cancel(m, { id: foreign.live, reason: 'x' })),
      cancelled: denial(() => reservations.cancel(m, { id: foreign.cancelled, reason: 'x' })),
      deleted: denial(() => reservations.cancel(m, { id: foreign.deleted, reason: 'x' })),
    };
    s.check('every foreign reservation id is refused by cancel',
      Object.values(cancelAnswers).every((c) => c !== null), JSON.stringify(cancelAnswers));
    s.check('cancel cannot be used to tell a deleted reservation from a nonexistent one',
      cancelAnswers.deleted === cancelAnswers.nonexistent, JSON.stringify(cancelAnswers));
    s.check('cancel cannot be used to tell a cancelled reservation from a live one',
      cancelAnswers.cancelled === cancelAnswers.live, JSON.stringify(cancelAnswers));

    /* The deleted id must be indistinguishable from a nonexistent one across
       EVERY verb that takes an id, not just the two the review happened to
       probe. */
    const acrossVerbs = {
      get: [denial(() => reservations.get(m, { id: foreign.deleted })), denial(() => reservations.get(m, { id: NONEXISTENT }))],
      update: [updateAnswers.deleted, updateAnswers.nonexistent],
      cancel: [cancelAnswers.deleted, cancelAnswers.nonexistent],
    };
    for (const [verb, [deletedCode, missingCode]] of Object.entries(acrossVerbs)) {
      s.check(`${verb} gives a deleted id the same answer as a nonexistent one`,
        deletedCode === missingCode, `${verb}: deleted=${deletedCode} nonexistent=${missingCode}`);
    }

    /* ============================================================ FINDING 2
     * Ownership derived from a booking must not outlive the booking. When the
     * only qualifying reservation is deleted there is nothing left in the
     * database that explains why the guest belongs to anybody — but the guest
     * stayed assigned, so the profile card's customer count and reservation
     * count disagreed and the marketer kept access to a record with no reason.
     */
    await app.loginAdmin();
    const derived = customers.create(admin, { code: 'D-1', fullName: 'DERIVED OWNER GUEST', registered: true });
    s.check('a new guest starts unowned',
      customers.get(app.ctx(), { id: derived.id }).marketing_profile_id === null);

    const derivedRes = reservations.create(app.ctx(), {
      customerId: derived.id, checkIn: addDays(today(), -30), checkOut: addDays(today(), -28),
      invitedByProfileId: kerem.profileId,
    }).id;
    s.check('a booking derives ownership to whoever invited it',
      customers.get(app.ctx(), { id: derived.id }).marketing_profile_id === kerem.profileId);

    const cardBefore = support.profiles.list(app.ctx(), {}).find((p) => p.id === kerem.profileId);
    reservations.remove(app.ctx(), { id: derivedRes, reason: 'Booked against the wrong guest' });
    const afterDelete = customers.get(app.ctx(), { id: derived.id });
    s.check('deleting the only booking that derived ownership releases the guest',
      afterDelete.marketing_profile_id === null, `still owned by ${afterDelete.marketing_profile_id}`);

    /* The two figures on the profile card must move together. Before the fix
       the reservation count dropped and the guest count did not, so the card
       claimed a guest whose presence nothing in the database explained. */
    const cardAfter = support.profiles.list(app.ctx(), {}).find((p) => p.id === kerem.profileId);
    s.check('the profile card stops counting a guest whose only booking was deleted',
      cardAfter.customer_count === cardBefore.customer_count - 1,
      `customers ${cardBefore.customer_count} → ${cardAfter.customer_count}`);
    s.check('and its reservation count fell by exactly the deleted booking',
      cardAfter.reservation_count === cardBefore.reservation_count - 1,
      `reservations ${cardBefore.reservation_count} → ${cardAfter.reservation_count}`);

    /* An EXPLICIT assignment is a management decision and must survive the
       deletion of any booking — this is the line between inference and intent. */
    const explicit = customers.create(app.ctx(), { code: 'D-2', fullName: 'EXPLICITLY ASSIGNED', registered: true });
    customers.assign(app.ctx(), { id: explicit.id, profileId: sena.profileId });
    const explicitRes = reservations.create(app.ctx(), {
      customerId: explicit.id, checkIn: addDays(today(), -20), checkOut: addDays(today(), -18),
      invitedByProfileId: sena.profileId,
    }).id;
    reservations.remove(app.ctx(), { id: explicitRes, reason: 'Duplicate entry' });
    s.check('an explicit assignment survives deletion of the booking',
      customers.get(app.ctx(), { id: explicit.id }).marketing_profile_id === sena.profileId);

    /* ============================================================ FINDING 3
     * Soft delete was complete for reservations and absent for customers. An
     * archived guest vanished from the guest list while their name, Guest ID
     * and dates went on being rendered by the reservation list, both calendar
     * views and the CSV export — every one of them a dead link, because
     * customers.get on the id those rows carry answers NOT_FOUND.
     */
    const archived = customers.create(app.ctx(), {
      code: 'ARCH-1', fullName: 'ARCHIVED GUEST', registered: true, marketingProfileId: sena.profileId,
    });
    const archivedStay = addDays(today(), 21);
    reservations.create(app.ctx(), {
      customerId: archived.id, checkIn: archivedStay, checkOut: addDays(archivedStay, 2),
      invitedByProfileId: sena.profileId,
    });
    const beforeArchive = support.dashboard.load(app.ctx(), { periodDays: 30 }).stats;
    customers.remove(app.ctx(), { id: archived.id });

    s.check('an archived guest is gone from the guest list',
      denial(() => customers.get(app.ctx(), { id: archived.id })) === 'NOT_FOUND');
    const afterArchive = support.dashboard.load(app.ctx(), { periodDays: 30 }).stats;
    s.check('archiving a guest drops the guest count',
      afterArchive.totalGuests === beforeArchive.totalGuests - 1,
      `${beforeArchive.totalGuests} → ${afterArchive.totalGuests}`);
    s.check('their upcoming stay stops counting toward the upcoming KPI',
      afterArchive.upcomingIn === beforeArchive.upcomingIn - 1,
      `${beforeArchive.upcomingIn} → ${afterArchive.upcomingIn}`);

    const listed = reservations.list(app.ctx(), { pageSize: 500 }).rows;
    s.check('their reservation is gone from the reservation list',
      !listed.some((r) => r.customer_id === archived.id),
      JSON.stringify(listed.filter((r) => r.customer_id === archived.id).map((r) => r.customer_name)));

    const [ay, am] = archivedStay.split('-').map(Number);
    const monthBuckets = support.calendar.month(app.ctx(), { year: ay, month: am }).buckets;
    s.check('their stay is gone from the calendar month view',
      !monthBuckets[archivedStay] || monthBuckets[archivedStay].arrivals === 0,
      JSON.stringify(monthBuckets[archivedStay] || {}));
    const dayView = support.calendar.day(app.ctx(), { date: archivedStay });
    s.check('their stay is gone from the calendar day view',
      !dayView.arrivals.some((r) => r.customer_id === archived.id),
      JSON.stringify(dayView.arrivals.map((r) => r.customer_name)));

    const exporter = require('../../src/main/services/export-service').build({ dialog: null, getWindow: () => null });
    const guestCsv = exporter.render(app.ctx(), { entity: 'customerlist', params: {} });
    s.check('an archived guest is not exported in the guest report',
      !guestCsv.csv.includes('ARCHIVED GUEST'));
    const stayCsv = exporter.render(app.ctx(), { entity: 'reservations', params: {} });
    s.check('their stay is not exported in the reservation report',
      !stayCsv.csv.includes('ARCHIVED GUEST'));

    /* No verb may still be operating on a booking whose guest no longer
       exists — that is how a dead link becomes a write. */
    const archivedResId = app.db.prepare('SELECT id FROM reservations WHERE customer_id = ?').get(archived.id).id;
    s.check('a reservation for an archived guest cannot be read',
      denial(() => reservations.get(app.ctx(), { id: archivedResId })) === 'NOT_FOUND');
    s.check('a reservation for an archived guest cannot be edited',
      denial(() => reservations.update(app.ctx(), { id: archivedResId, checkIn: addDays(today(), 30), checkOut: addDays(today(), 31) })) !== null);

    /* And the row itself is still there — archiving a guest is not a way to
       destroy reservation history. */
    s.check('the reservation row itself still exists in the database',
      app.db.prepare('SELECT COUNT(*) n FROM reservations WHERE customer_id = ?').get(archived.id).n === 1);

    /* ============================================================ FINDING 4
     * The guest inspector's headline figures — total stays, last visit, next
     * visit — cover the guest's WHOLE history. That is not an accident of the
     * migration: the prototype's own helper is unscoped too, so it is verified
     * baseline behaviour, and it is the right behaviour, because owning a guest
     * is precisely what entitles a marketer to know when that guest last came.
     *
     * The defect was that the stay list rendered underneath those figures was
     * scoped by who INVITED each booking, so the panel said three and the list
     * below it showed one. Same screen, two numbers, no explanation — the
     * "count says 12, list shows 9" class this product already fixed once.
     *
     * The fix is on the list side: asking about ONE named guest asks about the
     * guest, and reaching that branch already requires being allowed to read
     * them in full.
     */
    const shared = customers.create(app.ctx(), {
      code: 'SH-1', fullName: 'SHARED GUEST', registered: true, marketingProfileId: kerem.profileId,
    });
    /* Kerem's own booking is the NEWEST, so ownership stays derived to him
       while two older stays were invited by somebody else. */
    for (const [offset, profileId] of [[-60, sena.profileId], [-50, sena.profileId], [-10, kerem.profileId]]) {
      reservations.create(app.ctx(), {
        customerId: shared.id, checkIn: addDays(today(), offset), checkOut: addDays(today(), offset + 1),
        invitedByProfileId: profileId,
      });
    }

    await app.login('kerem', kerem.password);
    const k = app.ctx();
    const inspector = customers.get(k, { id: shared.id });
    const theirStays = reservations.list(k, { customerId: shared.id, pageSize: 100 });
    s.check('the guest inspector reports the whole history, as it always has',
      inspector.reservation_count === 3, String(inspector.reservation_count));
    s.check('the stay list under it agrees with that count',
      theirStays.total === inspector.reservation_count,
      `inspector says ${inspector.reservation_count}, list shows ${theirStays.total}`);
    s.check('and shows the stays other marketers invited, because the guest is theirs',
      theirStays.rows.some((r) => r.invited_by_profile_id === sena.profileId),
      JSON.stringify(theirStays.rows.map((r) => r.invited_by_profile_id)));

    /* Widening applies ONLY to a named guest in scope. The unfiltered list is
       still "my invitations", and a guest outside the book is still refused. */
    const myInvitations = reservations.list(k, { pageSize: 100 });
    s.check('the unfiltered reservation list is still scoped to my own invitations',
      myInvitations.rows.every((r) => r.invited_by_profile_id === kerem.profileId),
      JSON.stringify(myInvitations.rows.map((r) => r.invited_by_profile_id)));
    s.check('and naming a guest outside my book is still refused',
      denial(() => reservations.list(k, { customerId: explicit.id, pageSize: 10 })) !== null);
    s.check('naming a guest that does not exist is refused too',
      denial(() => reservations.list(k, { customerId: 999999, pageSize: 10 })) !== null);

    /* Management sees the whole guest, because management has no scope. */
    await app.loginAdmin();
    const full = customers.get(app.ctx(), { id: shared.id });
    s.check('an administrator sees the same three stays',
      full.reservation_count === 3, String(full.reservation_count));
    s.check('and the same last visit as the owner does',
      full.last_visit === inspector.last_visit, `${full.last_visit} vs ${inspector.last_visit}`);

    /* ============================================================ FINDING 5
     * A marketer can see that colleagues exist. A marketer must not be handed
     * a colleague's passport number, phone, email or the free-text note where
     * management records that somebody is on a final written warning.
     */
    app.db.prepare(`UPDATE profiles SET passport_no = ?, phone = ?, email = ?, notes = ? WHERE id = ?`)
      .run('U1234567', '+90 555 000 00 00', 'kerem@example.com', 'On a final written warning', kerem.profileId);

    await app.login('sena', sena.password);
    const colleague = support.profiles.get(app.ctx(), { id: kerem.profileId });
    const SENSITIVE = ['passport_no', 'phone', 'email', 'notes', 'salary', 'national_id'];
    const leaked = SENSITIVE.filter((f) => colleague[f] !== undefined && colleague[f] !== null);
    s.check('a colleague profile discloses no personal or employment detail',
      leaked.length === 0, `leaked: ${leaked.join(', ')} = ${JSON.stringify(leaked.map((f) => colleague[f]))}`);
    s.check('but the colleague is still visible as a name',
      colleague.full_name === 'KEREM SARICICEK', JSON.stringify(colleague.full_name));

    const listedProfiles = support.profiles.list(app.ctx(), {});
    const leakedInList = listedProfiles.flatMap((p) => SENSITIVE.filter((f) => p[f] !== undefined && p[f] !== null));
    s.check('the profile list discloses nothing personal either',
      leakedInList.length === 0, leakedInList.join(', '));

    const profileCsv = exporter.render(app.ctx(), { entity: 'profiles', params: {} });
    s.check('and neither does the exported profile report',
      !profileCsv.csv.includes('U1234567') && !profileCsv.csv.includes('final written warning'),
      profileCsv.csv.slice(0, 300));

    /* Management is who those fields exist for. */
    await app.loginAdmin();
    const asAdmin = support.profiles.get(app.ctx(), { id: kerem.profileId });
    s.check('an administrator still sees the profile detail',
      asAdmin.passport_no === 'U1234567' && asAdmin.notes === 'On a final written warning',
      JSON.stringify({ passport: asAdmin.passport_no, notes: asAdmin.notes }));

    /* ============================================================ FINDING 8
     * Archiving a guest kept their Guest ID reserved forever, and the attempt
     * to reuse it surfaced as a raw SQLite UNIQUE-constraint failure — which
     * the IPC layer turns into "An unexpected error occurred" with no field
     * highlighted and no way for the operator to proceed.
     */
    const reuse = denial(() => customers.create(app.ctx(), {
      code: 'ARCH-1', fullName: 'SOMEBODY ELSE', registered: true,
    }));
    s.check('reusing an archived Guest ID fails as a validation error, not an internal one',
      reuse === 'VALIDATION', String(reuse));
    let reuseError = null;
    try { customers.create(app.ctx(), { code: 'ARCH-1', fullName: 'SOMEBODY ELSE', registered: true }); }
    catch (err) { reuseError = err; }
    s.check('and names the field the operator must change',
      reuseError && reuseError.field === 'code', String(reuseError && reuseError.field));
    s.check('and says why, in words an operator can act on',
      /archiv/i.test(reuseError.message), reuseError.message);

    /* ============================================================ FINDING 11
     * A booking conflict tells the caller which dates clash. When the clashing
     * stay belongs to a marketer the caller cannot see, the conflict details
     * disclosed its id and exact dates — a record `reservations.list`
     * deliberately hides from them.
     */
    const lapsed = customers.create(app.ctx(), { code: 'LAPSE-1', fullName: 'LAPSED PROTECTION GUEST', registered: true });
    reservations.create(app.ctx(), {
      customerId: lapsed.id, checkIn: addDays(today(), -900), checkOut: addDays(today(), -896),
      invitedByProfileId: kerem.profileId,
    });
    await app.login('sena', sena.password);
    let conflictError = null;
    try {
      reservations.create(app.ctx(), {
        customerId: lapsed.id, checkIn: addDays(today(), -899), checkOut: addDays(today(), -897),
      });
    } catch (err) { conflictError = err; }
    s.check('booking over an out-of-scope stay still reports a conflict',
      conflictError && conflictError.code === 'CONFLICT', String(conflictError && conflictError.code));
    const conflicts = (conflictError.details && conflictError.details.conflicts) || [];
    s.check('but the conflict discloses no id or dates from a stay the caller cannot see',
      conflicts.length === 0, JSON.stringify(conflictError.details));

    /* In scope, the operator still gets what they need to resolve it. */
    await app.loginAdmin();
    let ownConflict = null;
    try {
      reservations.create(app.ctx(), {
        customerId: lapsed.id, checkIn: addDays(today(), -899), checkOut: addDays(today(), -897),
      });
    } catch (err) { ownConflict = err; }
    s.check('an administrator still sees the clashing dates',
      ownConflict.details.conflicts.length === 1
      && ownConflict.details.conflicts[0].check_in === addDays(today(), -900),
      JSON.stringify(ownConflict.details.conflicts));

    /* ============================================================ FINDING 12
     * `photos.remove` checked the capability and never the record, so a
     * marketer holding customers.update could delete the photo of a guest they
     * are not permitted to read.
     */
    const photos = require('../../src/main/services/photo-service')
      .build({ dialog: null, paths: app.paths, getWindow: () => null });
    const foreignGuest = customers.create(app.ctx(), {
      code: 'PH-1', fullName: 'PHOTO GUEST', registered: true, marketingProfileId: kerem.profileId,
    });
    const fs = require('fs');
    const path = require('path');
    const photoName = 'photo_1700000000_abcdef123456.jpg';
    fs.writeFileSync(path.join(app.paths.photos, photoName), Buffer.from([0xff, 0xd8, 0xff]));
    app.db.prepare(`INSERT INTO photos (name, mime_type, byte_size, created_at, created_by)
                    VALUES (?, 'image/jpeg', 3, ?, 1)`).run(photoName, new Date().toISOString());
    app.db.prepare('UPDATE customers SET photo_name = ? WHERE id = ?').run(photoName, foreignGuest.id);

    await app.login('sena', sena.password);
    const removal = denial(() => photos.remove(app.ctx(), { customerId: foreignGuest.id, name: photoName }));
    s.check('a marketer cannot delete the photo of a guest outside their scope',
      removal !== null, String(removal));
    s.check('and the file is still on disk',
      fs.existsSync(path.join(app.paths.photos, photoName)));

    /* Removing one's own guest photo also clears the reference, so the record
       does not keep pointing at a file that is gone. */
    await app.loginAdmin();
    photos.remove(app.ctx(), { customerId: foreignGuest.id, name: photoName });
    s.check('removing a photo clears the reference on the guest',
      app.db.prepare('SELECT photo_name FROM customers WHERE id = ?').get(foreignGuest.id).photo_name === null);
    s.check('and deletes the file', !fs.existsSync(path.join(app.paths.photos, photoName)));
  } finally {
    app.close();
  }

  return s.finish();
};
