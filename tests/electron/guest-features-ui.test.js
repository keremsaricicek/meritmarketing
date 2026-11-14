'use strict';
/* THE 1.2 GUEST FEATURES, DRIVEN IN THE REAL RENDERER.
 *
 * Follow-up reminders, note templates, duplicate warnings, merging, tags,
 * birthdays, saved views, keyboard shortcuts and recently viewed guests —
 * against the real main process and a real database, at the two window sizes
 * the product is used at (1440x900 and 1366x768).
 *
 * Set MERIT_SHOT_DIR to a folder to also write a screenshot of every screen
 * this visits; the layout checks below run either way.
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
  /* A failing step names itself, so a broken probe says where it broke. */
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
  /* No horizontal page scroll, and nothing poking out of the window. */
  const layout = () => js(\`(() => {
    const doc = document.documentElement;
    const page = document.querySelector('.page.active');
    return { pageOverflow: doc.scrollWidth - doc.clientWidth, pageWidth: page ? page.scrollWidth - page.clientWidth : 0 };
  })()\`);
  await resize(1440, 900);
  await settle(600);
  const out = { layout: {} };

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
    const sena = (await a.profiles.create({ fullName: 'Sena Yilmaz' })).data;
    const kerem = (await a.profiles.create({ fullName: 'Kerem Aydin' })).data;
    await a.users.create({ username: 'sena', password: ${JSON.stringify(PW)}, role: 'MARKETING', profileId: sena.id, fullName: 'Sena Yilmaz', active: true });
    const guest = async (code, name, extra = {}) => (await a.customers.create({ code, fullName: name, registered: true, ...extra })).data.id;
    const bd = day(2).slice(5);
    const weber = await guest('G1006', 'Thomas Weber', { marketingProfileId: sena.id, phone: '+90 532 111 22 33', passportNo: 'U1234567', birthDate: '1979-' + bd, notes: 'Prefers sea-view room.' });
    const cohen = await guest('G1005', 'Avi Cohen', { marketingProfileId: kerem.id, phone: '0555 999 88 77', passportNo: 'P7654321' });
    const dup = await guest('G1099', 'T. Weber', { marketingProfileId: sena.id, email: 'tw@example.com' });
    await a.crmNotes.create({ customerId: weber, note: 'Called, will call back about the suite.', remindOn: day(0) });
    await a.crmNotes.create({ customerId: weber, note: 'Asked for the spring offer.', noteDate: day(-3), remindOn: day(-2) });
    await a.crmNotes.create({ customerId: dup, note: 'Note on the duplicate record.' });
    await a.reservations.create({ customerId: weber, checkIn: day(10), checkOut: day(13), invitedByProfileId: sena.id });
    await a.reservations.create({ customerId: dup, checkIn: day(40), checkOut: day(42), invitedByProfileId: sena.id });
    const vip = (await a.tags.create({ name: 'VIP', color: 'gold' })).data;
    const high = (await a.tags.create({ name: 'High budget', color: 'green' })).data;
    await a.customers.setTags({ id: weber, tagIds: [vip.id, high.id] });
    await a.customers.setDates({ id: weber, dates: [{ label: 'Wedding anniversary', month: Number(day(0).slice(5, 7)), day: Number(day(0).slice(8, 10)) }] });
    return { weber, cohen, dup, vip: vip.id, high: high.id, overlapIn: day(11), overlapOut: day(12) };
  })()\`);
  const ids = out.seed;

  // --------------------------------------------------------------- dashboard
  out.dash = await js(\`(async () => {
    await switchTab('dashboard'); await new Promise(r => setTimeout(r, 1200));
    return {
      due: [...document.querySelectorAll('#dueTodayList .list-row')].map(r => r.querySelector('.lr-name').textContent + '|' + r.querySelector('.due-pill').textContent),
      dueCount: document.getElementById('dueTodayCount').textContent,
      dates: [...document.querySelectorAll('#upcomingDatesList .list-row .lr-sub')].map(n => n.textContent),
      recentEmpty: document.getElementById('recentGuestsList').textContent.trim(),
      notifTitles: [...document.querySelectorAll('#notifList .notif-title')].map(n => n.textContent),
      text: document.getElementById('page-dashboard').innerText,
    };
  })()\`);
  out.layout.dash1440 = await layout();
  await shot('01-dashboard');
  await resize(1366, 768);
  out.layout.dash1366 = await layout();
  await shot('01-dashboard');
  await resize(1440, 900);

  // ------------------------------------------------------------- guest panel
  out.panel = await js(\`(async () => {
    const r = {};
    await goToGuest(${'${ids.weber}'}, 'customers'); await new Promise(x => setTimeout(x, 1000));
    const p = document.getElementById('detailPanel');
    r.tags = [...p.querySelectorAll('.guest-tags .tag-chip')].map(t => t.textContent);
    r.reminders = p.querySelectorAll('.reminder-row').length;
    r.templates = [...p.querySelectorAll('.note-templates .tpl-chip')].map(b => b.textContent);
    r.hasRemindInput = !!p.querySelector('.composer-remind input[type="date"]');
    r.birthday = /Birthday/i.test(p.innerText) && /Wedding anniversary/i.test(p.innerText);
    r.facts = p.querySelector('.gi-facts')?.innerText;
    r.rowTags = [...document.querySelectorAll('#custTableBody tr')].filter(tr => tr.querySelector('.tag-chip')).length;
    p.querySelector('.note-templates .tpl-chip').click();
    r.afterTemplate = p.querySelector('.note-composer textarea').value;
    p.querySelectorAll('.note-templates .tpl-chip')[3].click();
    r.afterSecond = p.querySelector('.note-composer textarea').value;
    r.noteRemindBadge = [...p.querySelectorAll('.cn-remind')].map(n => n.textContent);
    return r;
  })()\`);
  out.layout.panel1440 = await layout();
  await shot('02-guest-panel');
  await resize(1366, 768);
  out.layout.panel1366 = await layout();
  out.panelFit = await js(\`(() => { const p = document.getElementById('detailPanel').getBoundingClientRect(); return p.bottom <= window.innerHeight + 1 && p.right <= window.innerWidth + 1; })()\`);
  await shot('02-guest-panel');
  await resize(1440, 900);

  // inline composer saves a note with a reminder; Done clears one
  out.composer = await js(\`(async () => {
    const r = {};
    const p = document.getElementById('detailPanel');
    const ta = p.querySelector('.note-composer textarea');
    ta.value = 'Offer sent by email.';
    p.querySelector('.composer-remind input').value = (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    p.querySelector('.note-composer .btn').click(); await new Promise(x => setTimeout(x, 1500));
    const rems = (await window.api.reminders.forCustomer({ customerId: ${'${ids.weber}'} })).data;
    r.reminders = rems.length;
    const panel = document.getElementById('detailPanel');
    r.rowsShown = panel.querySelectorAll('.reminder-row').length;
    panel.querySelector('.reminder-row [data-act="markReminderDone"]').click(); await new Promise(x => setTimeout(x, 1500));
    r.afterDone = (await window.api.reminders.forCustomer({ customerId: ${'${ids.weber}'} })).data.length;
    r.dueAfter = (await window.api.reminders.due({})).data.length;
    return r;
  })()\`);

  // ----------------------------------------------------- keyboard shortcuts
  out.keys = await js(\`(async () => {
    const r = {};
    const press = (key, target = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    const shown = (id) => document.getElementById(id).classList.contains('show');
    document.activeElement?.blur?.();
    press('n'); await new Promise(x => setTimeout(x, 300));
    r.n = shown('modalCrmNote');
    r.modalTemplates = document.querySelectorAll('#crmNoteTemplates .tpl-chip').length;
    r.modalRemind = !!document.getElementById('crmNoteRemind');
    press('Escape'); await new Promise(x => setTimeout(x, 200));
    r.nClosed = !shown('modalCrmNote');
    document.activeElement?.blur?.();
    press('r'); await new Promise(x => setTimeout(x, 600));
    r.r = shown('modalReservation');
    press('Escape'); await new Promise(x => setTimeout(x, 200));
    document.activeElement?.blur?.();
    press('e'); await new Promise(x => setTimeout(x, 600));
    r.e = shown('modalCustomer');
    r.birthField = document.getElementById('custBirth').value;
    press('Escape'); await new Promise(x => setTimeout(x, 200));
    document.activeElement?.blur?.();
    press('t'); await new Promise(x => setTimeout(x, 800));
    r.t = shown('modalTags');
    r.pickerOn = [...document.querySelectorAll('#tagPicker .tag-pick.on')].map(b => b.textContent.trim());
    document.getElementById('newTagName').value = 'Problematic';
    document.querySelector('#newTagColors .swatch.tc-red').click();
    document.querySelector('[data-act="addNewTag"]').click(); await new Promise(x => setTimeout(x, 700));
    r.pickerAfterAdd = [...document.querySelectorAll('#tagPicker .tag-pick.on')].map(b => b.textContent.trim());
    return r;
  })()\`);
  await shot('03-tags-modal');
  out.tagsSaved = await js(\`(async () => {
    document.getElementById('tagsSaveBtn').click(); await new Promise(x => setTimeout(x, 1500));
    const c = (await window.api.customers.get({ id: ${'${ids.weber}'} })).data;
    // typing in a field never fires a shortcut
    const ta = document.querySelector('#detailPanel .note-composer textarea');
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    const typingOpened = document.getElementById('modalCrmNote').classList.contains('show');
    ta.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    const help = document.getElementById('guestShortcutGrid').innerText;
    return { tagCount: c.tags.length, typingOpened, help };
  })()\`);
  await shot('04-shortcuts');
  out.slash = await js(\`(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await switchTab('dashboard'); await new Promise(x => setTimeout(x, 800));
    document.activeElement?.blur?.();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    await new Promise(x => setTimeout(x, 900));
    const r = { paletteOpen: palette.open,
      groups: [...document.querySelectorAll('#paletteList .palette-group')].map(g => g.childNodes[0].textContent.trim()),
      recent: [...document.querySelectorAll('#paletteList .palette-item')].slice(0, 3).map(i => i.querySelector('.pi-title').textContent) };
    return r;
  })()\`);
  await shot('05-palette-recent');
  out.recentPanel = await js(\`(async () => {
    closePalette(); await renderDashboard(); await new Promise(x => setTimeout(x, 900));
    return [...document.querySelectorAll('#recentGuestsList .lr-name')].map(n => n.textContent);
  })()\`);

  // ------------------------------------------------- tag filter and saved views
  out.filters = await js(\`(async () => {
    const r = {};
    await goCrmView('overview'); await new Promise(x => setTimeout(x, 700));
    const sel = document.getElementById('custFTag');
    r.tagOptions = [...sel.options].map(o => o.textContent);
    sel.value = String(${'${ids.vip}'}); applyCustFilters(); await new Promise(x => setTimeout(x, 800));
    r.rows = [...document.querySelectorAll('#custTableBody tr')].map(tr => tr.querySelector('.name-cell')?.firstChild.textContent.trim());
    r.chips = [...document.querySelectorAll('#custChips .chip')].map(c => c.childNodes[0].textContent.trim());
    // save the view
    await toggleViewsMenu('overview', null); await new Promise(x => setTimeout(x, 500));
    document.getElementById('viewName_overview').value = 'VIP guests';
    document.querySelector('#viewsMenu_overview [data-act="saveCurrentView"]').click(); await new Promise(x => setTimeout(x, 800));
    r.saved = [...document.querySelectorAll('#viewsMenu_overview .view-open')].map(b => b.textContent);
    return r;
  })()\`);
  await shot('06-saved-views');
  out.applyView = await js(\`(async () => {
    const r = {};
    clearCustFilters(); await new Promise(x => setTimeout(x, 700));
    r.rowsCleared = document.querySelectorAll('#custTableBody tr').length;
    await toggleViewsMenu('overview', null); await new Promise(x => setTimeout(x, 500));
    document.querySelector('#viewsMenu_overview .view-open').click(); await new Promise(x => setTimeout(x, 900));
    r.rowsAfter = document.querySelectorAll('#custTableBody tr').length;
    r.chipsAfter = [...document.querySelectorAll('#custChips .chip')].map(c => c.childNodes[0].textContent.trim());
    await toggleViewsMenu('overview', null); await new Promise(x => setTimeout(x, 500));
    document.querySelector('#viewsMenu_overview .view-del').click(); await new Promise(x => setTimeout(x, 700));
    r.afterDelete = document.querySelectorAll('#viewsMenu_overview .view-open').length;
    closeAllFilterMenus();
    // Customer List: tag filter + chips + saved view
    await goCrmView('customerlist'); await new Promise(x => setTimeout(x, 700));
    document.getElementById('listFTag').value = String(${'${ids.high}'}); applyListFilters(); await new Promise(x => setTimeout(x, 800));
    r.listRows = document.querySelectorAll('#listTableBody tr').length;
    r.listChips = [...document.querySelectorAll('#listChips .chip')].map(c => c.childNodes[0].textContent.trim());
    r.listRowTags = [...document.querySelectorAll('#listTableBody .tag-chip')].map(t => t.textContent);
    await toggleViewsMenu('customerlist', null); await new Promise(x => setTimeout(x, 500));
    document.getElementById('viewName_customerlist').value = 'High budget';
    document.querySelector('#viewsMenu_customerlist [data-act="saveCurrentView"]').click(); await new Promise(x => setTimeout(x, 700));
    r.listSaved = (await window.api.views.list({ screen: 'customerlist' })).data.map(v => v.name);
    closeAllFilterMenus();
    return r;
  })()\`);
  out.layout.list1440 = await layout();
  await shot('07-customer-list');
  await resize(1366, 768);
  out.layout.list1366 = await layout();
  await shot('07-customer-list');
  await resize(1440, 900);
  out.resViews = await js(\`(async () => {
    await switchTab('reservations'); await new Promise(x => setTimeout(x, 800));
    document.getElementById('resFStatus').value = 'UPCOMING'; applyResFilters(); await new Promise(x => setTimeout(x, 700));
    await toggleViewsMenu('reservations', null); await new Promise(x => setTimeout(x, 500));
    document.getElementById('viewName_reservations').value = 'Upcoming stays';
    document.querySelector('#viewsMenu_reservations [data-act="saveCurrentView"]').click(); await new Promise(x => setTimeout(x, 700));
    const saved = (await window.api.views.list({ screen: 'reservations' })).data;
    clearResFilters(); await new Promise(x => setTimeout(x, 500));
    await toggleViewsMenu('reservations', null); await new Promise(x => setTimeout(x, 500));
    document.querySelector('#viewsMenu_reservations .view-open').click(); await new Promise(x => setTimeout(x, 900));
    return { saved: saved.map(v => v.state.status), statusAfter: state.res.status, selectAfter: document.getElementById('resFStatus').value };
  })()\`);
  out.layout.res1366 = await (async () => { await resize(1366, 768); const l = await layout(); await shot('08-reservations'); await resize(1440, 900); return l; })();

  // ---------------------------------------------------------- overlap warning
  out.overlap = await js(\`(async () => {
    const r = {};
    await openReservationModal(null, ${'${ids.weber}'}); await new Promise(x => setTimeout(x, 700));
    document.getElementById('resCheckIn').value = ${JSON.stringify('${ids.overlapIn}')};
    document.getElementById('resCheckOut').value = ${JSON.stringify('${ids.overlapOut}')};
    saveReservation(); await new Promise(x => setTimeout(x, 900));
    const box = document.getElementById('appConfirm');
    r.shown = !!box;
    r.title = box?.querySelector('.modal-title')?.textContent;
    r.text = box?.innerText || '';
    r.button = [...(box?.querySelectorAll('button') || [])].map(b => b.textContent);
    return r;
  })()\`);
  await shot('09-overlap-warning');
  out.overlapSaved = await js(\`(async () => {
    const box = document.getElementById('appConfirm');
    if (!box) return -1;
    [...box.querySelectorAll('button')].find(b => b.textContent === 'Save anyway').click();
    await new Promise(x => setTimeout(x, 1500));
    const rows = (await window.api.reservations.list({ customerId: ${'${ids.weber}'} })).data.rows;
    return rows.length;
  })()\`);

  // -------------------------------------------------------- duplicate warning
  out.dup = await js(\`(async () => {
    const r = {};
    await switchTab('customers'); await openCustomerModal(); await new Promise(x => setTimeout(x, 500));
    document.getElementById('custName').value = 'Tom Weber';
    document.getElementById('custId').value = 'G2001';
    document.getElementById('custPhone').value = '0532-111-2233';
    document.getElementById('custPassport').value = 'P7654321';
    saveCustomer(); await new Promise(x => setTimeout(x, 900));
    const w = document.getElementById('custDupWarning');
    r.shown = w.classList.contains('show');
    r.text = w.innerText;
    r.open = [...w.querySelectorAll('button')].map(b => b.textContent);
    r.notCreated = !(await window.api.customers.list({ search: 'G2001' })).data.total;
    return r;
  })()\`);
  await shot('10-duplicate-warning');
  await resize(1366, 768);
  await shot('10-duplicate-warning');
  await resize(1440, 900);
  out.dupCreate = await js(\`(async () => {
    [...document.querySelectorAll('#custDupWarning button')].find(b => b.textContent === 'Create anyway').click();
    await new Promise(x => setTimeout(x, 1500));
    return { created: (await window.api.customers.list({ search: 'G2001' })).data.total, closed: !document.getElementById('modalCustomer').classList.contains('show') };
  })()\`);

  // -------------------------------------------------------------------- merge
  out.merge = await js(\`(async () => {
    const r = {};
    await openGuestPage(${'${ids.weber}'}); await new Promise(x => setTimeout(x, 1200));
    r.mergeLink = !!document.querySelector('#guestPageBody [data-act="openMergeModal"]');
    r.pageTags = [...document.querySelectorAll('#guestPageBody .guest-tags .tag-chip')].map(t => t.textContent);
    r.datesCard = /Wedding anniversary/i.test(document.getElementById('guestPageBody').innerText);
    return r;
  })()\`);
  out.layout.page1440 = await layout();
  await shot('11-full-record');
  await resize(1366, 768);
  out.layout.page1366 = await layout();
  await shot('11-full-record');
  await resize(1440, 900);
  out.merge2 = await js(\`(async () => {
    const r = {};
    await openMergeModal(${'${ids.weber}'}); await new Promise(x => setTimeout(x, 600));
    r.disabledBefore = document.getElementById('mergeConfirmBtn').disabled;
    document.getElementById('mergeDuplicateSelect').value = String(${'${ids.dup}'});
    await onMergeDuplicatePicked(); await new Promise(x => setTimeout(x, 500));
    r.cards = [...document.querySelectorAll('#mergeCards .merge-name')].map(n => n.textContent);
    return r;
  })()\`);
  await shot('12-merge');
  out.merge3 = await js(\`(async () => {
    document.getElementById('mergeConfirmBtn').click(); await new Promise(x => setTimeout(x, 1800));
    const c = (await window.api.customers.get({ id: ${'${ids.weber}'} })).data;
    const gone = await window.api.customers.get({ id: ${'${ids.dup}'} });
    return { email: c.email, notes: c.note_count, stays: c.reservation_count, dupGone: gone.ok === false };
  })()\`);

  // ----------------------------------------------------------------- settings
  out.settings = await js(\`(async () => {
    await switchTab('settings'); await new Promise(x => setTimeout(x, 900));
    const r = {};
    r.templates = document.getElementById('setNoteTemplates').value.split('\\\\n');
    r.tagRows = document.querySelectorAll('#tagSettingsList .tag-setting-row').length;
    r.mergePerm = [...document.querySelectorAll('#permGrid .perm-name')].some(n => n.textContent === 'Merge duplicate guests');
    document.getElementById('setNoteTemplates').value = 'Called, no answer\\\\nSent the brochure';
    await saveNoteTemplates(); await new Promise(x => setTimeout(x, 500));
    r.savedSetting = (await window.api.settings.all({})).data['crm.note_templates'];
    r.stateSetting = state.settings['crm.note_templates'];
    await goToGuest(${'${ids.weber}'}, 'customers'); await new Promise(x => setTimeout(x, 900));
    const pid = state.crmView === 'customerlist' ? 'listDetailPanel' : 'detailPanel';
    r.newTemplates = [...document.querySelectorAll('#' + pid + ' .tpl-chip')].map(b => b.textContent);
    return r;
  })()\`);
  await (async () => { await switchSettingsShot(); })();
  async function switchSettingsShot() {
    await js(\`switchTab('settings')\`); await settle(900);
    await js(\`document.getElementById('templatesSection').scrollIntoView()\`); await settle(300);
    out.layout.settings1440 = await layout();
    await shot('13-settings');
  }

  // --------------------------------------------------------------- marketer
  out.marketing = await js(\`(async () => {
    const r = {};
    await window.api.auth.logout({});
    const s = await window.api.auth.login({ username: 'sena', password: ${JSON.stringify(PW)} });
    if (!s.ok) return { signInFailed: true };
    state.session = s.data; await enterApp(); await new Promise(x => setTimeout(x, 1200));
    r.recentStart = [...document.querySelectorAll('#recentGuestsList .lr-name')].map(n => n.textContent);
    await switchTab('customers'); await openCustomerModal(); await new Promise(x => setTimeout(x, 500));
    document.getElementById('custName').value = 'Cohen Again';
    document.getElementById('custId').value = 'G3001';
    document.getElementById('custPhone').value = '+90 555 999 8877';
    saveCustomer(); await new Promise(x => setTimeout(x, 900));
    const w = document.getElementById('custDupWarning');
    r.shown = w.classList.contains('show');
    r.text = w.innerText;
    r.openButtons = [...w.querySelectorAll('button')].filter(b => b.textContent === 'Open existing').length;
    closeModal('modalCustomer');
    await openGuestPage(${'${ids.weber}'}); await new Promise(x => setTimeout(x, 1000));
    r.mergeLink = !!document.querySelector('#guestPageBody [data-act="openMergeModal"]');
    await switchTab('settings'); await new Promise(x => setTimeout(x, 700));
    r.templatesHidden = getComputedStyle(document.getElementById('templatesSection')).display === 'none';
    return r;
  })()\`);
  await shot('14-marketer-duplicate');

  out.consoleErrors = consoleErrors;
  console.log('PROBE:' + JSON.stringify(out));
  app.exit(0);
}).catch((err) => {
  console.log('PROBE:' + JSON.stringify({ error: err.message, stack: String(err.stack).split('\\n').slice(0, 5) }));
  app.exit(1);
});
`;

function runElectron(userData, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, 'guest-features-entry.js');
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
  const s = new Suite('electron/guest-features-ui');
  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-guestfx-ui-'));
  try {
    const run = await runElectron(userData);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the application starts and the guest-features probe completes', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stdout.slice(-800)}\n${run.stderr.slice(-1200)}`);
    if (!line) return s.finish();
    const p = JSON.parse(line.slice('PROBE:'.length));
    if (p.error) {
      s.check('the probe ran without throwing', false, `${p.error}\n${(p.stack || []).join('\n')}`);
      return s.finish();
    }
    const J = (v) => JSON.stringify(v);

    // dashboard
    s.check('Due today lists my overdue and due follow-ups', p.dash.due.length === 2 && p.dash.dueCount === '2', J(p.dash.due));
    s.check('a due-today follow-up says today, an overdue one says how late',
      p.dash.due.some((d) => d.endsWith('|today')) && p.dash.due.some((d) => /overdue 2d$/.test(d)), J(p.dash.due));
    s.check('the dashboard lists the birthday and the special date',
      p.dash.dates.some((d) => /Birthday \(\d+\)/.test(d)) && p.dash.dates.some((d) => /Wedding anniversary/.test(d)), J(p.dash.dates));
    s.check('the dashboard never prints "undefined" or "null"', !/undefined|\bnull\b/.test(p.dash.text));
    s.check('a follow-up due raises a notification', p.dash.notifTitles.includes('Follow-up due'), J(p.dash.notifTitles));

    // panel
    s.check('the guest panel shows tag chips', J(p.panel.tags) === J(['High budget', 'VIP']) || J(p.panel.tags) === J(['VIP', 'High budget']), J(p.panel.tags));
    s.check('the guest panel lists open follow-ups', p.panel.reminders === 2, String(p.panel.reminders));
    s.check('the composer offers the six default templates', p.panel.templates.length === 6 && p.panel.templates.includes('Offer sent'), J(p.panel.templates));
    s.check('the composer has a "Remind me on" date', p.panel.hasRemindInput === true);
    s.check('a template writes itself into the note', p.panel.afterTemplate === 'Called, no answer', p.panel.afterTemplate);
    s.check('a second template is added on its own line', p.panel.afterSecond === 'Called, no answer\nWill call back', J(p.panel.afterSecond));
    s.check('the panel shows the birthday and special dates', p.panel.birthday === true, J(p.panel.facts));
    s.check('tag chips appear in the Overview rows', p.panel.rowTags >= 1, String(p.panel.rowTags));
    s.check('a note with a reminder is marked in the list', p.panel.noteRemindBadge.length >= 1, J(p.panel.noteRemindBadge));
    s.check('the guest panel fits a 1366x768 window', p.panelFit === true);
    s.check('a note saved from the composer carries its reminder', p.composer.reminders === 3 && p.composer.rowsShown === 3, J(p.composer));
    s.check('Done removes the follow-up', p.composer.afterDone === 2, J(p.composer));

    // keys
    const k = p.keys;
    s.check('N opens a new CRM note for the open guest', k.n === true && k.nClosed === true, J(k));
    s.check('the note dialog has templates and Remind me on', k.modalTemplates === 6 && k.modalRemind === true, J(k));
    s.check('R opens a new reservation for the open guest', k.r === true, J(k));
    s.check('E edits the open guest, birth date included', k.e === true && /^\d{4}-\d{2}-\d{2}$/.test(k.birthField), J(k));
    s.check('T opens the tag editor with the guest\'s tags picked', k.t === true && k.pickerOn.length === 2, J(k));
    s.check('a new tag is created and picked at once', k.pickerAfterAdd.map((t) => t.replace('✓', '')).includes('Problematic'), J(k.pickerAfterAdd));
    s.check('saving tags stores them on the guest', p.tagsSaved.tagCount === 3, J(p.tagsSaved));
    s.check('a shortcut never fires while typing', p.tagsSaved.typingOpened === false);
    s.check('the shortcuts overlay lists the guest shortcuts',
      /New CRM note/.test(p.tagsSaved.help) && /New reservation/.test(p.tagsSaved.help) && /Tags/.test(p.tagsSaved.help), p.tagsSaved.help);
    s.check('/ on a page without a search box opens search', p.slash.paletteOpen === true, J(p.slash));
    s.check('the empty search shows recently viewed guests first',
      p.slash.groups[0] === 'Recently viewed' && p.slash.recent[0] === 'Thomas Weber', J(p.slash));
    s.check('the dashboard lists recently viewed guests', p.recentPanel[0] === 'Thomas Weber', J(p.recentPanel));

    // filters + views
    const f = p.filters;
    s.check('the Overview filter menu offers tags', f.tagOptions.includes('VIP'), J(f.tagOptions));
    s.check('filtering by tag shows only tagged guests', J(f.rows) === J(['Thomas Weber']), J(f.rows));
    s.check('the tag filter shows as a chip', J(f.chips) === J(['Tag: VIP']), J(f.chips));
    s.check('the current filters can be saved as a view', J(f.saved) === J(['VIP guests']), J(f.saved));
    const av = p.applyView;
    s.check('opening a saved view restores its filters',
      av.rowsCleared > 1 && av.rowsAfter === 1 && J(av.chipsAfter) === J(['Tag: VIP']), J(av));
    s.check('a saved view can be deleted', av.afterDelete === 0, J(av));
    s.check('Customer List filters by tag, with a chip', av.listRows === 1 && J(av.listChips) === J(['Tag: High budget']), J(av));
    s.check('Customer List rows show tag chips', av.listRowTags.length >= 2, J(av.listRowTags));
    s.check('Customer List saves views', J(av.listSaved) === J(['High budget']), J(av.listSaved));
    s.check('Reservation History saves and reopens views',
      J(p.resViews.saved) === J(['UPCOMING']) && p.resViews.statusAfter === 'UPCOMING' && p.resViews.selectAfter === 'UPCOMING', J(p.resViews));

    // overlap
    s.check('an overlapping reservation asks before saving', p.overlap.shown === true && p.overlap.title === 'Overlapping reservation', J(p.overlap));
    s.check('the warning names the existing stay and offers Save anyway',
      /Already booked/.test(p.overlap.text) && p.overlap.button.includes('Save anyway'), J(p.overlap));
    s.check('Save anyway books it', p.overlapSaved === 2, String(p.overlapSaved));

    // duplicates
    s.check('a duplicate phone or passport stops the save with a warning', p.dup.shown === true && p.dup.notCreated === true, J(p.dup));
    s.check('an in-scope match is listed with Open existing', /Thomas Weber/.test(p.dup.text) && p.dup.open.includes('Open existing'), J(p.dup));
    s.check('Create anyway saves the new guest', p.dupCreate.created === 1 && p.dupCreate.closed === true, J(p.dupCreate));

    // merge
    s.check('an administrator sees Merge duplicate on the full record', p.merge.mergeLink === true);
    s.check('the full record shows tags and dates', p.merge.pageTags.length === 3 && p.merge.datesCard === true, J(p.merge));
    s.check('merge waits until a duplicate is chosen', p.merge2.disabledBefore === true);
    s.check('the merge dialog compares both guests', p.merge2.cards.length === 2, J(p.merge2.cards));
    s.check('merging moves notes and stays and fills empty fields',
      p.merge3.email === 'tw@example.com' && p.merge3.notes >= 4 && p.merge3.stays === 3 && p.merge3.dupGone === true, J(p.merge3));

    // settings
    s.check('Settings shows the template list', p.settings.templates.length === 6, J(p.settings.templates));
    s.check('Settings lists the tags', p.settings.tagRows === 3, String(p.settings.tagRows));
    s.check('merge is a configurable permission', p.settings.mergePerm === true);
    s.check('edited templates reach the composer', J(p.settings.newTemplates) === J(['Called, no answer', 'Sent the brochure']), J(p.settings));

    // marketer
    const m = p.marketing;
    s.check('a marketer is warned about a duplicate in another book', m.shown === true && /another marketer's book/.test(m.text), J(m));
    s.check('but is never told who it is', m.openButtons === 0 && !/Avi Cohen|G1005/.test(m.text), J(m));
    s.check('a marketer does not see Merge duplicate', m.mergeLink === false);
    s.check('a marketer cannot edit the template list', m.templatesHidden === true);

    // layout
    for (const [name, l] of Object.entries(p.layout)) {
      s.check(`${name}: no horizontal page scroll`, l.pageOverflow <= 0 && l.pageWidth <= 1, J(l));
    }

    s.check('the renderer logged no errors or warnings', p.consoleErrors.length === 0,
      p.consoleErrors.map((e) => `${e.source}:${e.line} ${e.message}`).join(' | '));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return s.finish();
};
