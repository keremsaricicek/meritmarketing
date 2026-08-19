# Backup and recovery

## Where the data is

```
%APPDATA%\Merit Marketing Hub\      (Windows)
├── data\merit-marketing.sqlite3    the database
├── photos\                         guest and profile photos
├── backups\                        .mmhbackup archives
├── logs\                           diagnostics, rotated
└── state\                          the clean-shutdown marker
```

Application code lives elsewhere and is replaced wholesale on update. **An
update never touches this folder.**

## How a backup is taken

With SQLite's online backup API, not a file copy. In WAL mode the `.sqlite3`
file alone is not the whole database — recent commits may still be in the `-wal`
file — so copying it can silently produce a snapshot missing the last hour of
work.

A backup contains the database, every managed photo, and a manifest recording
the app version, schema version, timestamp and a SHA-256 for each entry. The
snapshot is opened and integrity-checked **before** it is offered as a safety
net; a backup nobody verified is a backup nobody can rely on.

## When backups happen

| Trigger | Label | Pruned? |
|---|---|---|
| Settings → Backup Now | `manual` | Never |
| Before a schema migration | `premigration` | Yes |
| Before installing an update | `preupdate` | Yes |
| Before a restore | `prerestore` | Yes |
| Scheduled | `auto` | Yes |

Automatic snapshots are pruned to the ten most recent. A backup the operator
deliberately made is never deleted by the application.

## Restore

Restore is the highest-risk operation in the product. The invariant is absolute:
**if anything goes wrong, the current data is untouched.**

1. Validate the archive: structure, manifest, per-entry checksums, and that the
   schema version is not from a newer build.
2. Take a safety backup of what is here now, so restoring the wrong file is
   itself reversible.
3. Extract into a scratch directory.
4. Open the incoming database **for real**: migrate it forward, run a deep
   integrity check, and confirm it contains an active administrator.
5. Only then close the live database and swap the files.
6. Reopen, verify, audit, and end the session — the user table has just been
   replaced, so the signed-in identity may no longer exist.

Steps 1–4 are rehearsal against a copy. Step 5 is the only irreversible moment.

Restore is ADMIN-only and is not configurable onto another role.

## Why the archive format is custom

A tiny container we fully control rather than a zip library. Entry names are
**logical labels** validated to contain no path separators, so nothing in an
archive is ever interpreted as a filesystem path. That removes the zip-slip
class of vulnerability entirely rather than defending against it.

## Crash recovery

A marker file is written at startup and removed on clean shutdown. If it is
still there on the next launch, the previous run ended badly — power loss, a
kill, a crash — and the database gets a **deep** integrity check instead of the
quick one.

If the database cannot be opened, or fails its check:

- the window is **never created** (a login screen over a damaged database is how
  a bad situation becomes a data-loss situation)
- the file is left exactly where it is
- the error names the database path, the backups path, and the log path
- **no empty replacement database is ever created**

## If the worst happens

1. Do not reinstall — that will not help and may confuse the picture.
2. Copy the whole `Merit Marketing Hub` folder somewhere safe.
3. Open `logs\merit.log` and read the last few lines.
4. In the application, Settings → Restore, and choose the most recent backup.
   If the application will not start, hand the folder to whoever maintains it.
