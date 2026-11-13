# Updates

Installed copies of Merit Marketing Hub update themselves. Nobody has to
uninstall or reinstall, and an update never touches the database, photos or
backups.

This page says how that works, what protects the data, how to publish a
release, and — honestly — what risk remains.

## Two rules that outrank everything

1. **The application must work with no Internet.** An update check that fails is
   a log line — never a dialog, never a blocked startup.
2. **No update is installed without a verified backup.** If the backup cannot be
   made, "Restart and update" is refused and the reason is reported. Business
   data is worth more than being on the newest build.

## How it works

| Piece | What it is |
|---|---|
| Installer | Squirrel.Windows, built by `@electron-forge/maker-squirrel` (`npm run make`) |
| Update client | Electron's **built-in** `autoUpdater` — on Windows this *is* Squirrel.Windows, so installer and client match |
| Feed | GitHub Releases of the public repository `keremsaricicek/meritmarketing`, **hard-coded** in `src/main/updates/update-service.js`: `https://github.com/keremsaricicek/meritmarketing/releases/latest/download` |
| Who checks | Only the installed (packaged) **Windows** application. `npm start`, the tests, the Linux/zip build and a hand-unzipped copy never check |
| When | ~60 s after startup (so startup and the automatic backup finish first), then every 4 hours while the app is open. Skipped on Squirrel's very first run after install, when the installer still holds `Update.exe` |

Squirrel reads `<feed>/RELEASES`, sees whether a newer version exists, and
downloads the `.nupkg` it names. GitHub redirects `releases/latest/download/X`
to asset `X` on the newest published (non-draft, non-prerelease) release.

The feed is **not** read from an environment variable, a settings file or the
registry, in any build. The old `MERIT_UPDATE_URL` is gone: anything able to set
an environment variable for the user could otherwise choose where the
application downloads code from. Changing the feed means shipping a new build.

`electron-updater` (whose Windows path is NSIS and never matched the Squirrel
installer) has been removed from the dependencies.

## Flow

```
installed app, Windows, packaged
      ↓  60 s after start, then every 4 h
GitHub reachable? ──no──→ status "unavailable"  (logged, nothing else happens)
      ↓ yes
newer version in RELEASES? ──no──→ "You are up to date"
      ↓ yes
download in the background (status "downloading")
      ↓
Squirrel stages the new version beside the current one
      ↓
VERIFIED BACKUP #1 (label "preupdate") — taken immediately, while the version
that wrote the data is still the one running
      ↓
status "downloaded" sent to the window on `updates:status`
      ↓
an ADMIN chooses "Restart and update"   (updates:install)
      ↓
VERIFIED BACKUP #2 ──fails──→ REFUSED. UPDATE_FAILED with the reason.
      ↓ succeeds                 Nothing is installed, nothing restarts.
audit row UPDATE_INSTALL, then quitAndInstall → app restarts on the new version
      ↓
schema migration if needed (its own pre-migration backup, verified)
      ↓
integrity check  →  normal startup
```

"Verified" means: the backup service checks the SQLite snapshot's integrity
before packing it (`backup-service.js`, `create`), and the update service then
reads the written archive back from disk and validates it (`validateFile`)
before trusting it. A backup that cannot be written **or** cannot be verified
refuses the install.

### Why there are two backups

Squirrel.Windows applies a downloaded update to a new `app-x.y.z` folder as part
of the download. From that moment, **the next launch runs the new version even
if nobody presses "Restart and update"** — closing and reopening the app is
enough. Backup #1 exists for exactly that case: it is taken as soon as the
update is staged, so the new version can never run against data that has no
fresh backup. Backup #2 is the gate in front of the restart button, and covers
work done between the download and the restart.

Honest limit: if backup #1 fails (for example, the disk is full), the failure is
logged (`update.staged-backup-failed`) but Squirrel has already staged the new
version, and the next ordinary launch will run it. The data is still protected
by the daily/startup automatic backup and, if the schema changes, by the
migration's own verified pre-migration backup — but it is not the
"preupdate" snapshot.

### Who can do what

- Any signed-in user can see the update status (`updates:check`, and the
  `updates:status` notifications).
- Only an **ADMIN** can install (`updates:install` requires `backup.create`
  **and** the ADMIN role, enforced in the service itself).

### The screen

