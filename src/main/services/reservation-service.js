'use strict';
/* Reservations, including the non-destructive delete.
 *
 * The rule that shapes this whole file: normal use NEVER removes a reservation
 * row. Deletion sets a tombstone, which keeps the audit trail and the historical
 * attribution intact while removing the booking from every operational
 * calculation. A physically deleted row would take its Invited By history with
 * it, and that history is what the commission conversation runs on.
 */

const repo = require('../repositories/reservations');
const customersRepo = require('../repositories/customers');
const domain = require('./domain');
const guard = require('./guard');
const { nowIso, today, isBusinessDate } = require('../../shared/contracts/dates');
const { validation, conflict, protectedGuest, notFound, forbidden } = require('../../shared/errors');

/** Decorate a row with its derived lifecycle. Status is never stored. */
function decorate(row) {
  if (!row) return null;
  return { ...row, status: domain.reservationStatus(row, today()) };
}

/* ------------------------------------------------------------------ read */

/* Two different questions share this verb, and they take different scopes.
 *
 *   "show me the bookings"          → MY invitations. Scoped by invited_by.
 *   "show me THIS guest's stays"    → the guest's history, all of it.
 *
 * The second is what the guest inspector asks, and the inspector's own headline
 * figures — reservation count, last visit, next visit — have always covered the
 * guest's whole history, in this product and in the one it replaced. Leaving the
 * list beneath them scoped by invited_by produced the exact contradiction this
 * product already fixed once elsewhere: the panel said three stays and the list
 * under it showed one.
 *
 * Widening here discloses nothing new. Reaching this branch at all requires
 * `customerId` to name a guest the caller may already read in full, which the
 * scope check below establishes; a marketer still cannot ask about a guest
 * outside their book.
 */
function list(ctx, params = {}) {
  guard.requireCapability(ctx, 'reservations.read');
  const view = params.view === 'cancelled' ? 'cancelled' : 'active';

  let scope = guard.scopeOf(ctx);
  if (params.customerId) {
    const customer = customersRepo.findById(ctx.db, Number(params.customerId));
    guard.requireCustomerInScope(ctx, customer);
    scope = null;
  }

  const result = repo.list(ctx.db, params, scope, view);
  return { ...result, rows: result.rows.map(decorate) };
}

/* Deleted history is a separate verb, not a `view` parameter on the normal one.
   A parameter is something a client passes; a verb is something a role either
   has or does not. Making it a verb means MARKETING cannot reach it by
   crafting a request, only by being granted a capability they do not have. */
function listDeleted(ctx, params = {}) {
  guard.requireCapability(ctx, 'reservations.read');
  guard.requireDeletedVisible(ctx);
  guard.requireCapability(ctx, 'reservations.deleted.read');
  const result = repo.list(ctx.db, params, guard.scopeOf(ctx), 'deleted');
  return { ...result, rows: result.rows.map(decorate) };
}

/* The single doorway every id-addressed verb goes through.
 *
 * The order of these questions is load-bearing, and getting it wrong is how a
 * refusal turns into an answer. `update` and `cancel` used to test the row's
 * lifecycle BEFORE asking whether the caller could touch the record at all,
 * which meant a marketer walking ids got four distinguishable refusals —
 * nonexistent, deleted, cancelled, live — and could classify every row in the
 * table, including other marketers'. The error message was the leak.
 *
 * So: reachability first (a row the caller may not see is simply not there),
 * then scope, and only then anything about the row's own state.
 */
function requireReachable(ctx, id) {
  const raw = repo.findRaw(ctx.db, Number(id));
  if (!raw) throw notFound('Reservation not found.');

  /* Deleted rows answer "not found" to anyone who may not see deleted history,
     which is the same answer they would get for a nonexistent id. */
  if (raw.deleted_at
      && !(domain.canSeeDeleted(ctx.sessions.get()) && ctx.sessions.can('reservations.deleted.read'))) {
    throw notFound('Reservation not found.');
  }
  /* A booking whose guest has been archived is not operational either. Leaving
     it reachable is what produced rows carrying a guest name and Guest ID that
     `customers.get` answers NOT_FOUND for — a dead link the operator can still
     click, and in the case of `update`, still write through. */
  if (!customersRepo.findById(ctx.db, raw.customer_id)) throw notFound('Reservation not found.');

  guard.requireReservationInScope(ctx, raw);
  return raw;
}

