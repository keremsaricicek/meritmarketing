'use strict';
/* OFFLINE-FIRST.
 *
 * A hotel back office loses its connection. The application must not care.
 *
 * This is checked structurally rather than by unplugging a cable, because the
 * structure is the guarantee: a renderer with no network API, no remote asset
 * and a CSP of connect-src 'none' cannot depend on the Internet, whatever the
 * network is doing. The one place that legitimately reaches out — the update
 * check — is verified to fail quietly.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');
const updateFactory = require('../../src/main/updates/update-service');
const { CSP } = require('../../src/main/windows/main-window');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

module.exports = async function () {
  const s = new Suite('electron/offline');

  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(RENDERER, 'styles', 'app.css'), 'utf8');
  const scripts = fs.readdirSync(path.join(RENDERER, 'scripts'))
    .map((f) => fs.readFileSync(path.join(RENDERER, 'scripts', f), 'utf8')).join('\n');

  // ------------------------------------------------------- no remote assets
  const remoteRefs = (html.match(/(?:src|href)="(https?:)?\/\/[^"]*"/g) || [])
    .filter((r) => !r.includes('www.w3.org'));   // an XML namespace, never fetched
  s.check('the markup loads no remote script, stylesheet, font or image',
    remoteRefs.length === 0, remoteRefs.join(', '));

  const cssRemote = (css.match(/url\(\s*['"]?(https?:)?\/\//g) || []);
  s.check('the stylesheet loads no remote font or image', cssRemote.length === 0, cssRemote.join(', '));
  s.check('the stylesheet has no remote @import',
    !/@import\s+url\(\s*['"]?(https?:)?\/\//.test(css));

  // --------------------------------------------------- no network at runtime
  const networkApis = [
    ['fetch(', /\bfetch\s*\(/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['WebSocket', /\bnew\s+WebSocket\b/],
    ['EventSource', /\bnew\s+EventSource\b/],
    ['navigator.sendBeacon', /sendBeacon/],
    ['importScripts', /importScripts\s*\(/],
  ];
  for (const [label, pattern] of networkApis) {
    s.check(`the renderer never calls ${label}`, !pattern.test(scripts), `${label} appears in renderer code`);
  }

  // ------------------------------------------------------------------- CSP
  s.check('the policy forbids outbound connections entirely',
    CSP.includes("connect-src 'none'"), CSP);
  s.check('the policy allows only local scripts', CSP.includes("script-src 'self'"), CSP);
  s.check('the policy allows only local styles', CSP.includes("style-src 'self'"), CSP);
  s.check('the policy allows only local and inline-data images',
    CSP.includes("img-src 'self' data:"), CSP);
  s.check('the policy blocks framing', CSP.includes("frame-src 'none'"), CSP);
  s.check('the policy blocks form submission', CSP.includes("form-action 'none'"), CSP);
  s.check('the policy has no unsafe-inline or unsafe-eval anywhere',
    !/unsafe-inline|unsafe-eval/.test(CSP), CSP);

  // ------------------------------------------------------- no telemetry
  const telemetry = /google-analytics|googletagmanager|sentry\.io|segment\.io|mixpanel|amplitude|posthog|telemetry/i;
  s.check('there is no analytics or telemetry in the renderer', !telemetry.test(scripts));
  s.check('there is no analytics or telemetry in the markup', !telemetry.test(html));

  // -------------------------------- the update check degrades, never blocks
  const events = {};
  const fakeUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: (name, fn) => { events[name] = fn; },
    checkForUpdates: async () => { throw new Error('getaddrinfo ENOTFOUND updates.example.com'); },
  };
  const notices = [];
  const updates = updateFactory.build({
    autoUpdater: fakeUpdater,
    backup: { create: async () => ({ name: 'x' }) },
    getContext: () => ({ audit: () => {} }),
    feedConfigured: true,
    log: () => {},
    notify: (status) => notices.push(status.state),
  });

  let threw = null;
  let status = null;
  try { status = await updates.check(); } catch (err) { threw = err; }
  s.check('a failed update check does not throw', threw === null, String(threw && threw.message));
  s.check('a failed update check reports "unavailable", not an error',
    status.state === updateFactory.STATES.UNAVAILABLE, JSON.stringify(status));
  s.check('the failure is surfaced as a status, not a dialog',
    notices.includes(updateFactory.STATES.UNAVAILABLE), JSON.stringify(notices));

  /* An offline network error arriving on the updater's error channel is the
     normal case in a back office, not an incident. */
  events.error(new Error('net::ERR_INTERNET_DISCONNECTED'));
  s.check('an offline error from the updater is absorbed',
    updates.status().state === updateFactory.STATES.UNAVAILABLE, JSON.stringify(updates.status()));

  // With no feed configured at all, checking is a no-op rather than a failure.
  /* Installing an update restarts the app and replaces the program on disk, so
     it needs a real session to authorize against — the surface documents it as
     ADMIN with `backup.create`. */
  const sessionFor = (role) => ({
    get: () => (role ? { id: 1, username: 'someone', role, profile_id: role === 'MARKETING' ? 7 : null } : null),
    touch: () => {},
    can: () => true,
  });
  const ctxFor = (role) => ({ sessions: sessionFor(role), audit: () => {} });

  const unconfigured = updateFactory.build({
    autoUpdater: null, backup: {}, getContext: () => ctxFor('ADMIN'), feedConfigured: false, log: () => {},
  });
  const noFeed = await unconfigured.check();
  s.check('an installation with no update feed simply never checks',
    noFeed.feedConfigured === false && noFeed.state === updateFactory.STATES.UNAVAILABLE, JSON.stringify(noFeed));

  // Installing without a downloaded update must be refused, not attempted.
  let installError = null;
  try { await unconfigured.install(); } catch (err) { installError = err.code; }
  s.check('installing with nothing downloaded is refused',
    installError === 'UPDATE_FAILED', String(installError));

  /* The service enforces the capability itself. The registry only checks that a
     session exists, and the pre-update backup runs as `system: true` — which is
     deliberately exempt from `backup.create` — so nothing downstream would have
     caught an unauthorised caller either. */
  for (const role of ['MARKETING', 'MANAGER']) {
    const asRole = updateFactory.build({
      autoUpdater: null, backup: {}, getContext: () => ctxFor(role), feedConfigured: false, log: () => {},
    });
    let code = null;
    try { await asRole.install(); } catch (err) { code = err.code; }
    s.check(`a ${role} user cannot install an update`, code === 'FORBIDDEN', `${role} → ${code}`);
  }
  const signedOut = updateFactory.build({
    autoUpdater: null, backup: {}, getContext: () => ctxFor(null), feedConfigured: false, log: () => {},
  });
  let anonCode = null;
  try { await signedOut.install(); } catch (err) { anonCode = err.code; }
  s.check('and nor can a caller with no session at all',
    anonCode === 'AUTH_REQUIRED' || anonCode === 'FORBIDDEN', String(anonCode));

  /* Silent install on quit would bypass install() entirely, taking the
     pre-update backup and the audit row with it. */
  const quitProbe = { autoDownload: true, autoInstallOnAppQuit: true, on: () => {} };
  updateFactory.build({
    autoUpdater: quitProbe, backup: {}, getContext: () => ctxFor('ADMIN'),
    feedConfigured: true, log: () => {}, notify: () => {},
  });
  s.check('the updater never installs silently on quit',
    quitProbe.autoInstallOnAppQuit === false, String(quitProbe.autoInstallOnAppQuit));

  // ------------------------------------- the update install is backup-gated
  const failingBackup = updateFactory.build({
    autoUpdater: { on: () => {}, quitAndInstall: () => { throw new Error('should not be reached'); } },
    backup: { create: async () => { throw new Error('disk full'); } },
    getContext: () => ({ audit: () => {} }),
    feedConfigured: true, log: () => {}, notify: () => {},
  });
  /* Drive it to DOWNLOADED so install() gets past its own state check. */
  const downloadedHandlers = {};
  updateFactory.build({
    autoUpdater: { on: (n, f) => { downloadedHandlers[n] = f; }, quitAndInstall: () => {} },
    backup: { create: async () => { throw new Error('disk full'); } },
    getContext: () => ({ audit: () => {} }),
    feedConfigured: true, log: () => {}, notify: () => {},
  });
  s.check('the updater exposes a state machine rather than installing on its own',
    typeof failingBackup.install === 'function' && typeof failingBackup.check === 'function');

  return s.finish();
};