The renderer has no Settings › Updates panel yet. The main process already
sends everything one needs — `state`, `currentVersion`, `version` (the staged
one), `lastCheckedAt`, `lastError`, `message`, `stagedBackup` — on
`updates:status` and from `updates:check`, and `window.api.updates.install()`
is wired. Until a panel is added, a staged update is applied the next time the
application is closed and reopened (after backup #1, as above).

## States

`idle` · `checking` · `not-available` · `downloading` · `downloaded` ·
`installing` · `failed` · `unavailable`

Offline is the normal case in a back office, so it is reported as
`unavailable`, not as an error. The technical reason goes to the log.

## Where the data lives — and why an update cannot touch it

| What | Where (Windows) | Owned by |
|---|---|---|
| Program | `%LOCALAPPDATA%\MeritMarketingHub\app-x.y.z\` (+ `Update.exe`) | Squirrel — replaced on every update, old versions deleted |
| Database, photos, backups, logs, state | `%APPDATA%\Merit Marketing Hub\` (`app.getPath('userData')`) | The application — Squirrel never reads or writes here |

The two are different trees (`Local` vs `Roaming`, and different folder names:
the maker's `MeritMarketingHub` vs the product name `Merit Marketing Hub`).
`src/main/paths.js` resolves every data path under `userData`, and
`tests/electron/updates.test.js` pins both names.

Squirrel's lifecycle runs (`--squirrel-install`, `--squirrel-updated`,
`--squirrel-uninstall`, `--squirrel-obsolete`) are handled at the very top of
`src/main/main.js` by `src/main/updates/squirrel-startup.js`: they create or
remove the Start-menu/desktop shortcuts through `Update.exe` and quit, before
the single-instance lock and before the database is opened. **Uninstalling
leaves `%APPDATA%\Merit Marketing Hub` in place**; reinstalling picks the data
up again.

Schema migrations, if a new version has them, already take their own snapshot
first (`onBeforeMigrate` in `src/main/main.js`): it checkpoints the WAL, writes a
`-premigration.mmhbackup`, reads it back with `verifyFile`, and a failure stops
the migration. A failed migration rolls back; the database is never recreated.

## What an update never does

- Touch the database, photos, backups, logs or preferences
- Re-seed demo data (there is none)
- Recreate the database because a migration failed
- Install silently on quit without the staging backup having been attempted

## Cutting a release

The version lives in **one** place: `"version"` in `package.json`. Forge, the
installer, the `.nupkg` name and `app.getVersion()` all read it.

1. Bump the version in `package.json` (`1.0.0 → 1.0.1` fix, `1.1.0` feature,
   `2.0.0` breaking). Use `X.Y.Z` only — Squirrel compares these.
2. Commit it: `git commit -am "Release 1.0.1"`.
3. Tag and push the tag:
   ```
   git tag v1.0.1
   git push origin main v1.0.1
   ```
4. `.github/workflows/release.yml` runs on `windows-latest`: checks the tag
   equals `v` + package.json's version (refuses otherwise), `npm ci`, the
   database/IPC/Electron suites, `npm run make`, then creates a GitHub Release
   for the tag with `RELEASES`, `MeritMarketingHub-<version>-full.nupkg`, any
   `-delta.nupkg`, `MeritMarketingHub-Setup.exe` and `SHA256SUMS.txt`.
5. Within ~4 hours every open installation has downloaded it.

**Pushing a `v*` tag is shipping.** There is no staging step after it.

To hold a release back, create it as a draft or pre-release — `latest` ignores
both — or delete the release. To roll back, publish a *higher* version built
from the older code; Squirrel never downgrades.

The first install on each PC is still `MeritMarketingHub-Setup.exe` from the
Releases page. A copy that was installed some other way (zip, hand copy) has no
`Update.exe` and will only log `update.check-failed`; install it once with the
Setup.exe and it will update itself from then on.

Delta packages: the workflow does not currently feed the previous release into
the maker, so it publishes full packages only (each update downloads the whole
app, ~100 MB). That is correct, just not minimal.

## Remaining risk — read this

**The builds are unsigned, and Squirrel.Windows does not verify a publisher.**
Squirrel checks the SHA-1 listed in `RELEASES` — which is served from the same
place as the package — so it proves the download was not corrupted, not who
built it. In practice that means:

> **Whoever can publish a release on `keremsaricicek/meritmarketing` can run
> code on every installed copy within hours.**

That is anyone with write access to the repository, anyone holding a token or
GitHub session with that access, and anyone able to push a `v*` tag through a
compromised CI dependency. What is in place to narrow that:

- the feed is HTTPS to github.com and cannot be redirected by the environment;
- the release workflow has only `contents: write` and uses GitHub's own `gh`
  CLI, not a third-party action holding the token;
- the tag must match `package.json`, and the core test suites must pass.

Recommended next steps, in order:

1. Protect the repository: 2FA for every account with write access, branch
   protection on `main`, tag protection rules for `v*`, and as few people with
   write access as possible.
2. **Buy a Windows code-signing certificate** and add `WINDOWS_CERT_BASE64` and
   `WINDOWS_CERT_PASSWORD` as repository secrets; the workflow and
   `forge.config.js` then sign `MeritMarketingHub.exe`, `Update.exe` and the
   Setup. That removes the SmartScreen warning and makes a tampered binary
   visible — though Squirrel itself still will not refuse an unsigned update,
   so repository protection stays the main control.
3. Run one end-to-end update between two real versions on a Windows PC before
   relying on it (install vX, publish vX+1, wait, confirm the backups and the
   restart).

## Channels

`MERIT_CHANNEL` (`internal` · `beta` · `stable`) is still stamped into the build
for the About/diagnostics information. It does not select a feed: every
packaged Windows build follows the repository's latest published release.
