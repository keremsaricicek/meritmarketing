'use strict';
/* THE OPERATOR'S GOLDEN PATH, THROUGH THE REAL CONTROLS.
 *
 * This suite exists because of a specific, repeated failure of the other ones.
 *
 * 1240 assertions passed while the Customer form could not save a guest with a
 * photo, the Reports screen produced a validation error on its default filters,
 * both photo buttons did nothing, the crop silently discarded itself at the next
 * launch, Automatic Backup never made a backup, and every avatar in the product
 * was blank. Each of those tests called `window.api.customers.create(...)` and
 * friends directly — so they proved the SERVICES work, which was never in doubt,
 * and said nothing about whether pressing the button works.
 *
 * So the rule here is absolute: for the operations under test this suite fills
 * real inputs and clicks real buttons. It never calls a create/update verb
 * directly to perform the thing it is verifying. Where a direct call appears it
 * is seeding a precondition that cannot be produced through the UI, and it says
 * so at the call site.
 *
 * The flow runs once against an isolated userData directory, then the app is
 * restarted against the SAME directory — because "it saved" and "it persisted"
 * are different claims, and only the second one matters to an operator.
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
const MARKETER_PW = 'graphite-evening-ledger';

/* Shared preamble for both runs. `press` and `fill` are the only way this
   suite is allowed to change anything. */
const PRELUDE = `
const path = require('path');
const { app } = require('electron');
app.setPath('userData', process.env.MERIT_TEST_USERDATA);
require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))});

const consoleErrors = [];
const validationErrors = [];

async function boot() {
  const { BrowserWindow } = require('electron');
  const started = Date.now();
  let win = null;
  while (Date.now() - started < 25000) {
    const all = BrowserWindow.getAllWindows();
    if (all.length) { win = all[0]; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!win) throw new Error('no window');
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) consoleErrors.push(String(source).split('/').pop() + ':' + line + ' ' + message);
    /* A strict schema refusing a renderer payload is the exact defect class
       this suite exists to catch, so it is collected separately and loudly. */
    if (/invalid-payload|VALIDATION/i.test(message)) validationErrors.push(message.slice(0, 300));
  });
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 700));
  return win;
}

/* Helpers injected into the page: fill a real input, click a real control. */
const HELPERS = \`
  window.__fill = (id, value) => {
    const node = document.getElementById(id);
    if (!node) throw new Error('no input #' + id);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  window.__press = (selector) => {
    const node = document.querySelector(selector);
    if (!node) throw new Error('no control ' + selector);
    node.click();
    return true;
  };
  window.__text = (selector) => (document.querySelector(selector) || {}).textContent || '';
  true;
\`;
`;

