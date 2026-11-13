'use strict';
/* THE OVERSIGHT AND RECORD SCREENS, DRIVEN IN THE REAL RENDERER.
 *
 * Global search, the guest panel and full record, CRM Overview's filter chips
 * and activity feed, Team control, the Audit Log filters and the dashboard's
 * pending list — all against the real main process and a real database, so a
 * field name the backend does not send (the "in undefinedd" bug) or a payload
 * the boundary rejects shows up here rather than on somebody's desk.
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
const { app } = require('electron');
app.setPath('userData', process.env.MERIT_TEST_USERDATA);
require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))});
const consoleErrors = [];

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
  win.setContentSize(1366, 768);
  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));
  await settle(600);
  const out = {};

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
    const prof = (await a.profiles.create({ fullName: 'Sena Yilmaz' })).data;
    const mk = (await a.users.create({ username: 'sena', password: ${JSON.stringify(PW)}, role: 'MARKETING',
      profileId: prof.id, fullName: 'Sena Yilmaz', active: true })).ok;
    const guest = async (code, name, notes) => (await a.customers.create({ code, fullName: name, registered: true,
      marketingProfileId: prof.id, notes })).data.id;
    const weber = await guest('G1006', 'Thomas Weber', 'Prefers sea-view room.');
    const cohen = await guest('G1005', 'Avi Cohen');
    const hostile = await guest('G1099', 'Hostile Guest');
    await a.reservations.create({ customerId: weber, checkIn: day(5), checkOut: day(8), invitedByProfileId: prof.id });
    await a.reservations.create({ customerId: cohen, checkIn: day(1), checkOut: day(3), invitedByProfileId: prof.id });
    for (const [i, text] of ['Called guest, confirmed interest.', 'Asked about upgrade options.',
      'Left voicemail, no answer.', 'Confirmed the zanzibar weekend arrival time.'].entries()) {
      await a.crmNotes.create({ customerId: weber, note: text, noteDate: day(-4 + i) });
    }
    await a.crmNotes.create({ customerId: hostile, note: 'zanzibar <img src=x onerror="window.__XSS=1"> trip' });
    return { weber, cohen, hostile, profileId: prof.id, marketingUser: mk };
  })()\`);
  const ids = out.seed;

  // --------------------------------------------------------------- dashboard
  out.dash = await js(\`(async () => {
    await switchTab('dashboard'); await new Promise(r => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('#pendingList .list-row')];
    return {
      text: document.getElementById('pendingList').innerText,
      dues: rows.map(r => r.querySelector('.due-pill')?.textContent.trim()),
      names: rows.map(r => r.querySelector('.lr-name')?.textContent.trim()),
      unit: [pendingDue({ check_in: '2026-03-10', check_out: '2026-03-12' }, '2026-03-10').label,
             pendingDue({ check_in: '2026-03-11', check_out: '2026-03-12' }, '2026-03-10').label,
             pendingDue({ check_in: '2026-03-15', check_out: '2026-03-18' }, '2026-03-10').label,
             pendingDue({ check_in: '2026-03-08', check_out: '2026-03-12' }, '2026-03-10').label],
    };
  })()\`);

  // ------------------------------------------------------------------ palette
  out.palette = await js(\`(async () => {
    const r = {};
    openPalette(); await new Promise(x => setTimeout(x, 100));
    const input = document.getElementById('paletteInput');
    input.value = 'zanzibar';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(x => setTimeout(x, 900));
    r.groups = [...document.querySelectorAll('#paletteList .palette-group')].map(g => g.childNodes[0].textContent.trim());
    r.marks = [...document.querySelectorAll('#paletteList mark')].map(m => m.textContent);
    r.injected = !!document.querySelector('#paletteList img');
    r.xss = typeof window.__XSS;
    r.quoteText = [...document.querySelectorAll('#paletteList .pi-quote')].map(q => q.textContent).join(' | ');
    r.activeCount = document.querySelectorAll('#paletteList .palette-item.active').length;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    r.cursorMoved = palette.cursor === 1;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(x => setTimeout(x, 1200));
    r.closed = !palette.open;
    r.page = document.querySelector('.page.active')?.id;
    r.panelGuest = document.getElementById('detailPanel')?.dataset.customerId;
    // Short queries never reach the backend; commands still render.
    openPalette(); input.value = 'D'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(x => setTimeout(x, 500));
    r.shortGroups = [...document.querySelectorAll('#paletteList .palette-group')].map(g => g.childNodes[0].textContent.trim());
    closePalette();
    return r;
  })()\`);

  // -------------------------------------------------------------- guest panel
  out.panel = await js(\`(async () => {
    const r = {};
    await goToGuest(${'${ids.weber}'}, 'customers'); await new Promise(x => setTimeout(x, 800));
    const p = document.getElementById('detailPanel');
    r.guestNote = p.querySelector('.card-pane.active .guest-note')?.innerText || '';
    r.visibleNotes = [...p.querySelectorAll('.card-pane.active .crm-note-list > .crm-note')].map(n => n.querySelector('.cn-text').textContent);
    r.showAll = p.querySelector('.cn-show-all')?.textContent.trim() || '';
    r.actions = [...p.querySelectorAll('.gi-actions-bar .btn')].map(b => b.textContent.trim());
    r.fullRecord = !!p.querySelector('[data-act="openGuestPage"]');
    const scroll = p.querySelector('.card-body-scroll');
    const pr = p.getBoundingClientRect();
    r.panelFits = pr.bottom <= window.innerHeight + 1;
    r.scrollsInternally = getComputedStyle(scroll).overflowY === 'auto';
    p.querySelector('.cn-show-all')?.click(); await new Promise(x => setTimeout(x, 100));
    r.afterShowAll = p.querySelectorAll('.card-pane.active .crm-note').length;
    const ta = p.querySelector('.note-composer textarea');
    p.querySelector('.note-composer .btn').click(); await new Promise(x => setTimeout(x, 300));
    r.emptyRefused = (p.querySelector('.note-composer .field-error')?.textContent || '').length > 0;
    ta.value = 'Inline composer note';
    p.querySelector('.note-composer .btn').click(); await new Promise(x => setTimeout(x, 1500));
    const notes = (await window.api.crmNotes.list({ customerId: ${'${ids.weber}'} })).data;
    r.saved = notes.some(n => n.note === 'Inline composer note');
    r.newestFirst = document.querySelector('#detailPanel .card-pane.active .crm-note .cn-text')?.textContent;
    return r;
  })()\`);

  // -------------------------------------------------------------- full record
  out.page = await js(\`(async () => {
    const r = {};
    document.querySelector('#detailPanel [data-act="openGuestPage"]').click();
    await new Promise(x => setTimeout(x, 1500));
    r.page = document.querySelector('.page.active')?.id;
    r.tab = document.querySelector('.ws-tab.active .ws-tab-label')?.textContent.trim();
    r.title = document.querySelector('#page-guest h1')?.textContent.trim();
    r.history = document.querySelectorAll('#guestHistoryList .gh-item').length;
    setGuestHistoryFilter('stay');
    r.staysShown = document.querySelectorAll('#guestHistoryList .gh-item:not(.hidden)').length;
    r.staysKinds = [...document.querySelectorAll('#guestHistoryList .gh-item:not(.hidden)')].map(n => n.dataset.kind);
    setGuestHistoryFilter('all');
    r.hasComposer = !!document.getElementById('guestPageComposer');
    r.hasReservations = document.querySelector('#page-guest').innerText.includes('Reservations');
    return r;
  })()\`);

  // ------------------------------------------------------------ filter chips
  out.chips = await js(\`(async () => {
    const r = {};
    await goCrmView('overview'); await setCustMode('table');
    setCustFilter('COLD', document.querySelector('#custFilterMenu .filter-opt[data-val="COLD"]'));
    await new Promise(x => setTimeout(x, 600));
    r.chips = [...document.querySelectorAll('#custChips .chip')].map(c => c.firstChild.textContent.trim());
    r.count = document.getElementById('custFilterCount').textContent;
    r.countVisible = !document.getElementById('custFilterCount').classList.contains('hidden');
    document.querySelector('#custChips .chip-x').click(); await new Promise(x => setTimeout(x, 600));
    r.afterRemove = document.querySelectorAll('#custChips .chip').length;
    r.statusAfter = state.cust.status;
    return r;
  })()\`);

  // ---------------------------------------------------------------- activity
  out.activity = await js(\`(async () => {
    const r = {};
    await openTodaysActivity(); await new Promise(x => setTimeout(x, 1000));
    r.mode = state.custMode;
    r.tableHidden = document.getElementById('custTableView').classList.contains('hidden');
    r.summaryCells = document.querySelectorAll('#actSummary .as-cell').length;
    r.members = document.querySelectorAll('.act-members .am-row').length;
    r.feedHasNote = document.getElementById('actFeed').innerText.includes('Confirmed the zanzibar weekend arrival time.');
    r.dayHeading = document.querySelector('.act-day')?.textContent || '';
    r.xss = typeof window.__XSS;
    r.scope = document.querySelector('.scope-pill')?.textContent;
    const me = [...document.querySelectorAll('.act-members .am-row')][1];
    me?.click(); await new Promise(x => setTimeout(x, 800));
    r.actorFiltered = !!state.act.actorUserId;
    await setCustMode('table');
    return r;
  })()\`);

  // ------------------------------------------------------------ team control
  out.team = await js(\`(async () => {
    const r = {};
    const nav = document.querySelector('.nav-item[data-page="team"]');
    r.navVisible = !!nav && !nav.classList.contains('hidden');
    nav.click(); await new Promise(x => setTimeout(x, 1200));
    r.page = document.querySelector('.page.active')?.id;
    r.alerts = document.querySelectorAll('#teamBody .alert-card').length;
    r.members = document.querySelectorAll('#teamTableBody tr').length;
    r.sensitive = document.querySelectorAll('#teamSensitive .sens-row').length;
    r.headers = [...document.querySelectorAll('.team-table thead th')].map(t => t.textContent.trim()).filter(Boolean);
    return r;
  })()\`);

  // ---------------------------------------------------------------- audit log
  out.audit = await js(\`(async () => {
    const r = {};
    await switchTab('audit'); await new Promise(x => setTimeout(x, 900));
    r.actorOptions = document.getElementById('auditFActor').options.length;
    r.actionOptions = document.getElementById('auditFAction').options.length;
    r.payloadWithoutPerson = JSON.stringify(auditFilterPayload());
    document.getElementById('auditFAction').value = 'CRM_NOTE_CREATE';
    await applyAuditFilters(); await new Promise(x => setTimeout(x, 400));
    r.actions = [...new Set([...document.querySelectorAll('#auditTableBody .audit-action')].map(n => n.textContent))];
    r.chips = [...document.querySelectorAll('#auditChips .chip')].map(c => c.firstChild.textContent.trim());
    const actor = document.getElementById('auditFActor');
    actor.value = actor.options[1]?.value || '';
    await applyAuditFilters(); await new Promise(x => setTimeout(x, 400));
    r.payloadWithPerson = auditFilterPayload();
    await clearAuditFilters(); await new Promise(x => setTimeout(x, 400));
    r.chipsAfterClear = document.querySelectorAll('#auditChips .chip').length;
    return r;
  })()\`);

  // ------------------------------------------------------------------ updates
  out.updates = await js(\`(async () => {
    await switchTab('settings'); await new Promise(x => setTimeout(x, 900));
    return {
      version: document.getElementById('updVersion').textContent,
      status: document.getElementById('updStatus').textContent,
      installHidden: document.getElementById('updInstallBtn').classList.contains('hidden'),
    };
  })()\`);

  // ------------------------------------------------- a marketer, by contrast
  out.marketing = await js(\`(async () => {
    const r = {};
    await window.api.auth.logout({});
    const s = await window.api.auth.login({ username: 'sena', password: ${JSON.stringify(PW)} });
    if (!s.ok) return { signInFailed: true };
    state.session = s.data; await enterApp(); await new Promise(x => setTimeout(x, 900));
    const nav = document.querySelector('.nav-item[data-page="team"]');
    r.navHidden = !nav || nav.classList.contains('hidden');
    await switchTab('team'); await new Promise(x => setTimeout(x, 500));
    r.pageAfterForcedOpen = document.querySelector('.page.active')?.id;
    await openTodaysActivity(); await new Promise(x => setTimeout(x, 900));
    r.scope = document.querySelector('.scope-pill')?.textContent;
    r.members = document.querySelectorAll('.act-members').length;
    r.crumbs = document.getElementById('topbarCrumbs').textContent;
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

function runElectron(userData, timeoutMs = 150000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, 'oversight-entry.js');
    fs.writeFileSync(probeFile, PROBE);
    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb ? ['-a', ELECTRON, '--no-sandbox', probeFile] : [probeFile];
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
  const s = new Suite('electron/oversight-ui');
  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-oversight-'));
  try {
    const run = await runElectron(userData);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the application starts and the oversight probe completes', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stdout.slice(-800)}\n${run.stderr.slice(-1200)}`);
    if (!line) return s.finish();
    const p = JSON.parse(line.slice('PROBE:'.length));
    if (p.error) {
      s.check('the probe ran without throwing', false, `${p.error}\n${(p.stack || []).join('\n')}`);
      return s.finish();
    }
    const J = (v) => JSON.stringify(v);

    // dashboard
    s.check('pending reservations never print "undefined"', !/undefined/i.test(p.dash.text), p.dash.text);
    s.check('pending reservations say when the guest arrives',
      J(p.dash.dues) === J(['tomorrow', 'in 5 days']), J(p.dash.dues));
    s.check('pending reservations are sorted by soonest check-in',
      J(p.dash.names) === J(['Avi Cohen', 'Thomas Weber']), J(p.dash.names));
    s.check('the due label covers today, tomorrow, later and in house',
      J(p.dash.unit) === J(['today', 'tomorrow', 'in 5 days', 'in house']), J(p.dash.unit));

    // palette
    const pal = p.palette;
    s.check('global search groups CRM notes in the palette', pal.groups.includes('CRM notes'), J(pal.groups));
    s.check('the matched term is highlighted with <mark>',
      pal.marks.length > 0 && pal.marks.every((m) => m.toLowerCase() === 'zanzibar'), J(pal.marks));
    s.check('a hostile note is shown as text, never as markup',
      pal.injected === false && pal.xss === 'undefined' && pal.quoteText.includes('<img'), J(pal));
    s.check('exactly one result is selected', pal.activeCount === 1, String(pal.activeCount));
    s.check('arrow keys move through the results', pal.cursorMoved === true, J(pal));
    s.check('Enter on a record closes the palette and opens the guest',
      pal.closed && pal.page === 'page-customers' && !!pal.panelGuest, J(pal));
    s.check('a one-letter query shows commands only',
      pal.shortGroups.length > 0 && !pal.shortGroups.some((g) => ['Guests', 'CRM notes', 'Reservations', 'Profiles'].includes(g)),
      J(pal.shortGroups));

    // guest panel
    const pn = p.panel;
    s.check('the panel Overview shows the guest note', pn.guestNote.includes('Prefers sea-view room.'), pn.guestNote);
    s.check('the Overview shows the latest three CRM notes in full', pn.visibleNotes.length === 3, J(pn.visibleNotes));
    s.check('CRM notes are newest first', pn.visibleNotes[0] === 'Confirmed the zanzibar weekend arrival time.', J(pn.visibleNotes));
    s.check('more than three notes offers Show all', /Show all 4 notes/.test(pn.showAll), pn.showAll);
    s.check('Show all reveals every note', pn.afterShowAll === 4, String(pn.afterShowAll));
    s.check('the four actions are buttons in the header row',
      J(pn.actions) === J(['Add note', 'Reservation', 'Edit', 'Reassign']), J(pn.actions));
    s.check('the panel offers Full record', pn.fullRecord === true);
    s.check('the panel fits a 1366x768 window and scrolls internally',
      pn.panelFits && pn.scrollsInternally, J(pn));
    s.check('the inline composer refuses an empty note', pn.emptyRefused === true);
    s.check('the inline composer saves through crmNotes.create', pn.saved === true);
    s.check('and the new note appears first', pn.newestFirst === 'Inline composer note', String(pn.newestFirst));

    // full record
    const pg = p.page;
    s.check('Full record opens the guest page', pg.page === 'page-guest', String(pg.page));
    s.check('its workspace tab carries the guest name', pg.tab === 'Thomas Weber', String(pg.tab));
    s.check('the page heading is the guest name', pg.title === 'Thomas Weber', String(pg.title));
    s.check('History lists notes, stays and registration', pg.history >= 7, String(pg.history));
    s.check('the Stays filter shows only stays',
      pg.staysShown === 1 && pg.staysKinds.every((k) => k === 'stay'), J(pg));
    s.check('the page has a composer and a reservations column', pg.hasComposer && pg.hasReservations, J(pg));

    // chips
    const ch = p.chips;
    s.check('an active status filter shows as a chip', J(ch.chips) === J(['Status: Cold']), J(ch.chips));
    s.check('the filter button counts active filters', ch.count === '1' && ch.countVisible, J(ch));
    s.check('removing the chip removes the filter', ch.afterRemove === 0 && ch.statusAfter === '', J(ch));

    // activity
    const ac = p.activity;
    s.check("Today's activity switches Overview to the activity layout",
      ac.mode === 'activity' && ac.tableHidden, J(ac));
    s.check('the summary strip has five figures', ac.summaryCells === 5, String(ac.summaryCells));
    s.check('an administrator sees the By team member list', ac.members >= 2, String(ac.members));
    s.check('the feed shows CRM note text in full', ac.feedHasNote === true);
    s.check('the feed is grouped by day', /^Today/.test(ac.dayHeading), ac.dayHeading);
    s.check('the feed never renders note markup', ac.xss === 'undefined');
    s.check('an administrator is in the team view', ac.scope === 'Team view', String(ac.scope));
    s.check('clicking a person filters the feed by them', ac.actorFiltered === true);

    // team control
    const tc = p.team;
    s.check('Team control is in the sidebar for an administrator', tc.navVisible === true);
    s.check('it opens the Team control page', tc.page === 'page-team', String(tc.page));
    s.check('it shows the alert cards', tc.alerts >= 4, String(tc.alerts));
    s.check('it lists every account', tc.members === 2, String(tc.members));
    s.check('it lists sensitive actions', tc.sensitive >= 1, String(tc.sensitive));
    s.check('its column headers are sentence case',
      tc.headers.every((h) => h !== h.toUpperCase()), J(tc.headers));

    // audit
    const au = p.audit;
    s.check('the person filter is filled from audit facets', au.actorOptions >= 2, String(au.actorOptions));
    s.check('the action filter is filled from audit facets', au.actionOptions >= 3, String(au.actionOptions));
    s.check('no person filter is sent unless one is chosen',
      !au.payloadWithoutPerson.includes('actorUserId'), au.payloadWithoutPerson);
    s.check('filtering by action shows only that action', J(au.actions) === J(['CRM_NOTE_CREATE']), J(au.actions));
    s.check('the active filter shows as a chip', J(au.chips) === J(['Action: CRM note create']), J(au.chips));
    s.check('a chosen person is sent as a number',
      typeof au.payloadWithPerson.actorUserId === 'number', J(au.payloadWithPerson));
    s.check('Clear all removes every audit filter', au.chipsAfterClear === 0, String(au.chipsAfterClear));

    // updates
    s.check('Settings shows the running version', /\d+\.\d+/.test(p.updates.version), p.updates.version);
    s.check('Settings shows an update status', p.updates.status.trim().length > 0, p.updates.status);
    s.check('Restart and update is not offered without a downloaded update', p.updates.installHidden === true);

    // marketing
    const mk = p.marketing;
    s.check('a marketer does not see Team control', mk.navHidden === true, J(mk));
    s.check('and cannot open it directly', mk.pageAfterForcedOpen !== 'page-team', String(mk.pageAfterForcedOpen));
    s.check("a marketer's activity is labelled as their own", mk.scope === 'My activity', String(mk.scope));
    s.check('without activity.team there is no team member list', mk.members === 0, String(mk.members));
    s.check('the breadcrumb says My activity', /My activity/.test(mk.crumbs || ''), String(mk.crumbs));

    s.check('the renderer logged no errors or warnings', p.consoleErrors.length === 0,
      p.consoleErrors.map((e) => `${e.source}:${e.line} ${e.message}`).join(' | '));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return s.finish();
};
