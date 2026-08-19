'use strict';
/* The authorization primitives every service call goes through.
 *
 * Three separate questions, asked in this order, because they fail for
 * different reasons and conflating them is how boundaries disappear:
 *
 *   1. requireSession   is anybody signed in?
 *   2. requireCapability may this ROLE call this verb at all?
 *   3. requireScope      may this SESSION touch THIS record?
 *
 * A handler that asks only (2) is the classic horizontal-escalation hole: the
 * role is allowed to call customers.get, so the call succeeds — for anybody's
 * guest.
 */

const { authRequired, forbidden, outOfScope, notFound } = require('../../shared/errors');
const domain = require('./domain');

function requireSession(ctx) {
  const session = ctx.sessions.get();
  if (!session) throw authRequired();
  ctx.sessions.touch();
  return session;
}

function requireCapability(ctx, capability) {
  const session = requireSession(ctx);
  if (!ctx.sessions.can(capability)) throw forbidden();
  return session;
}

/** The profile a MARKETING session is confined to; null for ADMIN/MANAGER. */
function scopeOf(ctx) {
  return domain.scopeProfileId(ctx.sessions.get());
}

function requireCustomerInScope(ctx, customer) {
  if (!customer) throw notFound('Guest not found.');
  if (!domain.customerInScope(ctx.sessions.get(), customer)) throw outOfScope();
  return customer;
}

function requireReservationInScope(ctx, reservation) {
  if (!reservation) throw notFound('Reservation not found.');
  if (!domain.reservationInScope(ctx.sessions.get(), reservation)) throw outOfScope();
  return reservation;
}

/* A DELETED reservation is history that only management may read. A marketer
   asking for one by id must get the same answer as a marketer asking for a
   reservation that never existed — otherwise the refusal itself confirms the
   record is there. */
function requireDeletedVisible(ctx) {
  const session = requireSession(ctx);
  if (!domain.canSeeDeleted(session)) throw notFound('Reservation not found.');
  return session;
}

module.exports = {
  requireSession, requireCapability, scopeOf,
  requireCustomerInScope, requireReservationInScope, requireDeletedVisible,
};
