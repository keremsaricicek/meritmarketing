'use strict';
/* RESERVATION WORKFLOW — cancel, delete, and the validation floor.
 *
 * Cancelling is reversible bookkeeping and is broadly available. Permanent
 * deletion destroys audit trail and attribution history, so it is ADMIN-only
 * and must stay that way at the API layer regardless of which buttons render.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('regression/reservation-workflow');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // ------------------------------------------------ cancellation reason capture
  const cancel = await s.page.evaluate(async (keremId) => {
    const c = (await window.api.customers.create({
      code: 'RW-CANCEL', fullName: 'RW CANCEL GUEST', registered: true })).data;
    const mk = async (ci, co) => (await window.api.reservations.create({
      customerId: c.id, checkIn: ci, checkOut: co, invitedByProfileId: keremId })).data;

    const preset = await mk('2027-10-01', '2027-10-03');
    const other = await mk('2027-10-10', '2027-10-12');
    const presetRes = await window.api.reservations.cancel({ id: preset.id, reason: 'Guest request' });
    // "Other" is a UI affordance: the form substitutes the typed text before
    // calling, so the handler only ever sees a final reason string.
    const otherRes = await window.api.reservations.cancel({ id: other.id, reason: 'Guest changed plans' });
    const rows = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.rows;
    const find = id => rows.find(r => r.id === id) || {};
    return {
      presetOk: presetRes.ok, otherOk: otherRes.ok,
      presetRow: JSON.stringify(find(preset.id)),
      otherRow: JSON.stringify(find(other.id)),
      customerId: c.id, presetId: preset.id, otherId: other.id,
    };
  }, ids.keremId);
  s.check('cancelling with a preset reason succeeds', cancel.presetOk === true, cancel.presetRow);
  s.check('cancelling with OTHER + free text succeeds', cancel.otherOk === true, cancel.otherRow);
  s.check('the preset reason is stored on the cancelled row',
    cancel.presetRow.includes('Guest request'), cancel.presetRow);
  s.check('the custom OTHER text is stored on the cancelled row',
    cancel.otherRow.includes('Guest changed plans'), cancel.otherRow);

  // Cancelling an already-cancelled reservation is idempotent, not an error,
  // so a double-submit cannot rewrite the recorded reason.
  const again = await s.api('reservations', 'cancel', { id: cancel.presetId, reason: 'Different reason' });
  const reasonKept = await s.page.evaluate(async (id) => {
    const rows = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.rows;
    return (rows.find(r => r.id === id) || {}).cancellation_reason;
  }, cancel.presetId);
  s.check('re-cancelling an already-cancelled reservation is idempotent', again.ok === true, JSON.stringify(again.error));
  s.check('re-cancelling does not overwrite the original reason',
    reasonKept === 'Guest request', String(reasonKept));

  // An edit must never resurrect a cancelled reservation.
  const editCancelled = await s.api('reservations', 'update', { id: cancel.presetId, checkIn: '2027-10-05', checkOut: '2027-10-07' });
  s.check('a cancelled reservation cannot be edited back into life',
    editCancelled.error?.code === 'VALIDATION', JSON.stringify(editCancelled));

  // ----------------------------------------- deletion is ADMIN-only at the API
  await s.loginManager();
  s.denied('MANAGER cannot permanently delete an active reservation',
    await s.api('reservations', 'delete', { id: cancel.otherId }), 'FORBIDDEN');

  await s.loginSena();
  s.denied('MARKETING cannot permanently delete a reservation',
    await s.api('reservations', 'delete', { id: cancel.otherId }), 'FORBIDDEN');

  // ------------------------------------- ADMIN may delete active AND cancelled
  await s.loginAdmin();
  const del = await s.page.evaluate(async (o) => {
    const active = (await window.api.reservations.create({
      customerId: o.customerId, checkIn: '2027-11-01', checkOut: '2027-11-03' })).data;
    const beforeActive = (await window.api.reservations.list({ view: 'active', pageSize: 5000 })).data.total;
    const delActive = await window.api.reservations.delete({ id: active.id });
    const afterActive = (await window.api.reservations.list({ view: 'active', pageSize: 5000 })).data.total;

    const beforeCancelled = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.total;
    const delCancelled = await window.api.reservations.delete({ id: o.otherId });
    const afterCancelled = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.total;

    const gone = await window.api.reservations.get({ id: o.otherId });
    const missing = await window.api.reservations.delete({ id: 999999 });
    const audits = (await window.api.audit.list({ pageSize: 500 })).data.rows
      .filter(a => a.action === 'RESERVATION_DELETE').length;
    return {
      delActive: delActive.ok, beforeActive, afterActive,
      delCancelled: delCancelled.ok, beforeCancelled, afterCancelled,
      gone: gone.ok ? (gone.data === null ? 'GONE' : 'STILL_READABLE') : gone.error.code,
      missing: missing.error?.code || 'ALLOWED', audits,
    };
  }, cancel);
  s.check('ADMIN may permanently delete an ACTIVE reservation', del.delActive === true, JSON.stringify(del));
  s.check('deleting an active reservation removes it from the active dataset',
    del.afterActive === del.beforeActive - 1, JSON.stringify(del));
  s.check('ADMIN may permanently delete a CANCELLED reservation', del.delCancelled === true, JSON.stringify(del));
  s.check('deleting a cancelled reservation removes it from the cancelled dataset',
    del.afterCancelled === del.beforeCancelled - 1, JSON.stringify(del));
  s.check('a deleted reservation is no longer readable by id', del.gone === 'GONE', String(del.gone));
  s.check('deleting a reservation that does not exist is rejected', del.missing === 'VALIDATION', String(del.missing));
  s.check('permanent deletion is written to the audit log', del.audits >= 2, JSON.stringify(del));

  // ----------------------------------------------- reservation status lifecycle
  const lifecycle = await s.page.evaluate(async (customerId) => {
    const mk = async (ci, co) => {
      const r = (await window.api.reservations.create({ customerId, checkIn: ci, checkOut: co })).data;
      return (await window.api.reservations.get({ id: r.id })).data.status;
    };
    const day = off => {
      const d = new Date(); d.setUTCDate(d.getUTCDate() + off);
      return d.toISOString().slice(0, 10);
    };
    return {
      upcoming: await mk(day(30), day(33)),
      checkedIn: await mk(day(-1), day(2)),
      completed: await mk(day(-20), day(-17)),
    };
  }, cancel.customerId);
  s.check('a future booking is UPCOMING', lifecycle.upcoming === 'UPCOMING', JSON.stringify(lifecycle));
  s.check('a stay spanning today is CHECKED_IN', lifecycle.checkedIn === 'CHECKED_IN', JSON.stringify(lifecycle));
  s.check('a stay entirely in the past is COMPLETED', lifecycle.completed === 'COMPLETED', JSON.stringify(lifecycle));

  // ------------------------------------------------ server-side validation floor
  const val = await s.page.evaluate(async (customerId) => ({
    emptyCode: (await window.api.customers.create({ code: '', fullName: 'X' })).error?.code,
    emptyName: (await window.api.customers.create({ code: 'RW-V1', fullName: '   ' })).error?.code,
    dupCode: (await window.api.customers.create({ code: 'RW-CANCEL', fullName: 'DUPE' })).error?.code,
    badDates: (await window.api.reservations.create({ customerId, checkIn: '2027-05-10', checkOut: '2027-05-01' })).error?.code,
    missingCustomer: (await window.api.reservations.create({ checkIn: '2027-05-01', checkOut: '2027-05-03' })).error?.code,
    emptyNote: (await window.api.crmNotes.create({ customerId, note: '   ' })).error?.code,
    shortPw: (await window.api.users.create({ username: 'zz', password: '1', role: 'MANAGER' })).error?.code,
    badRole: (await window.api.users.create({ username: 'zzz', password: 'longenough', role: 'SUPERADMIN' })).error?.code,
    dupUsername: (await window.api.users.create({ username: 'admin', password: 'longenough', role: 'MANAGER' })).error?.code,
  }), cancel.customerId);
  for (const [k, v] of Object.entries(val)) {
    s.check(`validation is enforced in the handler, not the form: ${k}`, v === 'VALIDATION', String(v));
  }

  // password change must verify the current password
  const pw = await s.api('auth', 'changePassword', { currentPassword: 'wrong', newPassword: 'newpass123' });
  s.check('auth.changePassword requires the correct current password',
    pw.error?.code === 'VALIDATION', JSON.stringify(pw.error));

  await s.close();
  return s.finish();
};
