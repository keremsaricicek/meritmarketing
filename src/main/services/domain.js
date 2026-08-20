'use strict';
/* THE BUSINESS RULES. One implementation, used by every screen.
 *
 * These are pure functions over plain rows. They touch no database and no
 * session, which is what makes them testable in isolation and what stops
 * Dashboard, Reports, Customer List and Calendar from each inventing their own
 * slightly different answer to the same question — the failure that produced
 * the original "No Record says 12, the list shows 9" defect.
 *
 * Every rule here was verified against the 529-assertion browser baseline and
 * must keep behaving identically, with exactly one deliberate addition: a
 * DELETED reservation is excluded from all operational meaning.
 */

const { today, addYears, daysSince, instantToBusinessDate } = require('../../shared/contracts/dates');

const PROTECTION_YEARS = 1;
const COLD_AFTER_DAYS = 90;

/* --------------------------------------------------------- reservations */

/* Lifecycle is derived, never stored as a client-settable string.
   DELETED outranks CANCELLED: a cancelled booking that is later deleted is
   deleted history, and must not appear in the Cancelled list as well. */
function reservationStatus(r, ref = today()) {
  if (!r) return null;
  if (r.deleted_at) return 'DELETED';
  if (r.cancelled_at) return 'CANCELLED';
  if (r.check_out < ref) return 'COMPLETED';
  if (r.check_in > ref) return 'UPCOMING';
  return 'CHECKED_IN';
}

const isDeleted = (r) => !!(r && r.deleted_at);
const isCancelled = (r) => !!(r && r.cancelled_at && !r.deleted_at);

/* A QUALIFYING reservation is one that still counts as real activity: it was
   not cancelled and it was not deleted. This single predicate is what keeps
   "Last Visit", "No Record", "Cold", protection and the KPIs agreeing with each
   other. Historical totals are a different question — see counts below. */
const isQualifying = (r) => !!r && !r.cancelled_at && !r.deleted_at;

/* Operational visibility: everything except deleted. Cancelled rows are still
   operationally interesting (they have their own tab), deleted ones are not. */
const isOperational = (r) => !!r && !r.deleted_at;

/* ------------------------------------------------------------ ownership */

/* Who the guest belongs to for protection purposes.
   Normally the current assignment — but ownership is nulled when the owning
   profile is deactivated, and a guest with a real recent stay is still
   somebody's guest. Falling back to the inviter on the latest qualifying stay
   stops protection evaporating the moment a profile is switched off. */
function effectiveOwnerProfileId(customer, qualifyingReservationsNewestFirst = []) {
  if (!customer) return null;
  if (customer.marketing_profile_id) return customer.marketing_profile_id;
  const newest = qualifyingReservationsNewestFirst.find(isQualifying);
  return (newest && newest.invited_by_profile_id) || null;
}

/* The latest qualifying stay, as a business date. */
function latestQualifyingVisit(qualifyingReservationsNewestFirst = []) {
  const r = qualifyingReservationsNewestFirst.find(isQualifying);
  return r ? r.check_in : null;
}

/* Only a DELIBERATE assignment anchors the protection clock.
   The system also writes history when a booking implies an owner, stamped with
   the moment the row was written rather than the date of the stay. Counting
   those would restart the one-year window on every booking — including one
   cancelled seconds later — permanently locking a guest to whoever invited them
   first. */
function lastExplicitAssignmentDate(assignmentHistoryOldestFirst = []) {
  const explicit = assignmentHistoryOldestFirst.filter((h) => h.event_type === 'explicit');
  if (!explicit.length) return null;
  const at = explicit[explicit.length - 1].changed_at;
  /* `changed_at` is a system instant in UTC; the protection clock runs in
     business dates. Slicing the first ten characters silently answers "what
     date was this in UTC", which is a different day from the operator's for
     every decision made between midnight and the UTC offset — the whole of the
     early shift in Turkey (UTC+3). */
  return instantToBusinessDate(at);
}

/* Protection runs for one year from whichever came later: the latest qualifying
   visit, or the explicit assignment that created the relationship. Anchoring on
   the visit alone leaves a never-visited assigned guest unprotected; anchoring
   on assignment alone strands a guest nobody can ever take over. */
function protectionExpiry({ customer, qualifyingReservations = [], assignmentHistory = [] }) {
  if (!effectiveOwnerProfileId(customer, qualifyingReservations)) return null;
  const visit = latestQualifyingVisit(qualifyingReservations);
  const assigned = lastExplicitAssignmentDate(assignmentHistory);
  const anchor = [visit, assigned].filter(Boolean).sort().pop();
  return anchor ? addYears(anchor, PROTECTION_YEARS) : null;
}

/* Is this guest protected AGAINST the given marketing profile?
   Never against their own owner, and never once the window has passed. */
function isProtectedFrom({ customer, qualifyingReservations = [], assignmentHistory = [], profileId }) {
  const owner = effectiveOwnerProfileId(customer, qualifyingReservations);
  if (!owner || owner === profileId) return false;
  const expiry = protectionExpiry({ customer, qualifyingReservations, assignmentHistory });
  return !!expiry && today() <= expiry;
}