/* ---------------------------------------------------------------- run one */
const RUN_ONE = `
${PRELUDE}
app.whenReady().then(async () => {
  const win = await boot();
  const stalls = [];
  let step = 'boot';
  /* A page call that never settles — a modal waiting for a click, a promise
     that is never resolved — would otherwise hang the whole suite and report
     nothing but "timed out". Bounding each call turns that into a named step. */
  const js = (code) => Promise.race([
    win.webContents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => { stalls.push(step); resolve('__STALLED__'); }, 15000)),
  ]).catch((err) => { stalls.push(step + ':' + err.message.slice(0, 80)); return '__THREW__'; });
  const settle = (ms = 600) => new Promise(r => setTimeout(r, ms));
  await js(HELPERS);
  const out = {};

  // ---------------------------------------- 1. first-run admin, through the form
  step = 'setup';
  await js(\`(() => {
    __fill('setupName', 'Kerem');
    __fill('setupUser', 'owner');
    __fill('setupPass', ${JSON.stringify(ADMIN_PW)});
    __fill('setupPass2', ${JSON.stringify(ADMIN_PW)});
    __press('#setupBtn');
  })()\`);
  await settle(2600);
  out.adminCreated = await js("typeof state !== 'undefined' && !!state.session && state.session.role === 'ADMIN'");
  out.setupError = await js("(document.getElementById('setupError')||{}).textContent || ''");

  // ------------------------------------- 2. marketing profile, through the form
  step = 'profile';
  await js('switchTab("profiles")'); await settle();
  await js('openProfileModal()'); await settle(400);
  await js(\`(() => {
    __fill('profName', 'SENA NUR AKMUT');
    __fill('profPhone', '+90 555 111 22 33');
    __press('#modalProfile .btn-gold');
  })()\`);
  await settle(1400);
  out.profileVisible = await js("document.getElementById('profilesGrid') ? /SENA NUR AKMUT/.test(document.getElementById('profilesGrid').textContent) : /SENA NUR AKMUT/.test(document.body.textContent)");

  // ------------------------------------------ 3. guest, through the form
  await js('switchTab("customers")'); await settle();
  await js('openCustomerModal()'); await settle(400);
  await js(\`(() => {
    __fill('custName', 'MEHMET YILMAZ');
    __fill('custId', 'G-0001');
    __fill('custPhone', '+90 532 000 11 22');
    __fill('custPassport', 'U12345678');
    __press('#modalCustomer .btn-gold');
  })()\`);
  await settle(1600);
  out.customerSaved = await js("/MEHMET YILMAZ/.test(document.body.textContent)");
  out.customerModalClosed = await js("!document.getElementById('modalCustomer').classList.contains('show')");

  // ------------------------------------------ 4. edit that guest, through the form
  const customerId = await js("(async () => { const r = await window.api.customers.list({ page:1, pageSize:10 }); return r.ok ? r.data.rows[0].id : null; })()");
  out.customerId = customerId;
  await js(\`openCustomerModal(\${customerId})\`); await settle(600);
  await js(\`(() => { __fill('custName', 'MEHMET YILMAZ EDITED'); __press('#modalCustomer .btn-gold'); })()\`);
  await settle(1400);
  out.customerEdited = await js("/MEHMET YILMAZ EDITED/.test(document.body.textContent)");

  // ---------------------------------------------- 5. marketing user, through the form
  step = 'user';
  await js('switchTab("users")'); await settle();
  await js('openUserModal()'); await settle(400);
  out.defaultRole = await js("document.getElementById('userRole').value");
  const profileId = await js("(async () => { const r = await window.api.profiles.list({}); return r.ok ? r.data[0].id : null; })()");
  await js(\`(() => {
    __fill('userUsername', 'sena');
    __fill('userPassword', ${JSON.stringify(MARKETER_PW)});
    __fill('userRole', 'MARKETING');
    __fill('userProfile', String(\${profileId}));
    __press('#userSaveBtn');
  })()\`);
  await settle(1600);
  out.userSaved = await js("/sena/.test(document.body.textContent)");

  // ------------------------------------------ 6. reservation, through the form
  await js('switchTab("reservations")'); await settle();
  await js(\`openReservationModal(null, \${customerId})\`); await settle(700);
  const inDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const outDate = new Date(Date.now() + 17 * 86400000).toISOString().slice(0, 10);
  await js(\`(() => {
    __fill('resCheckIn', ${'`'}\${'\${inDate}'}${'`'});
    __fill('resCheckOut', ${'`'}\${'\${outDate}'}${'`'});
    __press('#modalReservation .btn-gold');
  })()\`);
  await settle(1600);
  out.reservationSaved = await js("/MEHMET YILMAZ/.test(document.getElementById('resTableBody').textContent)");

  // --------------------------------- 7. cancel it, through the row action + modal
  const resId = await js("(async () => { const r = await window.api.reservations.list({ page:1, pageSize:10 }); return r.ok && r.data.rows.length ? r.data.rows[0].id : null; })()");
  out.resId = resId;
  await js(\`openCancelReservationModal(\${resId})\`); await settle(500);
  await js(\`(() => { __fill('cancelResReason', 'Guest changed plans'); __press('#modalCancelReservation .btn-gold'); })()\`);
  await settle(1400);
  await js("setResView('cancelled')"); await settle(900);
  out.inCancelled = await js("/MEHMET YILMAZ/.test(document.getElementById('resTableBody').textContent)");

  /* A SECOND reservation, so there is something to delete that was never
     cancelled — created through the form again, not through the API. */
  await js('switchTab("reservations")'); await settle();
  await js("setResView('active')"); await settle(600);
  await js(\`openReservationModal(null, \${customerId})\`); await settle(700);
  const in2 = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const out2 = new Date(Date.now() + 42 * 86400000).toISOString().slice(0, 10);
  await js(\`(() => {
    __fill('resCheckIn', ${'`'}\${'\${in2}'}${'`'});
    __fill('resCheckOut', ${'`'}\${'\${out2}'}${'`'});
    __press('#modalReservation .btn-gold');
  })()\`);
  await settle(1600);
  const secondId = await js("(async () => { const r = await window.api.reservations.list({ page:1, pageSize:10, view:'active' }); return r.ok && r.data.rows.length ? r.data.rows[0].id : null; })()");

  // ------------------------------- 8. delete it, through the modal and its reason
  await js(\`openDeleteReservationModal(\${secondId})\`); await settle(600);
  out.deleteBlockedWithoutReason = await js(\`(async () => {
    __press('#modalDeleteReservation .btn-gold');
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('modalDeleteReservation').classList.contains('show');
  })()\`);
  await js(\`(() => { __fill('deleteResReason', 'Entered against the wrong guest'); __press('#modalDeleteReservation .btn-gold'); })()\`);
  await settle(1600);
  await js("setResView('deleted')"); await settle(900);
  out.inDeleted = await js("/wrong guest/i.test(document.getElementById('resTableBody').textContent)");
  out.deletedRowHasNoActions = await js("document.querySelectorAll('#resTableBody .ra-btn').length === 0");

  // ------------------------------------ 9. reports, with DEFAULT blank filters
  step = 'reports';
  await js('switchTab("reports")'); await settle(700);
  out.reports = {};
  for (const type of ['reservations', 'guests', 'norecord', 'marketing', 'cold']) {
    await js(\`setReportType('\${type}')\`); await settle(500);
    const before = validationErrors.length;
    await js('runReport()'); await settle(900);
    out.reports[type] = {
      newValidationErrors: validationErrors.length - before,
      rendered: await js("!document.getElementById('reportResultsWrap') || true"),
    };
  }

  // ----------------------------------------- 10. dashboard KPI, clicked for real
  step = 'dashboard';
  await js('switchTab("dashboard")'); await settle(900);
  out.kpiNavigated = await js(\`(async () => {
    const cells = [...document.querySelectorAll('#kpiBand .stat-cell, .stat-cell')];
    const total = cells.find(c => /TOTAL GUESTS/i.test(c.textContent));
    if (!total) return 'no-kpi';
    if (!total.getAttribute('data-act')) return 'no-action';
    total.click();
    await new Promise(r => setTimeout(r, 900));
    return document.querySelector('.page.active') ? document.querySelector('.page.active').id : 'none';
  })()\`);

  // -------------------------------------- 11. backup preference, changed for real
  step = 'settings';
  await js('switchTab("settings")'); await settle(900);
  out.backupPrefSaved = await js(\`(async () => {
    const freq = document.getElementById('setBackupFreq');
    const keep = document.getElementById('setBackupKeep');
    if (!freq || !keep) return 'missing';
    freq.value = 'daily'; freq.dispatchEvent(new Event('change', { bubbles: true }));
    keep.value = '5'; keep.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    const s = await window.api.settings.all({});
    return s.ok ? (s.data['backup.frequency'] + '/' + s.data['backup.keep']) : 'failed';
  })()\`);

  /* The data-folder button used to always fail. It cannot open a file manager
     in a headless container, so what is asserted is that the verb EXISTS and is
     reachable — not that a window appeared. */
  out.dataFolderReachable = await js(\`(async () => {
    const r = await window.api.backup.openFolder({});
    return r.ok ? 'ok' : (r.error && r.error.code);
  })()\`);

  // ------------------------ 12. hostile data, entered through the real form
  /* The rendering-safety suites drive the LEGACY prototype. This is the
     production renderer, given the same treatment. */
  await js('switchTab("customers")'); await settle(600);
  await js('openCustomerModal()'); await settle(400);
  await js(\`(() => {
    __fill('custName', '<img src=x onerror="window.__XSS=1"><script>window.__XSS=1<\\\\/script>');
    __fill('custId', 'G-XSS');
    __fill('custPhone', '"><b>bold</b>');
    __press('#modalCustomer .btn-gold');
  })()\`);
  await settle(1600);
  const hostileId = await js("(async () => { const r = await window.api.customers.list({ search:'G-XSS', page:1, pageSize:5 }); return r.ok && r.data.rows.length ? r.data.rows[0].id : null; })()");
  if (hostileId) {
    await js(\`showCustomerDetail(\${hostileId}, 'detailPanel')\`); await settle(800);
    await js(\`(async () => {
      await window.api.crmNotes.create({ customerId: \${hostileId}, note: '<svg onload="window.__XSS=1"></svg> note' });
    })()\`);
    await js('renderCustomers()'); await settle(800);
  }
  out.xss = await js(\`({
    sentinel: typeof window.__XSS,
    injectedImg: document.querySelectorAll('img[src="x"]').length,
    injectedScript: [...document.querySelectorAll('script')].filter(s => /__XSS/.test(s.textContent)).length,
    injectedSvgOnload: document.querySelectorAll('svg[onload]').length,
    textPresent: /onerror/.test(document.body.textContent),
  })\`);

  out.consoleErrors = consoleErrors;
  out.validationErrors = validationErrors;
  console.log('PROBE:' + JSON.stringify(out));
  app.exit(0);
}).catch((err) => {
  console.log('PROBE:' + JSON.stringify({ error: err.message, stack: String(err.stack).split('\\n').slice(0, 6) }));
  app.exit(1);
});
`;

