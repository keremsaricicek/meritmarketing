'use strict';
/* AUTOMATIC UPDATES.
 *
 * Electron's built-in autoUpdater (Squirrel.Windows) against a feed that is
 * HARD-CODED in the application. These checks pin the rules that make that
 * safe enough to ship:
 *
 *   - only the installed (packaged) Windows application ever checks;
 *   - the feed is the repository's GitHub Releases and nothing in the
 *     environment can change it;
 *   - a verified backup is taken when an update is staged, and again as a hard
 *     gate before "Restart and update" — a failed backup refuses the install;
 *   - installing stays ADMIN-only;
 *   - Squirrel's install/update/uninstall runs create or remove shortcuts and
 *     quit without starting the application.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Suite } = require('../lib/harness');
const updateFactory = require('../../src/main/updates/update-service');
const squirrel = require('../../src/main/updates/squirrel-startup');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const EXPECTED_FEED = 'https://github.com/keremsaricicek/meritmarketing/releases/latest/download';

function fakeUpdater() {
  const u = new EventEmitter();
  u.feeds = [];
  u.checks = 0;
  u.installs = 0;
  u.setFeedURL = (opts) => { u.feeds.push(opts); };
  u.checkForUpdates = () => { u.checks++; };
  u.quitAndInstall = () => { u.installs++; };
  return u;
}

function fakeTimers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeout = (fn, ms) => { const h = { fn, ms, unref() {} }; t.timeouts.push(h); return h; };
  t.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; t.intervals.push(h); return h; };
  t.clearTimeout = () => {};
  t.clearInterval = () => {};
  t.flush = () => { const due = t.timeouts.splice(0); due.forEach((h) => h.fn()); };
  return t;
}

const sessionFor = (role) => ({
  get: () => (role ? { id: 1, username: 'someone', role, profile_id: role === 'MARKETING' ? 7 : null } : null),
  touch: () => {},
  can: () => true,
});

function fakeBackup({ createFails = false, verifyFails = false } = {}) {
  const b = { created: [], validated: [] };
  b.create = async (_ctx, opts) => {
    if (createFails) throw new Error('disk full');
    const name = `MeritBackup-test-${b.created.length}-${opts.label}.mmhbackup`;
    b.created.push({ name, ...opts });
    return { name };
  };
  b.resolveBackup = (name) => `/backups/${name}`;
  b.validateFile = (file) => {
    if (verifyFails) throw new Error('The backup archive is damaged.');
    b.validated.push(file);
    return { manifest: {}, entries: new Map() };
  };
  return b;
}

function packaged({ role = 'ADMIN', backup = fakeBackup(), platform = 'win32', isPackaged = true } = {}) {
  const updater = fakeUpdater();
  const timers = fakeTimers();
  const audits = [];
  const logs = [];
  const notices = [];
  const service = updateFactory.build({
    autoUpdater: updater, backup, isPackaged, platform, currentVersion: '1.0.0',
    getContext: () => ({ sessions: sessionFor(role), audit: (e) => audits.push(e) }),
    log: (level, event, data) => logs.push({ level, event, data }),
    notify: (st) => notices.push(st),
    timers,
  });
  return { service, updater, timers, audits, logs, notices, backup };
}

const settle = () => new Promise((r) => setImmediate(r));

module.exports = async function () {
  const s = new Suite('electron/updates');

  // ---------------------------------------------------------------- the feed
  s.check('the feed is the repository\'s GitHub Releases, hard-coded',
    updateFactory.FEED_URL === EXPECTED_FEED, updateFactory.FEED_URL);

  const svcSource = read('src/main/updates/update-service.js');
  const mainSource = read('src/main/main.js');
  s.check('the update service never reads the environment',
    !/process\.env/.test(svcSource), 'process.env appears in update-service.js');
  s.check('main.js no longer reads MERIT_UPDATE_URL or any update URL from the environment',
    !/MERIT_UPDATE_URL|process\.env\.[A-Z_]*UPDATE/.test(mainSource));
  s.check('the NSIS-path electron-updater is gone from main.js',
    !/electron-updater/.test(mainSource));
  const pkg = JSON.parse(read('package.json'));
  s.check('electron-updater is no longer a dependency',
    !(pkg.dependencies || {})['electron-updater'] && !(pkg.devDependencies || {})['electron-updater']);
  s.check('main.js uses Electron\'s built-in autoUpdater',
    /autoUpdater\s*}\s*=\s*require\('electron'\)|,\s*autoUpdater\s*}\s*=\s*require\('electron'\)/.test(mainSource));

  /* A feed set in the environment changes nothing, even in a packaged build. */
  process.env.MERIT_UPDATE_URL = 'https://attacker.example.com/feed';
  try {
    const { updater } = packaged();
    s.check('a packaged build points Squirrel at the hard-coded feed',
      updater.feeds.length === 1 && updater.feeds[0].url === EXPECTED_FEED, JSON.stringify(updater.feeds));
    s.check('and an environment variable cannot redirect it',
      !JSON.stringify(updater.feeds).includes('attacker'), JSON.stringify(updater.feeds));
  } finally {
    delete process.env.MERIT_UPDATE_URL;
  }

  // ------------------------------------------------ packaged Windows only
  for (const [label, opts] of [['a development (unpackaged) run', { isPackaged: false }],
    ['a packaged Linux build', { platform: 'linux' }]]) {
    const { service, updater, timers } = packaged(opts);
    const st = await service.check();
    s.check(`${label} never configures a feed`, updater.feeds.length === 0, JSON.stringify(updater.feeds));
    s.check(`${label} never subscribes to updater events`, updater.eventNames().length === 0,
      updater.eventNames().join(','));
    s.check(`${label} never checks`, updater.checks === 0 && st.enabled === false
      && st.state === updateFactory.STATES.UNAVAILABLE, JSON.stringify(st));
    s.check(`${label} schedules nothing`, service.start() === false
      && timers.timeouts.length === 0 && timers.intervals.length === 0);
  }
  s.check('resolveFeed: only packaged + win32 is enabled',
    updateFactory.resolveFeed({ isPackaged: true, platform: 'win32' }).enabled === true
    && updateFactory.resolveFeed({ isPackaged: false, platform: 'win32' }).enabled === false
    && updateFactory.resolveFeed({ isPackaged: true, platform: 'darwin' }).enabled === false);

  // ---------------------------------------------------------------- schedule
  {
    const { service, updater, timers } = packaged();
    s.check('the installed app schedules checks', service.start() === true);
    s.check('the first check waits for startup to finish',
      timers.timeouts.length === 1 && timers.timeouts[0].ms === updateFactory.STARTUP_DELAY_MS
      && updateFactory.STARTUP_DELAY_MS >= 30000, JSON.stringify(timers.timeouts.map((t) => t.ms)));
    s.check('then it checks every few hours',
      timers.intervals.length === 1 && timers.intervals[0].ms === updateFactory.CHECK_INTERVAL_MS
      && updateFactory.CHECK_INTERVAL_MS >= 60 * 60 * 1000);
    s.check('starting twice does not double the schedule', service.start() === false);
    timers.flush();
    await settle();
    s.check('the scheduled check runs against Squirrel', updater.checks === 1, String(updater.checks));
    s.check('and records when it last checked', typeof service.status().lastCheckedAt === 'string');

    const first = packaged();
    first.service.start({ skipInitialCheck: true });
    s.check('on Squirrel\'s first run the immediate check is skipped',
      first.timers.timeouts.length === 0 && first.timers.intervals.length === 1);
  }

  // ------------------------------------------------- download and staging
  {
    const h = packaged();
    h.updater.emit('checking-for-update');
    s.check('checking is reported', h.service.status().state === updateFactory.STATES.CHECKING);
    h.updater.emit('update-available');
    s.check('an available update downloads in the background',
      h.service.status().state === updateFactory.STATES.DOWNLOADING);
    h.updater.emit('update-downloaded', {}, 'notes', '1.0.1', new Date(), EXPECTED_FEED);
    await settle(); await settle();
    const st = h.service.status();
    s.check('a downloaded update is reported as ready, with its version',
      st.state === updateFactory.STATES.DOWNLOADED && st.version === '1.0.1', JSON.stringify(st));
    s.check('the renderer is told on updates:status',
      h.notices.some((n) => n.state === updateFactory.STATES.DOWNLOADED));
    s.check('a verified backup is taken as soon as the update is staged',
      h.backup.created.length === 1 && h.backup.created[0].label === 'preupdate'
      && h.backup.created[0].system === true && h.backup.validated.length === 1, JSON.stringify(h.backup));
    s.check('status carries current version and the staged backup',
      st.currentVersion === '1.0.0' && st.stagedBackup === h.backup.created[0].name, JSON.stringify(st));

    await h.service.check();
    s.check('no new check while an update is waiting for a restart', h.updater.checks === 0);
    h.updater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    s.check('a later network error does not lose the staged update',
      h.service.status().state === updateFactory.STATES.DOWNLOADED);

    // ---- authorization
    for (const role of ['MARKETING', 'MANAGER']) {
      const r = packaged({ role });
      r.updater.emit('update-downloaded', {}, '', '1.0.1');
      await settle(); await settle();
      let code = null;
      try { await r.service.install(); } catch (err) { code = err.code; }
      s.check(`a ${role} user cannot install an update`, code === 'FORBIDDEN', `${role} → ${code}`);
      r.timers.flush();
      s.check(`and nothing was installed for ${role}`, r.updater.installs === 0);
    }
    const anon = packaged({ role: null });
    let anonCode = null;
    try { await anon.service.install(); } catch (err) { anonCode = err.code; }
    s.check('nor can a caller with no session', anonCode === 'AUTH_REQUIRED' || anonCode === 'FORBIDDEN', String(anonCode));

    // ---- the happy path
    const result = await h.service.install();
    s.check('installing takes a fresh verified backup first',
      h.backup.created.length === 2 && h.backup.validated.length === 2, JSON.stringify(h.backup));
    s.check('the install is audited with the safety backup',
      h.audits.length === 1 && h.audits[0].action === 'UPDATE_INSTALL'
      && h.audits[0].description.includes(result.safetyBackup), JSON.stringify(h.audits));
    s.check('the renderer gets its answer before the restart', h.updater.installs === 0);
    h.timers.flush();
    s.check('then Squirrel restarts into the new version', h.updater.installs === 1, String(h.updater.installs));
    let again = null;
    try { await h.service.install(); } catch (err) { again = err.code; }
    s.check('a second install request is refused', again === 'UPDATE_FAILED', String(again));
  }

  // ------------------------------------------- backup-before-install gate
  {
    const nothing = packaged();
    let code = null;
    try { await nothing.service.install(); } catch (err) { code = err.code; }
    s.check('installing with nothing downloaded is refused', code === 'UPDATE_FAILED', String(code));

    const failing = packaged({ backup: fakeBackup({ createFails: true }) });
    failing.updater.emit('update-downloaded', {}, '', '1.0.1');
    await settle(); await settle();
    s.check('a failed backup at staging is logged, and the update still waits for a choice',
      failing.service.status().state === updateFactory.STATES.DOWNLOADED
      && failing.service.status().stagedBackup === null
      && failing.logs.some((l) => l.event === 'update.staged-backup-failed'));
    let err = null;
    try { await failing.service.install(); } catch (e) { err = e; }
    s.check('if the pre-install backup fails, the install is REFUSED',
      err && err.code === 'UPDATE_FAILED', String(err && err.code));
    s.check('and the refusal says why', err && /safety backup/.test(err.message) && /disk full/.test(err.message),
      err && err.message);
    failing.timers.flush();
    s.check('and Squirrel is never asked to install', failing.updater.installs === 0);
    s.check('and nothing is audited as installed', failing.audits.length === 0);

    const unverifiable = packaged({ backup: fakeBackup({ verifyFails: true }) });
    unverifiable.updater.emit('update-downloaded', {}, '', '1.0.1');
    await settle(); await settle();
    let verr = null;
    try { await unverifiable.service.install(); } catch (e) { verr = e; }
    unverifiable.timers.flush();
    s.check('a backup that fails verification also refuses the install',
      verr && verr.code === 'UPDATE_FAILED' && unverifiable.updater.installs === 0, String(verr && verr.message));
  }

  // ------------------------------------------------------ squirrel events
  {
    const run = (argv, { platform = 'win32', spawnThrows = false } = {}) => {
      const out = { quit: 0, spawned: [] };
      const app = { quit: () => { out.quit++; } };
      const handled = squirrel.handle({
        app, argv, platform,
        execPath: 'C:\\Users\\op\\AppData\\Local\\MeritMarketingHub\\app-1.0.1\\MeritMarketingHub.exe',
        spawnFn: (cmd, args) => {
          if (spawnThrows) throw new Error('ENOENT');
          const child = new EventEmitter();
          out.spawned.push({ cmd, args });
          setImmediate(() => child.emit('close', 0));
          return child;
        },
        setTimeoutFn: () => {},
      });
      return { handled, out };
    };
    const exe = 'C:\\Users\\op\\AppData\\Local\\MeritMarketingHub\\Update.exe';

    for (const flag of ['--squirrel-install', '--squirrel-updated']) {
      const { handled, out } = run(['app.exe', flag]);
      await settle();
      s.check(`${flag} creates shortcuts through Update.exe and quits`,
        handled === true && out.spawned.length === 1 && out.spawned[0].cmd === exe
        && out.spawned[0].args.join(' ') === '--createShortcut MeritMarketingHub.exe' && out.quit === 1,
        JSON.stringify(out));
    }
    {
      const { handled, out } = run(['app.exe', '--squirrel-uninstall']);
      await settle();
      s.check('--squirrel-uninstall removes shortcuts and quits (user data is not touched)',
        handled === true && out.spawned[0].args.join(' ') === '--removeShortcut MeritMarketingHub.exe' && out.quit === 1,
        JSON.stringify(out));
    }
    {
      const { handled, out } = run(['app.exe', '--squirrel-obsolete']);
      s.check('--squirrel-obsolete quits at once', handled === true && out.spawned.length === 0 && out.quit === 1);
    }
    {
      const { handled, out } = run(['app.exe', '--squirrel-install'], { spawnThrows: true });
      s.check('a missing Update.exe still quits rather than starting the app', handled === true && out.quit === 1);
    }
    s.check('--squirrel-firstrun starts the application normally', run(['app.exe', '--squirrel-firstrun']).handled === false);
    s.check('a normal launch is not a Squirrel event', run(['app.exe']).handled === false);
    s.check('Squirrel flags are ignored off Windows', run(['app', '--squirrel-install'], { platform: 'linux' }).handled === false);

    const handleAt = mainSource.indexOf('squirrelStartup.handle(');
    const lockAt = mainSource.indexOf('requestSingleInstanceLock()');
    const dbAt = mainSource.indexOf('connection.open(');
    s.check('main.js handles Squirrel events before the single-instance lock and the database',
      handleAt > 0 && handleAt < lockAt && handleAt < dbAt, `${handleAt} ${lockAt} ${dbAt}`);
  }

  // -------------------------------------------- user data is out of reach
  {
    const forge = require('../../forge.config.js');
    const maker = forge.makers.find((m) => m.name === '@electron-forge/maker-squirrel');
    s.check('the Squirrel install folder (%LOCALAPPDATA%\\MeritMarketingHub) is named by the maker',
      maker && maker.config.name === 'MeritMarketingHub');
    s.check('user data lives under the product name (%APPDATA%\\Merit Marketing Hub), a different tree',
      pkg.productName === 'Merit Marketing Hub');
    const pathsModule = require('../../src/main/paths');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-upd-'));
    try {
      const p = pathsModule.resolve({ getPath: (k) => (k === 'userData' ? tmp : null) });
      s.check('database, photos and backups all resolve inside userData',
        [p.database, p.photos, p.backups].every((x) => x.startsWith(tmp)), JSON.stringify(p));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------ release pipeline
  {
    const wf = read('.github/workflows/release.yml');
    s.check('a release workflow publishes on v* tags', /tags:\s*\['v\*'\]/.test(wf));
    s.check('it builds on Windows with npm ci and npm run make',
      /windows-latest/.test(wf) && /npm ci/.test(wf) && /npm run make/.test(wf));
    s.check('it uploads RELEASES, the nupkg packages and the Setup.exe',
      /RELEASES/.test(wf) && /-full\.nupkg/.test(wf) && /-delta\.nupkg/.test(wf) && /MeritMarketingHub-Setup\.exe/.test(wf));
    s.check('it refuses a tag that does not match package.json', /does not match package\.json/.test(wf));
  }

  return s.finish();
};
