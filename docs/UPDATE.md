# Updates

## Two rules that outrank everything

1. **The application must work with no Internet.** An update check that fails is
   a log line — never a dialog, never a blocked startup.
2. **No update is installed without a verified backup.** If the backup cannot be
   made, the install is blocked. Business data is worth more than being on the
   newest build.

## Flow

```
installed version
      ↓  check (manual, or on a schedule)
feed reachable? ──no──→ "Updates unavailable"  (logged, nothing else happens)
      ↓ yes
newer version? ──no──→ "You are up to date"
      ↓ yes
download  →  user chooses "Restart and update"
      ↓
pre-update backup  ──fails──→ BLOCKED, with an explanation. Nothing is installed.
      ↓ succeeds
installer runs, app restarts
      ↓
schema migration if needed (its own pre-migration backup)
      ↓
integrity check  →  normal startup
```

## States the user can see

`checking` · `no update` · `downloading` · `ready to restart` · `failed` ·
`unavailable (offline or not configured)`

Offline is the normal case in a back office, so it is reported as "unavailable",
not as an error. The technical reason goes to the log.

## What an update never does

- Touch the database, photos, backups, logs or preferences
- Re-seed demo data (there is none)
- Recreate the database because a migration failed — a failed migration rolls
  back and the previous version's data is intact

## Configuring the feed

The client only ever **reads** update metadata. Set `MERIT_UPDATE_URL` to an
HTTPS base URL at build time.

**A private repository does not mean an embedded token.** Never ship a GitHub
PAT or any write credential inside the application — it is trivially extractable
from an asar. Publish artifacts from CI to static object storage (S3, R2, or
similar) that is public-read for artifacts and authenticated for writes. The
application needs read access and nothing more.

If no feed is configured, the application simply never checks. That is a valid
configuration for a hand-installed internal build.

## Channels

`internal` · `beta` · `stable`

Set at build time via `MERIT_CHANNEL`. Ordinary users do not switch channels;
the channel is a property of the build they were given. The current version,
channel and commit are shown in About.