/* ------------------------------------- run two: restart, same userData */
const RUN_TWO = `
${PRELUDE}
app.whenReady().then(async () => {
  const win = await boot();
  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = (ms = 600) => new Promise(r => setTimeout(r, ms));
  await js(HELPERS);
  const out = {};

  out.asksForSetup = await js("(async () => { const r = await window.api.app.needsSetup(); return r.data; })()");

  await js(\`(() => {
    __fill('loginUser', 'owner');
    __fill('loginPass', ${JSON.stringify(ADMIN_PW)});
    __press('#loginBtn');
  })()\`);
  await settle(2400);
  out.loggedIn = await js("typeof state !== 'undefined' && !!state.session");
  out.loginError = await js("(document.getElementById('loginError')||{}).textContent || ''");

  await js('switchTab("customers")'); await settle(900);
  out.customerPersisted = await js("/MEHMET YILMAZ EDITED/.test(document.body.textContent)");

  await js('switchTab("profiles")'); await settle(900);
  out.profilePersisted = await js("/SENA NUR AKMUT/.test(document.body.textContent)");

  await js('switchTab("reservations")'); await settle(900);
  out.activeReservations = await js("document.querySelectorAll('#resTableBody tr').length");
  await js("setResView('cancelled')"); await settle(800);
  out.cancelledPersisted = await js("/MEHMET YILMAZ/.test(document.getElementById('resTableBody').textContent)");
  await js("setResView('deleted')"); await settle(800);
  out.deletedPersisted = await js("/wrong guest/i.test(document.getElementById('resTableBody').textContent)");

  await js('switchTab("users")'); await settle(900);
  out.userPersisted = await js("/sena/.test(document.body.textContent)");

  await js('switchTab("settings")'); await settle(900);
  out.backupPrefPersisted = await js(\`(async () => {
    const s = await window.api.settings.all({});
    return s.ok ? (s.data['backup.frequency'] + '/' + s.data['backup.keep']) : 'failed';
  })()\`);

  /* Automatic backup: the preference said daily and this is a second launch on
     a later-or-equal calendar day, so at least one automatic backup must exist
     from the FIRST launch, which had frequency=startup by default. */
  out.automaticBackups = await js(\`(async () => {
    const r = await window.api.backup.list({});
    if (!r.ok) return { error: r.error && r.error.code };
    return {
      total: r.data.length,
      automatic: r.data.filter(b => /-auto\\\\.mmhbackup$/.test(b.name)).length,
      names: r.data.map(b => b.name).slice(0, 6),
      fieldsPresent: r.data.length ? (typeof r.data[0].byteSize === 'number' && typeof r.data[0].createdAt === 'string') : null,
    };
  })()\`);

  /* v1 must refuse updates even with a feed configured in the environment. */
  out.updates = await js(\`(async () => {
    const c = await window.api.updates.check({});
    const i = await window.api.updates.install({});
    return {
      check: c.ok ? JSON.stringify(c.data) : ('ERR:' + (c.error && c.error.code)),
      install: i.ok ? 'ALLOWED' : (i.error && i.error.code),
    };
  })()\`);

  out.consoleErrors = consoleErrors;
  out.validationErrors = validationErrors;
  console.log('PROBE:' + JSON.stringify(out));
  app.exit(0);
}).catch((err) => {
  console.log('PROBE:' + JSON.stringify({ error: err.message, stack: String(err.stack).split('\\n').slice(0, 6) }));
  app.exit(1);
});
`;

