'use strict';
/* Versioned schema migrations.
 *
 * Rules this enforces, all of which exist because the alternative destroys a
 * customer's book:
 *   - every schema change is a numbered file, never an ad-hoc ALTER at startup
 *   - each migration runs inside a transaction and fails closed
 *   - a database from the FUTURE (newer than this build knows) is refused, not
 *     "migrated" downwards
 *   - a checksum change on an already-applied migration is refused, because it
 *     means the file was edited after it ran somewhere
 *   - a failure leaves the database exactly as it was and never yields a blank
 *     replacement
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AppError, CODES } = require('../../shared/errors');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
}

function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = /^(\d+)-(.+)\.sql$/.exec(file);
      if (!match) {
        throw new AppError(CODES.MIGRATION_FAILED,
          'A migration file is not named <version>-<name>.sql.', { internal: file });
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return {
        version: Number(match[1]),
        name: match[2],
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

function currentVersion(db) {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row && row.v ? row.v : 0;
}

function targetVersion(dir = MIGRATIONS_DIR) {
  const all = loadMigrations(dir);
  return all.length ? all[all.length - 1].version : 0;
}

/**
 * Bring the database up to the latest known schema.
 * Returns { from, to, applied: [...] } and throws AppError on any failure.
 */
function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const migrations = loadMigrations(dir);
  ensureMigrationsTable(db);

  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  const appliedByVersion = new Map(applied.map((r) => [r.version, r]));
  const from = applied.length ? applied[applied.length - 1].version : 0;
  const to = migrations.length ? migrations[migrations.length - 1].version : 0;

  /* A database written by a NEWER build. Running older code against it would
     silently misread columns it does not know about, so refuse to open at all. */
  if (from > to) {
    throw new AppError(CODES.MIGRATION_FAILED,
      'This database was created by a newer version of Merit Marketing Hub. Please update the application.',
      { internal: `db=${from} app=${to}` });
  }

  /* An already-applied migration whose file has since changed means two
     installations have diverging schemas under the same version number. */
  for (const m of migrations) {
    const seen = appliedByVersion.get(m.version);
    if (seen && seen.checksum !== m.checksum) {
      throw new AppError(CODES.MIGRATION_FAILED,
        'The database schema history does not match this application build.',
        { internal: `migration ${m.version}-${m.name} checksum drift` });
    }
  }

  const pending = migrations.filter((m) => !appliedByVersion.has(m.version));
  const done = [];

  for (const m of pending) {
    /* Foreign keys are suspended for the DDL only. SQLite ignores changes to
       this pragma inside a transaction, so it has to happen out here — and it
       must be restored even if the migration throws. */
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(m.version, m.name, m.checksum, new Date().toISOString());
      });
      run();
      /* Structural damage introduced by a migration must not be discovered
         later by a user — check while we still know which migration did it. */
      const violations = db.pragma('foreign_key_check');
      if (violations.length) {
        throw new AppError(CODES.MIGRATION_FAILED,
          'A schema migration left the database inconsistent.',
          { internal: `${m.version}-${m.name}: ${JSON.stringify(violations).slice(0, 400)}` });
      }
      done.push({ version: m.version, name: m.name });
      log(`migration applied: ${m.version}-${m.name}`);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(CODES.MIGRATION_FAILED,
        'The database could not be upgraded. Your data has not been changed.',
        { internal: `${m.version}-${m.name}: ${err.message}` });
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
  }

  return { from, to, applied: done };
}

module.exports = { migrate, currentVersion, targetVersion, loadMigrations, MIGRATIONS_DIR };
