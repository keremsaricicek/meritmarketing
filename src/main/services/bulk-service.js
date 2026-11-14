'use strict';
/* Bulk actions over a selection of guests.
 *
 * A bulk verb is a loop over the SINGLE-guest verb, not a second
 * implementation of it. Reassigning fifty guests runs customers.assign fifty
 * times, so capability, record scope and the one-year protection rule apply
 * to every row exactly as they would from the row menu — and a guest the
 * caller may not touch fails on its own without stopping the rest.
 *
 * The result reports each failure by row; the renderer summarises it. One
 * summary audit row is written per bulk action in addition to the per-guest
 * rows the single verb already writes.
 */

const customersRepo = require('../repositories/customers');
const customerService = require('./customer-service');
const support = require('./support-services');
const domain = require('./domain');
const guard = require('./guard');
const { AppError, validation, outOfScope } = require('../../shared/errors');

/* What a failure row may say about the guest: its identity only when the
   caller could already see it. Otherwise the id they sent, and nothing else. */
function label(ctx, id) {
  const row = customersRepo.findById(ctx.db, id);
  if (row && domain.customerInScope(ctx.sessions.get(), row)) return { code: row.code, name: row.full_name };
  return { code: null, name: null };
}

/* The renderer only ever offers guests the caller can see, so a selection
   containing one outside their book is a crafted request, not a mistake: it
   is refused whole, with the same answer as a single out-of-scope call. */
function requireAllInScope(ctx, ids) {
  for (const id of ids) {
    const row = customersRepo.findById(ctx.db, Number(id));
    if (row && !domain.customerInScope(ctx.sessions.get(), row)) throw outOfScope();
  }
}

function each(ctx, ids, fn) {
  requireAllInScope(ctx, ids);
  const done = [];
  const failed = [];
  for (const raw of [...new Set(ids.map(Number))]) {
    try {
      fn(raw);
      done.push(raw);
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'An unexpected error occurred.';
      if (!(err instanceof AppError) && ctx.logger) ctx.logger.error('bulk.row-failed', { message: err.message });
      failed.push({ id: raw, ...label(ctx, raw), reasonCode: err.code || 'INTERNAL', message });
    }
  }
  return { done, failed };
}

function assign(ctx, { ids, profileId, reason }) {
  guard.requireCapability(ctx, 'customers.assign');
  const target = profileId ? Number(profileId) : null;
  const { done, failed } = each(ctx, ids, (id) => customerService.assign(ctx, {
    id, profileId: target, reason: reason || 'bulk reassignment',
  }));
  const profile = target ? ctx.db.prepare('SELECT full_name FROM profiles WHERE id = ?').get(target) : null;
  ctx.audit({
    action: 'CUSTOMER_BULK_ASSIGN', entity_type: 'customer',
    description: `Bulk reassignment to ${profile ? profile.full_name : 'unassigned'}: `
      + `${done.length} reassigned, ${failed.length} failed`,
    metadata: { requested: ids.length, succeeded: done.length, failed: failed.length, profile_id: target },
  });
  return { succeeded: done.length, failed };
}

function note(ctx, { ids, note: text, noteDate }) {
  guard.requireCapability(ctx, 'crm.create');
  const body = String(text || '').trim();
  if (!body) throw validation('A note cannot be empty.', 'note');
  const { done, failed } = each(ctx, ids, (id) => support.crmNotes.create(ctx, { customerId: id, note: body, noteDate }));
  ctx.audit({
    action: 'CRM_NOTE_BULK_CREATE', entity_type: 'crm_note',
    description: `Bulk CRM note: ${done.length} added, ${failed.length} failed`,
    metadata: { requested: ids.length, succeeded: done.length, failed: failed.length },
  });
  return { succeeded: done.length, failed };
}

module.exports = { assign, note };