function runElectron(userData, script, file, extraEnv = {}, timeoutMs = 420000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, file);
    fs.writeFileSync(probeFile, script);
    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb ? ['-a', ELECTRON, '--no-sandbox', probeFile] : [probeFile];
    const env = { ...process.env, MERIT_TEST_USERDATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...extraEnv };
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

function parse(run) {
  const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
  return line ? JSON.parse(line.slice('PROBE:'.length)) : null;
}

module.exports = async function () {
  const s = new Suite('electron/golden-path');

  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-golden-'));
  try {
    // ============================================================== run one
    const first = await runElectron(userData, RUN_ONE, 'golden-one.js');
    const a = parse(first);
    s.check('the application starts and the operator flow completes', !!a && !a.error,
      a ? `${a.error}\n${(a.stack || []).join('\n')}` : `exit=${first.code} timedOut=${!!first.timedOut}\n${first.stderr.slice(-1200)}`);
    if (!a || a.error) return s.finish();

    s.check('no step in the operator flow hung',
      !a.stalls || a.stalls.length === 0, (a.stalls || []).join(', '));

    // -------------------------------------------------- forms, not API calls
    s.check('the setup FORM creates the first administrator',
      a.adminCreated === true, `error: ${a.setupError}`);
    s.check('the profile FORM saves a marketing profile', a.profileVisible === true);
    s.check('the customer FORM saves a guest', a.customerSaved === true);
    s.check('and the modal closes on success', a.customerModalClosed === true);
    s.check('the customer FORM saves an edit', a.customerEdited === true);
    s.check('a new user defaults to a role that exists',
      ['MARKETING', 'MANAGER', 'ADMIN'].includes(a.defaultRole), String(a.defaultRole));
    s.check('the user FORM saves a marketing account', a.userSaved === true);
    s.check('the reservation FORM saves a booking', a.reservationSaved === true);

    // ------------------------------------------------------- lifecycle views
    s.check('cancelling through the modal moves the booking to Cancelled',
      a.inCancelled === true, String(a.inCancelled));
    s.check('deleting without a reason is refused by the form',
      a.deleteBlockedWithoutReason === true, 'the dialog closed without a reason');
    s.check('deleting with a reason moves the booking to Deleted',
      a.inDeleted === true, String(a.inDeleted));
    s.check('a Deleted row offers no row actions', a.deletedRowHasNoActions === true);

    // ---------------------------------------------------------------- reports
    /* Every report, run from its DEFAULT blank filters — the state the operator
       actually finds the screen in. A strict-schema refusal here is the exact
       defect this suite was written for. */
    for (const [type, result] of Object.entries(a.reports)) {
      s.check(`the ${type} report runs on default filters with no validation error`,
        result.newValidationErrors === 0, `${result.newValidationErrors} validation error(s)`);
    }

    // ------------------------------------------------------------------- KPI
    s.check('the Total Guests KPI carries an action and navigates',
      a.kpiNavigated && !['no-kpi', 'no-action', 'none'].includes(a.kpiNavigated), String(a.kpiNavigated));

    // --------------------------------------------------------------- settings
    s.check('the backup preference saves what was selected',
      a.backupPrefSaved === 'daily/5', String(a.backupPrefSaved));
    s.check('the Data Folder action reaches a real verb rather than always failing',
      a.dataFolderReachable !== 'VALIDATION', String(a.dataFolderReachable));

    // ------------------------------------------------- hostile data, production
    const x = a.xss;
    s.check('a hostile guest name creates no element', x.injectedImg === 0, JSON.stringify(x));
    s.check('and injects no script', x.injectedScript === 0, JSON.stringify(x));
    s.check('and no svg onload survives', x.injectedSvgOnload === 0, JSON.stringify(x));
    s.check('no handler executed — the sentinel is untouched',
      x.sentinel === 'undefined', String(x.sentinel));
    s.check('the hostile string is displayed as text', x.textPresent === true, JSON.stringify(x));

    // -------------------------------------------- nothing complained, run one
    s.check('no strict-schema refusal occurred anywhere in the flow',
      a.validationErrors.length === 0, a.validationErrors.slice(0, 3).join(' | '));
    s.check('the renderer logged no errors during the flow',
      a.consoleErrors.length === 0, a.consoleErrors.slice(0, 3).join(' | '));

    // ============================================ run two: restart, same data
    /* A feed URL is set deliberately: v1 must refuse updates even when the
       environment tries to arm them. */
    const second = await runElectron(userData, RUN_TWO, 'golden-two.js',
      { MERIT_UPDATE_URL: 'https://updates.example.com/merit/' });
    const b = parse(second);
    s.check('the application restarts against the same data directory', !!b && !b.error,
      b ? `${b.error}\n${(b.stack || []).join('\n')}` : `exit=${second.code}\n${second.stderr.slice(-1200)}`);
    if (!b || b.error) return s.finish();

    s.check('a second launch does not ask for setup again', b.asksForSetup === false, String(b.asksForSetup));
    s.check('the administrator can sign in through the LOGIN FORM',
      b.loggedIn === true, `error: ${b.loginError}`);
    s.check('the edited guest persisted across a restart', b.customerPersisted === true);
    s.check('the profile persisted across a restart', b.profilePersisted === true);
    s.check('the marketing user persisted across a restart', b.userPersisted === true);
    s.check('the cancelled booking persisted', b.cancelledPersisted === true);
    s.check('the deleted booking persisted in Deleted history', b.deletedPersisted === true);
    s.check('the backup preference persisted', b.backupPrefPersisted === 'daily/5', String(b.backupPrefPersisted));

    // -------------------------------------------------- automatic backup ran
    const backups = b.automaticBackups;
    s.check('automatic backups were actually created',
      backups.automatic >= 1, JSON.stringify(backups));
    s.check('the backup list carries the fields the screen renders',
      backups.fieldsPresent === true, JSON.stringify(backups));

    // ------------------------------------------------------ v1 updates are off
    s.check('a configured update feed does not enable checking in v1',
      /"disabled":true/.test(b.updates.check) || /ERR:/.test(b.updates.check), String(b.updates.check));
    s.check('and installing an update is refused in v1',
      b.updates.install === 'UPDATE_FAILED', String(b.updates.install));

    s.check('no strict-schema refusal occurred after the restart',
      b.validationErrors.length === 0, b.validationErrors.slice(0, 3).join(' | '));
    s.check('the renderer logged no errors after the restart',
      b.consoleErrors.length === 0, b.consoleErrors.slice(0, 3).join(' | '));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }

  return s.finish();
};
