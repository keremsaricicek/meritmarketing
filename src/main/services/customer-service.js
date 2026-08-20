'use strict';
/* Guests: reading, creating, editing, and the one path that moves ownership.
 *
 * Ownership moves through `assign` and nowhere else. `update` explicitly
 * refuses a marketing_profile_id, because an edit form that also silently
 * reassigns is how a marketer takes a protected guest without ever touching the
 * reassignment screen.
 */

const repo = require('../repositories/customers');
const domain = require('./domain');
const guard = require('./guard');
const { nowIso, today } = require('../../shared/contracts/dates');
const { validation, conflict, protectedGuest, notFound, forbidden } = require('../../shared/errors');

/** Attach the derived status the whole product agrees on. */
function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    status: domain.customerStatus({
      registered: row.registered,
      qualifyingReservationCount: row.qualifying_reservation_count,
      noteCount: row.note_count,
      lastVisit: row.last_visit,
      nextVisit: row.next_visit,
      lastNoteDate: row.last_note_date,
    }),
  };
}

function list(ctx, params = {}) {
  guard.requireCapability(ctx, 'customers.read');
  const result = repo.list(ctx.db, params, guard.scopeOf(ctx));
  return { ...result, rows: result.rows.map(decorate) };
}

function get(ctx, { id }) {
  guard.requireCapability(ctx, 'customers.read');
  const row = repo.findById(ctx.db, Number(id));
  guard.requireCustomerInScope(ctx, row);
  return decorate(repo.detail(ctx.db, Number(id)));
}

/* The inspector's extra panel. Assignment history is a separate call precisely
   so it never rides along on every row of a list. */
function history(ctx, { id }) {
  guard.requireCapability(ctx, 'customers.read');
  const row = repo.findById(ctx.db, Number(id));
  guard.requireCustomerInScope(ctx, row);
  return repo.assignmentHistory(ctx.db, Number(id));
}

/* Identity-only lookup for out-of-scope guests. An operator must be able to
   discover that a guest already exists — otherwise they create a duplicate
   record and the book quietly forks — but "this person is in the book" is a
   very different disclosure from "here is their phone number". */
function summary(ctx, { id }) {
  guard.requireCapability(ctx, 'customers.read');
  const row = repo.detail(ctx.db, Number(id));
  if (!row) throw notFound('Guest not found.');
  if (domain.customerInScope(ctx.sessions.get(), row)) return decorate(row);
  return {
    id: row.id, code: row.code, full_name: row.full_name, registered: row.registered,
    in_scope: false,
    phone: null, email: null, passport_no: null, nationality: null,
    marketing_name: null, status: null, last_visit: null, next_visit: null,
  };
}

function picker(ctx, params = {}) {
  guard.requireCapability(ctx, 'customers.read');
  return repo.picker(ctx.db, params, guard.scopeOf(ctx));
}

/* A Guest ID is unique across the whole table, archived guests included — the
   database index does not stop at the tombstone. Asking about the archived case
   separately is the difference between an operator being told what to do and
   being shown "An unexpected error occurred", which is what a bare UNIQUE
   constraint failure becomes by the time it crosses the IPC boundary. */
function requireCodeAvailable(ctx, code, exceptId = null) {
  const clash = repo.findByCode(ctx.db, code);
  if (clash && clash.id !== exceptId) throw validation('That Guest ID is already in use.', 'code');
  const archived = repo.findArchivedByCode(ctx.db, code);
  if (archived && archived.id !== exceptId) {
    throw validation(
      `That Guest ID belongs to an archived guest (${archived.full_name}). Guest IDs are never reused — choose a different one.`,
      'code');
  }
}

function create(ctx, params) {
  const session = guard.requireCapability(ctx, 'customers.create');
  const code = String(params.code || '').trim();
  const fullName = String(params.fullName || '').trim();
  if (!code) throw validation('Guest ID is required.', 'code');
  if (!fullName) throw validation('Name is required.', 'fullName');
  requireCodeAvailable(ctx, code);

  /* A marketer may only create guests owned by themselves. Scope is a two-way
     boundary: it stops reading another marketer's book, and it stops writing
     into it. */
  let owner = params.marketingProfileId ? Number(params.marketingProfileId) : null;
  if (session.role === 'MARKETING') {
    if (owner !== null && owner !== session.profile_id) {
      throw forbidden('You can only create guests assigned to yourself.');
    }
    owner = session.profile_id;
  }
  if (owner !== null && !ctx.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(owner)) {
    throw validation('Selected marketing profile no longer exists.', 'marketingProfileId');
  }

  const now = nowIso();
  const run = ctx.db.transaction(() => {
    const id = repo.create(ctx.db, {
      code, full_name: fullName,
      registered: params.registered === false ? 0 : 1,
      phone: params.phone || null, email: params.email || null,
      passport_no: params.passportNo || null, nationality: params.nationality || null,
      photo_name: params.photoName || null, notes: params.notes || null,
      marketing_profile_id: owner,
      created_at: now, created_by: session.id, updated_at: now, updated_by: session.id,
    });
    if (owner) {
      /* Creating a guest already assigned IS an explicit decision, so it
         anchors the protection clock the same way a reassignment does. */
      repo.recordAssignment(ctx.db, {
        customer_id: id, previous_profile_id: null, new_profile_id: owner,
        event_type: 'explicit', source: 'create', reservation_id: null,
        actor_user_id: session.id, changed_at: now,
      });
    }
    ctx.audit({
      action: 'CUSTOMER_CREATE', entity_type: 'customer', entity_id: id,
      description: `Created guest ${fullName} (${code})`,
    });
    return id;
  });
  return { id: run() };
}

/* Fields an edit is allowed to touch. Anything outside this list is ignored
   rather than written — mass assignment is how ownership, timestamps and
   row_version get rewritten by a crafted payload. */
