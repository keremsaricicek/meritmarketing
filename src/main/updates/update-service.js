'use strict';
/* Updates.
 *
 * Two rules outrank everything else here:
 *
 *   1. The application must work with no Internet. An update check that fails
 *      is a log line, not a dialog and never a blocked startup.
 *   2. An update must never be installed without a verified backup first. If
 *      the backup cannot be made, the install is blocked — business data is
 *      worth more than being on the newest build.
 *
 * The client is Electron's BUILT-IN `autoUpdater`, which on Windows is
 * Squirrel.Windows — the same technology @electron-forge/maker-squirrel builds
 * the installer with, so the maker and the update client finally match. (The
 * earlier design used electron-updater, whose Windows path is NSIS and did not
 * compose with the Squirrel installer at all.)
 *
 * The feed is HARD-CODED below. It is not read from the environment, a
 * settings file or the registry: anything able to set an environment variable
 * for this user could otherwise choose which host this machine downloads and
 * runs code from. Changing the feed means shipping a new build.
 *
 * How Squirrel.Windows behaves, because the backup rule depends on it:
 * `checkForUpdates()` runs `Update.exe --update <feed>`, which reads
 * `<feed>/RELEASES`, downloads the .nupkg and STAGES the new version in a new
 * `app-x.y.z` folder beside the current one. From that moment the next launch
 * runs the new version, whether or not anybody presses "Restart and update".
 * So a verified backup is taken twice:
 *   - as soon as the download is staged (before the new version can ever run),
 *   - and again, as a hard gate, immediately before `quitAndInstall`.
 * The user's data lives in userData (%APPDATA%\Merit Marketing Hub), which
 * Squirrel never touches; see docs/UPDATE.md.
 */

const { AppError, CODES, forbidden } = require('../../shared/errors');
const guard = require('../services/guard');

const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  NOT_AVAILABLE: 'not-available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  INSTALLING: 'installing',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable',
});

/* The public repository's GitHub Releases. GitHub redirects
   `releases/latest/download/<asset>` to that asset on the newest published
   (non-draft, non-prerelease) release, which is exactly the shape Squirrel
   wants: `<feed>/RELEASES`, then `<feed>/<package>.nupkg`. */
const FEED_REPOSITORY = 'keremsaricicek/meritmarketing';
const FEED_URL = `https://github.com/${FEED_REPOSITORY}/releases/latest/download`;

const STARTUP_DELAY_MS = 60 * 1000;            // let startup and the auto-backup finish first
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;  // then every four hours while running

/* Updates run only in the INSTALLED Windows application. A development run
   (`npm start`), a test run, the Linux/CI zip and a hand-unzipped copy all
   have no Squirrel Update.exe to apply anything with, so they never check.
   There is deliberately no override: the feed is the constant above. */
function resolveFeed({ isPackaged, platform }) {
  if (!isPackaged) {
    return { enabled: false, url: FEED_URL, reason: 'Updates are only checked by the installed application, not by a development build.' };
  }
  if (platform !== 'win32') {
    return { enabled: false, url: FEED_URL, reason: 'Automatic updates are only available on Windows.' };
  }
  return { enabled: true, url: FEED_URL, reason: null };
}

const short = (value) => String((value && value.message) || value || '').slice(0, 300);

