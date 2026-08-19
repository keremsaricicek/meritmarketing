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
 * The provider is configured at build time. No credential is ever embedded: a
 * private repository is served through a static HTTPS feed the client only
 * needs to READ, and publishing credentials live in CI.
 */

const { AppError, CODES } = require('../../shared/errors');

const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  NOT_AVAILABLE: 'not-available',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable',
});

function build({ autoUpdater, backup, getContext, log = () => {}, notify = () => {}, feedConfigured = false, channel = 'stable' }) {
  let state = STATES.IDLE;
  let lastError = null;
  let pendingVersion = null;

  const setState = (next, extra = {}) => {
    state = next;
    notify({ state, channel, version: pendingVersion, ...extra });
  };

  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    /* Never restart underneath somebody. The user chooses when. */
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      pendingVersion = info && info.version;
      log('info', 'update.available', { version: pendingVersion });
      setState(STATES.AVAILABLE);
      autoUpdater.downloadUpdate().catch((err) => {
        lastError = err.message;
        log('warn', 'update.download-failed', { message: err.message });
        setState(STATES.FAILED, { message: 'The update could not be downloaded.' });
      });
    });
    autoUpdater.on('update-not-available', () => setState(STATES.NOT_AVAILABLE));
    autoUpdater.on('download-progress', (p) => setState(STATES.DOWNLOADING, { percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      pendingVersion = info && info.version;
      log('info', 'update.downloaded', { version: pendingVersion });
      setState(STATES.DOWNLOADED);
    });
    autoUpdater.on('error', (err) => {
      /* Offline is the normal case in a hotel back office, not an incident.
         It is logged and shown as "unavailable", never as an error dialog. */
      lastError = err && err.message;
      log('info', 'update.check-failed', { message: lastError });
      setState(STATES.UNAVAILABLE);
    });
  }

  return {
    STATES,

    status() {
      return { state, channel, version: pendingVersion, feedConfigured, lastError };
    },

    async check() {
      if (!feedConfigured || !autoUpdater) {
        /* No feed is a legitimate configuration, not a failure: an internal
           build installed by hand simply never checks. */
        return { state: STATES.UNAVAILABLE, channel, feedConfigured: false,
          message: 'Automatic updates are not configured for this installation.' };
      }
      setState(STATES.CHECKING);
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        lastError = err.message;
        log('info', 'update.check-failed', { message: err.message });
        setState(STATES.UNAVAILABLE);
      }
      return this.status();
    },

    /* Called when the user asks to restart and update. The pre-update backup is
       a gate, not a courtesy: if it fails, the install does not happen. */
    async install() {
      if (state !== STATES.DOWNLOADED) {
        throw new AppError(CODES.UPDATE_FAILED, 'There is no downloaded update to install.');
      }
      const ctx = getContext();
      let safety;
      try {
        safety = await backup.create(ctx, { label: 'preupdate', system: true });
      } catch (err) {
        log('error', 'update.backup-failed', { message: err.message });
        throw new AppError(CODES.UPDATE_FAILED,
          'The update was not installed because a safety backup could not be created. Your data has not been changed.');
      }
      ctx.audit({ action: 'UPDATE_INSTALL', entity_type: 'app',
        description: `Installing update ${pendingVersion || ''} (safety backup ${safety.name})` });
      log('warn', 'update.installing', { version: pendingVersion, safety: safety.name });
      /* isSilent=false, isForceRunAfter=true — the installer shows progress and
         the app comes back up afterwards. */
      autoUpdater.quitAndInstall(false, true);
      return { ok: true, version: pendingVersion, safetyBackup: safety.name };
    },
  };
}

module.exports = { build, STATES };
