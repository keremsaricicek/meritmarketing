'use strict';
/* Application entry point.
 *
 * Startup order matters and is deliberate:
 *   single-instance lock → paths → logger → crash detection → database (with a
 *   pre-migration backup) → health check → services → IPC → window.
 *
 * If the database cannot be opened safely, the window is never created. Showing
 * a login screen backed by a damaged database is how a bad situation becomes a
 * data-loss situation.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const pathsModule = require('./paths');
const { Logger } = require('./diagnostics/logger');
const connection = require('./database/connection');
const { currentVersion, targetVersion } = require('./database/migrator');
const { SessionManager } = require('./auth/session');
const { registerAll, makeSenderValidator } = require('./ipc/registry');
const handlerFactory = require('./ipc/handlers');
const backupFactory = require('./backup/backup-service');
const photoFactory = require('./services/photo-service');
const exportFactory = require('./services/export-service');
const updateFactory = require('./updates/update-service');
const mainWindow = require('./windows/main-window');
const supportServices = require('./services/support-services');
const { AppError, CODES } = require('../shared/errors');
const { nowIso } = require('../shared/contracts/dates');

const isDevelopment = !app.isPackaged;
const RELEASE_CHANNEL = process.env.MERIT_CHANNEL || 'stable';

/* A stable identity Windows uses for taskbar grouping, shortcuts and toast
   attribution. Changing it after a release orphans pinned shortcuts, so it is
   set once and left alone. */
app.setAppUserModelId('com.meritmarketing.hub');

/* Two copies writing one SQLite file is how a database gets corrupted. The
   second launch hands its focus to the first and exits. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let db = null;
let win = null;
let logger = null;
let paths = null;
const sessions = new SessionManager();

function audit(entry) {
  if (!db) return;
  const session = sessions.get();
  try {
    db.prepare(`
      INSERT INTO audit_log (action, entity_type, entity_id, actor_user_id, actor_username, description, metadata, created_at)
      VALUES (@action, @entity_type, @entity_id, @actor_user_id, @actor_username, @description, @metadata, @created_at)`)
      .run({
        action: entry.action,
        entity_type: entry.entity_type ?? null,
        entity_id: entry.entity_id ?? null,
        actor_user_id: entry.actor_user_id ?? (session ? session.id : null),
        actor_username: entry.actor_username ?? (session ? session.username : null),
        description: entry.description ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        created_at: nowIso(),
      });
  } catch (err) {
    logger.error('audit.write-failed', { message: err.message, action: entry.action });
  }
}

const getContext = () => ({ db, sessions, audit, paths, logger });

function fatal(title, message, detail) {
  try { logger && logger.error('startup.fatal', { title, message, detail }); } catch (_) { /* nothing left */ }
  dialog.showErrorBox(title, `${message}\n\n${detail || ''}`.trim());
  app.exit(1);
}

