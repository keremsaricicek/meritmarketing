'use strict';
/* Squirrel.Windows lifecycle events.
 *
 * Squirrel runs the application with one of these arguments while installing,
 * updating or uninstalling it, and expects it to do its housekeeping and exit
 * quickly — it waits on the process, and an application that opens its window
 * (and its database) here would stall the installer:
 *
 *   --squirrel-install    first install         → create shortcuts, quit
 *   --squirrel-updated    a new version applied → refresh shortcuts, quit
 *   --squirrel-uninstall  being removed         → remove shortcuts, quit
 *   --squirrel-obsolete   an old version folder about to be deleted → quit
 *   --squirrel-firstrun   first normal launch after install → carry on
 *
 * This is the same thing the `electron-squirrel-startup` package does, written
 * inline so it needs no dependency. It never touches user data: uninstalling
 * removes the program and its shortcuts and leaves %APPDATA%\Merit Marketing Hub
 * (database, photos, backups) exactly where it is.
 */

const path = require('path').win32;   // only ever acts on Windows paths
const { spawn } = require('child_process');

const QUIT_EVENTS = new Set(['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete']);

/* Returns true when this launch was a Squirrel event and the caller must not
   start the application. */
function handle({ app, argv = process.argv, platform = process.platform, execPath = process.execPath,
  spawnFn = spawn, setTimeoutFn = setTimeout } = {}) {
  if (platform !== 'win32') return false;
  const command = argv[1];
  if (!command || !QUIT_EVENTS.has(command)) return false;

  /* Layout: %LOCALAPPDATA%\MeritMarketingHub\Update.exe and
     %LOCALAPPDATA%\MeritMarketingHub\app-x.y.z\MeritMarketingHub.exe */
  const updateExe = path.resolve(path.dirname(execPath), '..', 'Update.exe');
  const exeName = path.basename(execPath);

  let quit = false;
  const done = () => { if (!quit) { quit = true; app.quit(); } };

  const runUpdate = (args) => {
    try {
      const child = spawnFn(updateExe, args, { detached: true });
      if (child && typeof child.on === 'function') {
        child.on('close', done);
        child.on('error', done);
      }
    } catch (_) {
      done();
      return;
    }
    /* Never hang the installer waiting for a shortcut. */
    setTimeoutFn(done, 5000);
  };

  switch (command) {
    case '--squirrel-install':
    case '--squirrel-updated':
      runUpdate(['--createShortcut', exeName]);
      break;
    case '--squirrel-uninstall':
      runUpdate(['--removeShortcut', exeName]);
      break;
    default: // --squirrel-obsolete
      done();
  }
  return true;
}

const isFirstRun = (argv = process.argv) => argv.includes('--squirrel-firstrun');

module.exports = { handle, isFirstRun, QUIT_EVENTS };