function get(ctx, { id }) {
  guard.requireCapability(ctx, 'reservations.read');
  const raw = requireReachable(ctx, id);
  if (raw.deleted_at) guard.requireCapability(ctx, 'reservations.deleted.read');
  return decorate(repo.findById(ctx.db, Number(id), { includeDeleted: !!raw.deleted_at }));
}

/* --------------------------------------------------------------- mutate */

function validateDates(checkIn, checkOut) {
  if (!isBusinessDate(checkIn)) throw validation('Check-in must be a valid date.', 'checkIn');
  if (!isBusinessDate(checkOut)) throw validation('Check-out must be a valid date.', 'checkOut');
  if (checkOut < checkIn) throw validation('Check-out must be on or after check-in.', 'checkOut');
}

/* Ownership derivation, run inside the caller's transaction after a booking
   changes. Writes an assignment_history row marked 'derived' so the protection
   rule can tell a system inference from a management decision. */
function syncOwnership(ctx, customerId, { reservationId = null, source = 'reservation' } = {}) {
  const customer = customersRepo.findById(ctx.db, customerId);
  if (!customer) return;

  const qualifying = customersRepo.qualifyingFor(ctx.db, customerId);
  const history = customersRepo.assignmentHistory(ctx.db, customerId);
  const newest = qualifying[0] || null;

  if (!domain.shouldDeriveOwnership({ customer, newestQualifying: newest, assignmentHistory: history })) return;

  const profile = newest && newest.invited_by_profile_id
    ? ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(newest.invited_by_profile_id)
    : null;
  /* An inactive profile cannot hold guests: ownership falls away rather than
     pointing at somebody who has left. */
  const next = (!profile || profile.employment_status === 'inactive') ? null : profile.id;
  const previous = customer.marketing_profile_id ?? null;
  if (next === previous) return;

  const session = ctx.sessions.get();
  customersRepo.recordAssignment(ctx.db, {
    customer_id: customerId,
    previous_profile_id: previous,
    new_profile_id: next,
    event_type: 'derived',
    source,
    reservation_id: reservationId,
    actor_user_id: session ? session.id : null,
    changed_at: nowIso(),
  });
  customersRepo.update(ctx.db, customerId, {
    marketing_profile_id: next, updated_at: nowIso(),
    updated_by: session ? session.id : null,
  });
  ctx.audit({
    action: 'CUSTOMER_ASSIGN', entity_type: 'customer', entity_id: customerId,
    description: `Ownership derived from reservation attribution: ${customer.full_name} → ${profile ? profile.full_name : 'unassigned'}`,
  });
}

/* A conflict tells the operator which dates clash so they can resolve it. When
   the clashing stay belongs to a marketer the caller cannot see, its id and
   exact dates are exactly what `reservations.list` deliberately withholds —
   so the conflict still fires, it just stops carrying the evidence.
   `reservations.create` is intentionally unscoped (any marketer may book a
   guest whose protection has lapsed), which is what makes this reachable. */
function visibleConflicts(ctx, clashes) {
  const session = ctx.sessions.get();
  return clashes.filter((r) => domain.reservationInScope(session, r));
}

