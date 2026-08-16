'use strict';
/* REVOKED ACCESS — what a marketer sees after a guest is moved away.
 *
 * Historical attribution and current ownership are different concepts. When
 * management reassigns a guest, the reservation the original marketer booked is
 * still THEIR history and must remain visible. The guest record behind it is no
 * longer theirs and must become unreadable.
 *
 * The failure mode this guards is a crash: the row renders from list data the
 * user is allowed to see, then clicking it fetches a record they are not. The
 * detail panel must degrade to an explanation, not throw.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('regression/revoked-access');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // SENA books a guest; management then moves that guest to KEREM.
  const cid = await s.page.evaluate(async (o) => {
    const c = (await window.api.customers.create({
      code: 'RA-REASSIGNED', fullName: 'REASSIGNED GUEST', registered: true })).data;
    await window.api.reservations.create({
      customerId: c.id, checkIn: '2027-08-01', checkOut: '2027-08-03', invitedByProfileId: o.senaId });
    await window.api.customers.assign({ id: c.id, profileId: o.keremId });
    return c.id;
  }, ids);

  await s.loginSena();
  const seen = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('reservations');
    await new Promise(r => setTimeout(r, 450));
    const row = [...document.querySelectorAll('#resTableBody tr')].find(r => r.textContent.includes('REASSIGNED GUEST'));
    const visible = !!row;
    if (row) row.click();
    await new Promise(r => setTimeout(r, 500));
    const panel = document.getElementById('resDetailPanel');
    return { visible, panelText: panel.innerText.trim().slice(0, 80), graceful: panel.classList.contains('empty') };
  });
  s.check('MARKETING still sees their own historical reservation after the guest was reassigned',
    seen.visible, JSON.stringify(seen));
  s.check('opening it degrades to a no-access explanation instead of crashing',
    seen.graceful && /no longer assigned/i.test(seen.panelText), JSON.stringify(seen));
  s.check('that path produced no console or page error', s.errors.length === 0, s.errors.join(' | '));

  const denied = await s.api('customers', 'get', { id: cid });
  s.denied('the reassigned guest record itself is unreadable at the API layer', denied, 'FORBIDDEN');

  // The reservation is history, so it must remain readable to the marketer who
  // made it even though the guest behind it is not.
  const histRes = await s.page.evaluate(async () => {
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows
      .filter(r => r.customer_name === 'REASSIGNED GUEST');
    if (!rows.length) return { found: false };
    const g = await window.api.reservations.get({ id: rows[0].id });
    return { found: true, readable: g.ok, invited: g.ok ? g.data.invited_by_name : g.error.code };
  });
  s.check('the historical reservation stays readable to the marketer who booked it',
    histRes.found && histRes.readable, JSON.stringify(histRes));
  s.check('historical Invited By still names the original marketer',
    histRes.invited === 'SENA NUR AKMUT', JSON.stringify(histRes));

  await s.close();
  return s.finish();
};
