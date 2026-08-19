'use strict';
/* Domain rules, tested as pure functions.
 *
 * These are the same rules the 529-assertion browser baseline verified through
 * the UI and the API. Testing them directly means a rule change is caught here,
 * in one line of output, instead of as a mysterious KPI discrepancy later.
 */

const { Suite } = require('../lib/harness');
const d = require('../../src/main/services/domain');
const { today, addDays, addYears } = require('../../src/shared/contracts/dates');

module.exports = async function () {
  const s = new Suite('database/domain-rules');

  const day = (n) => addDays(today(), n);
  const res = (over = {}) => ({
    check_in: day(10), check_out: day(12), cancelled_at: null, deleted_at: null,
    invited_by_profile_id: 1, created_at: '2026-01-01T00:00:00.000Z', ...over,
  });

  // ------------------------------------------------------------- lifecycle
  s.check('a future stay is UPCOMING', d.reservationStatus(res()) === 'UPCOMING');
  s.check('a stay spanning today is CHECKED_IN',
    d.reservationStatus(res({ check_in: day(-1), check_out: day(2) })) === 'CHECKED_IN');
  s.check('a past stay is COMPLETED',
    d.reservationStatus(res({ check_in: day(-9), check_out: day(-7) })) === 'COMPLETED');
  s.check('a cancelled stay is CANCELLED',
    d.reservationStatus(res({ cancelled_at: 'x' })) === 'CANCELLED');
  s.check('a deleted stay is DELETED',
    d.reservationStatus(res({ deleted_at: 'x' })) === 'DELETED');
  s.check('DELETED outranks CANCELLED, so a cancelled-then-deleted stay is not in both lists',
    d.reservationStatus(res({ cancelled_at: 'x', deleted_at: 'y' })) === 'DELETED');

  s.check('a plain stay qualifies as activity', d.isQualifying(res()));
  s.check('a cancelled stay does not qualify', !d.isQualifying(res({ cancelled_at: 'x' })));
  s.check('a deleted stay does not qualify', !d.isQualifying(res({ deleted_at: 'x' })));
  s.check('a cancelled stay is still operational history', d.isOperational(res({ cancelled_at: 'x' })));
  s.check('a deleted stay is not operational history', !d.isOperational(res({ deleted_at: 'x' })));

  // ------------------------------------------------------------- ownership
  const customer = (over = {}) => ({ id: 1, registered: 1, marketing_profile_id: 7, ...over });

  s.check('current assignment is the effective owner',
    d.effectiveOwnerProfileId(customer(), []) === 7);
  s.check('with no assignment the inviter on the latest qualifying stay owns the guest',
    d.effectiveOwnerProfileId(customer({ marketing_profile_id: null }), [res({ invited_by_profile_id: 3 })]) === 3);
  s.check('a deleted stay cannot make someone the effective owner',
    d.effectiveOwnerProfileId(customer({ marketing_profile_id: null }), [res({ invited_by_profile_id: 3, deleted_at: 'x' })]) === null);

  const explicitAt = (iso) => ({ event_type: 'explicit', new_profile_id: 7, changed_at: iso });
  const derivedAt = (iso) => ({ event_type: 'derived', new_profile_id: 7, changed_at: iso });

  s.check('only explicit assignments anchor the protection clock',
    d.lastExplicitAssignmentDate([derivedAt('2026-08-01T00:00:00Z')]) === null);
  s.check('the latest explicit assignment is the anchor',
    d.lastExplicitAssignmentDate([explicitAt('2025-01-01T00:00:00Z'), derivedAt('2026-08-01T00:00:00Z'), explicitAt('2026-03-04T00:00:00Z')]) === '2026-03-04');

  // ------------------------------------------------------------ protection
  const protectedFrom = (opts) => d.isProtectedFrom({ profileId: 99, ...opts });

  s.check('a guest with a recent stay is protected from another marketer',
    protectedFrom({ customer: customer(), qualifyingReservations: [res({ check_in: day(-90) })] }));
  s.check('a guest is never protected from their own owner',
    !d.isProtectedFrom({ customer: customer(), qualifyingReservations: [res({ check_in: day(-90) })], profileId: 7 }));
  s.check('a never-visited but explicitly assigned guest is protected',
    protectedFrom({ customer: customer(), qualifyingReservations: [], assignmentHistory: [explicitAt(new Date().toISOString())] }));
  s.check('a guest with no owner and no history is not protected',
    !protectedFrom({ customer: customer({ marketing_profile_id: null }), qualifyingReservations: [] }));
  s.check('a cancelled-only booking does not lock the guest',
    !protectedFrom({ customer: customer({ marketing_profile_id: null }), qualifyingReservations: [res({ cancelled_at: 'x' })] }));
  s.check('a DELETED booking does not extend protection',
    !protectedFrom({ customer: customer({ marketing_profile_id: null }), qualifyingReservations: [res({ deleted_at: 'x' })] }));
  s.check('protection expires a year after the last qualifying stay',
    !protectedFrom({ customer: customer(), qualifyingReservations: [res({ check_in: addDays(today(), -370), check_out: addDays(today(), -368) })] }));
  s.check('two days inside the year is still protected',
    protectedFrom({ customer: customer(), qualifyingReservations: [res({ check_in: addDays(addYears(today(), -1), 2), check_out: addDays(addYears(today(), -1), 4) })] }));

  // -------------------------------------------------- ownership derivation
  const derive = (opts) => d.shouldDeriveOwnership(opts);
  s.check('a booking with no inviter derives nothing',
    !derive({ customer: customer(), newestQualifying: res({ invited_by_profile_id: null }) }));
  s.check('with no explicit history, a booking derives ownership',
    derive({ customer: customer(), newestQualifying: res({ invited_by_profile_id: 3 }), assignmentHistory: [] }));
  s.check('a booking predating a manager\'s reassignment must not undo it',
    !derive({
      customer: customer(),
      newestQualifying: res({ invited_by_profile_id: 3, created_at: '2026-01-01T00:00:00.000Z' }),
      assignmentHistory: [{ event_type: 'explicit', new_profile_id: 7, changed_at: '2026-06-01T00:00:00.000Z' }],
    }));
  s.check('a booking made AFTER the reassignment does move ownership (no strand)',
    derive({
      customer: customer(),
      newestQualifying: res({ invited_by_profile_id: 3, created_at: '2026-09-01T00:00:00.000Z' }),
      assignmentHistory: [{ event_type: 'explicit', new_profile_id: 7, changed_at: '2026-06-01T00:00:00.000Z' }],
    }));
  s.check('a derived event never freezes ownership against future derivation',
    derive({
      customer: customer(),
      newestQualifying: res({ invited_by_profile_id: 3, created_at: '2026-01-01T00:00:00.000Z' }),
      assignmentHistory: [{ event_type: 'derived', new_profile_id: 7, changed_at: '2026-06-01T00:00:00.000Z' }],
    }));

  // ---------------------------------------------------------- guest status
  s.check('a registered guest with nothing at all is NO_RECORD',
    d.customerStatus({ registered: 1, qualifyingReservationCount: 0, noteCount: 0 }) === 'NO_RECORD');
  s.check('a CRM note alone lifts a guest out of NO_RECORD',
    d.customerStatus({ registered: 1, qualifyingReservationCount: 0, noteCount: 1, lastNoteDate: today() }) === 'ACTIVE');
  s.check('an UNREGISTERED lead has no status badge at all',
    d.customerStatus({ registered: 0, qualifyingReservationCount: 0, noteCount: 0 }) === null);
  s.check('a stay within 90 days is ACTIVE',
    d.customerStatus({ registered: 1, qualifyingReservationCount: 1, noteCount: 0, lastVisit: day(-10) }) === 'ACTIVE');
  s.check('a stay older than 90 days is COLD',
    d.customerStatus({ registered: 1, qualifyingReservationCount: 1, noteCount: 0, lastVisit: day(-120) }) === 'COLD');
  s.check('an upcoming stay keeps a guest ACTIVE',
    d.customerStatus({ registered: 1, qualifyingReservationCount: 1, noteCount: 0, lastVisit: day(-400), nextVisit: day(20) }) === 'ACTIVE');

  // -------------------------------------------------------------- calendar
  const stay = res({ check_in: '2027-08-15', check_out: '2027-08-18' });
  s.check('check-in day is an arrival', d.calendarBucket(stay, '2027-08-15') === 'arrival');
  s.check('a middle day is in-house', d.calendarBucket(stay, '2027-08-16') === 'active');
  s.check('check-out day is a departure', d.calendarBucket(stay, '2027-08-18') === 'departure');
  s.check('a day outside the stay is in no bucket', d.calendarBucket(stay, '2027-08-20') === null);
  s.check('a deleted stay occupies no calendar bucket',
    d.calendarBucket({ ...stay, deleted_at: 'x' }, '2027-08-15') === null);
  s.check('a cancelled stay occupies no calendar bucket',
    d.calendarBucket({ ...stay, cancelled_at: 'x' }, '2027-08-15') === null);

  // ----------------------------------------------------------------- scope
  s.check('ADMIN is unrestricted', d.scopeProfileId({ role: 'ADMIN' }) === null);
  s.check('MANAGER is unrestricted', d.scopeProfileId({ role: 'MANAGER' }) === null);
  s.check('MARKETING is narrowed to its own profile',
    d.scopeProfileId({ role: 'MARKETING', profile_id: 5 }) === 5);
  s.check('a MARKETING session with no profile fails closed, matching nothing',
    d.scopeProfileId({ role: 'MARKETING' }) === -1);
  s.check('no session at all fails closed', d.scopeProfileId(null) === -1);
  s.check('MARKETING cannot see deleted history', !d.canSeeDeleted({ role: 'MARKETING' }));
  s.check('MANAGER can see deleted history', d.canSeeDeleted({ role: 'MANAGER' }));
  s.check('ADMIN can see deleted history', d.canSeeDeleted({ role: 'ADMIN' }));

  return s.finish();
};
