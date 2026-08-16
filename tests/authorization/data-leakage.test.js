'use strict';
/* DATA LEAKAGE — read paths that are not obviously "get by id".
 *
 * Reports, exports, dashboards, calendars and search all read the same guest
 * book through different helpers. Each is a chance to forget scope, and each
 * returns bulk data, so a single miss leaks far more than an IDOR would.
 */

const { Suite } = require('../lib/harness');

const SECRET = 'LEAK CANARY GUEST';

module.exports = async function () {
  const s = new Suite('authorization/data-leakage');
  await s.open();
  await s.bootstrap();
  const ids = await s.seedMarketingUser();

  // A canary owned by KEREM: if this name appears anywhere in SENA's output,
  // something leaked.
  const canary = await s.makeGuest({
    code: 'LEAK-CANARY', name: SECRET, phone: 'CANARY-PHONE', passport: 'CANARY-PASSPORT',
    visitMonthsAgo: 1, invitedBy: ids.keremId, assignTo: ids.keremId, note: 'canary note',
  });
  // Every leak assertion below is `!body.includes(SECRET)`. If the canary was
  // never created, all of them pass while proving nothing — so establish that
  // it exists, and is owned by the other marketer, before switching sessions.
  const canaryState = await s.page.evaluate(async (id) => {
    const c = await window.api.customers.get({ id });
    return c.ok ? { name: c.data.full_name, owner: c.data.marketing_name } : { error: c.error.code };
  }, canary.id);
  s.check('the leak canary exists and belongs to the other marketer',
    canaryState.name === SECRET && canaryState.owner === 'KEREM SARICICEK',
    JSON.stringify({ canary, canaryState }));
  // and one SENA legitimately owns, so "empty results" cannot pass by accident
  await s.makeGuest({
    code: 'LEAK-MINE', name: 'LEAK OWN GUEST',
    visitMonthsAgo: 1, invitedBy: ids.senaId, assignTo: ids.senaId,
  });

  await s.loginSena();

  // ------------------------------------------------------- exports (real CSV)
  // These read the bytes the app actually writes, not the { name, rows }
  // envelope — see Suite#exportCsv for why that distinction matters.
  const EXPORTS = [
    ['customerlist',     'customerlist',     {}],
    ['reservations',     'reservations',     {}],
    ['norecord',         'norecord',         {}],
    ['profiles',         'profiles',         {}],
    ['profile_guests',   'profile_guests',   { profileId: ids.keremId }],
    ['profile_invited',  'profile_invited',  { profileId: ids.keremId }],
    ['report_marketing', 'report_marketing', {}],
    // Crafted params: naming another marketer's profile in a filter must not
    // hand back their book. A filter narrows an already-scoped set; it never
    // chooses which set is read from.
    ['customerlist with crafted assignedTo', 'customerlist', { assignedTo: ids.keremId }],
    ['reservations with crafted invitedBy',  'reservations', { invitedBy: ids.keremId }],
    ['norecord with crafted assignedTo',     'norecord',     { assignedTo: ids.keremId }],
  ];
  const csvs = {};
  for (const [label, entity, params] of EXPORTS) {
    const r = await s.exportCsv(entity, params);
    csvs[label] = r;
    const body = r.ok ? String(r.csv) : `blocked:${r.code}`;
    s.check(`export ${label} does not leak another marketer's guest`,
      !body.includes(SECRET), body.slice(0, 200));
  }

  // The checks above must not be passing because every export came back empty
  // or refused. At least the marketer's own book has to be in there.
  const ownExport = csvs.customerlist;
  s.check('own guests still appear in own export (export checks are not vacuous)',
    ownExport.ok && String(ownExport.csv).includes('LEAK OWN GUEST'),
    JSON.stringify(ownExport).slice(0, 200));
  s.check('the export envelope row count matches the rows actually written',
    ownExport.rows === String(ownExport.csv).trim().split('\n').length - 1,
    JSON.stringify({ rows: ownExport.rows, csv: String(ownExport.csv).slice(0, 120) }));

  // ------------------------------------------- reports, dashboard, calendar
  const probes = await s.page.evaluate(async (o) => {
    const j = v => JSON.stringify(v);
    const out = {};
    out.reportGuests = j((await window.api.customers.list({ assignedTo: o.keremId, pageSize: 5000 })).data.rows.map(r => r.full_name));
    out.reportRes    = j((await window.api.reservations.list({ invitedBy: o.keremId, pageSize: 5000 })).data.rows.map(r => r.customer_name));
    const dash = (await window.api.dashboard.load({ periodDays: 'all' })).data;
    out.dashRecent    = j(dash.recent.map(r => r.customer_name));
    out.dashPending   = j(dash.pending.map(r => r.customer_name));
    out.dashAttention = j(dash.attention.map(a => a.full_name));
    const month = new Date(); month.setUTCMonth(month.getUTCMonth() - 1);
    out.calendarDay = j((await window.api.calendar.day({ date: month.toISOString().slice(0, 10) })).data);
    out.calendarMonth = j((await window.api.calendar.month({ year: month.getUTCFullYear(), month: month.getUTCMonth() + 1 })).data);
    return out;
  }, ids);

  for (const [name, payload] of Object.entries(probes)) {
    s.check(`${name} does not leak another marketer's guest`, !payload.includes(SECRET), payload.slice(0, 160));
  }

  // command palette is a search surface too
  const palette = await s.page.evaluate(async () => {
    window.openPalette();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('paletteInput').value = 'LEAK CANARY';
    window.onPaletteInput();
    await new Promise(r => setTimeout(r, 500));
    const text = document.getElementById('paletteList').innerText;
    window.closePalette();
    return text;
  });
  s.check('command palette does not surface another marketer\'s guest',
    !palette.includes(SECRET), palette.slice(0, 160));

  // notifications are addressed to a profile, so the feed is another read path
  // that has to be scoped rather than filtered client-side
  const notifs = await s.page.evaluate(async (o) => {
    // Plant one addressed to KEREM so "no foreign items" is a real claim rather
    // than a statement about an empty feed.
    const KEY = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('"customers"'));
    const d = JSON.parse(localStorage.getItem(KEY));
    d.notifications = d.notifications || [];
    d.notifications.push({
      id: Math.max(0, ...d.notifications.map(n => n.id || 0)) + 1,
      type: 'PROBE', title: 'KEREM ONLY NOTIFICATION', message: o.secret,
      target_profile_id: o.keremId, read: 0, created_at: new Date().toISOString(),
    });
    localStorage.setItem(KEY, JSON.stringify(d));
    location.reload();
  }, { keremId: ids.keremId, secret: SECRET });
  await s.page.waitForTimeout(700);
  await s.loginSena();

  const feed = await s.page.evaluate(async (senaId) => {
    const r = await window.api.notifications.list({});
    if (!r.ok) return { blocked: r.error.code };
    const rows = r.data.rows || r.data;
    // The addressing field is target_profile_id. Filtering on a field that does
    // not exist yields zero every time and asserts nothing.
    const keys = rows.length ? Object.keys(rows[0]) : [];
    return {
      total: rows.length,
      hasAddressField: keys.includes('target_profile_id'),
      foreign: rows.filter(n => n.target_profile_id != null && n.target_profile_id !== senaId).length,
      body: JSON.stringify(rows).slice(0, 300),
    };
  }, ids.senaId);
  s.check('the notification feed is readable by a marketer', !feed.blocked, JSON.stringify(feed));
  s.check('the feed rows carry the addressing field the scope check depends on',
    feed.hasAddressField, JSON.stringify(feed));
  s.check('the notification feed carries no other profile\'s items',
    feed.foreign === 0, JSON.stringify(feed));
  s.check('the notification feed does not leak another marketer\'s guest',
    !String(feed.body).includes(SECRET), String(feed.body));

  // other marketers' business metrics stay masked
  const metrics = await s.page.evaluate(async (senaId) => {
    const profs = (await window.api.profiles.list({})).data;
    return profs.filter(p => p.id !== senaId).map(p => ({ n: p.full_name, c: p.customer_count, r: p.reservation_count }));
  }, ids.senaId);
  s.check('other profiles\' guest and reservation counts are masked',
    metrics.every(m => m.c === null && m.r === null), JSON.stringify(metrics));

  await s.close();
  return s.finish();
};
