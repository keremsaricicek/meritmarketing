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

const { AppError, CODES, forbidden } = require('../../shared/errors');
const guard = require('../services/guard');

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

/* v1 SHIPS WITH AUTOMATIC UPDATES OFF, IN CODE.
 *
 * Documentation saying updates are disabled is not the same as code that
 * disables them: setting MERIT_UPDATE_URL was enough to arm the whole flow.
 * Until the installer is signature-verified (B8) and the maker matches the
 * update client (B9), whoever controls a feed controls the operator's machine.
 *
 * So the switch lives here, above the environment. The structure below is kept
 * intact for the future updater project; nothing can reach it while this is on. */
const V1_UPDATES_DISABLED = true;

/* The only entry point the application uses. While the v1 switch is on it
   never reaches the implementation below. */
function build(options) {
  if (!V1_UPDATES_DISABLED) return buildUpdater(options);

  const { autoUpdater, channel = 'stable' } = options;
  /* Neutralise the updater object itself before returning. No listener is
     attached, so no download can be triggered by the updater's own events —
     but electron-updater will install on a normal quit if it ever reaches a
     downloaded state by any other route, and that path never calls install()
     below. Turning it off costs two lines and closes the question. */
  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  }
  return {
    STATES,
    V1_DISABLED: true,
    status() {
      return { state: STATES.UNAVAILABLE, channel, version: null, feedConfigured: false,
        disabled: true, lastError: null };
    },
    async check() {
      return { state: STATES.UNAVAILABLE, channel, feedConfigured: false, disabled: true,
        message: 'Automatic updates are turned off in this version. Update by running the new installer.' };
    },
    async install() {
      throw new AppError(CODES.UPDATE_FAILED,
        'Automatic updates are turned off in this version. Update by running the new installer.');
    },
  };
}

/* The full updater, kept intact for the future updater project (B8, B9) and
   still covered by its own tests so the authorization and backup rules do not
   rot while they are unreachable. Nothing in the application calls this
   directly; `build` is the door, and in v1 that door is shut. */
function buildUpdater({ autoUpdater, backup, getContext, log = () => {}, notify = () => {}, feedConfigured = false, channel = 'stable' }) {
  let state = STATES.IDLE;
  let lastError = null;
  let pendingVersion = null;

  const setState = (next, extra = {}) => {
    state = next;
    notify({ state, channel, version: pendingVersion, ...extra });
  };

  if (autoUpdater) {
    autoUpdater.autoDownload = false;
    /* Never restart underneath somebody. The user chooses when.
       This MUST be false: with it on, electron-updater installs silently on a
       normal quit, straight through its own BaseUpdater — which never reaches
       install() below, so the pre-update backup and the audit row are both
       skipped. An invariant enforced only on the path the user takes is not an
       invariant. */
    autoUpdater.autoInstallOnAppQuit = false;

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
      /* Installing an update restarts the application for everybody and
         replaces the program on disk. The IPC surface documents this as
         ADMIN-only with `backup.create`, and the registry enforces only that a
         session exists — capability enforcement is the service's job here as
         everywhere else, and this service was the one not doing it. The backup
         it takes is `system: true`, which is deliberately exempt from the
         capability check, so nothing downstream was catching it either. */
      const ctx = getContext();
      guard.requireCapability(ctx, 'backup.create');
      const session = ctx.sessions.get();
      if (!session || session.role !== 'ADMIN') {
        throw forbidden('Only an administrator can install an update.');
      }
      if (state !== STATES.DOWNLOADED) {
        throw new AppError(CODES.UPDATE_FAILED, 'There is no downloaded update to install.');
      }
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

module.exports = { build, buildUpdater, STATES, V1_UPDATES_DISABLED };
