'use strict';
/* THE TURKISH INTERFACE, DRIVEN IN THE REAL RENDERER.
 *
 * Language is a personal preference (appearance.language) like the theme;
 * the sign-in and setup screens follow the last language chosen on the
 * computer. Switching needs no reload. This probe sets up a real database,
 * switches to Turkish, walks every main screen at the two window sizes the
 * product is used at (1440x900 and 1366x768), and checks that the key labels
 * are Turkish and that nothing longer in Turkish is pushed out of its box.
 *
 * Set MERIT_SHOT_DIR to a folder to also write a screenshot of every screen.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const PW = 'harbour-lantern-quiet';

const PROBE = `
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
app.setPath('userData', process.env.MERIT_TEST_USERDATA);
require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))});
const consoleErrors = [];
const SHOT = process.env.MERIT_SHOT_DIR || '';

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  let win = null;
  const started = Date.now();
  while (!win && Date.now() - started < 20000) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await new Promise(r => setTimeout(r, 200));
  }
  if (!win) { console.log('PROBE:' + JSON.stringify({ error: 'no window' })); app.exit(1); return; }
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) consoleErrors.push({ message, source: String(source).split('/').pop(), line });
  });
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code)
    .catch((err) => { throw new Error(err.message + ' @ ' + code.replace(/\\s+/g, ' ').slice(0, 160)); });
  const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));
  let size = '1440';
  const resize = async (w, h) => { win.setContentSize(w, h); size = String(w); await settle(500); };
  const shot = async (name) => {
    if (!SHOT) return;
    const img = await win.webContents.capturePage();
    fs.mkdirSync(SHOT, { recursive: true });
    fs.writeFileSync(path.join(SHOT, name + '-' + size + '.png'), img.toPNG());
  };
  /* Page-level horizontal scroll, plus any visible label whose text is wider
     than the box it is drawn in (clipped, or spilling into its neighbour). */
  const layout = () => js(\`(() => {
    const doc = document.documentElement;
    const page = document.querySelector('.page.active');
    const scope = [...document.querySelectorAll('.page.active, .overlay.show, #appMenu, .topbar, .workspace-strip, #palette.show')];
    const sel = 'button, .nav-item, th, .view-switch-tab, .sc-l, .sc-sub, .fm-title, .setting-label, .panel-title, label, .tag, .card-tab, .ws-tab-label, .page-title, .seg button, .pc-metric .l, .as-l, .gf-l, .gp-fact-l, .pd-stat .l, .perm-head, .ac-head, .btn-link';
    const clipped = [];
    for (const root of scope) for (const n of root.querySelectorAll(sel)) {
      if (!n.offsetParent || !n.textContent.trim() || n.closest('.visually-hidden')) continue;
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden') continue;
      const over = n.scrollWidth - n.clientWidth;
      const hides = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis';
      if (over > 1 && (hides || cs.whiteSpace === 'nowrap')) clipped.push(n.textContent.trim().replace(/\\\\s+/g, ' ').slice(0, 60) + ' [' + over + 'px]');
    }
    return { pageOverflow: doc.scrollWidth - doc.clientWidth, pageWidth: page ? page.scrollWidth - page.clientWidth : 0, clipped: [...new Set(clipped)].slice(0, 25) };
  })()\`);
  const out = { layout: {} };
  const both = async (name, key) => {
    await resize(1440, 900); out.layout[key + '1440'] = await layout(); await shot(name);
    await resize(1366, 768); out.layout[key + '1366'] = await layout(); await shot(name);
    await resize(1440, 900);
  };
  await resize(1440, 900);
  await settle(600);

  // ---------------------------------------------- setup card follows the switch
  out.setup = await js(\`(async () => {
    const r = {};
    const card = document.getElementById('setupCard');
    r.enTitle = card.querySelector('.login-title').textContent;
    card.querySelector('[data-lang-choice="tr"]').click(); await new Promise(x => setTimeout(x, 150));
    r.trTitle = card.querySelector('.login-title').textContent;
    r.trButton = document.getElementById('setupBtn').textContent.trim();
    r.trLabel = card.querySelector('label[for="setupPass2"]').textContent;
    r.htmlLang = document.documentElement.lang;
    r.stored = localStorage.getItem('mmh.language');
    return r;
  })()\`);
  await shot('00-setup-tr');
  await js(\`document.querySelector('#setupCard [data-lang-choice="en"]').click()\`);
  await settle(150);
  out.setupBack = await js(\`document.querySelector('#setupCard .login-title').textContent\`);

  await js(\`(() => {
    document.getElementById('setupName').value = 'Owner Person';
    document.getElementById('setupUser').value = 'owner';
    document.getElementById('setupPass').value = ${JSON.stringify(PW)};
    document.getElementById('setupPass2').value = ${JSON.stringify(PW)};
    document.getElementById('setupBtn').click();
  })()\`);
  await settle(2500);

  // ------------------------------------------------------------- seed data
  out.seed = await js(\`(async () => {
    const a = window.api;
    const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
    const sena = (await a.profiles.create({ fullName: 'Sena Yılmaz', nationality: 'Türkiye' })).data;
    const kerem = (await a.profiles.create({ fullName: 'Kerem Aydın' })).data;
    await a.users.create({ username: 'sena', password: ${JSON.stringify(PW)}, role: 'MARKETING', profileId: sena.id, fullName: 'Sena Yılmaz', active: true });
    const guest = async (code, name, extra = {}) => (await a.customers.create({ code, fullName: name, registered: true, ...extra })).data.id;
    const bd = day(2).slice(5);
    const weber = await guest('G1006', 'Thomas Weber', { marketingProfileId: sena.id, phone: '+90 532 111 22 33', passportNo: 'U1234567', birthDate: '1979-' + bd, notes: 'Deniz manzaralı oda tercih ediyor.' });
    const cohen = await guest('G1005', 'Avi Cohen', { marketingProfileId: kerem.id, phone: '0555 999 88 77' });
    await guest('G1007', 'Ayşe Demir', {});
    await a.crmNotes.create({ customerId: weber, note: 'Arandı, süit için geri dönecek.', remindOn: day(0) });
    await a.crmNotes.create({ customerId: cohen, note: 'Bahar teklifi gönderildi.', noteDate: day(-40) });
    await a.reservations.create({ customerId: weber, checkIn: day(1), checkOut: day(4), invitedByProfileId: sena.id });
    await a.reservations.create({ customerId: cohen, checkIn: day(-50), checkOut: day(-47), invitedByProfileId: kerem.id });
    const vip = (await a.tags.create({ name: 'VIP', color: 'gold' })).data;
    await a.customers.setTags({ id: weber, tagIds: [vip.id] });
    return { weber, cohen };
  })()\`);
  const ids = out.seed;

  // ------------------------------------- English first, then switch in Settings
  out.switch = await js(\`(async () => {
    const r = {};
    await switchTab('dashboard'); await new Promise(x => setTimeout(x, 800));
    r.enNav = document.querySelector('.nav-item[data-page="dashboard"]').textContent.trim();
    r.enLang = document.documentElement.lang;
    await switchTab('settings'); await new Promise(x => setTimeout(x, 700));
    r.selectBefore = document.getElementById('setLanguage').value;
    const sel = document.getElementById('setLanguage');
    sel.value = 'tr';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(x => setTimeout(x, 900));
    r.reloaded = !state.session;
    r.htmlLang = document.documentElement.lang;
    r.nav = ['dashboard','reservations','calendar','customers','profiles','reports','audit','users','settings','help']
      .map(p => document.querySelector('.nav-item[data-page="' + p + '"]')?.textContent.trim());
    r.title = document.querySelector('#page-settings .page-title').textContent;
    r.themeLabel = document.querySelector('[data-i18n="h.theme"]').textContent;
    r.langLabel = document.querySelector('[data-i18n="h.language"]').textContent;
    r.tab = document.querySelector('.ws-tab.active .ws-tab-label').textContent;
    r.crumbs = document.getElementById('topbarCrumbs').textContent;
    r.role = document.getElementById('sessionRole').textContent;
    r.stored = (await window.api.settings.all({})).data['appearance.language'];
    r.search = document.querySelector('#topbarSearchBtn span').textContent;
    return r;
  })()\`);
  await both('13-settings-tr', 'settings');

  // ---------------------------------------------------------------- screens
  out.dash = await js(\`(async () => {
    await switchTab('dashboard'); await new Promise(x => setTimeout(x, 1200));
    const p = document.getElementById('page-dashboard');
    return {
      kpis: [...p.querySelectorAll('.stat-cell .sc-l')].map(n => n.textContent),
      panels: [...p.querySelectorAll('.panel-title')].map(n => n.firstChild?.textContent || n.textContent),
      due: [...document.querySelectorAll('#dueTodayList .due-pill')].map(n => n.textContent),
      text: p.innerText,
    };
  })()\`);
  await both('01-dashboard-tr', 'dash');

  out.res = await js(\`(async () => {
    await switchTab('reservations'); await new Promise(x => setTimeout(x, 900));
    const p = document.getElementById('page-reservations');
    return { heads: [...p.querySelectorAll('thead th')].map(n => n.textContent.trim()), tags: [...p.querySelectorAll('#resTableBody .tag')].map(n => n.textContent.trim()), text: p.innerText };
  })()\`);
  await both('02-reservations-tr', 'res');

  out.cal = await js(\`(async () => {
    await switchTab('calendar'); await new Promise(x => setTimeout(x, 900));
    return { month: document.getElementById('calMonthLabel').textContent, days: [...document.querySelectorAll('.cal-weekdays div')].map(n => n.textContent) };
  })()\`);
  await both('03-calendar-tr', 'cal');

  out.crm = await js(\`(async () => {
    await goToGuest(${'${ids.weber}'}, 'customers'); await new Promise(x => setTimeout(x, 1200));
    const p = document.getElementById('page-customers');
    const panel = document.getElementById('detailPanel');
    return { heads: [...p.querySelectorAll('#crmPane_overview thead th')].map(n => n.textContent.trim()),
      tabs: [...document.querySelectorAll('#crmViewTabs .view-switch-tab')].map(n => n.textContent.trim()),
      cardTabs: [...panel.querySelectorAll('.card-tab')].map(n => n.textContent.trim()),
      templates: [...panel.querySelectorAll('.tpl-chip')].map(n => n.textContent),
      panelText: panel.innerText };
  })()\`);
  await both('04-crm-overview-tr', 'crm');

  await js(\`(async () => { await setCrmView('customerlist'); await new Promise(x => setTimeout(x, 800)); toggleFilterMenu('listFilterMenu'); await new Promise(x => setTimeout(x, 200)); })()\`);
  await both('05-customer-list-filters-tr', 'list');
  await js(\`closeAllFilterMenus()\`);

  out.guest = await js(\`(async () => {
    await openGuestPage(${'${ids.weber}'}); await new Promise(x => setTimeout(x, 1200));
    return { text: document.getElementById('guestPageBody').innerText };
  })()\`);
  await both('06-guest-record-tr', 'guest');

  out.activity = await js(\`(async () => {
    await openTodaysActivity(); await new Promise(x => setTimeout(x, 1200));
    return { text: document.getElementById('custActivityView').innerText };
  })()\`);
  await both('07-activity-tr', 'activity');
  await js(\`setCustMode('table')\`);

  await js(\`(async () => { await switchTab('profiles'); await new Promise(x => setTimeout(x, 900)); })()\`);
  await both('08-profiles-tr', 'profiles');

  out.reports = await js(\`(async () => {
    await switchTab('reports'); await new Promise(x => setTimeout(x, 700));
    await runReport(); await new Promise(x => setTimeout(x, 900));
    const p = document.getElementById('page-reports');
    return { tabs: [...p.querySelectorAll('#reportTypeTabs .view-switch-tab')].map(n => n.textContent.trim()), heads: [...p.querySelectorAll('#reportResultsHead th')].map(n => n.textContent), count: document.getElementById('reportResultCount').textContent };
  })()\`);
  await both('09-reports-tr', 'reports');

  out.audit = await js(\`(async () => {
    await switchTab('audit'); await new Promise(x => setTimeout(x, 900));
    const p = document.getElementById('page-audit');
    return { heads: [...p.querySelectorAll('thead th')].map(n => n.textContent.trim()), actions: [...p.querySelectorAll('.audit-action')].slice(0, 5).map(n => n.textContent), any: document.getElementById('auditFAction').options[0].textContent };
  })()\`);
  await both('10-audit-tr', 'audit');

  await js(\`(async () => { await switchTab('users'); await new Promise(x => setTimeout(x, 700)); })()\`);
  await both('11-users-tr', 'users');

  out.team = await js(\`(async () => {
    await switchTab('team'); await new Promise(x => setTimeout(x, 1000));
    return { text: document.getElementById('teamBody').innerText.slice(0, 600) };
  })()\`);
  await both('12-team-tr', 'team');

  out.help = await js(\`(async () => {
    await switchTab('help'); await new Promise(x => setTimeout(x, 700));
    return { title: document.querySelector('#page-help .page-title').textContent,
      firstHeading: document.querySelector('#helpBody h2, #helpBody h3')?.textContent || '',
      toc: document.querySelectorAll('#helpToc li').length,
      scripts: document.querySelectorAll('#helpBody script, #helpBody iframe').length,
      images: [...document.querySelectorAll('#helpBody img')].map(i => i.getAttribute('src')),
      brokenLinks: [...document.querySelectorAll('#page-help [data-help-target]')].filter(a => !document.getElementById(a.dataset.helpTarget)).map(a => a.textContent),
      outsideLinks: [...document.querySelectorAll('#helpBody a')].filter(a => a.getAttribute('href') !== '#').length };
  })()\`);
  await both('14-help-tr', 'help');

  // ------------------------------------------------------ dialogs and search
  await js(\`(async () => { await switchTab('reservations'); openReservationModal(); await new Promise(x => setTimeout(x, 700)); })()\`);
  out.resModal = await js(\`document.getElementById('modalReservation').innerText.slice(0, 400)\`);
  await both('15-new-reservation-tr', 'resModal');
  await js(\`closeModal('modalReservation')\`);

  await js(\`(async () => { await switchTab('customers'); openImportDialog(); await new Promise(x => setTimeout(x, 700)); })()\`);
  await both('16-import-tr', 'import');
  await js(\`closeModal('modalImport')\`);

  await js(\`(async () => { await exportCurrentView('customers'); await new Promise(x => setTimeout(x, 700)); })()\`);
  out.exportModal = await js(\`document.getElementById('modalExport').innerText.slice(0, 300)\`);
  await both('17-export-tr', 'export');
  await js(\`closeModal('modalExport')\`);

  await js(\`(async () => { openMonthlyReport(); await new Promise(x => setTimeout(x, 400)); })()\`);
  await both('18-monthly-report-tr', 'monthly');
  await js(\`closeModal('modalMonthlyReport')\`);

  out.palette = await js(\`(async () => {
    openPalette(); await new Promise(x => setTimeout(x, 300));
    const input = document.getElementById('paletteInput');
    input.value = 'web'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(x => setTimeout(x, 900));
    return { groups: [...document.querySelectorAll('#paletteList .palette-group')].map(n => n.firstChild.textContent.trim()), meta: document.getElementById('paletteMeta').textContent };
  })()\`);
  await both('19-search-tr', 'palette');
  await js(\`closePalette()\`);

  out.shortcuts = await js(\`(async () => { showShortcuts(); await new Promise(x => setTimeout(x, 300)); return document.getElementById('modalShortcuts').innerText; })()\`);
  await both('20-shortcuts-tr', 'shortcuts');
  await js(\`closeModal('modalShortcuts')\`);

  out.errors = await js(\`(async () => {
    const r = {};
    const before = document.querySelectorAll('#toastStack .toast').length;
    try { await call(window.api.customers.get, { id: 987654 }); } catch (e) { r.message = e.message; r.code = e.code; }
    await new Promise(x => setTimeout(x, 200));
    r.toast = [...document.querySelectorAll('#toastStack .toast .t-title')].map(n => n.textContent).slice(before);
    return r;
  })()\`);

  // --------------------------------- sign out: the login card stays Turkish
  out.logout = await js(\`(async () => {
    await doLogout(); await new Promise(x => setTimeout(x, 800));
    return { button: document.getElementById('loginBtn').textContent.trim(), user: document.querySelector('label[for="loginUser"]').textContent, lang: document.documentElement.lang };
  })()\`);
  await both('00-login-tr', 'login');

  /* Language is per user: sena signs in, picks English for herself, and the
     owner still gets Turkish back on his next sign-in. */
  out.perUser = await js(\`(async () => {
    const r = {};
    let s = await window.api.auth.login({ username: 'sena', password: ${JSON.stringify(PW)} });
    state.session = s.data; await enterApp(); await new Promise(x => setTimeout(x, 900));
    r.senaStart = document.documentElement.lang;
    applyLanguage('en', true); await new Promise(x => setTimeout(x, 600));
    r.senaNav = document.querySelector('.nav-item[data-page="dashboard"]').textContent.trim();
    await doLogout(); await new Promise(x => setTimeout(x, 600));
    r.loginAfterSena = document.getElementById('loginBtn').textContent.trim();
    s = await window.api.auth.login({ username: 'owner', password: ${JSON.stringify(PW)} });
    state.session = s.data; await enterApp(); await new Promise(x => setTimeout(x, 900));
    r.ownerLang = document.documentElement.lang;
    r.ownerNav = document.querySelector('.nav-item[data-page="dashboard"]').textContent.trim();
    return r;
  })()\`);

  out.consoleErrors = consoleErrors;
  console.log('PROBE:' + JSON.stringify(out));
  app.exit(0);
}).catch((err) => {
  console.log('PROBE:' + JSON.stringify({ error: err.message, stack: String(err.stack).split('\\n').slice(0, 5) }));
  app.exit(1);
});
`;

function runElectron(userData, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, 'i18n-entry.js');
    fs.writeFileSync(probeFile, PROBE);
    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb ? ['-a', '-s', '-screen 0 1600x1000x24', ELECTRON, '--no-sandbox', probeFile] : [probeFile];
    const env = { ...process.env, MERIT_TEST_USERDATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { env, cwd: ROOT });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, stdout, stderr }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