const EDITABLE = Object.freeze({
  fullName: 'full_name', phone: 'phone', email: 'email',
  passportNo: 'passport_no', nationality: 'nationality',
  photoName: 'photo_name', notes: 'notes', registered: 'registered',
});

function update(ctx, params) {
  const session = guard.requireCapability(ctx, 'customers.update');
  const existing = repo.findById(ctx.db, Number(params.id));
  guard.requireCustomerInScope(ctx, existing);

  /* Ownership never moves through this verb. Echoing back the unchanged owner
     is tolerated so an edit form that round-trips the whole record still works;
     asking for a DIFFERENT owner is refused outright. */
  if (params.marketingProfileId !== undefined && params.marketingProfileId !== null) {
    const requested = Number(params.marketingProfileId);
    if (requested !== (existing.marketing_profile_id ?? null)) {
      throw forbidden('Guest ownership is changed through reassignment, not by editing the guest.');
    }
  }

  const patch = {};
  for (const [input, column] of Object.entries(EDITABLE)) {
    if (params[input] === undefined) continue;
    if (input === 'registered') patch[column] = params[input] ? 1 : 0;
    else if (input === 'fullName') {
      const value = String(params[input] || '').trim();
      if (!value) throw validation('Name is required.', 'fullName');
      patch[column] = value;
    } else patch[column] = params[input] || null;
  }
  if (params.code !== undefined) {
    const code = String(params.code).trim();
    if (!code) throw validation('Guest ID is required.', 'code');
    requireCodeAvailable(ctx, code, existing.id);
    patch.code = code;
  }
  if (!Object.keys(patch).length) return { id: existing.id };

  patch.updated_at = nowIso();
  patch.updated_by = session.id;
  repo.update(ctx.db, existing.id, patch);
  ctx.audit({
    action: 'CUSTOMER_UPDATE', entity_type: 'customer', entity_id: existing.id,
    description: `Updated guest ${existing.full_name}`,
  });
  return { id: existing.id };
}

/* The authorized reassignment override — the one deliberate way a protected
   guest changes hands, and the reason protection is a marketer-level rule
   rather than an absolute one. */
function assign(ctx, params) {
  const session = guard.requireCapability(ctx, 'customers.assign');
  const customer = repo.findById(ctx.db, Number(params.id));
  if (!customer) throw notFound('Guest not found.');
  guard.requireCustomerInScope(ctx, customer);

  const profileId = params.profileId ? Number(params.profileId) : null;
  const profile = profileId ? ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) : null;
  if (profileId && (!profile || profile.employment_status !== 'active')) {
    throw validation('Select an active marketing profile.', 'profileId');
  }
  if ((customer.marketing_profile_id ?? null) === profileId) return { id: customer.id };

  /* MARKETING cannot use this path to take a protected guest either. */
  if (session.role === 'MARKETING') {
    const qualifying = repo.qualifyingFor(ctx.db, customer.id);
    const hist = repo.assignmentHistory(ctx.db, customer.id);
    if (domain.isProtectedFrom({ customer, qualifyingReservations: qualifying, assignmentHistory: hist, profileId: session.profile_id })) {
      throw protectedGuest();
    }
  }

  const previous = customer.marketing_profile_id ?? null;
  const now = nowIso();
  const run = ctx.db.transaction(() => {
    /* Current ownership only. Every past reservation's Invited By is untouched:
       history records who actually invited the guest, and that does not become
       false because management moved the relationship. */
    repo.update(ctx.db, customer.id, {
      marketing_profile_id: profileId, updated_at: now, updated_by: session.id,
    });
    repo.recordAssignment(ctx.db, {
      customer_id: customer.id, previous_profile_id: previous, new_profile_id: profileId,
      event_type: 'explicit', source: params.reason || 'reassignment', reservation_id: null,
      actor_user_id: session.id, changed_at: now,
    });
    /* The marketer receiving the guest is told. The one losing them is not:
       that conversation belongs to management, not to a bell icon. */
    require('./notification-service').emitAssignment(ctx.db, { customer, profileId });
    ctx.audit({
      action: 'CUSTOMER_ASSIGN', entity_type: 'customer', entity_id: customer.id,
      description: `Reassigned ${customer.full_name} → ${profile ? profile.full_name : 'unassigned'}`,
    });
  });
  run();
  return { id: customer.id };
}

/* Guests are archived, never destroyed: their reservations and audit trail are
   business history, and ON DELETE RESTRICT on those tables would refuse a hard
   delete anyway. */
function remove(ctx, params) {
  const session = guard.requireCapability(ctx, 'customers.delete');
  const existing = repo.findById(ctx.db, Number(params.id));
  guard.requireCustomerInScope(ctx, existing);
  repo.softDelete(ctx.db, existing.id, { deleted_at: nowIso(), deleted_by: session.id });
  ctx.audit({
    action: 'CUSTOMER_DELETE', entity_type: 'customer', entity_id: existing.id,
    description: `Archived guest ${existing.full_name}`,
  });
  return { ok: true };
}

/** What the reassignment screen needs to warn before it acts. */
function protectionState(ctx, { id }) {
  guard.requireCapability(ctx, 'customers.read');
  const customer = repo.findById(ctx.db, Number(id));
  guard.requireCustomerInScope(ctx, customer);
  const qualifying = repo.qualifyingFor(ctx.db, customer.id);
  const hist = repo.assignmentHistory(ctx.db, customer.id);
  const expiry = domain.protectionExpiry({ customer, qualifyingReservations: qualifying, assignmentHistory: hist });
  return { expiry, active: !!expiry && today() <= expiry };
}

module.exports = { list, get, history, summary, picker, create, update, assign, remove, protectionState, decorate };
