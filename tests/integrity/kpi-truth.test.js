'use strict';
/* KPI TRUTH — displayed number === authoritative dataset, per role.
 *
 * Role scope may legitimately change the RESULT. It may never make the
 * displayed figure disagree with the dataset the same role would actually get
 * by clicking through. Every KPI is checked against an independent query, for
 * all three roles, and again after live mutations with no reload.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('integrity/kpi-truth');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // give each role something to count
  await s.makeGuest({ code: 'KPI-K1', name: 'KPI KEREM ONE', visitMonthsAgo: 1, invitedBy: ids.keremId, assignTo: ids.keremId });
  await s.makeGuest({ code: 'KPI-S1', name: 'KPI SENA ONE', visitMonthsAgo: 1, invitedBy: ids.senaId, assignTo: ids.senaId });
  await s.makeGuest({ code: 'KPI-S2', name: 'KPI SENA COLD', visitMonthsAgo: 14, invitedBy: ids.senaId, assignTo: ids.senaId });
  await s.makeGuest({ code: 'KPI-S3', name: 'KPI SENA NORECORD', assignTo: ids.senaId });

  const measure = () => s.page.evaluate(async () => {
    const stats = (await window.api.dashboard.load({ periodDays: 'all' })).data.stats;
    const [guests, cold, norec, upcoming, reservations, profiles] = await Promise.all([
      window.api.customers.list({ registeredOnly: true, pageSize: 5000 }),
      window.api.customers.list({ status: 'COLD', pageSize: 5000 }),
      window.api.customers.list({ noRecord: true, registeredOnly: true, pageSize: 5000 }),
      window.api.reservations.list({ status: 'UPCOMING', pageSize: 5000 }),
      window.api.reservations.list({ pageSize: 5000 }),
      window.api.profiles.list({}),
    ]);
    return {
      totalGuests:     [stats.totalGuests, guests.data.total],
      cold:            [stats.cold, cold.data.total],
      noRecord:        [stats.noRecord, norec.data.total],
      upcomingIn:      [stats.upcomingIn, upcoming.data.total],
      reservations:    [stats.reservations, reservations.data.total],
      activeMarketing: [stats.activeMarketing, profiles.data.filter(p => p.employment_status === 'active').length],
    };
  });

  for (const [role, fn] of [['ADMIN', () => s.loginAdmin()], ['MANAGER', () => s.loginManager()], ['MARKETING', () => s.loginSena()]]) {
    await fn();
    const m = await measure();
    for (const [kpi, [shown, actual]] of Object.entries(m)) {
      s.check(`${role} / ${kpi}: KPI === authoritative dataset`, shown === actual, `kpi=${shown} dataset=${actual}`);
    }
  }

  // role scope genuinely differs — otherwise the checks above are vacuous
  await s.loginAdmin();  const admin = await measure();
  await s.loginSena();   const mkt = await measure();
  s.check('MARKETING sees strictly fewer guests than ADMIN (scope is real)',
    mkt.totalGuests[0] < admin.totalGuests[0], `admin=${admin.totalGuests[0]} marketing=${mkt.totalGuests[0]}`);

  // -------------------------------------------------- live mutation, no reload
  await s.loginAdmin();
  const live = await s.page.evaluate(async () => {
    const read = async () => (await window.api.dashboard.load({ periodDays: 'all' })).data.stats;
    const before = await read();
    const c = (await window.api.customers.create({ code: 'KPI-LIVE', fullName: 'KPI LIVE GUEST', registered: true })).data;
    const afterCreate = await read();
    const r = (await window.api.reservations.create({ customerId: c.id, checkIn: '2027-08-01', checkOut: '2027-08-03' })).data;
    const afterRes = await read();
    await window.api.reservations.cancel({ id: r.id, reason: 'Duplicate' });
    const afterCancel = await read();
    return { before, afterCreate, afterRes, afterCancel };
  });
  s.check('creating a guest raises Total Guests immediately',
    live.afterCreate.totalGuests === live.before.totalGuests + 1, JSON.stringify([live.before.totalGuests, live.afterCreate.totalGuests]));
  s.check('creating a guest raises No Record immediately',
    live.afterCreate.noRecord === live.before.noRecord + 1, JSON.stringify([live.before.noRecord, live.afterCreate.noRecord]));
  s.check('booking that guest removes them from No Record immediately',
    live.afterRes.noRecord === live.before.noRecord, JSON.stringify([live.before.noRecord, live.afterRes.noRecord]));
  s.check('cancelling the booking returns them to No Record immediately',
    live.afterCancel.noRecord === live.afterCreate.noRecord, JSON.stringify([live.afterCreate.noRecord, live.afterCancel.noRecord]));

  // profile activation moves Active Marketing with no reload
  const profLive = await s.page.evaluate(async (okanId) => {
    const read = async () => (await window.api.dashboard.load({})).data.stats.activeMarketing;
    const before = await read();
    await window.api.profiles.update({ id: okanId, inactive: false });
    const activated = await read();
    await window.api.profiles.update({ id: okanId, inactive: true });
    const deactivated = await read();
    return { before, activated, deactivated };
  }, ids.okanId);
  s.check('activating a profile raises Active Marketing', profLive.activated === profLive.before + 1, JSON.stringify(profLive));
  s.check('deactivating it lowers Active Marketing again', profLive.deactivated === profLive.before, JSON.stringify(profLive));
  s.check('Active Marketing never exceeds the real profile count',
    profLive.activated <= 5, JSON.stringify(profLive));

  // ------------------------------------------------- STOCK vs PERIOD semantics
  const period = await s.page.evaluate(async () => {
    const at = async p => (await window.api.dashboard.load({ periodDays: p })).data.stats;
    const all = await at('all'), d7 = await at('7'), d30 = await at('30');
    return { all, d7, d30 };
  });
  s.check('STOCK: Total Guests ignores the period filter',
    period.all.totalGuests === period.d7.totalGuests, JSON.stringify([period.all.totalGuests, period.d7.totalGuests]));
  s.check('STOCK: Active Marketing ignores the period filter',
    period.all.activeMarketing === period.d7.activeMarketing, JSON.stringify([period.all.activeMarketing, period.d7.activeMarketing]));
  s.check('STOCK: Cold ignores the period filter',
    period.all.cold === period.d7.cold, JSON.stringify([period.all.cold, period.d7.cold]));
  s.check('STOCK: No Record ignores the period filter',
    period.all.noRecord === period.d7.noRecord, JSON.stringify([period.all.noRecord, period.d7.noRecord]));
  s.check('PERIOD: Reservations narrows as the window narrows',
    period.d7.reservations <= period.d30.reservations && period.d30.reservations <= period.all.reservations,
    JSON.stringify([period.d7.reservations, period.d30.reservations, period.all.reservations]));
  s.check('FUTURE: Upcoming Check-ins ignores the period filter',
    period.all.upcomingIn === period.d7.upcomingIn, JSON.stringify([period.all.upcomingIn, period.d7.upcomingIn]));

  await s.close();
  return s.finish();
};
