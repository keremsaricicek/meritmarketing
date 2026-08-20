'use strict';
/* THE RENDERER AND THE MAIN PROCESS, TALKING TO EACH OTHER FOR REAL.
 *
 * This suite exists because of a whole class of defect that every other suite
 * was structurally incapable of seeing.
 *
 * The service suites call the services directly. The IPC suites build payloads
 * by hand. The UI suites drive the ORIGINAL prototype HTML. So nothing anywhere
 * asked the one question that decides whether the product works: does the
 * migrated renderer send payloads the migrated boundary accepts?
 *
 * It did not. `auth:setup` omitted `passwordConfirm`, so no administrator could
 * ever be created and a fresh installation was a brick. The guest and
 * reservation lists sent `status:''` and a field name the surface does not
 * have, so both screens failed validation and rendered nothing. Every one of
 * those is a one-word fix and all of them shipped, because 1016 assertions were
 * all looking somewhere else.
 *
 * So this suite starts the real binary, loads the real renderer, and drives the
 * real screens — including the first-run form, which is the only way anybody
 * ever gets into a shipped installation.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const ADMIN_PW = 'harbour-lantern-quiet';

const PROBE = `
const path = require('path');
const { app } = require('electron');
app.setPath('userData', process.env.MERIT_TEST_USERDATA);
require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))});

const consoleErrors = [];

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const started = Date.now();
  let win = null;
  while (Date.now() - started < 20000) {
    const all = BrowserWindow.getAllWindows();
    if (all.length) { win = all[0]; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!win) { console.log('PROBE:' + JSON.stringify({ error: 'no window' })); app.exit(1); return; }

  /* Anything the page complains about is a finding. A renderer that throws on
     load still "loads", which is how a dead adapter layer went unnoticed. */
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) consoleErrors.push({ message, source: String(source).split('/').pop(), line });
  });

  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));
  await settle(600);

  const out = {};

  // ------------------------------------------------- the adapter layer loaded
  out.adapter = await js(\`({
    hasApi: typeof window.api === 'object' && window.api !== null,
    firstRun: typeof (window.api && window.api.auth && window.api.auth.firstRun) === 'function',
    dialogConfirm: typeof (window.api && window.api.dialog && window.api.dialog.confirm) === 'function',
    exportFiltered: typeof (window.api && window.api.export && window.api.export.filtered) === 'function',
    photosPick: typeof (window.api && window.api.photos && window.api.photos.pick) === 'function',
    relatedCustomers: typeof (window.api && window.api.profiles && window.api.profiles.relatedCustomers) === 'function',
    reportsAccess: typeof (window.api && window.api.reports && window.api.reports.access) === 'function',
    confirmDialog: typeof window.confirmDialog === 'function',
  })\`);

  // ------------------------------------------ what is actually on the screen
  const visible = (id) => \`(() => { const n = document.getElementById('\${id}');
    if (!n) return 'missing';
    return getComputedStyle(n).display; })()\`;
  out.firstRunScreen = {
    setupCard: await js(visible('setupCard')),
    loginCard: await js(visible('loginCard')),
    inlineHandlers: await js(
      'document.querySelectorAll("[onclick],[onchange],[oninput],[onkeydown],[onload],[onerror],[onsubmit],[onfocus]").length'),
  };

  // ------------------------------------------------------ create the admin
  await js(\`(() => {
    document.getElementById('setupName').value = 'Kerem';
    document.getElementById('setupUser').value = 'owner';
    document.getElementById('setupPass').value = ${JSON.stringify(ADMIN_PW)};
    document.getElementById('setupPass2').value = ${JSON.stringify(ADMIN_PW)};
    document.getElementById('setupBtn').click();
  })()\`);
  await settle(2500);

  out.afterSetup = {
    error: await js("(document.getElementById('setupError')||{}).textContent || ''"),
    /* The state object is a top-level const in a classic script: a global
       BINDING, not a property of window, so it is read by bare name. */
    session: await js("typeof state !== 'undefined' ? JSON.stringify(state.session) : 'no-state'"),
  };

  const db = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'database', 'connection.js'))});
  const handle = db.open(path.join(process.env.MERIT_TEST_USERDATA, 'data', 'merit-marketing.sqlite3'));
  out.users = handle.prepare('SELECT username, role FROM users').all();

  // ---------------------------- the screens' own filter payloads are accepted
  out.contracts = await js(\`(async () => {
    const results = {};
    const probe = async (label, fn) => {
      try { const r = await fn(); results[label] = r && r.ok === false ? ('REJECTED:' + (r.error && r.error.code) + ':' + (r.error && r.error.message)) : 'ok'; }
      catch (e) { results[label] = 'THREW:' + e.message; }
    };
    await probe('customers.list', () => window.api.customers.list(
      Object.assign({ page: 1, pageSize: 25 }, window.custFilterParams ? window.custFilterParams() : {})));
    await probe('reservations.list', () => window.api.reservations.list(
      Object.assign({ page: 1, pageSize: 25 }, window.resFilterParams ? window.resFilterParams() : {})));
    await probe('customers.picker', () => window.api.customers.picker({ search: 'a', pageSize: 50 }));
    await probe('dashboard.load', () => window.api.dashboard.load({ periodDays: 30 }));
    await probe('profiles.list', () => window.api.profiles.list({}));
    await probe('notifications.list', () => window.api.notifications.list({}));
    await probe('settings.all', () => window.api.settings.all({}));
    return results;
  })()\`);

  // -------------------------------- a guest, a reservation, and a soft delete
  out.workflow = await js(\`(async () => {
    const r = {};
    const created = await window.api.customers.create({ code: 'W-1', fullName: 'WORKFLOW GUEST', registered: true });
    r.customer = created.ok ? 'ok' : JSON.stringify(created.error);
    if (!created.ok) return r;
    const d = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const d2 = new Date(Date.now() + 16 * 86400000).toISOString().slice(0, 10);
    const stay = await window.api.reservations.create({ customerId: created.data.id, checkIn: d, checkOut: d2 });
    r.reservation = stay.ok ? 'ok' : JSON.stringify(stay.error);
    if (!stay.ok) return r;
    const noReason = await window.api.reservations.delete({ id: stay.data.id });
    r.deleteWithoutReason = noReason.ok ? 'ACCEPTED' : (noReason.error && noReason.error.code);
    const withReason = await window.api.reservations.delete({ id: stay.data.id, reason: 'Entered against the wrong guest' });
    r.deleteWithReason = withReason.ok ? 'ok' : JSON.stringify(withReason.error);
    /* The actor here is an ADMIN, who MAY read deleted history, so the read
       still answers. What must change is that the booking stops being
       operational. */
    const stillVisibleToAdmin = await window.api.reservations.get({ id: stay.data.id });
    r.adminCanStillRead = stillVisibleToAdmin.ok ? 'ok' : (stillVisibleToAdmin.error && stillVisibleToAdmin.error.code);
    const active = await window.api.reservations.list({ page: 1, pageSize: 100 });
    r.inActiveList = active.ok && active.data.rows.some((x) => x.id === stay.data.id) ? 'PRESENT' : 'absent';
    const deleted = await window.api.reservations.listDeleted({ page: 1, pageSize: 100 });
    r.inDeletedList = deleted.ok && deleted.data.rows.some((x) => x.id === stay.data.id) ? 'present' : 'MISSING';
    const guest = await window.api.customers.get({ id: created.data.id });
    r.guestStatusAfterDelete = guest.ok ? guest.data.status : 'unreadable';
    return r;
  })()\`);

  // ------------------------------ the delete form collects the required reason
  out.deleteForm = await js(\`({
    hasReasonField: !!document.getElementById('deleteResReason'),
    copy: (document.querySelector('#modalDeleteReservation .danger-hint') || {}).textContent || '',
  })\`);

  // ============================ Deleted Reservations, in the real screen
  /* The backend verb existed from the start; the screen never exposed it, so
     an administrator had no way to reach deleted history at all. */
  await js('switchTab("reservations")');
  await settle(700);

  out.deletedTabAdmin = await js(\`(async () => {
    const tab = document.getElementById('resViewDeletedTab');
    if (!tab) return { present: false };
    tab.click();
    await new Promise(r => setTimeout(r, 800));
    const rows = [...document.querySelectorAll('#resTableBody tr')];
    const text = rows.map(r => r.textContent).join(' | ');
    return {
      present: true,
      visible: getComputedStyle(tab).display !== 'none',
      active: tab.classList.contains('active'),
      count: document.getElementById('resViewDeletedCount').textContent,
      rowCount: rows.length,
      showsGuest: /WORKFLOW GUEST/.test(text),
      showsReason: /wrong guest/i.test(text),
      showsWhoDeleted: /owner/.test(text),
      showsDeletedBadge: /DELETED/.test(text),
      notesHeader: document.getElementById('resNotesHeader').textContent,
      /* A deleted booking offers no destructive actions — editing or
         cancelling something already withdrawn is meaningless. */
      rowActionButtons: document.querySelectorAll('#resTableBody .ra-btn').length,
    };
  })()\`);

  /* The same booking must not still be sitting in Reservations or Cancelled. */
  out.deletedAbsentElsewhere = await js(\`(async () => {
    const seen = {};
    for (const [view, id] of [['active','resViewActiveTab'], ['cancelled','resViewCancelledTab']]) {
      document.getElementById(id).click();
      await new Promise(r => setTimeout(r, 700));
      seen[view] = /WORKFLOW GUEST/.test(document.getElementById('resTableBody').textContent);
    }
    return seen;
  })()\`);

  // ================================================ Command Palette, for real
  out.palette = await js(\`(async () => {
    const r = {};
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise(x => setTimeout(x, 400));
    const overlay = document.getElementById('palette') || document.querySelector('.palette-overlay, #paletteOverlay');
    const input = document.getElementById('paletteInput');
    r.opened = !!input && !!input.offsetParent;
    if (!r.opened) return r;

    input.value = 'Dash';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    r.itemsAfterTyping = document.querySelectorAll('#paletteList .palette-item').length;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise(x => setTimeout(x, 120));
    r.arrowDownMovedCursor = document.querySelectorAll('#paletteList .palette-item.active').length === 1;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await new Promise(x => setTimeout(x, 120));
    r.arrowUpKeptOneActive = document.querySelectorAll('#paletteList .palette-item.active').length === 1;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    r.escapeClosed = !input.offsetParent;

    /* Reopen and execute by MOUSE, which is the path that used to run
       eval(item.run). */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    const input2 = document.getElementById('paletteInput');
    input2.value = 'Action Calendar';
    input2.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    const item = document.querySelector('#paletteList .palette-item');
    r.hasMatch = !!item;
    if (item) {
      item.click();
      await new Promise(x => setTimeout(x, 700));
      r.clickNavigated = !!document.querySelector('#page-calendar.active, [data-page="calendar"].active')
        || (document.getElementById('page-calendar') || {}).classList?.contains('active') || false;
      r.closedAfterRun = !document.getElementById('paletteInput').offsetParent;
    }
    /* Enter must execute too. */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    const input3 = document.getElementById('paletteInput');
    input3.value = 'Dashboard';
    input3.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(x => setTimeout(x, 300));
    input3.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(x => setTimeout(x, 700));
    r.enterNavigated = (document.getElementById('page-dashboard') || {}).classList?.contains('active') || false;
    return r;
  })()\`);

  // ================== CRM submenu + Finder: the hover paths that were inline
  out.hover = await js(\`(async () => {
    const r = {};
    const trigger = document.getElementById('appMenuTrigger');
    if (trigger) { trigger.click(); await new Promise(x => setTimeout(x, 400)); }
    const crm = document.getElementById('appMenuCrmItem');
    r.crmItemPresent = !!crm;
    if (crm) {
      r.inlineAttrs = crm.getAttributeNames().filter(n => n.startsWith('on'));
      r.scopedAttrs = crm.getAttributeNames().filter(n => n.startsWith('data-act-'));
      /* mouseenter does not bubble; the app delegates via mouseover. */
      crm.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      await new Promise(x => setTimeout(x, 500));
      const sub = document.getElementById('crmSubmenu');
      r.submenuOpenedOnHover = !!sub && sub.classList.contains('show');
      r.submenuInlineAttrs = sub ? sub.getAttributeNames().filter(n => n.startsWith('on')) : [];
    }
    return r;
  })()\`);

  out.finder = await js(\`(async () => {
    const r = {};
    if (typeof openFinder !== 'function') return { openFinderMissing: true };
    openFinder('customer');
    await new Promise(x => setTimeout(x, 900));
    const rows = [...document.querySelectorAll('#finderResults .finder-row')];
    r.rowCount = rows.length;
    if (!rows.length) return r;
    r.inlineAttrs = rows[0].getAttributeNames().filter(n => n.startsWith('on'));
    r.scopedAttrs = rows[0].getAttributeNames().filter(n => n.startsWith('data-act-'));
    const target = rows[rows.length - 1];
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await new Promise(x => setTimeout(x, 250));
    r.hoverMovedCursor = target.classList.contains('cursor');
    if (typeof closeFinder === 'function') closeFinder();
    return r;
  })()\`);

  // ========================= MARKETING must not reach any of this
  out.marketing = await js(\`(async () => {
    const r = {};
    const profile = await window.api.profiles.create({ fullName: 'DELETED VIEW MARKETER' });
    if (!profile.ok) return { setupFailed: JSON.stringify(profile.error) };
    const user = await window.api.users.create({
      username: 'mviewer', password: 'harbour-lantern-quiet', role: 'MARKETING',
      profileId: profile.data.id, fullName: 'DELETED VIEW MARKETER', active: true });
    if (!user.ok) return { setupFailed: JSON.stringify(user.error) };
    await window.api.auth.logout({});
    const session = await window.api.auth.login({ username: 'mviewer', password: 'harbour-lantern-quiet' });
    r.signedIn = session.ok && session.data.role === 'MARKETING';
    if (!r.signedIn) return r;
    if (typeof enterApp === 'function') { state.session = session.data; await enterApp(); }
    await new Promise(x => setTimeout(x, 900));
    switchTab('reservations');
    await new Promise(x => setTimeout(x, 900));

    const tab = document.getElementById('resViewDeletedTab');
    r.tabVisible = !!tab && getComputedStyle(tab).display !== 'none';
    /* The UI hides it — but the UI is not the boundary. Click it anyway, and
       call the verb directly, and both must fail. */
    if (tab) { tab.click(); await new Promise(x => setTimeout(x, 600)); }
    r.viewAfterForcedClick = state.res.view;
    r.tableShowsDeleted = /DELETED/.test(document.getElementById('resTableBody').textContent);
    const direct = await window.api.reservations.listDeleted({ page: 1, pageSize: 50 });
    r.directCall = direct.ok ? 'ALLOWED' : (direct.error && direct.error.code);
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

function runElectron(userData, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, 'workflow-entry.js');
    fs.writeFileSync(probeFile, PROBE);
    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb ? ['-a', ELECTRON, '--no-sandbox', probeFile] : [probeFile];
    const env = { ...process.env, MERIT_TEST_USERDATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(command, args, { env, cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, stdout, stderr }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

module.exports = async function () {
  const s = new Suite('electron/workflow');

  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-workflow-'));
  try {
    const run = await runElectron(userData);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the application starts and the workflow probe completes', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stdout.slice(-800)}\n${run.stderr.slice(-1200)}`);
    if (!line) return s.finish();
    const p = JSON.parse(line.slice('PROBE:'.length));
    if (p.error) {
      s.check('the probe ran without throwing', false, `${p.error}\n${(p.stack || []).join('\n')}`);
      return s.finish();
    }

    // ------------------------------------------------------- adapter layer
    /* `contextBridge.exposeInMainWorld` defines a NON-writable property, so the
       adapter's `window.api = ...` threw in strict mode and the entire file
       died on its first statement — taking every verb it adapts with it. */
    const a = p.adapter;
    s.check('the adapter layer installed at all', a.hasApi === true, JSON.stringify(a));
    for (const [verb, present] of Object.entries({
      'auth.firstRun': a.firstRun, 'dialog.confirm': a.dialogConfirm,
      'export.filtered': a.exportFiltered, 'photos.pick': a.photosPick,
      'profiles.relatedCustomers': a.relatedCustomers, 'reports.access': a.reportsAccess,
    })) {
      s.check(`the adapted verb ${verb} exists`, present === true, JSON.stringify(a));
    }
    s.check('the in-app confirmation dialog replaced window.confirm',
      a.confirmDialog === true, JSON.stringify(a));

    // ------------------------------------------------------------- the CSP
    /* Under `style-src 'self'` a style attribute in markup is inert, so an
       element hidden only that way is permanently visible — which put the login
       card and the setup card on screen at the same time, over the whole app. */
    const fr = p.firstRunScreen;
    /* Checked in the SOURCE, not the live DOM: the screens legitimately assign
       `element.style` from script, which produces a style attribute at runtime
       and is exactly what the policy permits. What must not exist is a style
       attribute WRITTEN IN THE MARKUP, which is inert and therefore a lie about
       what the user will see. */
    for (const file of ['index.html', path.join('scripts', 'core.js'), path.join('scripts', 'views.js'),
      path.join('scripts', 'screens.js'), path.join('scripts', 'bridge.js'), path.join('scripts', 'actions.js')]) {
      const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', file), 'utf8');
      const hits = source.match(/style="/g) || [];
      s.check(`${file} authors no style attribute`, hits.length === 0, `${hits.length} occurrences`);
    }
    /* Named for what it actually checks. This assertion used to be called "no
       inline event handler of ANY kind survives" while testing a hand-written
       list of four event names — and `onmouseenter`/`onmouseleave` were sitting
       in the markup the whole time. The exhaustive claim belongs to the source
       gate in tests/ui/renderer-source-safety.test.js, which matches by shape;
       this one confirms the DOM the app actually delivered is free of the
       common ones. */
    s.check('the delivered DOM carries none of the common inline handlers',
      fr.inlineHandlers === 0, `${fr.inlineHandlers} elements still carry one`);
    s.check('on a fresh installation the setup card is shown',
      fr.setupCard === 'block', String(fr.setupCard));
    s.check('and the sign-in card is not shown at the same time',
      fr.loginCard === 'none', String(fr.loginCard));

    // -------------------------------------------------- first run really works
    s.check('the setup form reports no error',
      p.afterSetup.error === '', p.afterSetup.error);
    s.check('the first administrator is actually created',
      p.users.length === 1 && p.users[0].username === 'owner' && p.users[0].role === 'ADMIN',
      JSON.stringify(p.users));
    s.check('and the renderer holds the resulting session',
      p.afterSetup.session && p.afterSetup.session !== 'null', String(p.afterSetup.session));

    // ------------------------------ the screens' own payloads are accepted
    for (const [label, result] of Object.entries(p.contracts)) {
      s.check(`the payload the renderer builds for ${label} is accepted`,
        result === 'ok', `${label} → ${result}`);
    }

    // ------------------------------------------------------------ workflow
    s.check('a guest can be created through the bridge', p.workflow.customer === 'ok', String(p.workflow.customer));
    s.check('a reservation can be created through the bridge', p.workflow.reservation === 'ok', String(p.workflow.reservation));
    s.check('deleting a reservation without a reason is refused',
      p.workflow.deleteWithoutReason === 'VALIDATION', String(p.workflow.deleteWithoutReason));
    s.check('deleting it with a reason succeeds', p.workflow.deleteWithReason === 'ok', String(p.workflow.deleteWithReason));
    s.check('the deleted booking leaves the operational list',
      p.workflow.inActiveList === 'absent', String(p.workflow.inActiveList));
    s.check('and appears in Deleted history instead',
      p.workflow.inDeletedList === 'present', String(p.workflow.inDeletedList));
    s.check('an administrator can still read it, because deletion is not destruction',
      p.workflow.adminCanStillRead === 'ok', String(p.workflow.adminCanStillRead));
    /* The guest had exactly one booking; deleting it must return them to No
       Record, or the deletion did not reach the derived facts. */
    s.check('the guest returns to NO_RECORD once their only booking is deleted',
      p.workflow.guestStatusAfterDelete === 'NO_RECORD', String(p.workflow.guestStatusAfterDelete));

    /* The form has to collect what the service requires, or the button is dead. */
    s.check('the delete dialog collects the required reason',
      p.deleteForm.hasReasonField === true);
    s.check('and its copy no longer claims the record is destroyed',
      !/no record of the stay is kept|cannot be undone/i.test(p.deleteForm.copy), p.deleteForm.copy.trim());

    // ================================================ Deleted Reservations UI
    /* The verb existed from the first day of the migration and the screen never
       exposed it, so deleted history was unreachable for the only two roles
       permitted to read it. */
    const d = p.deletedTabAdmin;
    s.check('the Reservation History screen has a Deleted tab', d.present === true, JSON.stringify(d));
    s.check('an administrator can see it', d.visible === true, JSON.stringify(d));
    s.check('clicking it activates the Deleted view', d.active === true, JSON.stringify(d));
    s.check('the deleted reservation is listed there', d.showsGuest === true, JSON.stringify(d));
    s.check('the row shows why it was deleted', d.showsReason === true, JSON.stringify(d));
    s.check('and who deleted it', d.showsWhoDeleted === true, JSON.stringify(d));
    s.check('and carries a DELETED badge', d.showsDeletedBadge === true, JSON.stringify(d));
    s.check('the count pill reports one deleted reservation', d.count === '1', String(d.count));
    s.check('the column header names the deletion reason',
      d.notesHeader === 'DELETION REASON', String(d.notesHeader));
    s.check('a deleted row offers no edit or cancel action',
      d.rowActionButtons === 0, `${d.rowActionButtons} action buttons on deleted rows`);

    /* DELETED outranks CANCELLED: the booking belongs to exactly one view. */
    s.check('the deleted reservation is gone from Reservations',
      p.deletedAbsentElsewhere.active === false, JSON.stringify(p.deletedAbsentElsewhere));
    s.check('and gone from Cancelled',
      p.deletedAbsentElsewhere.cancelled === false, JSON.stringify(p.deletedAbsentElsewhere));

    // ============================================== Command Palette, driven live
    const pal = p.palette;
    s.check('the Command Palette opens', pal.opened === true, JSON.stringify(pal));
    s.check('typing filters the command list', pal.itemsAfterTyping > 0, JSON.stringify(pal));
    s.check('Arrow Down keeps exactly one command selected', pal.arrowDownMovedCursor === true, JSON.stringify(pal));
    s.check('Arrow Up keeps exactly one command selected', pal.arrowUpKeptOneActive === true, JSON.stringify(pal));
    s.check('Escape closes the palette', pal.escapeClosed === true, JSON.stringify(pal));
    /* This is the path that used to call eval(item.run). */
    s.check('clicking a command executes it', pal.clickNavigated === true, JSON.stringify(pal));
    s.check('and the palette closes after running a command', pal.closedAfterRun === true, JSON.stringify(pal));
    s.check('Enter executes the selected command', pal.enterNavigated === true, JSON.stringify(pal));

    // ======================================= CRM submenu and Finder hover paths
    const h = p.hover;
    s.check('the CRM menu item carries no inline handler',
      Array.isArray(h.inlineAttrs) && h.inlineAttrs.length === 0, JSON.stringify(h.inlineAttrs));
    s.check('it uses event-scoped delegated actions instead',
      Array.isArray(h.scopedAttrs) && h.scopedAttrs.length >= 3, JSON.stringify(h.scopedAttrs));
    s.check('hovering the CRM item opens the submenu', h.submenuOpenedOnHover === true, JSON.stringify(h));
    s.check('the submenu itself carries no inline handler',
      Array.isArray(h.submenuInlineAttrs) && h.submenuInlineAttrs.length === 0, JSON.stringify(h.submenuInlineAttrs));

    const f = p.finder;
    s.check('the Finder lists guests', f.rowCount > 0, JSON.stringify(f));
    s.check('a Finder row carries no inline handler',
      Array.isArray(f.inlineAttrs) && f.inlineAttrs.length === 0, JSON.stringify(f.inlineAttrs));
    s.check('hovering a Finder row moves the cursor to it',
      f.hoverMovedCursor === true, JSON.stringify(f));

    // ================================ MARKETING is refused, by UI and by boundary
    const mk = p.marketing;
    s.check('a marketing user can sign in for the negative test',
      mk.signedIn === true, JSON.stringify(mk));
    s.check('MARKETING never sees the Deleted tab', mk.tabVisible === false, JSON.stringify(mk));
    s.check('forcing a click on it does not switch the view',
      mk.viewAfterForcedClick !== 'deleted', String(mk.viewAfterForcedClick));
    s.check('and no deleted row reaches their table',
      mk.tableShowsDeleted === false, String(mk.tableShowsDeleted));
    /* The UI is a convenience. The boundary is the guarantee. */
    s.check('calling the deleted verb directly is refused by the backend',
      mk.directCall === 'FORBIDDEN' || mk.directCall === 'NOT_FOUND', String(mk.directCall));

    // ------------------------------------------------------ nothing complained
    s.check('the renderer logged no errors or warnings',
      p.consoleErrors.length === 0,
      p.consoleErrors.map((e) => `${e.source}:${e.line} ${e.message}`).join(' | '));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }

  return s.finish();
};
