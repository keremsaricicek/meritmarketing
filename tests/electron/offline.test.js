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

  /* ------------------------------------------- the update check is quiet
   *
   * The one place the application reaches out. A failed check — offline being
   * the normal case in a back office — is a status and a log line, never a
   * throw and never a dialog. The detailed updater rules (hard-coded feed,
   * packaged Windows only, backup-gated install) live in updates.test.js. */
  const { EventEmitter } = require('events');
  const offlineUpdater = new EventEmitter();
  offlineUpdater.setFeedURL = () => {};
  offlineUpdater.checkForUpdates = () => { throw new Error('getaddrinfo ENOTFOUND github.com'); };
  const notices = [];
  const updates = updateFactory.build({
    autoUpdater: offlineUpdater, isPackaged: true, platform: 'win32',
    backup: { create: async () => ({ name: 'x' }) },
    getContext: () => ({ audit: () => {} }),
    log: () => {},
    notify: (st) => notices.push(st.state),
  });

  let threw = null;
  let status = null;
  try { status = await updates.check(); } catch (err) { threw = err; }
  s.check('a failed update check does not throw', threw === null, String(threw && threw.message));
  s.check('a failed update check reports "unavailable", not an error',
    status.state === updateFactory.STATES.UNAVAILABLE, JSON.stringify(status));
  s.check('the failure is surfaced as a status, not a dialog',
    notices.includes(updateFactory.STATES.UNAVAILABLE), JSON.stringify(notices));

  offlineUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  s.check('an offline error from the updater is absorbed',
    updates.status().state === updateFactory.STATES.UNAVAILABLE, JSON.stringify(updates.status()));

  return s.finish();
};
