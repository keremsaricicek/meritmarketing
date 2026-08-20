'use strict';
/* Backup and restore.
 *
 * A backup is taken with SQLite's own online backup API, not a file copy. In
 * WAL mode the .sqlite3 file alone is not the database — recent commits may
 * still be in the -wal file — so copying it can silently produce a snapshot
 * missing the last hour of work.
 *
 * Restore is the highest-risk operation in the product. The invariant is
 * absolute: if anything at all goes wrong, the CURRENT data is untouched. That
 * is why the incoming archive is fully validated and staged before a single
 * live file is replaced.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const connection = require('../database/connection');
const { currentVersion } = require('../database/migrator');
const guard = require('../services/guard');
const { safeJoin } = require('../paths');
const { nowIso } = require('../../shared/contracts/dates');
const { AppError, CODES, validation, notFound } = require('../../shared/errors');

const EXTENSION = '.mmhbackup';
const MAGIC = 'MMHBACKUP1';
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
/* The COMPRESSED cap above says nothing about what the file expands to: gzip
   reaches roughly 1000:1 on repetitive input, so a 10 MB archive can decompress
   to gigabytes and take the main process — the whole application — down with
   it. This runs during `inspect`, before the operator has confirmed anything,
   so the file does not even have to be one they chose to restore. */
const MAX_UNPACKED_BYTES = 8 * 1024 * 1024 * 1024;

/* A tiny container format rather than a zip library: a dependency-free reader
   we fully control means no zip-slip surface at all, because nothing in the
   archive is ever interpreted as a path. Layout:
   MAGIC \n <manifest json length> \n <manifest json> then, per entry,
   <sha256> <byteLength> <logicalName> \n <bytes>, all gzip-compressed. */

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function pack(manifest, entries) {
  const chunks = [Buffer.from(`${MAGIC}\n`)];
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
  chunks.push(Buffer.from(`${manifestJson.length}\n`), manifestJson);
  for (const entry of entries) {
    chunks.push(Buffer.from(`${sha256(entry.data)} ${entry.data.length} ${entry.name}\n`));
    chunks.push(entry.data);
  }
  return zlib.gzipSync(Buffer.concat(chunks));
}

/* Every structural assumption is checked before anything is used. A file that
   merely parses is not a valid backup. */
function unpack(raw) {
  let buffer;
  try { buffer = zlib.gunzipSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch (err) {
    /* zlib reports the cap as ERR_BUFFER_TOO_LARGE. Saying which of the two
       things went wrong matters: one is a corrupt file, the other is a file
       built to exhaust memory. */
    if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /too large/i.test(String(err.message)))) {
      throw new AppError(CODES.BACKUP_INVALID, 'That backup expands to an implausible size and was not opened.');
    }
    throw new AppError(CODES.BACKUP_INVALID, 'That file is not a Merit backup.');
  }

  const readLine = (from) => {
    const end = buffer.indexOf(0x0A, from);
    if (end === -1) throw new AppError(CODES.BACKUP_INVALID, 'That backup file is damaged.');
    return { line: buffer.toString('utf8', from, end), next: end + 1 };
  };

  let cursor = 0;
  const magic = readLine(cursor); cursor = magic.next;
  if (magic.line !== MAGIC) throw new AppError(CODES.BACKUP_INVALID, 'That file is not a Merit backup.');

  const lengthLine = readLine(cursor); cursor = lengthLine.next;
  const manifestLength = Number(lengthLine.line);
  if (!Number.isInteger(manifestLength) || manifestLength <= 0 || manifestLength > 1024 * 1024) {
    throw new AppError(CODES.BACKUP_INVALID, 'That backup file is damaged.');
  }
  let manifest;
  try { manifest = JSON.parse(buffer.toString('utf8', cursor, cursor + manifestLength)); }
  catch (_) { throw new AppError(CODES.BACKUP_INVALID, 'That backup file is damaged.'); }
  cursor += manifestLength;

  const entries = new Map();
  while (cursor < buffer.length) {
    const header = readLine(cursor); cursor = header.next;
    const [digest, sizeText, ...nameParts] = header.line.split(' ');
    const size = Number(sizeText);
    const name = nameParts.join(' ');
    if (!/^[0-9a-f]{64}$/.test(digest || '') || !Number.isInteger(size) || size < 0) {
      throw new AppError(CODES.BACKUP_INVALID, 'That backup file is damaged.');
    }
    /* Entry names are LOGICAL labels, never paths. Rejecting separators here
       means nothing in the archive can ever be written outside the staging
       directory, whatever it claims to be called. */
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new AppError(CODES.BACKUP_INVALID, 'That backup file contains an unexpected entry.');
    }
    if (cursor + size > buffer.length) throw new AppError(CODES.BACKUP_INVALID, 'That backup file is truncated.');
    const data = buffer.subarray(cursor, cursor + size);
    cursor += size;
    if (sha256(data) !== digest) {
      throw new AppError(CODES.BACKUP_INVALID, 'That backup file failed its integrity check.');
    }
    entries.set(name, data);
  }
  return { manifest, entries };
}

