'use strict';
/* NO RECORD — one definition, every surface.
 *
 * A registered guest with zero qualifying (non-cancelled) reservation activity
 * and zero CRM notes. The classic failure mode this guards against: the status
 * badge derived from cancelled-excluded facts while the KPI counted total
 * historical reservations, so a guest whose only booking was cancelled showed
 * NO RECORD while being absent from the count and the list.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('business/no-record');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  const g = {};
  g.A = (await s.makeGuest({ code: 'NR-A', name: 'NR PLAIN' })).id;
  g.B = (await s.makeGuest({ code: 'NR-B', name: 'NR WITH NOTE', note: 'called them' })).id;
  g.C = (await s.makeGuest({ code: 'NR-C', name: 'NR WITH VISIT', visitMonthsAgo: 1, invitedBy: ids.keremId })).id;
  g.D = (await s.makeGuest({ code: 'NR-D', name: 'NR CANCELLED ONLY', visitMonthsAgo: 1, invitedBy: ids.keremId, cancel: true })).id;
  g.E = (await s.makeGuest({ code: 'NR-E', name: 'NR CANCELLED PLUS NOTE', visitMonthsAgo: 1, invitedBy: ids.keremId, cancel: true, note: 'called' })).id;
  g.F = (await s.makeGuest({ code: 'NR-F', name: 'NR FUTURE ONLY', futureVisit: true, invitedBy: ids.keremId })).id;

  const view = await s.page.evaluate(async (g) => {
    const st = async id => (await window.api.customers.get({ id })).data.status;
    const counts = async id => {
      const c = (await window.api.customers.get({ id })).data;
      return { total: c.reservation_count, qualifying: c.qualifying_reservation_count };
    };
    const list = (await window.api.customers.list({ noRecord: true, registeredOnly: true, pageSize: 5000 })).data;
    const dash = (await window.api.dashboard.load({ periodDays: 'all' })).data.stats;
    const badge = (await window.api.customers.list({ noRecord: true, registeredOnly: true, pageSize: 1 })).data.total;
    const inList = id => list.rows.some(r => r.id === id);
    const out = { listTotal: list.total, kpi: dash.noRecord, badge };
    for (const [k, id] of Object.entries(g)) {
      out[k] = { status: await st(id), inList: inList(id), counts: await counts(id) };
    }
    return out;
  }, g);

  s.check('A registered, no reservation, no note => NO_RECORD and in list',
    view.A.status === 'NO_RECORD' && view.A.inList, JSON.stringify(view.A));
  s.check('B has a CRM note => not NO_RECORD, not in list',
    view.B.status !== 'NO_RECORD' && !view.B.inList, JSON.stringify(view.B));
  s.check('C has a real reservation => not NO_RECORD, not in list',
    view.C.status !== 'NO_RECORD' && !view.C.inList, JSON.stringify(view.C));
  s.check('D only CANCELLED reservation, no note => NO_RECORD and in list',
    view.D.status === 'NO_RECORD' && view.D.inList, JSON.stringify(view.D));
  s.check('E cancelled reservation plus a note => not NO_RECORD, not in list',
    view.E.status !== 'NO_RECORD' && !view.E.inList, JSON.stringify(view.E));
  s.check('F only a FUTURE booking => not NO_RECORD, not in list',
    view.F.status !== 'NO_RECORD' && !view.F.inList, JSON.stringify(view.F));

  s.check('D keeps its historical reservation count while having no qualifying activity',
    view.D.counts.total === 1 && view.D.counts.qualifying === 0, JSON.stringify(view.D.counts));

  s.check('Dashboard KPI equals the No Record list total', view.kpi === view.listTotal, `kpi=${view.kpi} list=${view.listTotal}`);
  s.check('No Record badge equals the same total', view.badge === view.listTotal, `badge=${view.badge} list=${view.listTotal}`);

  // ------------------------------------------------ reports and exports agree
  const surfaces = await s.page.evaluate(async () => {
    const exp = await window.api.export.filtered({ entity: 'norecord', params: { noRecord: true, registeredOnly: true } });
    const rpt = await window.api.customers.list({ noRecord: true, registeredOnly: true, pageSize: 5000 });
    return { exportRows: exp.ok ? exp.data.rows : -1, reportRows: rpt.data.total };
  });
  s.check('export row count matches the No Record dataset',
    surfaces.exportRows === view.listTotal, JSON.stringify({ ...surfaces, list: view.listTotal }));
  s.check('report query matches the No Record dataset',
    surfaces.reportRows === view.listTotal, JSON.stringify({ ...surfaces, list: view.listTotal }));

  // ---------------------------------------- classification updates immediately
  const live = await s.page.evaluate(async (id) => {
    const before = (await window.api.dashboard.load({})).data.stats.noRecord;
    await window.api.crmNotes.create({ customerId: id, note: 'now has activity' });
    const after = (await window.api.dashboard.load({})).data.stats.noRecord;
    const status = (await window.api.customers.get({ id })).data.status;
    return { before, after, status };
  }, g.A);
  s.check('adding a CRM note removes the guest from No Record immediately',
    live.after === live.before - 1 && live.status !== 'NO_RECORD', JSON.stringify(live));

  // and the reverse: cancelling the only reservation puts a guest back in
  const reverse = await s.page.evaluate(async (id) => {
    const before = (await window.api.dashboard.load({})).data.stats.noRecord;
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows.filter(r => r.customer_id === id);
    await window.api.reservations.cancel({ id: rows[0].id, reason: 'Duplicate' });
    const after = (await window.api.dashboard.load({})).data.stats.noRecord;
    const status = (await window.api.customers.get({ id })).data.status;
    return { before, after, status };
  }, g.C);
  s.check('cancelling the only reservation returns the guest to No Record',
    reverse.after === reverse.before + 1 && reverse.status === 'NO_RECORD', JSON.stringify(reverse));

  await s.close();
  return s.finish();
};