function build({
  autoUpdater,
  backup,
  getContext,
  log = () => {},
  notify = () => {},
  isPackaged = false,
  platform = process.platform,
  currentVersion = null,
  channel = 'stable',
  now = () => new Date().toISOString(),
  timers = { setTimeout, setInterval, clearTimeout, clearInterval },
}) {
  const feed = resolveFeed({ isPackaged, platform });
  const enabled = feed.enabled && !!autoUpdater;

  let state = enabled ? STATES.IDLE : STATES.UNAVAILABLE;
  let message = enabled ? null : feed.reason;
  let lastError = null;
  let lastCheckedAt = null;
  let pendingVersion = null;
  let stagedBackup = null;
  let installing = false;
  let startTimer = null;
  let intervalTimer = null;

  const status = () => ({
    state,
    enabled,
    channel,
    currentVersion,
    version: pendingVersion,
    feed: feed.url,
    lastCheckedAt,
    lastError,
    message,
    stagedBackup,
  });

  const setState = (next, nextMessage = null) => {
    state = next;
    message = nextMessage;
    try { notify(status()); } catch (_) { /* a closed window is not an error */ }
  };

  /* A verified backup: written by the backup service (which already checks the
     snapshot's integrity), then read back from disk and validated as an
     archive before it is trusted. */
  async function verifiedBackup(ctx) {
    const made = await backup.create(ctx, { label: 'preupdate', system: true });
    if (!made || !made.name) throw new Error('The backup service returned no backup.');
    if (typeof backup.validateFile !== 'function' || typeof backup.resolveBackup !== 'function') {
      throw new Error('The backup could not be verified.');
    }
    backup.validateFile(backup.resolveBackup(made.name));
    return made;
  }

  if (enabled) {
    autoUpdater.setFeedURL({ url: feed.url });

    autoUpdater.on('checking-for-update', () => {
      lastCheckedAt = now();
      setState(STATES.CHECKING);
    });
    /* On Windows "available" means Squirrel has already started downloading. */
    autoUpdater.on('update-available', () => {
      log('info', 'update.available', {});
      setState(STATES.DOWNLOADING, 'A new version is being downloaded in the background.');
    });
    autoUpdater.on('update-not-available', () => {
      lastError = null;
      setState(STATES.NOT_AVAILABLE, 'You are up to date.');
    });
    autoUpdater.on('update-downloaded', async (_event, _notes, releaseName) => {
      pendingVersion = releaseName || null;
      log('info', 'update.downloaded', { version: pendingVersion });
      /* Squirrel has staged the new version: the next launch runs it. Take the
         safety backup now, while the version that wrote the data is still the
         one running. */
      try {
        const made = await verifiedBackup(getContext());
        stagedBackup = made.name;
        log('info', 'update.staged-backup', { version: pendingVersion, backup: made.name });
      } catch (err) {
        stagedBackup = null;
        log('error', 'update.staged-backup-failed', { message: short(err) });
      }
      setState(STATES.DOWNLOADED, `Version ${pendingVersion || 'update'} is ready. Restart to finish updating.`);
    });
    autoUpdater.on('error', (err) => {
      /* Offline is the normal case in a back office, not an incident. It is
         logged and shown as "unavailable", never as an error dialog. A
         download already staged stays staged. */
      lastError = short(err);
      log('info', 'update.check-failed', { message: lastError });
      if (state !== STATES.DOWNLOADED && state !== STATES.INSTALLING) {
        setState(STATES.UNAVAILABLE, 'Updates are unavailable right now (offline or the update server could not be reached).');
      }
    });
  }

  const service = {
    STATES,
    FEED_URL,

    status,

    /* Starts the schedule: once after a delay, then every few hours. Does
       nothing outside the installed Windows application. */
    start({ skipInitialCheck = false } = {}) {
      if (!enabled || intervalTimer) return false;
      const run = () => { service.check().catch(() => {}); };
      if (!skipInitialCheck) {
        startTimer = timers.setTimeout(run, STARTUP_DELAY_MS);
        if (startTimer && startTimer.unref) startTimer.unref();
      }
      intervalTimer = timers.setInterval(run, CHECK_INTERVAL_MS);
      if (intervalTimer && intervalTimer.unref) intervalTimer.unref();
      return true;
    },

    stop() {
      if (startTimer) timers.clearTimeout(startTimer);
      if (intervalTimer) timers.clearInterval(intervalTimer);
      startTimer = null;
      intervalTimer = null;
    },

    /* Never throws: a failed check is a status and a log line. */
    async check() {
      if (!enabled) return status();
      /* Nothing to do while a check or download is in flight, or once a
         version is staged and waiting for a restart. */
      if ([STATES.CHECKING, STATES.DOWNLOADING, STATES.DOWNLOADED, STATES.INSTALLING].includes(state)) {
        return status();
      }
      lastCheckedAt = now();
      try {
        autoUpdater.checkForUpdates();
      } catch (err) {
        lastError = short(err);
        log('info', 'update.check-failed', { message: lastError });
        setState(STATES.UNAVAILABLE, 'Updates are unavailable right now (offline or the update server could not be reached).');
      }
      return status();
    },

    /* Called when the user chooses "Restart and update". The pre-update backup
       is a gate, not a courtesy: if it fails, the install does not happen. */
    async install() {
      /* Installing restarts the application for everybody and replaces the
         program on disk. The IPC surface documents this as ADMIN-only with
         `backup.create`; the registry enforces only that a session exists, so
         the service enforces the rest. The backup it takes is `system: true`,
         which is exempt from the capability check, so nothing downstream would
         catch an unauthorised caller either. */
      const ctx = getContext();
      guard.requireCapability(ctx, 'backup.create');
      const session = ctx.sessions.get();
      if (!session || session.role !== 'ADMIN') {
        throw forbidden('Only an administrator can install an update.');
      }
      if (!enabled || state !== STATES.DOWNLOADED) {
        throw new AppError(CODES.UPDATE_FAILED, 'There is no downloaded update to install.');
      }
      if (installing) {
        throw new AppError(CODES.UPDATE_FAILED, 'The update is already being installed.');
      }
      installing = true;

      let safety;
      try {
        safety = await verifiedBackup(ctx);
      } catch (err) {
        installing = false;
        const reason = short(err);
        log('error', 'update.backup-failed', { message: reason });
        notify({ ...status(), message: `The update was not installed: the safety backup failed (${reason}).` });
        throw new AppError(CODES.UPDATE_FAILED,
          `The update was not installed because a safety backup could not be created. Your data has not been changed. Reason: ${reason}`);
      }

      ctx.audit({ action: 'UPDATE_INSTALL', entity_type: 'app',
        description: `Installing update ${pendingVersion || ''} (safety backup ${safety.name})` });
      log('warn', 'update.installing', { version: pendingVersion, safety: safety.name });
      setState(STATES.INSTALLING, 'Restarting to finish the update…');

      /* Answer the renderer first, then restart. Electron's quitAndInstall on
         Windows starts the staged version through Update.exe and quits; the
         normal before-quit handler closes the database cleanly. */
      timers.setTimeout(() => {
        try {
          autoUpdater.quitAndInstall();
        } catch (err) {
          installing = false;
          lastError = short(err);
          log('error', 'update.quit-and-install-failed', { message: lastError });
          setState(STATES.FAILED, 'The application could not restart to install the update. Close and reopen it to finish.');
        }
      }, 250);
      return { ok: true, version: pendingVersion, safetyBackup: safety.name };
    },
  };
  return service;
}

module.exports = { build, resolveFeed, STATES, FEED_URL, FEED_REPOSITORY, STARTUP_DELAY_MS, CHECK_INTERVAL_MS };