function build({ paths, appVersion, getDb, setDb, log = () => {} }) {
  const service = {
    EXTENSION,

    list(ctx) {
      guard.requireCapability(ctx, 'backup.read');
      if (!fs.existsSync(paths.backups)) return [];
      return fs.readdirSync(paths.backups)
        .filter((f) => f.endsWith(EXTENSION))
        .map((f) => {
          const stat = fs.statSync(path.join(paths.backups, f));
          return { name: f, byteSize: stat.size, createdAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    /* Used both by the Settings screen and automatically before a migration or
       an update. `system` skips the capability check because there is no user
       session during startup — the caller is the application itself. */
    async create(ctx, { label, system = false } = {}) {
      if (!system) guard.requireCapability(ctx, 'backup.create');
      const db = getDb();

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeLabel = String(label || (system ? 'auto' : 'manual')).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'manual';
      const name = `MeritBackup-${stamp}-${safeLabel}${EXTENSION}`;
      const staging = path.join(paths.backups, `.staging-${crypto.randomBytes(6).toString('hex')}.sqlite3`);

      /* SQLite's own backup API produces a consistent snapshot of a live
         database including anything still in the WAL. */
      await db.backup(staging);

      let databaseBytes;
      try {
        /* Verify the snapshot before it is offered as a safety net. A backup
           nobody checked is a backup nobody can rely on. */
        const probe = connection.open(staging, { readonly: true });
        const health = connection.checkHealth(probe, { deep: true });
        const schemaVersion = currentVersion(probe);
        probe.close();
        if (!health.healthy) {
          throw new AppError(CODES.DATABASE_ERROR,
            'The database could not be backed up safely.', { internal: health.problems.join('; ') });
        }
        databaseBytes = fs.readFileSync(staging);
        var manifestSchemaVersion = schemaVersion;
      } finally {
        if (fs.existsSync(staging)) fs.unlinkSync(staging);
      }

      const photoNames = fs.existsSync(paths.photos)
        ? fs.readdirSync(paths.photos).filter((f) => /^[A-Za-z0-9._-]+$/.test(f))
        : [];
      const entries = [{ name: 'database.sqlite3', data: databaseBytes }];
      for (const photo of photoNames) {
        entries.push({ name: `photo__${photo}`, data: fs.readFileSync(path.join(paths.photos, photo)) });
      }

      const manifest = {
        format: MAGIC,
        appVersion,
        schemaVersion: manifestSchemaVersion,
        createdAt: nowIso(),
        kind: system ? 'automatic' : 'manual',
        label: safeLabel,
        databaseSha256: sha256(databaseBytes),
        photoCount: photoNames.length,
        entries: entries.map((e) => ({ name: e.name, byteSize: e.data.length, sha256: sha256(e.data) })),
      };

      const target = path.join(paths.backups, name);
      fs.writeFileSync(target, pack(manifest, entries));
      log('info', 'backup.created', { name, schemaVersion: manifestSchemaVersion, photos: photoNames.length });
      if (!system) {
        ctx.audit({ action: 'BACKUP_CREATE', entity_type: 'backup',
          description: `Backup created: ${name}` });
      }
      return { name, byteSize: fs.statSync(target).size, manifest };
    },

    /* A backup name is a managed, flat label chosen by this application — never
       a path. Joining it directly let `../Downloads/planted.mmhbackup` name a
       file outside the backup directory, which turns "restore my backup" into
       "install this archive somebody dropped in the user's profile", including
       its users table. `safeJoin` is what every other file path in the app goes
       through; this was the one that did not. */
    resolveBackup(name) {
      const file = safeJoin(paths.backups, name);
      if (!file) throw notFound('That backup no longer exists.');
      return file;
    },

    /** Structural validation only — never touches live data. */
    inspect(ctx, { name }) {
      guard.requireCapability(ctx, 'backup.read');
      return service.validateFile(service.resolveBackup(name));
    },

    validateFile(file) {
      if (!fs.existsSync(file)) throw notFound('That backup no longer exists.');
      const stat = fs.statSync(file);
      if (stat.size === 0) throw new AppError(CODES.BACKUP_INVALID, 'That backup file is empty.');
      if (stat.size > MAX_ARCHIVE_BYTES) throw new AppError(CODES.BACKUP_INVALID, 'That backup file is implausibly large.');

      const { manifest, entries } = unpack(fs.readFileSync(file));
      if (!manifest || manifest.format !== MAGIC) {
        throw new AppError(CODES.BACKUP_INVALID, 'That file is not a Merit backup.');
      }
      if (!entries.has('database.sqlite3')) {
        throw new AppError(CODES.BACKUP_INVALID, 'That backup does not contain a database.');
      }
      if (manifest.databaseSha256 !== sha256(entries.get('database.sqlite3'))) {
        throw new AppError(CODES.BACKUP_INVALID, 'That backup failed its integrity check.');
      }
      /* A backup from a NEWER build may contain a schema this code cannot read.
         Restoring it would leave the app running against a future database. */
      const { targetVersion } = require('../database/migrator');
      if (Number(manifest.schemaVersion) > targetVersion()) {
        throw new AppError(CODES.BACKUP_INVALID,
          'That backup was made by a newer version of Merit Marketing Hub. Please update the application first.');
      }
      return { manifest, entries };
    },

    /* Restore, staged. Nothing live is replaced until every check has passed
       and the incoming database has been opened, migrated and verified in a
       scratch directory. */
    async restore(ctx, { name }) {
      guard.requireCapability(ctx, 'backup.restore');
      const file = service.resolveBackup(name);
      const { manifest, entries } = service.validateFile(file);

      /* Before anything else: a safety copy of what is here now, so a restore
         that turns out to be the wrong backup is itself reversible. */
      const safety = await service.create(ctx, { label: 'prerestore', system: true });

      const scratch = path.join(paths.backups, `.restore-${crypto.randomBytes(6).toString('hex')}`);
      fs.mkdirSync(scratch, { recursive: true });
      try {
        const stagedDb = path.join(scratch, 'database.sqlite3');
        fs.writeFileSync(stagedDb, entries.get('database.sqlite3'));

        /* Open it for real: migrate it forward to this build's schema and run a
           deep integrity check. If the archive holds a corrupt or incompatible
           database, we find out now, against a copy. */
        const probe = connection.open(stagedDb, { log: (m) => log('info', 'restore.migrate', { m }) });
        const health = connection.checkHealth(probe, { deep: true });
        const usersPresent = probe.prepare("SELECT COUNT(*) n FROM users WHERE role = 'ADMIN' AND active = 1").get().n;
        connection.close(probe);
        if (!health.healthy) {
          throw new AppError(CODES.BACKUP_INVALID,
            'That backup did not pass its integrity check and was not restored.',
            { internal: health.problems.join('; ') });
        }
        if (usersPresent === 0) {
          throw new AppError(CODES.BACKUP_INVALID,
            'That backup contains no administrator account and was not restored.');
        }

        const stagedPhotos = path.join(scratch, 'photos');
        fs.mkdirSync(stagedPhotos, { recursive: true });
        for (const [entryName, data] of entries) {
          if (!entryName.startsWith('photo__')) continue;
          const photoName = entryName.slice('photo__'.length);
          /* Validated at unpack time, re-checked here: nothing writes outside
             the staging directory. */
          if (!/^[A-Za-z0-9._-]+$/.test(photoName)) continue;
          fs.writeFileSync(path.join(stagedPhotos, photoName), data);
        }

        /* Point of no return. Everything above this line was rehearsal. */
        const live = getDb();
        connection.close(live);
        setDb(null);

        fs.copyFileSync(stagedDb, paths.database);
        for (const sidecar of ['-wal', '-shm']) {
          const stale = `${paths.database}${sidecar}`;
          if (fs.existsSync(stale)) fs.unlinkSync(stale);
        }
        fs.rmSync(paths.photos, { recursive: true, force: true });
        fs.mkdirSync(paths.photos, { recursive: true });
        for (const photo of fs.readdirSync(stagedPhotos)) {
          fs.copyFileSync(path.join(stagedPhotos, photo), path.join(paths.photos, photo));
        }

        const reopened = connection.open(paths.database, { log: (m) => log('info', 'restore.reopen', { m }) });
        setDb(reopened);

        log('warn', 'backup.restored', { name, from: manifest.createdAt, safety: safety.name });
        /* The session is over: the user table itself has just been replaced, so
           the signed-in identity may no longer exist. */
        ctx.sessions.end();
        return { ok: true, restored: name, safetyBackup: safety.name, requiresRestart: true };
      } catch (err) {
        log('error', 'backup.restore-failed', { name, message: err.message });
        if (!getDb()) {
          /* The swap failed midway. Reopen whatever is on disk so the app is
             not left with no database at all; the safety backup is the route
             back if that file is the damaged one. */
          try { setDb(connection.open(paths.database)); }
          catch (reopenErr) { log('error', 'backup.reopen-failed', { message: reopenErr.message }); }
        }
        throw err instanceof AppError ? err
          : new AppError(CODES.BACKUP_INVALID, 'That backup could not be restored. Your current data has not been changed.');
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },

    /* Retention. Automatic snapshots are pruned; a manual export the operator
       deliberately made is never deleted by the application. */
    prune({ keepAutomatic = 10 } = {}) {
      if (!fs.existsSync(paths.backups)) return { removed: [] };
      const automatic = fs.readdirSync(paths.backups)
        .filter((f) => f.endsWith(EXTENSION) && /-(auto|premigration|preupdate|prerestore)\.mmhbackup$/.test(f))
        .map((f) => ({ f, at: fs.statSync(path.join(paths.backups, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      const removed = [];
      for (const stale of automatic.slice(keepAutomatic)) {
        fs.unlinkSync(path.join(paths.backups, stale.f));
        removed.push(stale.f);
      }
      if (removed.length) log('info', 'backup.pruned', { removed });
      return { removed };
    },
  };

  return service;
}

/* Read an archive back and confirm it is what it claims to be. Standalone,
   because the pre-migration snapshot is written before any service exists —
   and it was the one backup in the product that nothing ever verified. */
function verifyFile(file) {
  const { manifest, entries } = unpack(fs.readFileSync(file));
  if (!manifest || manifest.format !== MAGIC) {
    throw new AppError(CODES.BACKUP_INVALID, 'The snapshot that was just written is not a valid Merit backup.');
  }
  const database = entries.get('database.sqlite3');
  if (!database) {
    throw new AppError(CODES.BACKUP_INVALID, 'The snapshot that was just written contains no database.');
  }
  if (manifest.databaseSha256 !== sha256(database)) {
    throw new AppError(CODES.BACKUP_INVALID, 'The snapshot that was just written failed its own integrity check.');
  }
  return { manifest, byteSize: database.length };
}

module.exports = { build, pack, unpack, sha256, verifyFile, EXTENSION, MAGIC };
