'use strict';
/* CONSISTENCY CONTRACTS — invariants that must hold across screens.
 *
 * These are the "two screens describing the same thing must agree" rules,
 * plus calendar day-bucket exclusivity and cancelled-reservation side effects.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('integrity/consistency-contracts');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // ------------------------------------------------ profile counts vs reality
  const profiles = await s.page.evaluate(async () => {
    const profs = (await window.api.profiles.list({})).data;
    const custs = (await window.api.customers.list({ pageSize: 5000 })).data.rows;
    const res = (await window.api.reservations.list({ pageSize: 5000 })).data.rows;
    const cancelled = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.rows;
    return profs.map(p => ({
      name: p.full_name,
      shownGuests: p.customer_count,
      actualGuests: custs.filter(c => c.marketing_profile_id === p.id).length,
      shownRes: p.reservation_count,
      actualRes: res.concat(cancelled).filter(r => r.invited_by_profile_id === p.id).length,
    }));
  });
  for (const p of profiles) {
    s.check(`profile "${p.name}" guest count === actual assigned set`,
      p.shownGuests === p.actualGuests, `shown=${p.shownGuests} actual=${p.actualGuests}`);
    s.check(`profile "${p.name}" reservation count === actual invited set`,
      p.shownRes === p.actualRes, `shown=${p.shownRes} actual=${p.actualRes}`);
  }

  // ------------------------------------------- reservations vs cancelled split
  const split = await s.page.evaluate(async () => {
    const active = (await window.api.reservations.list({ view: 'active', pageSize: 5000 })).data;
    const cancelled = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data;
    const kpi = (await window.api.dashboard.load({ periodDays: 'all' })).data.stats.reservations;
    const overlap = active.rows.filter(a => cancelled.rows.some(c => c.id === a.id)).length;
    return { active: active.total, cancelled: cancelled.total, kpi, overlap };
  });
  s.check('Reservations KPI === active reservation dataset', split.kpi === split.active, JSON.stringify(split));
  s.check('a reservation is never in both Active and Cancelled', split.overlap === 0, JSON.stringify(split));

  // --------------------------------- calendar arrival/in-house/departure rules
  const cal = await s.page.evaluate(async (keremId) => {
    const c = (await window.api.customers.create({ code: 'CC-CAL', fullName: 'CALENDAR GUEST', registered: true })).data;
    await window.api.reservations.create({
      customerId: c.id, checkIn: '2027-08-15', checkOut: '2027-08-18', invitedByProfileId: keremId });
    const buckets = (await window.api.calendar.month({ year: 2027, month: 8 })).data.buckets;
    const days = {};
    for (const d of ['2027-08-15', '2027-08-16', '2027-08-17', '2027-08-18']) {
      const day = (await window.api.calendar.day({ date: d })).data;
      days[d] = { arrivals: day.arrivals.length, active: day.active.length, departures: day.departures.length };
    }
    return { buckets, days };
  }, ids.keremId);

  const expect = {
    '2027-08-15': { arrivals: 1, active: 0, departures: 0 },
    '2027-08-16': { arrivals: 0, active: 1, departures: 0 },
    '2027-08-17': { arrivals: 0, active: 1, departures: 0 },
    '2027-08-18': { arrivals: 0, active: 0, departures: 1 },
  };
  for (const [date, want] of Object.entries(expect)) {
    const gotBucket = cal.buckets[date];
    const gotDay = cal.days[date];
    s.check(`calendar bucket ${date} is exclusive (${want.arrivals}/${want.active}/${want.departures})`,
      gotBucket.arrivals === want.arrivals && gotBucket.active === want.active && gotBucket.departures === want.departures,
      JSON.stringify(gotBucket));
    s.check(`calendar day list ${date} matches its bucket`,
      gotDay.arrivals === gotBucket.arrivals && gotDay.active === gotBucket.active && gotDay.departures === gotBucket.departures,
      JSON.stringify({ bucket: gotBucket, day: gotDay }));
  }

  // ------------------------------- cancelled reservations have no side effects
  const cancelled = await s.page.evaluate(async (keremId) => {
    const c = (await window.api.customers.create({ code: 'CC-CANCEL', fullName: 'CANCEL SIDE EFFECTS', registered: true })).data;
    const r = (await window.api.reservations.create({
      customerId: c.id, checkIn: '2027-09-10', checkOut: '2027-09-12', invitedByProfileId: keremId })).data;
    const beforeCal = (await window.api.calendar.month({ year: 2027, month: 9 })).data.buckets['2027-09-10'];
    await window.api.reservations.cancel({ id: r.id, reason: 'Duplicate' });
    const afterCal = (await window.api.calendar.month({ year: 2027, month: 9 })).data.buckets['2027-09-10'];
    const guest = (await window.api.customers.get({ id: c.id })).data;
    const upcoming = (await window.api.reservations.list({ status: 'UPCOMING', pageSize: 5000 })).data.rows.some(x => x.id === r.id);
    const inCancelledView = (await window.api.reservations.list({ view: 'cancelled', pageSize: 5000 })).data.rows.some(x => x.id === r.id);
    return {
      calBefore: beforeCal.arrivals, calAfter: afterCal.arrivals,
      lastVisit: guest.last_visit, nextVisit: guest.next_visit,
      totalCount: guest.reservation_count, qualifyingCount: guest.qualifying_reservation_count,
      status: guest.status, upcoming, inCancelledView,
    };
  }, ids.keremId);
  s.check('cancelling removes the arrival from the calendar', cancelled.calAfter === cancelled.calBefore - 1, JSON.stringify(cancelled));
  s.check('cancelled reservation is not counted as an upcoming stay', !cancelled.upcoming, JSON.stringify(cancelled));
  s.check('cancelled reservation does not set next_visit', cancelled.nextVisit === null, JSON.stringify(cancelled));
  s.check('cancelled reservation does not count as qualifying activity', cancelled.qualifyingCount === 0, JSON.stringify(cancelled));
  s.check('cancelled reservation is still counted in total history', cancelled.totalCount === 1, JSON.stringify(cancelled));
  s.check('guest returns to NO_RECORD after the only booking is cancelled', cancelled.status === 'NO_RECORD', JSON.stringify(cancelled));
  s.check('cancelled reservation remains visible in the Cancelled view', cancelled.inCancelledView, JSON.stringify(cancelled));

  await s.close();
  return s.finish();
};
