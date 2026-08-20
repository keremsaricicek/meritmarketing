# Updates

> **Automatic updates are NOT enabled for v1.**
>
> A shipped v1 installation has no update feed configured, so the application
> never checks, never downloads and never installs anything on its own. This is
> a deliberate release decision, not an oversight.
>
> The reasons are concrete and were confirmed by independent review:
> electron-updater's Windows path performs **no signature verification** when
> the packaging toolchain has not produced an `app-update.yml` (this project
> packages with Forge, which does not), so the only integrity check would be a
> hash served by the same host as the payload. Until there is a signing
> certificate and a trusted feed, an automatic updater is a remote code
> execution path with extra steps.
>
> `autoInstallOnAppQuit` is off, so nothing installs silently on exit;
> `updates:install` requires ADMIN and takes a backup first; and with no
> `MERIT_UPDATE_URL` the check is a no-op. Updating v1 means running a new
> installer by hand.
>
> Redesigning the updater properly is a separate project, after the first
> signed and Windows-tested release.

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

## Before this can be switched on — read this first

The update path is **implemented but never executed end to end**, and three
things must be resolved before it is. None of them is a small detail, and the
honest position is that automatic updates are not ready to enable:

1. **There is no signature verification of the downloaded installer.**
   `electron-updater`'s `NsisUpdater.verifySignature` reads `publisherName` from
   an `app-update.yml` that **electron-builder** produces. This project packages
   with **electron-forge**, so that file does not exist, and the check returns
   `null` — meaning *skip*. The only integrity check left is the SHA-512 in
   `latest.yml`, which is served by the same host as the payload, so it proves
   the download was not corrupted and nothing about who wrote it. **Whoever
   controls the feed gets code execution on every installation.** A real
   deployment needs a code-signing certificate (blocker B5) and the publisher
   name wired through, or a different verification step entirely.

2. **The maker and the updater do not compose as configured.** `forge.config.js`
   builds with Squirrel.Windows; `electron-updater`'s Windows path is
   `NsisUpdater`, which runs the downloaded executable with NSIS arguments and
   expects a `latest.yml` and blockmap that `Release-Merit.ps1` does not emit.
   Either the maker changes to NSIS or the update client changes to Squirrel's
   own. This has to be decided before a feed is published, not after.

3. **No end-to-end update between two versions has ever been performed.** It
   needs a published feed and a Windows host, neither of which exists yet.

Until those are settled, leave `MERIT_UPDATE_URL` unset. With no feed the
application never checks, which is a supported configuration — see below.

## Configuring the feed

The client only ever **reads** update metadata. Set `MERIT_UPDATE_URL` to an
HTTPS base URL.

**It is read from the environment at startup, not baked into the build.** That
is worth being clear-eyed about: anything able to set an environment variable
for that user — including a persistent `HKCU\Environment` entry — can point the
application at a host of its choosing. The application refuses a non-HTTPS feed
outright and logs the host it accepted, so the choice is at least visible in the
log; it does not make an attacker-supplied HTTPS feed safe. Combined with (1)
above, this is the reason updates stay off until signature verification is real.

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
