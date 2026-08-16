'use strict';
/* ONE-YEAR GUEST PROTECTION — the full matrix.
 *
 * Rule: a guest belongs to their marketing profile for one year from whichever
 * is later — the latest qualifying (non-cancelled) visit, or the explicit
 * assignment that created the relationship. Within that window no OTHER
 * MARKETING user may take them over by any route. ADMIN/MANAGER reassignment
 * is the deliberate override. Cancelled bookings never extend protection.
 */

const { Suite } = require('../lib/harness');

const MSG = 'Guest protection period has not expired.';

module.exports = async function () {
  const s = new Suite('business/guest-protection');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  const g = {};
  g.recent   = (await s.makeGuest({ code: 'GP-3MO',  name: 'GP THREE MONTHS',  visitMonthsAgo: 3,  invitedBy: ids.keremId, assignTo: ids.keremId })).id;
  g.almost   = (await s.makeGuest({ code: 'GP-11MO', name: 'GP ELEVEN MONTHS', visitMonthsAgo: 11, invitedBy: ids.keremId, assignTo: ids.keremId })).id;
  g.cancelled= (await s.makeGuest({ code: 'GP-CAN',  name: 'GP CANCELLED ONLY',visitMonthsAgo: 2,  invitedBy: ids.keremId, cancel: true })).id;
  g.neverVisited = (await s.makeGuest({ code: 'GP-NEVER', name: 'GP NEVER VISITED',
    phone: 'GP-SECRET-PHONE', passport: 'GP-SECRET-PASS', assignTo: ids.keremId })).id;

  // A guest whose visit AND assignment are both older than a year.
  g.expired = (await s.makeGuest({ code: 'GP-EXP', name: 'GP EXPIRED', visitMonthsAgo: 26, invitedBy: ids.keremId, assignTo: ids.keremId })).id;
  await s.page.evaluate(async (id) => {
    const KEY = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('"customers"'));
    const d = JSON.parse(localStorage.getItem(KEY));
    const c = d.customers.find(x => x.id === id);
    const old = new Date(); old.setUTCFullYear(old.getUTCFullYear() - 2);
    (c.assignment_history || []).forEach(h => { h.changed_at = old.toISOString(); });
    localStorage.setItem(KEY, JSON.stringify(d));
    location.reload();
  }, g.expired);
  await s.page.waitForTimeout(700);
  await s.page.evaluate(() => { loginUser.value = 'admin'; loginPass.value = 'admin123'; });
  await s.page.evaluate(() => window.doLogin());
  await s.page.waitForTimeout(500);

  // ------------------------------------------------------ A–E, I : blocked
  await s.loginSena();
  const book = async (id) => {
    const r = await s.api('reservations', 'create', { customerId: id, checkIn: '2027-03-01', checkOut: '2027-03-03' });
    return r.ok ? 'ALLOWED' : r.error.message;
  };

  const a = await book(g.recent);
  const b = await book(g.almost);
  const c = await book(g.neverVisited);
  const d = await book(g.expired);
  const e = await book(g.cancelled);
  s.check('A: visit 3 months ago blocks another marketer', a === MSG, a);
  s.check('B: visit 11 months ago blocks another marketer', b === MSG, b);
  s.check('C: never-visited but ASSIGNED guest is protected', c === MSG, c);
  s.check('D: fully expired protection permits takeover', d === 'ALLOWED', d);
  s.check('E: a cancelled-only booking does not lock the guest', e === 'ALLOWED', e);

  // the protected guest's PII must remain unreadable throughout
  const pii = await s.api('customers', 'get', { id: g.neverVisited });
  s.denied('protected guest PII stays unreadable', pii, 'FORBIDDEN');

  // I: every crafted route is blocked, not just the reservation form
  s.denied('I: crafted customers.assign is blocked',
    await s.api('customers', 'assign', { id: g.recent, profileId: ids.senaId }), 'FORBIDDEN');
  s.denied('I: crafted customers.update ownership is blocked',
    await s.api('customers', 'update', { id: g.recent, marketingProfileId: ids.senaId }), 'FORBIDDEN');

  const retarget = await s.page.evaluate(async (o) => {
    const own = (await window.api.customers.create({ code: 'GP-OWN', fullName: 'GP OWN', marketingProfileId: o.senaId })).data;
    const r = (await window.api.reservations.create({ customerId: own.id, checkIn: '2027-04-01', checkOut: '2027-04-03' })).data;
    const up = await window.api.reservations.update({ id: r.id, customerId: o.protectedId });
    return up.ok ? 'ALLOWED' : up.error.message;
  }, { senaId: ids.senaId, protectedId: g.recent });
  s.check('I: retargeting a reservation onto a protected guest is blocked', retarget !== 'ALLOWED', retarget);

  // ownership must be untouched after all of that
  await s.loginAdmin();
  const stillKerem = await s.page.evaluate(async (id) =>
    (await window.api.customers.get({ id })).data.marketing_name, g.recent);
  s.check('blocked attempts never changed ownership', stillKerem === 'KEREM SARICICEK', String(stillKerem));

  // ------------------------------------- F/G: authorized reassignment override
  const before = await s.page.evaluate(async (id) => {
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows.filter(r => r.customer_id === id);
    return rows.map(r => ({ id: r.id, invited: r.invited_by_name }));
  }, g.recent);

  const reassign = await s.api('customers', 'assign', { id: g.recent, profileId: ids.senaId });
  s.check('F: ADMIN reassignment overrides active protection', reassign.ok === true, JSON.stringify(reassign.error));

  const after = await s.page.evaluate(async (id) => {
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows.filter(r => r.customer_id === id);
    const c = (await window.api.customers.get({ id })).data;
    return {
      invited: rows.map(r => ({ id: r.id, invited: r.invited_by_name })),
      owner: c.marketing_name,
      history: c.assignment_history,
    };
  }, g.recent);
  s.check('F: current ownership moved to the new marketer', after.owner === 'SENA NUR AKMUT', String(after.owner));
  s.check('F: historical Invited By is NOT rewritten',
    JSON.stringify(before) === JSON.stringify(after.invited), JSON.stringify({ before, after: after.invited }));
  s.check('F: assignment_history records the reassignment',
    after.history.some(h => h.new_profile_id === ids.senaId && !h.derived), JSON.stringify(after.history));
  s.check('F: history entry carries actor and timestamp',
    after.history.every(h => h.changed_at && ('changed_by' in h)), JSON.stringify(after.history));

  await s.loginSena();
  const nowAllowed = await book(g.recent);
  s.check('G: after authorized reassignment the new owner may book', nowAllowed === 'ALLOWED', nowAllowed);

  // ------------------------- H: editing history must not revert current owner
  await s.loginAdmin();
  const afterDelete = await s.page.evaluate(async (id) => {
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows.filter(r => r.customer_id === id);
    const keremRes = rows.find(r => r.invited_by_name === 'KEREM SARICICEK');
    if (keremRes) await window.api.reservations.delete({ id: keremRes.id });
    return (await window.api.customers.get({ id })).data.marketing_name;
  }, g.recent);
  s.check('H: deleting a historical reservation does not revert ownership',
    afterDelete === 'SENA NUR AKMUT', String(afterDelete));

  // -------------------------------------- expiry boundary is calendar-correct
  const boundary = await s.page.evaluate(async () => {
    // exactly one year minus a day ago -> still protected; one year and a day -> expired
    const mk = async (code, yearsBack, daysOffset) => {
      const d = new Date();
      d.setUTCFullYear(d.getUTCFullYear() - yearsBack);
      d.setUTCDate(d.getUTCDate() + daysOffset);
      const ci = d.toISOString().slice(0, 10);
      const co = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
      const profs = (await window.api.profiles.list({})).data;
      const kerem = profs.find(p => p.full_name === 'KEREM SARICICEK');
      const c = (await window.api.customers.create({ code, fullName: 'BOUNDARY ' + code, registered: true })).data;
      await window.api.reservations.create({ customerId: c.id, checkIn: ci, checkOut: co, invitedByProfileId: kerem.id });
      return c.id;
    };
    return { inside: await mk('GP-B1', 1, 2), outside: await mk('GP-B2', 1, -2) };
  });
  await s.loginSena();
  const insideRes = await book(boundary.inside);
  const outsideRes = await book(boundary.outside);
  s.check('boundary: two days inside the year is still protected', insideRes === MSG, insideRes);
  s.check('boundary: two days past the year is no longer protected', outsideRes === 'ALLOWED', outsideRes);

  await s.close();
  return s.finish();
};
