'use strict';
/* APPEARANCE — theme and density are PER USER.
 *
 * A shared appearance setting is a small bug with a large blast radius on a
 * shift-shared workstation: whoever signed in last decides what everybody else
 * sees. Theme and density are personal keys and must resolve to the calling
 * user's own saved choice.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('ui/appearance');
  await s.open();
  await s.bootstrap();
  await s.seedMarketingUser();

  // -------------------------------------------------------- controls do work
  const controls = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('settings');
    await new Promise(r => setTimeout(r, 350));
    const t = document.getElementById('setTheme');
    const d = document.getElementById('setDensity');
    t.value = 'dark'; t.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const dark = document.body.classList.contains('theme-dark');
    d.value = 'compact'; d.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    const compact = document.body.classList.contains('density-compact');
    d.value = 'comfortable'; d.dispatchEvent(new Event('change'));
    t.value = 'light'; t.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 200));
    return { dark, compact, backLight: !document.body.classList.contains('theme-dark') };
  });
  s.check('the theme control switches the app to dark', controls.dark, JSON.stringify(controls));
  s.check('the density control switches the app to compact', controls.compact, JSON.stringify(controls));
  s.check('the theme control switches back to light', controls.backLight, JSON.stringify(controls));

  // -------------------------------- a fresh user inherits the SHARED default
  // The shared default ships as 'dark'. ADMIN picks 'light' as a PERSONAL
  // choice, so the two differ and the next assertion can actually distinguish
  // "inherited the shared default" from "inherited whoever signed in last" —
  // which is the bug this suite exists to catch.
  const sharedDefault = await s.page.evaluate(() => {
    const KEY = Object.keys(localStorage).find(k => (localStorage.getItem(k) || '').includes('"customers"'));
    return JSON.parse(localStorage.getItem(KEY)).settings['appearance.theme'];
  });
  s.check('the shared default theme is readable and is dark',
    sharedDefault === 'dark', String(sharedDefault));

  await s.loginAdmin();
  await s.page.evaluate(() => window.applyTheme('light', true));
  await s.page.waitForTimeout(250);
  const adminChose = await s.page.evaluate(() => document.body.classList.contains('theme-dark'));
  s.check('ADMIN\'s personal choice of light took effect', adminChose === false, String(adminChose));

  await s.loginSena();
  const senaInherited = await s.page.evaluate(() => document.body.classList.contains('theme-dark'));
  s.check('a user who has not chosen yet gets the shared default, not the previous user\'s choice',
    senaInherited === true, `senaDark=${senaInherited} adminChose=light sharedDefault=${sharedDefault}`);

  // ------------------------------------------------------ per-user isolation
  await s.loginAdmin();
  await s.page.evaluate(() => window.applyTheme('dark', true));
  await s.page.waitForTimeout(250);

  await s.loginSena();
  await s.page.evaluate(() => window.applyTheme('light', true));
  await s.page.waitForTimeout(250);

  await s.loginAdmin();
  const adminTheme = await s.page.evaluate(() => document.body.classList.contains('theme-dark'));
  await s.loginSena();
  const senaTheme = await s.page.evaluate(() => document.body.classList.contains('theme-dark'));

  s.check('ADMIN keeps dark after another user chose light', adminTheme === true, `adminDark=${adminTheme}`);
  s.check('MARKETING keeps light independently', senaTheme === false, `senaDark=${senaTheme}`);

  // density is personal on the same terms
  await s.loginAdmin();
  await s.page.evaluate(() => window.applyDensity('compact', true));
  await s.page.waitForTimeout(250);
  await s.loginSena();
  await s.page.evaluate(() => window.applyDensity('comfortable', true));
  await s.page.waitForTimeout(250);
  const senaDensity = await s.page.evaluate(() => document.body.classList.contains('density-compact'));
  await s.loginAdmin();
  const adminDensity = await s.page.evaluate(() => document.body.classList.contains('density-compact'));
  s.check('ADMIN keeps compact density after another user chose comfortable',
    adminDensity === true, `adminCompact=${adminDensity}`);
  s.check('the other user\'s comfortable density stayed theirs alone',
    senaDensity === false, `senaCompact=${senaDensity}`);

  // ---------------------------------------- the preference survives a reload
  await s.page.reload();
  await s.page.waitForTimeout(700);
  await s.page.evaluate(() => {
    document.getElementById('loginUser').value = 'admin';
    document.getElementById('loginPass').value = 'admin123';
  });
  await s.page.evaluate(() => window.doLogin());
  await s.page.waitForTimeout(600);
  const persisted = await s.page.evaluate(() => ({
    dark: document.body.classList.contains('theme-dark'),
    compact: document.body.classList.contains('density-compact'),
  }));
  s.check('the personal theme survives a reload', persisted.dark === true, JSON.stringify(persisted));
  s.check('the personal density survives a reload', persisted.compact === true, JSON.stringify(persisted));

  // ------------------------------- appearance keys are writable by every role
  await s.loginSena();
  const marketingWrite = await s.page.evaluate(async () => ({
    theme: (await window.api.settings.set({ key: 'appearance.theme', value: 'dark' })).ok,
    density: (await window.api.settings.set({ key: 'appearance.density', value: 'compact' })).ok,
    shared: (await window.api.settings.set({ key: 'notifications.manager_feed', value: 'false' })).error?.code || 'ALLOWED',
  }));
  s.check('MARKETING may set their own theme', marketingWrite.theme === true, JSON.stringify(marketingWrite));
  s.check('MARKETING may set their own density', marketingWrite.density === true, JSON.stringify(marketingWrite));
  s.check('MARKETING may not change a shared, non-personal setting',
    marketingWrite.shared === 'FORBIDDEN', String(marketingWrite.shared));

  await s.close();
  return s.finish();
};