module.exports = async function () {
  const s = new Suite('electron/i18n-ui');
  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-i18n-ui-'));
  try {
    const run = await runElectron(userData);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the application starts and the language probe completes', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stdout.slice(-800)}\n${run.stderr.slice(-1200)}`);
    if (!line) return s.finish();
    const p = JSON.parse(line.slice('PROBE:'.length));
    if (p.error) {
      s.check('the probe ran without throwing', false, `${p.error}\n${(p.stack || []).join('\n')}`);
      return s.finish();
    }
    if (process.env.MERIT_I18N_DUMP) fs.writeFileSync(process.env.MERIT_I18N_DUMP, JSON.stringify(p, null, 2));
    const J = (v) => JSON.stringify(v);

    // setup / login screens
    s.check('the setup card starts in English', p.setup.enTitle === 'Welcome', p.setup.enTitle);
    s.check('the language switch turns the setup card Turkish at once',
      p.setup.trTitle === 'Hoş geldiniz' && p.setup.trButton === 'HESAP OLUŞTUR' && p.setup.trLabel === 'Şifreyi onaylayın', J(p.setup));
    s.check('the page language follows the switch', p.setup.htmlLang === 'tr', p.setup.htmlLang);
    s.check('the choice is remembered on this computer for the sign-in screen', p.setup.stored === 'tr', p.setup.stored);
    s.check('switching back restores English', p.setupBack === 'Welcome', p.setupBack);

    // switching in Settings
    const w = p.switch;
    s.check('an account with no language preference starts in English', w.enNav === 'Dashboard' && w.enLang === 'en' && w.selectBefore === 'en', J(w));
    s.check('changing Language in Settings needs no reload', w.reloaded === false);
    s.check('the navigation turns Turkish',
      J(w.nav) === J(['Gösterge paneli', 'Rezervasyon geçmişi', 'Eylem takvimi', 'CRM paneli0', 'Profiller', 'Raporlar', 'Denetim kaydı', 'Kullanıcılar', 'Ayarlar', 'Yardım'])
        || (w.nav[0] === 'Gösterge paneli' && w.nav[1] === 'Rezervasyon geçmişi' && w.nav[2] === 'Eylem takvimi' && /^CRM paneli/.test(w.nav[3]) && w.nav[4] === 'Profiller' && w.nav[8] === 'Ayarlar' && w.nav[9] === 'Yardım'), J(w.nav));
    s.check('page title, tab, breadcrumb and role are Turkish',
      w.title === 'Ayarlar' && w.tab === 'Ayarlar' && /Yönetim/.test(w.crumbs) && w.role === 'Yönetici', J(w));
    s.check('Language sits next to Theme in Appearance', w.themeLabel === 'Tema' && w.langLabel === 'Dil', J(w));
    s.check('the choice is stored as the personal appearance.language preference', w.stored === 'tr', w.stored);
    s.check('the html lang attribute is tr', w.htmlLang === 'tr', w.htmlLang);
    s.check('the top search box is Turkish', w.search === 'Ara…', w.search);

    // screens
    s.check('dashboard KPI cards are Turkish', p.dash.kpis.includes('Toplam misafir') && p.dash.kpis.includes('Rezervasyonlar'), J(p.dash.kpis));
    s.check('dashboard panels are Turkish', p.dash.panels.includes('Bildirimler') && p.dash.panels.includes('Bugün yapılacaklar'), J(p.dash.panels));
    s.check('a due follow-up says bugün', p.dash.due.includes('bugün'), J(p.dash.due));
    s.check('the dashboard never prints "undefined" or "null"', !/undefined|\bnull\b/.test(p.dash.text));
    s.check('reservation table headers are Turkish', p.res.heads.includes('AD SOYAD') && p.res.heads.some((h) => h.startsWith('GİRİŞ')) && p.res.heads.includes('DAVET EDEN'), J(p.res.heads));
    s.check('reservation status badges are Turkish', p.res.tags.some((x) => x === 'GELECEK' || x === 'TAMAMLANDI'), J(p.res.tags));
    s.check('calendar month and weekdays are Turkish', /^(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık) \d{4}$/.test(p.cal.month) && p.cal.days[0] === 'PZT', J(p.cal));
    s.check('CRM panel tabs and headers are Turkish',
      p.crm.tabs[0] === 'Genel bakış' && p.crm.heads.includes('SON CRM NOTU'), J(p.crm));
    s.check('the guest panel is Turkish', p.crm.cardTabs[0] === 'Özet' && /Ayrıntılar/.test(p.crm.panelText) && /Not ekle/.test(p.crm.panelText), J(p.crm.cardTabs));
    s.check('the built-in note templates are Turkish', p.crm.templates.includes('Teklif gönderildi'), J(p.crm.templates));
    s.check('the full guest record is Turkish', /Geçmiş/.test(p.guest.text) && /İletişim ve kimlik/.test(p.guest.text), p.guest.text.slice(0, 300));
    s.check('Today\'s activity is Turkish', /Bugün/.test(p.activity.text) && /İşlemler/.test(p.activity.text), p.activity.text.slice(0, 300));
    s.check('report tabs, columns and count are Turkish',
      p.reports.tabs[0] === 'Rezervasyonlar' && p.reports.heads.includes('GİRİŞ') && /sonuç$/.test(p.reports.count), J(p.reports));
    s.check('audit headers and action names are Turkish', p.audit.heads.includes('ZAMAN') && p.audit.any === 'Tüm işlemler' && p.audit.actions.length > 0 && !p.audit.actions.some((a) => /^[A-Z_]+$/.test(a)), J(p.audit));
    s.check('Team control is Turkish', /Atanmamış misafirler/.test(p.team.text) && /Ekip/.test(p.team.text), p.team.text.slice(0, 200));
    s.check('Help opens the Turkish manual', p.help.title === 'Kullanım kılavuzu' && p.help.toc > 0 && /Merit|Başlarken|Kurulum/.test(p.help.firstHeading), J(p.help));
    s.check('the manual renders no script or frame', p.help.scripts === 0);
    s.check('every jump in the manual lands on a heading', p.help.brokenLinks.length === 0, J(p.help.brokenLinks));
    s.check('the manual links nowhere outside itself', p.help.outsideLinks === 0, String(p.help.outsideLinks));
    s.check('the manual shows its bundled screenshots', p.help.images.length >= 5 && p.help.images.every((src) => /^\.\/manual-images\/tr-[a-z-]+\.png$/.test(src)), J(p.help.images));
    s.check('the new-reservation dialog is Turkish', /Yeni rezervasyon/.test(p.resModal) && /Kaydet/.test(p.resModal) && /Davet eden/i.test(p.resModal), p.resModal);
    s.check('the export dialog is Turkish', /Dışa aktar/.test(p.exportModal) && /Excel çalışma kitabı/.test(p.exportModal), p.exportModal);
    s.check('search groups and help text are Turkish', p.palette.groups.includes('Misafirler') && /kayıt bulundu|Eşleşen kayıt yok/.test(p.palette.meta), J(p.palette));
    s.check('keyboard shortcuts help is Turkish', /Klavye kısayolları/.test(p.shortcuts) && /Arama kutusuna git/.test(p.shortcuts), p.shortcuts.slice(0, 200));
    s.check('a main-process error is shown in Turkish, its code unchanged',
      p.errors.message === 'Misafir bulunamadı.' && p.errors.code === 'NOT_FOUND' && p.errors.toast.includes('İşlem tamamlanamadı'), J(p.errors));

    // sign-out and per-user preference
    s.check('after signing out the login card stays Turkish',
      p.logout.button === 'GİRİŞ YAP' && p.logout.user === 'Kullanıcı adı' && p.logout.lang === 'tr', J(p.logout));
    s.check('a user without a preference keeps the sign-in screen language', p.perUser.senaStart === 'tr', J(p.perUser));
    s.check('each user\'s choice is their own',
      p.perUser.senaNav === 'Dashboard' && p.perUser.loginAfterSena === 'SIGN IN' && p.perUser.ownerLang === 'tr' && p.perUser.ownerNav === 'Gösterge paneli', J(p.perUser));

    // layout at both sizes
    for (const [key, l] of Object.entries(p.layout)) {
      s.check(`no horizontal scroll in Turkish (${key})`, l.pageOverflow <= 0, J(l));
      s.check(`no Turkish label is clipped (${key})`, l.clipped.length === 0, J(l.clipped));
    }
    s.check('no console errors while switching and walking the screens', p.consoleErrors.length === 0, J(p.consoleErrors));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return s.finish();
};
