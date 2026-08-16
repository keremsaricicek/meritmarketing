'use strict';
/* SCREEN RENDER + MENU GATING PER ROLE.
 *
 * Two separate claims are checked here and they must not be conflated:
 *   1. every screen a role is allowed to reach renders without throwing;
 *   2. the application menu offers exactly the destinations that role should see.
 *
 * (2) is a usability property, never a security one. The authorization suites
 * prove the boundary; this file only proves the menu is honest about it.
 */

const { Suite } = require('../lib/harness');

const PAGES = ['dashboard', 'reservations', 'calendar', 'customers', 'profiles', 'reports', 'audit', 'users', 'settings'];

const EXPECTED = {
  ADMIN:     { users: true,  audit: true,  profiles: true },
  MANAGER:   { users: false, audit: true,  profiles: true },
  MARKETING: { users: false, audit: false, profiles: false },
};

module.exports = async function () {
  const s = new Suite('ui/screens');
  await s.open();
  await s.bootstrap();
  await s.seedMarketingUser();

  for (const [role, signIn] of [
    ['ADMIN', () => s.loginAdmin()],
    ['MANAGER', () => s.loginManager()],
    ['MARKETING', () => s.loginSena()],
  ]) {
    await signIn();
    const seen = await s.page.evaluate(async (pages) => {
      const out = {};
      for (const pg of pages) {
        await window.openWorkspaceTab(pg);
        await new Promise(r => setTimeout(r, 140));
        out[pg] = document.querySelector('.page.active')?.id || null;
      }
      const menu = [...document.querySelectorAll('.nav-item[data-page]')]
        .filter(n => !n.classList.contains('hidden'))
        .map(n => n.dataset.page);
      return { out, menu };
    }, PAGES);

    s.check(`${role}: every screen renders without throwing`,
      Object.values(seen.out).every(Boolean), JSON.stringify(seen.out));
    for (const [page, expected] of Object.entries(EXPECTED[role])) {
      s.check(`${role}: the ${page} destination is gated correctly in the menu`,
        seen.menu.includes(page) === expected, JSON.stringify(seen.menu));
    }
  }

  // ------------------------------------------------- dashboard composition
  // Panels that only make sense with full visibility must not render for a
  // marketer, and the KPI strip must carry Active Marketing for management.
  const strips = {};
  for (const [role, signIn] of [
    ['ADMIN', () => s.loginAdmin()],
    ['MANAGER', () => s.loginManager()],
    ['MARKETING', () => s.loginSena()],
  ]) {
    await signIn();
    strips[role] = await s.page.evaluate(async () => {
      await window.openWorkspaceTab('dashboard');
      await new Promise(r => setTimeout(r, 450));
      const col = document.getElementById('rankCol');
      const attention = document.getElementById('attentionList')
        ?.closest('.panel')?.querySelector('.panel-title')?.textContent.trim();
      return {
        kpis: [...document.querySelectorAll('.stat-cell .sc-l')].map(l => l.textContent.trim()),
        rankColVisible: !!col && getComputedStyle(col).display !== 'none',
        attention,
      };
    });
  }
  s.check('ADMIN sees the Active Marketing KPI',
    strips.ADMIN.kpis.includes('Active Marketing'), JSON.stringify(strips.ADMIN.kpis));
  s.check('MANAGER sees the Active Marketing KPI',
    strips.MANAGER.kpis.includes('Active Marketing'), JSON.stringify(strips.MANAGER.kpis));
  s.check('MARKETING does not see the Active Marketing KPI',
    !strips.MARKETING.kpis.includes('Active Marketing'), JSON.stringify(strips.MARKETING.kpis));
  s.check('every role gets a populated KPI strip',
    Object.values(strips).every(v => v.kpis.length > 0), JSON.stringify(Object.keys(strips)));

  // The fourth dashboard column answers a management question (who is
  // producing, who is newly on the books) and is not shown to a marketer.
  s.check('ADMIN sees the marketing ranking column', strips.ADMIN.rankColVisible, JSON.stringify(strips.ADMIN));
  s.check('MANAGER sees the marketing ranking column', strips.MANAGER.rankColVisible, JSON.stringify(strips.MANAGER));
  s.check('MARKETING does not see the marketing ranking column',
    !strips.MARKETING.rankColVisible, JSON.stringify(strips.MARKETING));
  s.check('management sees the panel framed as "Requires Attention"',
    strips.ADMIN.attention === 'Requires Attention' && strips.MANAGER.attention === 'Requires Attention',
    JSON.stringify([strips.ADMIN.attention, strips.MANAGER.attention]));
  s.check('a marketer sees the same panel framed as their call list',
    strips.MARKETING.attention === 'Needs A Call', String(strips.MARKETING.attention));

  // ------------------------------------------------ no cross-session leakage
  // Signing in as someone else must not inherit the previous user's selection
  // or in-flight search text.
  await s.loginAdmin();
  await s.page.evaluate(async () => {
    await window.openWorkspaceTab('customers');
    await window.setCrmView('customerlist');
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('listSearch').value = 'MEHMET';
    document.querySelector('#listTableBody tr')?.click();
    await new Promise(r => setTimeout(r, 350));
  });
  await s.loginSena();
  const leak = await s.page.evaluate(() => ({
    selected: window.state?.selectedCustomerId ?? null,
    search: document.getElementById('listSearch')?.value ?? '',
  }));
  s.check('signing in as another user carries over no selected guest',
    !leak.selected, JSON.stringify(leak));
  s.check('signing in as another user carries over no search text',
    !leak.search, JSON.stringify(leak));

  await s.close();
  return s.finish();
};
