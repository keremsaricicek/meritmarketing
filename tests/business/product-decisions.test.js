'use strict';
/* PRODUCT DECISIONS — regression tests
 *
 * These encode three rulings that were previously ambiguous. They are business
 * rules, not implementation details: if someone later "simplifies" the code and
 * breaks one, this suite says which decision was reversed.
 *
 *  1. Any legitimate change to CURRENT ownership — including automatic/derived
 *     changes — must produce an assignment_history event. Historical
 *     Invited By on past reservations stays immutable.
 *  2. MANAGER sees the Active Marketing KPI, using the identical authoritative
 *     definition ADMIN sees.
 *  3. Operational statuses (NO RECORD / COLD / ACTIVE) apply to REGISTERED
 *     guests only. Unregistered leads carry no status badge at all.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('business/product-decisions');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // =====================================================================
  // DECISION 1 — derived ownership changes are recorded
  // =====================================================================
  // A guest with no owner and no assignment history. Booking them causes
  // syncMarketing() to derive ownership from the reservation's inviter.
  const derived = await s.makeGuest({ code: 'PD1-DERIVED', name: 'PD1 DERIVED OWNER' });

  const beforeDerive = await s.page.evaluate(async (id) => {
    const c = (await window.api.customers.get({ id })).data;
    return { owner: c.marketing_profile_id, history: (c.assignment_history || []).length };
  }, derived.id);
  s.check('D1 fixture starts with no owner and no history',
    beforeDerive.owner === null && beforeDerive.history === 0, JSON.stringify(beforeDerive));

  const afterDerive = await s.page.evaluate(async (o) => {
    await window.api.reservations.create({
      customerId: o.id, checkIn: '2027-05-01', checkOut: '2027-05-03', invitedByProfileId: o.keremId,
    });
    const c = (await window.api.customers.get({ id: o.id })).data;
    const audits = (await window.api.audit.list({ pageSize: 500 })).data.rows
      .filter(a => a.entity_type === 'customer' && a.entity_id === o.id && a.action === 'CUSTOMER_ASSIGN');
    return {
      owner: c.marketing_profile_id,
      history: c.assignment_history || [],
      auditCount: audits.length,
    };
  }, { id: derived.id, keremId: ids.keremId });

  s.check('D1 derived ownership actually changed', afterDerive.owner === ids.keremId, JSON.stringify(afterDerive.owner));
  s.check('D1 derived ownership change wrote an assignment_history event',
    afterDerive.history.length === 1, JSON.stringify(afterDerive.history));
  s.check('D1 the event records previous and new owner',
    afterDerive.history[0] && afterDerive.history[0].previous_profile_id === null
      && afterDerive.history[0].new_profile_id === ids.keremId, JSON.stringify(afterDerive.history));
  s.check('D1 the event is marked as derived, not an explicit management decision',
    afterDerive.history[0] && afterDerive.history[0].derived === true, JSON.stringify(afterDerive.history));
  s.check('D1 derived ownership change is auditable', afterDerive.auditCount >= 1, String(afterDerive.auditCount));

  // Explicit reassignment still records a NON-derived event, and history is additive.
  const afterExplicit = await s.page.evaluate(async (o) => {
    await window.api.customers.assign({ id: o.id, profileId: o.senaId });
    const c = (await window.api.customers.get({ id: o.id })).data;
    return c.assignment_history;
  }, { id: derived.id, senaId: ids.senaId });
  s.check('D1 explicit reassignment appends a second event',
    afterExplicit.length === 2, JSON.stringify(afterExplicit));
  s.check('D1 explicit event is NOT marked derived',
    afterExplicit[1] && !afterExplicit[1].derived, JSON.stringify(afterExplicit[1]));

  // Historical Invited By must survive every one of those ownership changes.
  const invitedAfter = await s.page.evaluate(async (id) => {
    const rows = (await window.api.reservations.list({ pageSize: 5000 })).data.rows
      .filter(r => r.customer_id === id);
    return rows.map(r => r.invited_by_name);
  }, derived.id);
  s.check('D1 historical Invited By is unchanged by ownership churn',
    invitedAfter.length === 1 && invitedAfter[0] === 'KEREM SARICICEK', JSON.stringify(invitedAfter));

  // A derived event must not be mistaken for a management decision: derivation
  // may still advance ownership afterwards (it is only explicit assignments
  // that outrank it), so the guest must not become stranded.
  const notStranded = await s.page.evaluate(async (id) => {
    const c = (await window.api.customers.get({ id })).data;
    return c.marketing_profile_id;
  }, derived.id);
  s.check('D1 guest is still owned and reachable after mixed history',
    notStranded === ids.senaId, String(notStranded));

  // =====================================================================
  // DECISION 2 — MANAGER sees Active Marketing, same definition as ADMIN
  // =====================================================================
  const readKpi = async () => s.page.evaluate(async () => {
    await window.openWorkspaceTab('dashboard');
    await new Promise(r => setTimeout(r, 450));
    const cell = [...document.querySelectorAll('.stat-cell')]
      .find(x => x.querySelector('.sc-l')?.textContent.trim() === 'Active Marketing');
    const shown = cell ? cell.querySelector('.sc-n').textContent.trim().replace(/\D+$/, '') : null;
    const authoritative = (await window.api.dashboard.load({ periodDays: 'all' })).data.stats.activeMarketing;
    return { shown, authoritative };
  });

  await s.loginAdmin();
  const adminKpi = await readKpi();
  await s.loginManager();
  const managerKpi = await readKpi();
  await s.loginSena();
  const marketingKpi = await readKpi();

  s.check('D2 ADMIN sees Active Marketing', adminKpi.shown !== null, JSON.stringify(adminKpi));
  s.check('D2 MANAGER sees Active Marketing', managerKpi.shown !== null, JSON.stringify(managerKpi));
  s.check('D2 MANAGER value matches the authoritative definition',
    managerKpi.shown === String(managerKpi.authoritative), JSON.stringify(managerKpi));
  s.check('D2 MANAGER and ADMIN see the same number',
    managerKpi.shown === adminKpi.shown, `admin=${adminKpi.shown} manager=${managerKpi.shown}`);
  s.check('D2 MARKETING still does not see it', marketingKpi.shown === null, JSON.stringify(marketingKpi));

  // and it stays correct through a live activate/deactivate with no reload
  await s.loginManager();
  const live = await s.page.evaluate(async (okanId) => {
    const read = async () => {
      await window.renderDashboard();
      const cell = [...document.querySelectorAll('.stat-cell')]
        .find(x => x.querySelector('.sc-l')?.textContent.trim() === 'Active Marketing');
      return cell ? cell.querySelector('.sc-n').textContent.trim().replace(/\D+$/, '') : null;
    };
    await window.openWorkspaceTab('dashboard'); await new Promise(r => setTimeout(r, 350));
    const before = await read();
    await window.api.profiles.update({ id: okanId, inactive: false });
    const activated = await read();
    await window.api.profiles.update({ id: okanId, inactive: true });
    const deactivated = await read();
    return { before, activated, deactivated };
  }, ids.okanId);
  s.check('D2 KPI rises when a profile is activated (no reload)',
    Number(live.activated) === Number(live.before) + 1, JSON.stringify(live));
  s.check('D2 KPI falls again when deactivated (no reload)',
    live.deactivated === live.before, JSON.stringify(live));

  // =====================================================================
  // DECISION 3 — unregistered leads carry no operational status
  // =====================================================================
  await s.loginAdmin();
  const leads = await s.page.evaluate(async (keremId) => {
    const mk = async (code, name, opts) => {
      const c = (await window.api.customers.create({ code, fullName: name, registered: opts.registered })).data;
      if (opts.oldVisit) {
        const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 20);
        const ci = d.toISOString().slice(0, 10);
        const co = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);
        await window.api.reservations.create({ customerId: c.id, checkIn: ci, checkOut: co, invitedByProfileId: keremId });
      }
      if (opts.note) await window.api.crmNotes.create({ customerId: c.id, note: 'x' });
      return c.id;
    };
    const bare        = await mk('PD3-A', 'PD3 UNREG BARE',      { registered: false });
    const stale       = await mk('PD3-B', 'PD3 UNREG STALE',     { registered: false, oldVisit: true });
    const noted       = await mk('PD3-C', 'PD3 UNREG NOTED',     { registered: false, note: true });
    const regBare     = await mk('PD3-D', 'PD3 REG BARE',        { registered: true });
    const regStale    = await mk('PD3-E', 'PD3 REG STALE',       { registered: true, oldVisit: true });
    const st = async id => (await window.api.customers.get({ id })).data.status;
    const listed = (await window.api.customers.list({ pageSize: 5000 })).data.rows;
    const inNoRecord = (await window.api.customers.list({ noRecord: true, registeredOnly: true, pageSize: 5000 })).data.rows.map(r => r.id);
    const inCold = (await window.api.customers.list({ status: 'COLD', pageSize: 5000 })).data.rows.map(r => r.id);
    return {
      bare: await st(bare), stale: await st(stale), noted: await st(noted),
      regBare: await st(regBare), regStale: await st(regStale),
      unregVisible: listed.some(r => r.id === bare),
      bareInNoRecord: inNoRecord.includes(bare),
      staleInCold: inCold.includes(stale),
      regBareInNoRecord: inNoRecord.includes(regBare),
      regStaleInCold: inCold.includes(regStale),
    };
  }, ids.keremId);

  s.check('D3 unregistered lead with no activity has NO status', leads.bare === null, String(leads.bare));
  s.check('D3 unregistered lead with a stale visit has NO status', leads.stale === null, String(leads.stale));
  s.check('D3 unregistered lead with a CRM note has NO status', leads.noted === null, String(leads.noted));
  s.check('D3 registered guest with no activity is still NO_RECORD', leads.regBare === 'NO_RECORD', String(leads.regBare));
  s.check('D3 registered guest with a stale visit is still COLD', leads.regStale === 'COLD', String(leads.regStale));
  s.check('D3 unregistered leads remain visible in the CRM list', leads.unregVisible, String(leads.unregVisible));
  s.check('D3 unregistered lead never counts as No Record', !leads.bareInNoRecord, String(leads.bareInNoRecord));
  s.check('D3 unregistered lead never counts as Cold', !leads.staleInCold, String(leads.staleInCold));
  s.check('D3 registered guest still counts as No Record', leads.regBareInNoRecord, String(leads.regBareInNoRecord));
  s.check('D3 registered guest still counts as Cold', leads.regStaleInCold, String(leads.regStaleInCold));

  // the badge itself must be absent in the rendered UI, not merely null in data
  const badge = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('customers');
    await window.setCrmView('overview');
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('custSearch').value = 'PD3 UNREG BARE';
    window.onCustSearch();
    await new Promise(r => setTimeout(r, 500));
    const row = [...document.querySelectorAll('#custTableBody tr')].find(t => t.textContent.includes('PD3 UNREG BARE'));
    return row ? { found: true, hasTag: !!row.querySelector('.tag') } : { found: false };
  });
  s.check('D3 unregistered lead renders without a status badge',
    badge.found && badge.hasTag === false, JSON.stringify(badge));

  await s.close();
  return s.finish();
};