async function start() {
  paths = pathsModule.resolve(app);
  logger = new Logger({ dir: paths.logs, console: isDevelopment });
  logger.setContext({
    appVersion: app.getVersion(),
    channel: RELEASE_CHANNEL,
    commit: process.env.MERIT_COMMIT || 'dev',
  });

  /* Did the last run end properly? A marker left behind means a crash, a power
     cut or a forced kill — reason enough to check the database more carefully
     than usual before trusting it. */
  const uncleanShutdown = fs.existsSync(paths.runningMarker);
  if (uncleanShutdown) logger.warn('startup.unclean-shutdown-detected');
  fs.writeFileSync(paths.runningMarker, nowIso());

  const backup = backupFactory.build({
    paths,
    appVersion: app.getVersion(),
    getDb: () => db,
    setDb: (next) => { db = next; },
    log: logger.asFunction(),
  });

  try {
    db = connection.open(paths.database, {
      log: (message) => logger.info('database.migration', { message }),
      /* A migration is the one moment the schema can go wrong in a way that is
         not reversible by hand. The snapshot is taken first, from the database
         as it is now, and a failure to take it stops the migration. */
      onBeforeMigrate: ({ from, to }) => {
        logger.warn('database.migration-pending', { from, to });
        if (from === 0) return; // nothing to protect on a brand-new install
        const tempDb = connection.open(paths.database, { readonly: true });
        try {
          const snapshot = path.join(paths.backups,
            `MeritBackup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-premigration.mmhbackup`);
          const raw = fs.readFileSync(paths.database);
          fs.writeFileSync(snapshot, backupFactory.pack(
            { format: backupFactory.MAGIC, appVersion: app.getVersion(), schemaVersion: from,
              createdAt: nowIso(), kind: 'automatic', label: 'premigration',
              databaseSha256: backupFactory.sha256(raw), photoCount: 0, entries: [] },
            [{ name: 'database.sqlite3', data: raw }]));
          logger.warn('database.premigration-backup', { snapshot, from, to });
        } finally {
          tempDb.close();
        }
      },
    });
  } catch (err) {
    /* Never replace a database we could not open. The file stays exactly where
       it is so it can be recovered.

       The user-facing text stays plain, but the underlying cause goes to the
       log — without it, "could not be opened" is indistinguishable between a
       corrupt file, a permissions problem and a native module built for the
       wrong runtime, and support has nothing to work with. */
    logger.error('database.open-failed', {
      message: err.message,
      code: err.code,
      stack: err.stack,
      internal: err.internal,
    });
    const detail = err instanceof AppError ? err.message : 'The database could not be opened.';
    return fatal('Merit Marketing Hub cannot start',
      detail,
      `Your data has not been changed. The database is at:\n${paths.database}\n\nBackups are in:\n${paths.backups}\n\nTechnical detail has been written to:\n${paths.logs}`);
  }

  const health = connection.checkHealth(db, { deep: uncleanShutdown });
  if (!health.healthy) {
    logger.error('database.unhealthy', { problems: health.problems });
    return fatal('Merit Marketing Hub cannot start',
      'The database did not pass its integrity check and has not been changed.',
      `Please restore the most recent backup from:\n${paths.backups}`);
  }
  logger.setContext({ schemaVersion: currentVersion(db) });
  logger.info('startup.database-ready', { schema: currentVersion(db), target: targetVersion(), uncleanShutdown });

  sessions.setPermissionOverrides(supportServices.settings.overrides(db));
  backup.prune({ keepAutomatic: 10 });

  const photos = photoFactory.build({ dialog, paths, getWindow: () => win });
  const exporter = exportFactory.build({ dialog, getWindow: () => win });

  let autoUpdater = null;
  const feedConfigured = !!process.env.MERIT_UPDATE_URL;
  if (feedConfigured && app.isPackaged) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MERIT_UPDATE_URL, channel: RELEASE_CHANNEL });
    } catch (err) {
      logger.warn('update.provider-unavailable', { message: err.message });
    }
  }
  const updates = updateFactory.build({
    autoUpdater, backup, getContext, feedConfigured, channel: RELEASE_CHANNEL,
    log: logger.asFunction(),
    notify: (status) => { if (win && !win.isDestroyed()) win.webContents.send('updates:status', status); },
  });

  const appInfo = {
    info: () => ({
      name: 'Merit Marketing Hub',
      version: app.getVersion(),
      channel: RELEASE_CHANNEL,
      commit: process.env.MERIT_COMMIT || 'dev',
      schemaVersion: currentVersion(db),
      electron: process.versions.electron,
      packaged: app.isPackaged,
      updates: updates.status(),
    }),
  };

  const handlers = handlerFactory.build({ app: appInfo, backup, photos, updates, exporter });
  registerAll({
    ipcMain,
    handlers,
    getContext,
    isTrustedSender: makeSenderValidator({ getTrustedWindow: () => win, expectedOrigin: 'file://' }),
    log: logger.asFunction(),
  });

  win = mainWindow.create({ isDevelopment, log: logger.asFunction() });

  /* An idle session is ended in the main process; the renderer is told so it
     can clear the screen rather than leaving a guest's record on a monitor in
     an empty office. */
  setInterval(() => {
    if (sessions.get() === null && sessions.current === null) return;
    if (sessions.isExpired()) {
      sessions.end();
      if (win && !win.isDestroyed()) win.webContents.send('session:ended', { reason: 'idle' });
    }
  }, 60000).unref();
}

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(start).catch((err) => {
  fatal('Merit Marketing Hub cannot start', 'The application failed to initialise.', err && err.message);
});

app.on('window-all-closed', () => app.quit());

/* A clean exit: checkpoint the WAL, close the handle, remove the marker. The
   next launch then knows it does not need a deep integrity check. */
app.on('before-quit', () => {
  try { if (db) connection.close(db); } catch (err) { logger && logger.error('shutdown.close-failed', { message: err.message }); }
  db = null;
  try { if (paths && fs.existsSync(paths.runningMarker)) fs.unlinkSync(paths.runningMarker); } catch (_) { /* best effort */ }
  logger && logger.info('shutdown.clean');
});

process.on('uncaughtException', (err) => {
  if (logger) logger.error('process.uncaught', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  if (logger) logger.error('process.unhandled-rejection', { message: String(reason) });
});