function create(ctx, params) {
  const session = guard.requireCapability(ctx, 'reservations.create');
  const { customerId, checkIn, checkOut, note } = params;
  validateDates(checkIn, checkOut);

  const customer = customersRepo.findById(ctx.db, Number(customerId));
  if (!customer) throw validation('Guest not found.', 'customerId');

  /* Deliberately NOT a record-scope check: any marketer may book any registered
     guest, which is how a guest whose protection has lapsed changes hands.
     Protection is the only gate here, and it is the one that must never be
     missing. */
  if (session.role === 'MARKETING') {
    const qualifying = customersRepo.qualifyingFor(ctx.db, customer.id);
    const history = customersRepo.assignmentHistory(ctx.db, customer.id);
    if (domain.isProtectedFrom({ customer, qualifyingReservations: qualifying, assignmentHistory: history, profileId: session.profile_id })) {
      throw protectedGuest();
    }
  }

  /* MARKETING can only ever invite as themselves. Enforced here rather than
     hidden in the form, so a crafted request cannot attribute a booking to —
     or hide one under — another marketer's scope. */
  let invitedBy = session.role === 'MARKETING' ? session.profile_id : params.invitedByProfileId;
  if (invitedBy !== null && invitedBy !== undefined && invitedBy !== '') {
    invitedBy = Number(invitedBy);
    const profile = ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(invitedBy);
    if (!profile) throw validation('Selected marketing profile no longer exists.', 'invitedByProfileId');
  } else {
    invitedBy = null;
  }

  const clashes = repo.overlapping(ctx.db, customer.id, checkIn, checkOut);
  if (clashes.length && !params.force) {
    throw conflict('This guest already has a reservation overlapping those dates.',
      { field: 'checkIn', conflicts: visibleConflicts(ctx, clashes) });
  }

  const now = nowIso();
  const run = ctx.db.transaction(() => {
    const id = repo.create(ctx.db, {
      customer_id: customer.id, check_in: checkIn, check_out: checkOut,
      invited_by_profile_id: invitedBy, reservation_note: note || null,
      created_at: now, created_by: session.id, updated_at: now, updated_by: session.id,
    });
    syncOwnership(ctx, customer.id, { reservationId: id });
    ctx.audit({
      action: 'RESERVATION_CREATE', entity_type: 'reservation', entity_id: id,
      description: `Reservation ${checkIn} → ${checkOut} for ${customer.full_name}`,
    });
    return id;
  });
  return { id: run() };
}

function update(ctx, params) {
  const session = guard.requireCapability(ctx, 'reservations.update');
  const existing = requireReachable(ctx, params.id);
  if (existing.deleted_at) throw validation('A deleted reservation cannot be edited.');
  if (existing.cancelled_at) {
    throw validation('A cancelled reservation cannot be edited. Create a new reservation instead.');
  }

  const checkIn = params.checkIn ?? existing.check_in;
  const checkOut = params.checkOut ?? existing.check_out;
  validateDates(checkIn, checkOut);

  let customerId = existing.customer_id;
  if (params.customerId !== undefined && Number(params.customerId) !== existing.customer_id) {
    customerId = Number(params.customerId);
    /* Retargeting is a second create in disguise: it needs the same existence,
       scope and protection checks, or it becomes the way around all three. */
    const target = customersRepo.findById(ctx.db, customerId);
    if (!target) throw validation('Guest not found.', 'customerId');
    guard.requireCustomerInScope(ctx, target);
    if (session.role === 'MARKETING') {
      const qualifying = customersRepo.qualifyingFor(ctx.db, customerId);
      const history = customersRepo.assignmentHistory(ctx.db, customerId);
      if (domain.isProtectedFrom({ customer: target, qualifyingReservations: qualifying, assignmentHistory: history, profileId: session.profile_id })) {
        throw protectedGuest();
      }
    }
  }

  const clashes = repo.overlapping(ctx.db, customerId, checkIn, checkOut, existing.id);
  if (clashes.length && !params.force) {
    throw conflict('This guest already has a reservation overlapping those dates.',
      { field: 'checkIn', conflicts: visibleConflicts(ctx, clashes) });
  }

  const patch = {
    customer_id: customerId, check_in: checkIn, check_out: checkOut,
    updated_at: nowIso(), updated_by: session.id,
  };
  if (session.role === 'MARKETING') patch.invited_by_profile_id = session.profile_id;
  else if (params.invitedByProfileId !== undefined) {
    patch.invited_by_profile_id = params.invitedByProfileId ? Number(params.invitedByProfileId) : null;
  }
  if (params.note !== undefined) patch.reservation_note = params.note || null;

  const previousCustomer = existing.customer_id;
  const run = ctx.db.transaction(() => {
    repo.update(ctx.db, existing.id, patch);
    syncOwnership(ctx, customerId, { reservationId: existing.id });
    if (previousCustomer !== customerId) syncOwnership(ctx, previousCustomer, { reservationId: existing.id });
    ctx.audit({
      action: 'RESERVATION_UPDATE', entity_type: 'reservation', entity_id: existing.id,
      description: `Updated reservation ${checkIn} → ${checkOut}`,
    });
  });
  run();
  return { id: existing.id };
}

