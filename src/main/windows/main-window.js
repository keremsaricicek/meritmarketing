'use strict';
/* The application window, hardened.
 *
 * Every one of these settings is the difference between "a renderer bug is a
 * broken screen" and "a renderer bug is code execution on the operator's
 * machine". A CRM full of passport numbers is worth the strictness.
 */

const path = require('path');
const fs = require('fs');
const { BrowserWindow, shell } = require('electron');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer');

/* Restrictive by default and no unsafe-inline anywhere. `script-src 'self'` is
   what makes an injected <script> or an onclick attribute inert, which is why
   the renderer was rewritten to use event delegation rather than inline
   handlers. connect-src 'none' means a compromised renderer cannot exfiltrate
   the guest book to a remote host — it has no network at all. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function iconPath() {
  /* The owner's Windows icon. Absent in this repository, so the window falls
     back to the Electron default rather than shipping an invented mark. */
  const candidate = path.join(__dirname, '..', '..', '..', 'assets', 'crm.ico');
  return fs.existsSync(candidate) ? candidate : undefined;
}

function create({ isDevelopment = false, log = () => {} } = {}) {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#f7f5f2',
    title: 'Merit Marketing Hub',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      /* The three that matter most. nodeIntegration off and contextIsolation on
         keep the page out of Node; sandbox on puts the renderer in the OS
         sandbox so even a Chromium exploit lands somewhere with no filesystem. */
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      /* DevTools are a debugging aid, not a production feature. */
      devTools: isDevelopment,
    },
  });

  win.setMenuBarVisibility(false);

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  /* Nothing in this application needs a camera, a microphone, a location or a
     notification. Denying by default means a future feature has to ask
     deliberately rather than inheriting access. */
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  /* The renderer is a local application, not a browser. It never navigates
     anywhere, and it never opens a window. */
  win.webContents.on('will-navigate', (event, url) => {
    log('warn', 'window.navigation-blocked', { url });
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    log('warn', 'window.popup-blocked', { url });
    return { action: 'deny' };
  });
  /* Deliberately no shell.openExternal bridge: no screen needs one, and a URL
     built from guest data is exactly how one becomes a command. */
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(RENDERER_DIR, 'index.html'));

  return win;
}

module.exports = { create, CSP, RENDERER_DIR, iconPath, shell };
