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
    s.check('no inline event handler of any kind survives',
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

    // ------------------------------------------------------ nothing complained
    s.check('the renderer logged no errors or warnings',
      p.consoleErrors.length === 0,
      p.consoleErrors.map((e) => `${e.source}:${e.line} ${e.message}`).join(' | '));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }

  return s.finish();
};