function cancel(ctx, params) {
  const session = guard.requireCapability(ctx, 'reservations.update');
  const existing = requireReachable(ctx, params.id);
  if (existing.deleted_at) throw validation('A deleted reservation cannot be cancelled.');
  /* Idempotent: a double submit must not rewrite the reason somebody recorded. */
  if (existing.cancelled_at) return { id: existing.id, status: 'CANCELLED' };

  const now = nowIso();
  const run = ctx.db.transaction(() => {
    repo.update(ctx.db, existing.id, {
      cancelled_at: now, cancelled_by: session.id,
      cancellation_reason: params.reason || null, updated_at: now, updated_by: session.id,
    });
    syncOwnership(ctx, existing.customer_id, { reservationId: existing.id, source: 'cancellation' });
    ctx.audit({
      action: 'RESERVATION_CANCEL', entity_type: 'reservation', entity_id: existing.id,
      description: `Cancelled reservation ${existing.check_in} → ${existing.check_out}`
        + (params.reason ? ` (${params.reason})` : ''),
    });
  });
  run();
  return { id: existing.id, status: 'CANCELLED' };
}

/* Soft delete. The row survives; it simply stops being operational.
 *
 * A cancelled reservation that is deleted keeps its cancellation metadata —
 * cancelled_at, cancelled_by and the reason are all still there, because the
 * question "why was this cancelled before it was deleted" is exactly the one
 * somebody asks six months later. */
function remove(ctx, params) {
  const session = guard.requireCapability(ctx, 'reservations.delete');
  /* Beyond the capability: deletion is not configurable onto another role. */
  if (session.role !== 'ADMIN') {
    throw forbidden('Only an administrator can delete a reservation. Cancel it instead.');
  }
  const existing = repo.findRaw(ctx.db, Number(params.id));
  if (!existing) throw notFound('Reservation not found.');
  if (existing.deleted_at) return { id: existing.id, status: 'DELETED' };

  const reason = String(params.reason || '').trim();
  if (!reason) throw validation('A reason is required to delete a reservation.', 'reason');

  const previousState = domain.reservationStatus(existing, today());
  const now = nowIso();
  const run = ctx.db.transaction(() => {
    repo.update(ctx.db, existing.id, {
      deleted_at: now, deleted_by: session.id, deletion_reason: reason,
      updated_at: now, updated_by: session.id,
    });
    /* The booking no longer counts, so ownership derived from it may have to
       fall back to whatever is still real. */
    syncOwnership(ctx, existing.customer_id, { reservationId: existing.id, source: 'deletion' });
    ctx.audit({
      action: 'RESERVATION_DELETE', entity_type: 'reservation', entity_id: existing.id,
      description: `Deleted reservation ${existing.check_in} → ${existing.check_out} (was ${previousState}): ${reason}`,
      metadata: {
        customer_id: existing.customer_id,
        previous_state: previousState,
        check_in: existing.check_in,
        check_out: existing.check_out,
        invited_by_profile_id: existing.invited_by_profile_id,
        cancelled_at: existing.cancelled_at,
        cancellation_reason: existing.cancellation_reason,
      },
    });
  });
  run();
  return { id: existing.id, status: 'DELETED' };
}

module.exports = { list, listDeleted, get, create, update, cancel, remove, syncOwnership, decorate };
