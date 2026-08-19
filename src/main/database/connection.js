'use strict';
/* Opening, checking and closing the database.
 *
 * The pragmas here are the difference between "SQLite works" and "SQLite is
 * safe on a desktop that loses power":
 *   foreign_keys ON  — the constraints in the schema are inert without it
 *   journal_mode WAL — a reader is never blocked by the writer, and a crash
 *                      recovers from the log instead of corrupting the file
 *   synchronous FULL — WAL's default (NORMAL) can lose the last commits on
 *                      power loss; a CRM losing a reservation is worse than
 *                      a few milliseconds per write on a single-user desktop
 *   busy_timeout     — wait rather than throw when a checkpoint holds the file
 */

const fs = require('fs');
const path = require('path');
const { Database } = require('./driver');
const { migrate, currentVersion } = require('./migrator');
const { AppError, CODES } = require('../../shared/errors');

const PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = FULL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'trusted_schema = OFF',
];

function applyPragmas(db) {
  for (const p of PRAGMAS) db.pragma(p);
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new AppError(CODES.DATABASE_ERROR, 'The database could not be opened safely.',
      { internal: 'foreign_keys pragma did not take effect' });
  }
}

/**
 * Open the database at `file`, run migrations, and verify it is usable.
 *
 * `onBeforeMigrate` is called with { from, to } when work is pending, which is
 * where the caller takes the pre-migration backup. If it throws, nothing is
 * migrated — that is deliberate: no verified backup, no schema change.
 */
function open(file, { readonly = false, log = () => {}, onBeforeMigrate = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly });
  try {
    applyPragmas(db);
    if (!readonly) {
      const from = currentVersion(db);
      const { targetVersion } = require('./migrator');
      const to = targetVersion();
      if (onBeforeMigrate && to > from) onBeforeMigrate({ from, to, db });
      migrate(db, { log });
    }
    return db;
  } catch (err) {
    try { db.close(); } catch (_) { /* the open failure is what matters */ }
    throw err;
  }
}

/**
 * Structural health check. `deep` runs a full integrity_check and is meant for
 * after a restore, after a migration, or when the last shutdown was unclean —
 * it reads every page, so it is not something to do on every launch.
 */
function checkHealth(db, { deep = false } = {}) {
  const problems = [];
  try {
    if (deep) {
      const rows = db.pragma('integrity_check');
      const first = rows[0] && (rows[0].integrity_check || rows[0]);
      if (first !== 'ok') problems.push(`integrity_check: ${JSON.stringify(rows).slice(0, 300)}`);
    } else {
      const rows = db.pragma('quick_check');
      const first = rows[0] && (rows[0].quick_check || rows[0]);
      if (first !== 'ok') problems.push(`quick_check: ${JSON.stringify(rows).slice(0, 300)}`);
    }
    const fk = db.pragma('foreign_key_check');
    if (fk.length) problems.push(`foreign_key_check: ${fk.length} violation(s)`);
  } catch (err) {
    problems.push(`health check failed: ${err.message}`);
  }
  return { healthy: problems.length === 0, problems };
}

function close(db) {
  if (!db || !db.open) return;
  try {
    /* Fold the WAL back into the main file so a copy of the .sqlite3 taken
       afterwards is complete on its own. */
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) { /* closing anyway */ }
  db.close();
}

module.exports = { open, close, checkHealth, applyPragmas, PRAGMAS };
