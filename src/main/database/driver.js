'use strict';
/* The SQLite driver: Node's built-in `node:sqlite`.
 *
 * WHY THIS ONE, over better-sqlite3 / node-sqlite3 / sql.js:
 *
 *   Electron compatibility — it ships inside Electron's own Node (24.x here),
 *     so there is no ABI to match and no electron-rebuild step. The alternative
 *     failed in exactly that way during this migration: better-sqlite3 built
 *     for Node 22 could not load in Electron 43, and rebuilding it needs the
 *     Electron headers, node-gyp, Python and a C++ toolchain on every build
 *     machine.
 *   Windows packaging — nothing to unpack from the asar, nothing to sign
 *     separately, no prebuilt-binary matrix to keep current.
 *   Maintenance — maintained as part of Node, with Node's security cadence,
 *     rather than a separate project that must chase each Electron release.
 *   Capability — synchronous prepared statements, explicit transactions, the
 *     online backup API, and full PRAGMA access: everything this application
 *     needs.
 *
 * The cost is that its API differs slightly from better-sqlite3's, so this
 * module presents the small surface the repositories already use. Keeping that
 * surface here means the data layer is a seam: a future driver swap, or a move
 * to a remote API, touches this file rather than every query.
 */

const sqlite = require('node:sqlite');

/* PRAGMAs that answer with a row rather than silently applying. */
const RETURNS_VALUE = /^(journal_mode|synchronous|foreign_keys|busy_timeout|user_version|trusted_schema|wal_checkpoint)/i;

class Statement {
  constructor(statement) {
    this.statement = statement;
  }

  /* better-sqlite3 accepts either positional arguments or a single object of
     named parameters. node:sqlite accepts the same shapes, but rejects an
     object containing keys the statement does not use — which is exactly the
     strictness we want, so it is passed straight through. */
  run(...params) {
    const result = this.statement.run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get(...params) {
    const row = this.statement.get(...params);
    return row === undefined ? undefined : row;
  }

  all(...params) {
    return this.statement.all(...params);
  }
}

class Database {
  constructor(file, { readonly = false } = {}) {
    this.handle = new sqlite.DatabaseSync(file, {
      readOnly: readonly,
      /* The schema's foreign keys are inert without this, and relying on a
         PRAGMA issued later leaves a window where they are not enforced. */
      enableForeignKeyConstraints: true,
      /* SQLite otherwise treats "unknown" as a string literal rather than an
         error, which turns a typo'd column name into a silent constant. */
      enableDoubleQuotedStringLiterals: false,
    });
    this.file = file;
    this.readonly = readonly;
    this.open = true;
    this.inTransaction = false;
  }

  prepare(sql) {
    return new Statement(this.handle.prepare(sql));
  }

  exec(sql) {
    this.handle.exec(sql);
    return this;
  }

  /* `pragma('foreign_keys = ON')` to set, `pragma('foreign_keys', {simple:true})`
     to read one value, `pragma('foreign_key_check')` to read many rows. */
  pragma(statement, { simple = false } = {}) {
    const text = String(statement).trim();
    const isAssignment = text.includes('=');
    const name = text.split(/[\s(=]/)[0];

    if (isAssignment) {
      /* Some assignments (journal_mode, wal_checkpoint) answer with a row.
         Executing those with exec() throws, so they are stepped instead. */
      if (RETURNS_VALUE.test(name)) {
        const rows = this.handle.prepare(`PRAGMA ${text}`).all();
        return simple ? firstValue(rows) : rows;
      }
      this.handle.exec(`PRAGMA ${text}`);
      return undefined;
    }

    const rows = this.handle.prepare(`PRAGMA ${text}`).all();
    if (simple) return firstValue(rows);
    /* better-sqlite3 returns bare values for single-column results like
       integrity_check; callers here handle both shapes, and returning the rows
       keeps the column name available. */
    return rows;
  }

  /* better-sqlite3 hands back a callable that wraps the work in a transaction.
     node:sqlite has no equivalent, so this reproduces it — including the part
     that matters: any throw rolls the whole thing back, so a half-written
     reassignment or a reservation without its audit row cannot survive.

     SAVEPOINT rather than BEGIN so a transaction nested inside another one
     composes instead of throwing. */
  transaction(fn) {
    return (...args) => {
      if (this.inTransaction) {
        const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
        this.handle.exec(`SAVEPOINT ${name}`);
        try {
          const result = fn(...args);
          this.handle.exec(`RELEASE ${name}`);
          return result;
        } catch (err) {
          this.handle.exec(`ROLLBACK TO ${name}`);
          this.handle.exec(`RELEASE ${name}`);
          throw err;
        }
      }
      this.handle.exec('BEGIN');
      this.inTransaction = true;
      try {
        const result = fn(...args);
        this.handle.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.handle.exec('ROLLBACK'); } catch (_) { /* the original error is what matters */ }
        throw err;
      } finally {
        this.inTransaction = false;
      }
    };
  }

  /* SQLite's online backup: a consistent snapshot of a live database including
     anything still sitting in the WAL. Copying the file would not be. */
  backup(destination) {
    return sqlite.backup(this.handle, destination);
  }

  close() {
    if (!this.open) return;
    this.handle.close();
    this.open = false;
  }
}

function firstValue(rows) {
  if (!rows || !rows.length) return undefined;
  const row = rows[0];
  if (row === null || typeof row !== 'object') return row;
  const values = Object.values(row);
  return values.length ? values[0] : undefined;
}

module.exports = { Database, Statement };