/* Should a booking cause ownership to move to whoever invited it?
 *
 * A manager's reassignment overrides the bookings that ALREADY EXISTED when
 * they made it — otherwise the next sync hands the guest straight back to
 * whoever invited them originally, silently undoing the decision. It must NOT
 * override bookings made afterwards: once protection lapses and a different
 * marketer is allowed to book, that booking is the signal ownership should
 * follow, and without this the guest is stranded — the new marketer holds a
 * reservation for a record they cannot read.
 *
 * Comparing booking time to decision time is what separates the two. Asking
 * "is protection live?" cannot, because this runs after the new reservation is
 * already stored, so the booking would itself re-establish the window.
 */
function shouldDeriveOwnership({ customer, newestQualifying, assignmentHistory = [] }) {
  if (!newestQualifying || !newestQualifying.invited_by_profile_id) {
    /* Nothing qualifying is left — the last booking was deleted or cancelled.
       Ownership that was INFERRED from a booking has to fall away with it,
       otherwise the guest stays assigned with nothing in the database left to
       explain why, and the owning profile's guest count and reservation count
       stop agreeing about the same person.

       A management DECISION is the opposite case: it was made deliberately and
       does not stop being true because a booking was removed. So the last
       history entry decides — inference releases, intent survives. */
    if (!customer.marketing_profile_id) return false;
    const last = assignmentHistory.length ? assignmentHistory[assignmentHistory.length - 1] : null;
    return !!last && last.event_type === 'derived';
  }
  const explicit = assignmentHistory.filter((h) => h.event_type === 'explicit');
  const lastExplicit = explicit.length ? explicit[explicit.length - 1] : null;
  if (!lastExplicit) return true;
  if (newestQualifying.invited_by_profile_id === lastExplicit.new_profile_id) return true;
  if (customer.marketing_profile_id !== lastExplicit.new_profile_id) return true;
  /* Missing timestamps keep the guard, which is the conservative direction. */
  return !!(newestQualifying.created_at && lastExplicit.changed_at
    && newestQualifying.created_at > lastExplicit.changed_at);
}

/* -------------------------------------------------------- guest status */

/* NO RECORD: a registered guest with no qualifying reservation activity and no
   CRM note. The classic defect this guards is the badge being derived from
   cancelled-excluded facts while the KPI counted total historical rows, so a
   guest whose only booking was cancelled showed NO RECORD while being absent
   from the count and the list. */
function isNoRecord({ registered, qualifyingReservationCount, noteCount }) {
  return !!registered && qualifyingReservationCount === 0 && noteCount === 0;
}

/* An UNREGISTERED lead carries no status badge at all — not NO RECORD, not
   COLD, not ACTIVE. Those words describe a guest of the property. */
function customerStatus({ registered, qualifyingReservationCount, noteCount, lastVisit, nextVisit, lastNoteDate }) {
  if (!registered) return null;
  if (isNoRecord({ registered, qualifyingReservationCount, noteCount })) return 'NO_RECORD';
  const ref = nextVisit || lastVisit || lastNoteDate;
  return daysSince(ref) <= COLD_AFTER_DAYS ? 'ACTIVE' : 'COLD';
}

/* ------------------------------------------------------------ calendar */

/* Exclusive buckets. A stay 15th→18th is an arrival on the 15th, in-house on
   the 16th and 17th, and a departure on the 18th — never two of those at once,
   which is what made the day totals disagree with the month view. */
function calendarBucket(r, date) {
  if (!isQualifying(r)) return null;
  if (r.check_in === date) return 'arrival';
  if (r.check_out === date) return 'departure';
  if (r.check_in < date && r.check_out > date) return 'active';
  return null;
}

/* ---------------------------------------------------------------- scope */

/* MARKETING is narrowed to its own profile. ADMIN and MANAGER are unrestricted,
   which is `null` here — NOT "no profile". The `?? -1` is what makes a broken
   MARKETING session match nothing instead of everything. */
function scopeProfileId(session) {
  if (!session) return -1;
  return session.role === 'MARKETING' ? (session.profile_id ?? -1) : null;
}

const customerInScope = (session, customer) => {
  const s = scopeProfileId(session);
  return s === null || (!!customer && customer.marketing_profile_id === s);
};

const reservationInScope = (session, reservation) => {
  const s = scopeProfileId(session);
  return s === null || (!!reservation && reservation.invited_by_profile_id === s);
};

/** May this session see DELETED reservation history at all? */
const canSeeDeleted = (session) => !!session && (session.role === 'ADMIN' || session.role === 'MANAGER');

module.exports = {
  PROTECTION_YEARS, COLD_AFTER_DAYS,
  reservationStatus, isDeleted, isCancelled, isQualifying, isOperational,
  effectiveOwnerProfileId, latestQualifyingVisit, lastExplicitAssignmentDate,
  protectionExpiry, isProtectedFrom, shouldDeriveOwnership,
  isNoRecord, customerStatus,
  calendarBucket,
  scopeProfileId, customerInScope, reservationInScope, canSeeDeleted,
};
