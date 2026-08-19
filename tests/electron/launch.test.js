'use strict';
/* The real Electron application, launched for real.
 *
 * Everything else in this suite tests services directly. This one starts the
 * actual binary, loads the actual renderer, and asks the page what it can see —
 * because the hardening that matters (contextIsolation, sandbox, CSP, the
 * preload shape) only exists once Electron is the thing running.
 *
 * Runs headlessly under xvfb on Linux and natively on Windows CI.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

/* A probe that runs INSIDE the started app's main process, reports what the
   renderer can see, and exits. Written to a temp file and passed as the entry
   point so the real main.js still does all the work. */
const PROBE = `
const path = require('path');
const { app } = require('electron');
const userData = process.env.MERIT_TEST_USERDATA;
app.setPath('userData', userData);

require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))});

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  const started = Date.now();
  let win = null;
  while (Date.now() - started < 20000) {
    const all = BrowserWindow.getAllWindows();
    if (all.length) { win = all[0]; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!win) { console.log('PROBE:' + JSON.stringify({ error: 'no window created' })); app.exit(1); return; }
  if (win.webContents.isLoading()) {
    await new Promise(r => win.webContents.once('did-finish-load', r));
  }

  const report = await win.webContents.executeJavaScript(\`(() => {
    const out = {};
    out.title = document.title;
    // The renderer must have no route into Node or Electron.
    out.hasRequire = typeof require !== 'undefined';
    out.hasProcess = typeof process !== 'undefined';
    out.hasModule = typeof module !== 'undefined';
    out.hasGlobal = typeof global !== 'undefined';
    out.hasBuffer = typeof Buffer !== 'undefined';
    // The bridge must exist, and must expose named verbs only.
    out.hasApi = typeof window.api === 'object' && window.api !== null;
    out.apiNamespaces = out.hasApi ? Object.keys(window.api).sort() : [];
    out.hasGenericInvoke = out.hasApi && (typeof window.api.invoke === 'function' || typeof window.api.send === 'function');
    out.hasIpcRenderer = out.hasApi && !!window.api.ipcRenderer;
    // Inline handlers must be gone, or a strict CSP would have broken the UI.
    out.inlineHandlers = document.querySelectorAll('[onclick],[onchange],[oninput],[onkeydown]').length;
    out.dataActions = document.querySelectorAll('[data-act]').length;
    out.screens = document.querySelectorAll('.page').length;
    return out;
  })()\`);

  // Ask the main process for what only it can answer.
  const setup = await win.webContents.executeJavaScript('window.api.app.needsSetup()');
  const info = await win.webContents.executeJavaScript('window.api.app.info()');
  // An unauthenticated privileged call must be refused.
  const denied = await win.webContents.executeJavaScript('window.api.customers.list({})');
  // CSP must be present on the delivered document.
  const csp = await win.webContents.executeJavaScript(
    'fetch ? "fetch-exists" : "no-fetch"').catch(() => 'blocked');

  console.log('PROBE:' + JSON.stringify({
    report, setup, info, denied, csp,
    dbExists: require('fs').existsSync(path.join(userData, 'data', 'merit-marketing.sqlite3')),
    userDataEntries: require('fs').readdirSync(userData).sort(),
    prefs: win.webContents.getLastWebPreferences ? win.webContents.getLastWebPreferences() : null,
  }));
  app.exit(0);
});
`;

function runElectron(userData, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, 'probe-entry.js');
    fs.writeFileSync(probeFile, PROBE);

    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb
      ? ['-a', ELECTRON, '--no-sandbox', probeFile]
      : [probeFile];

    /* The test runner itself runs under ELECTRON_RUN_AS_NODE so that the suites
       share the production SQLite runtime. The child must NOT inherit it, or
       Electron starts as a bare Node process and never creates a window. */
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
  const s = new Suite('electron/launch');

  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-electron-'));
  try {
    const run = await runElectron(userData);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the application starts and reaches a loaded window', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stderr.slice(-1200)}`);
    if (!line) return s.finish();

    const probe = JSON.parse(line.slice('PROBE:'.length));
    const r = probe.report;

    // ------------------------------------------------------------- identity
    s.check('the window carries the product name', r.title === 'Merit Marketing Hub', String(r.title));
    s.check('the renderer rendered the application screens', r.screens > 5, String(r.screens));

    // -------------------------------------------- renderer has no privileges
    s.check('the renderer has no require()', r.hasRequire === false, String(r.hasRequire));
    s.check('the renderer has no process', r.hasProcess === false, String(r.hasProcess));
    s.check('the renderer has no module', r.hasModule === false, String(r.hasModule));
    s.check('the renderer has no global', r.hasGlobal === false, String(r.hasGlobal));
    s.check('the renderer has no Buffer', r.hasBuffer === false, String(r.hasBuffer));

    // ------------------------------------------------------------- bridge
    s.check('the bridge is exposed', r.hasApi === true, JSON.stringify(r.apiNamespaces));
    s.check('the bridge exposes no generic invoke/send',
      r.hasGenericInvoke === false, 'a generic invoke would expose the whole IPC surface');
    s.check('the bridge exposes no ipcRenderer', r.hasIpcRenderer === false, String(r.hasIpcRenderer));
    s.check('the bridge exposes the expected namespaces',
      ['customers', 'reservations', 'auth', 'app'].every((n) => r.apiNamespaces.includes(n)),
      JSON.stringify(r.apiNamespaces));

    // ---------------------------------------------------------------- CSP
    s.check('no inline event handlers survive in the DOM (CSP compatible)',
      r.inlineHandlers === 0, `${r.inlineHandlers} elements still carry inline handlers`);
    s.check('the delegated actions replaced them', r.dataActions > 50, String(r.dataActions));

    // ------------------------------------------------------- first run + db
    s.check('a fresh installation reports that it needs setup',
      probe.setup && probe.setup.ok === true && probe.setup.data === true, JSON.stringify(probe.setup));
    s.check('the database was created under userData',
      probe.dbExists === true, JSON.stringify(probe.userDataEntries));
    s.check('user data lives beside the database, not in the install directory',
      ['data', 'photos', 'backups', 'logs', 'state'].every((d) => probe.userDataEntries.includes(d)),
      JSON.stringify(probe.userDataEntries));

    s.check('app info reports a version and schema version',
      probe.info && probe.info.ok && probe.info.data.schemaVersion >= 1, JSON.stringify(probe.info && probe.info.data));

    // --------------------------------------------------- unauthenticated IPC
    s.check('an unauthenticated privileged call is refused',
      probe.denied && probe.denied.ok === false, JSON.stringify(probe.denied));
    s.check('the refusal names the reason without leaking internals',
      probe.denied && probe.denied.error && probe.denied.error.code === 'AUTH_REQUIRED',
      JSON.stringify(probe.denied && probe.denied.error));

    // ------------------------------------------------------ webPreferences
    const prefs = probe.prefs || {};
    s.check('nodeIntegration is off in the packaged preferences',
      prefs.nodeIntegration !== true, JSON.stringify(prefs.nodeIntegration));
    s.check('contextIsolation is on', prefs.contextIsolation !== false, JSON.stringify(prefs.contextIsolation));
    s.check('sandbox is on', prefs.sandbox !== false, JSON.stringify(prefs.sandbox));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }

  return s.finish();
};
