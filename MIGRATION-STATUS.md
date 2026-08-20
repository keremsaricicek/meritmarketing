# Electron / SQLite Production Migration — Status

**Durable handoff record.** Updated at every checkpoint so a new session can
continue deterministically. Delete when the migration is fully complete.

## Baseline

| | |
|---|---|
| Baseline commit | `fb49302` |
| Baseline tag | `pre-electron-baseline` (local only — blocker B1) |
| Baseline tests | 529 assertions, 18 suites |
| Current | see `docs/FINAL-REPORT.md` — updated after each full run |
| Branch | `claude/plugin-marketplace-ui-ux-pro-max-91h8kg` |

## Checkpoints

| # | Checkpoint | Status |
|---|---|---|
| 1 | Schema, migrations, domain rules | **done** |
| 2 | Repositories, Argon2id auth, session | **done** |
| 3 | Customer/reservation services, soft delete | **done** |
| 4 | IPC boundary, preload, photos, export, backup | **done** |
| 5 | Renderer extraction, main process, app launches | **done** |
| 6 | IPC enforcement + adversarial attack suites | **done** |
| 7 | Release, recovery, CI, documentation | **done** |
| 8 | Performance at scale, clean-start workflow, offline | **done** |
| 9 | Independent code review | **done** — 28 confirmed defects, all fixed with regression tests |
| 10 | Scorecard and final report | **done** — `docs/SCORECARD.md`, `docs/FINAL-REPORT.md` |

## External blockers

| ID | Blocker | Effect | State |
|---|---|---|---|
| B1 | `git push` of **tags** returns HTTP 403 (branches push fine) | `pre-electron-baseline` is local only | Recovery tooling written **and verified** — a generated bundle was fetched into a fresh clone and all commits arrived |
| B2 | `assets/crm.ico` does not exist anywhere in the repo or workspace | Windows build uses the default Electron icon | Build wired to the path; Forge warns loudly; the release script **blocks a stable release** without it. No icon was invented. |
| B3 | `src/renderer/logo.png` is referenced by the renderer but is not in the repo | In-app brand mark falls back to the letter mark | Owner must supply. The release script **blocks a stable build** without it, alongside `assets/crm.ico`. |
| B4 | No Windows host in this container | Installer and Squirrel update not executed here | Windows CI job packages and smoke-tests; end-to-end update still needs one manual run |
| B5 | No code-signing certificate | Artifacts unsigned; SmartScreen will warn | Hooks configured, driven by CI secrets; `release.json` records `signed:false` honestly |
| B6 | No update-host credentials | Feed not published | Provider abstraction complete, configured by `MERIT_UPDATE_URL` (HTTPS enforced) |
| B7 | `www.electronjs.org` is policy-blocked by the proxy | `electron-rebuild` cannot fetch headers | **Resolved by design change**: switched to `node:sqlite`, so there is no native module to rebuild |
| B8 | The downloaded installer is **not signature-verified** | Whoever controls the feed would get code execution | `electron-updater` skips its check without an electron-builder `app-update.yml`, which forge does not produce. Needs B5 plus the publisher name wired through. **Updates must stay off until this is resolved** — see `docs/UPDATE.md`. |
| B9 | Squirrel.Windows maker vs `electron-updater`'s NSIS path | The update flow cannot work as configured | Decide maker-or-client before publishing a feed. Documented, not papered over. |

## Environment notes for the next session

- Tests **must** run on Electron's Node, not system Node:
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/run-all.js`
  (`npm test` does this.) System Node 22 has `node:sqlite` only behind an
  experimental flag; production uses Electron's Node 24.
- The Electron launch suite spawns the binary and must **delete**
  `ELECTRON_RUN_AS_NODE` from the child env, or Electron starts as bare Node.
- `xvfb-run` is present, so the real GUI app can be launched headlessly.

## What is NOT done

| Item | Notes |
|---|---|
| Windows installer executed | Requires the Windows CI job to run, or a Windows machine |
| End-to-end Squirrel update between two versions | Needs a published feed (B6) and a Windows host (B4) |
| Browser regression suites ported to Electron | The 529 baseline assertions still run against `merit-marketing-hub.html` as a behavioural reference. The security-critical ones are re-proved against the new architecture (283 new assertions); the UI-interaction ones still exercise the legacy file. |
| `logo.png` / `crm.ico` | Owner-supplied (B2, B3) |

## Next action — all of it external

The engineering is finished. Nothing on this list is code:

1. Supply `assets/crm.ico` and `logo.png` (B2, B3).
2. Run the Windows CI job, or package on a Windows machine, and execute the
   installer once (B4).
3. Obtain a code-signing certificate and set `WINDOWS_CERT_FILE` /
   `WINDOWS_CERT_PASSWORD` in CI secrets (B5).
4. **Before enabling updates at all**, resolve B8 (the downloaded installer is
   not signature-verified) and B9 (Squirrel maker vs electron-updater's NSIS
   path). Until then leave `MERIT_UPDATE_URL` unset — see `docs/UPDATE.md`.
5. Publish a feed and run one update end to end between two versions (B6).

Delete this file once those are done. It is a handoff record, not documentation.

## Final correction pass (post-a259ea9)

A third independent inspection of the source archive found four things the two
adversarial reviews and 1131 assertions had all missed:

| # | Finding | Fix |
|---|---|---|
| A | The Deleted Reservations **UI never existed**. The backend verb, its capability and its tests were all in place; the screen only ever showed Reservations and Cancelled, so no ADMIN or MANAGER could reach deleted history. | Third tab, using the dedicated `reservations.listDeleted` verb — not a `view` parameter. Removed for MARKETING and refused by the boundary. |
| B | `runPaletteItem` executed command strings with `eval(item.run)`, falling back to `Function(item.run)()`. A live code evaluator in the renderer, next to a CSP whose whole purpose is to prevent one. | Palette entries carry `action` + `args`; a frozen `PALETTE_ACTIONS` allowlist resolves them. |
| C | Inline `onmouseenter`/`onmouseleave` handlers remained on the CRM submenu and every Finder row — inert under CSP, so those hover behaviours were dead. The test claiming "no inline event handler of any kind survives" checked a hand-written list of four event names that did not include them. | Delegated via bubbling `mouseover`/`mouseout` filtered back to enter/leave semantics. Two `javascript:` URLs removed as well. |
| D | Duplicate `data-act`/`data-on`/`data-args` triples on the CRM item, the marketing filter and the palette input. HTML keeps the first and drops the rest, so the second behaviour silently did nothing. | Event-scoped `data-act-<event>` attributes, which cannot collide with themselves. |

The common thread is the one this migration keeps re-learning: **a gate built as
a hand-maintained list only catches what somebody remembered to list.** The new
`tests/ui/renderer-source-safety.test.js` is written as exhaustive patterns
instead — any `on*=` attribute, any code-constructing call, any repeated action
attribute in one tag — and was verified to go red when each defect is
reintroduced.

Also corrected: the CI step commented "Proves the packaged binary starts on
Windows" only checked that an .exe existed and was over 1 MB. It is now named
`Validate the packaged artifact (does not launch it)` and says so in its output.
Windows startup remains unverified.

## Final source-closure pass (post-ab25a77)

A third independent inspection of the source ZIP found the real operator
workflow still broken in ways every previous gate missed, because the tests
called services directly instead of pressing the buttons.

| Finding | What was actually wrong | Fix |
|---|---|---|
| Customer save | The form sent `photoPath`; the strict contract accepts `photoName` | One canonical name across renderer, schema, service |
| Profile save | Sent `photoPath` and `inactive` on create; `photo_name` was never persisted at all | `photoName` added to schema, service and INSERT; `inactive` is an edit-only concern |
| **Every photo in the app** | The renderer read `photo_name` as `photo_path` in 25 places — a column that exists nowhere | Renamed; avatars, inspector, profile cards and reservation preview now show photos |
| STAFF role | Renderer still defaulted new users to a role that does not exist | Default MARKETING; the linked-profile rule follows the real role |
| Reports | Blank filters sent `status:''`, `from:''`; `createdFrom`/`createdTo`/`hasReservation`/`hasCrm` were shown but not in the contract | `omitBlank()` on every payload; the four filters implemented in schema + SQL rather than removed |
| Photo buttons | `pickCustomerPhoto` was a top-level `const` — a global binding, not a window property — so the dispatcher never found it | Registered in the NAMED action table |
| Photo crop | Cropped on a canvas, called a `photos.save` that always failed, kept the ORIGINAL name and cached the crop in memory — it survived until the next launch | Real managed crop: `photos:crop` takes a name and a rectangle, clamps it, crops with `nativeImage`, stores a new managed photo |
| Automatic backup | Settings saved the preference; nothing ever created a backup | `src/main/backup/auto-backup.js`, run at startup through the same trusted service; local-calendar-day scheduling; retention never touches a manual backup |
| Legacy onclick reads | Seven `getAttribute('onclick')` lookups still decided which control was "active" — always null since the handlers were removed | Read `data-args` instead |
| Total Guests KPI | Carried a `go:` field the template never reads | `act`/`actArgs` like every other card |
| Duplicate `class` | Generated markup carried two `class` attributes; HTML keeps the first | Merged; gate generalised to every attribute name |
| Archive dialog | Promised the reservations would be removed and that it could not be undone. Neither is true — it is a soft archive | Truthful copy |
| Data Folder button | Bridge stub always returned VALIDATION | Real no-argument `app:openDataFolder` using `shell.openPath` on the fixed path |
| v1 updater | Documentation said disabled; `MERIT_UPDATE_URL` still armed it | `V1_UPDATES_DISABLED` in code, above the environment |
| Stable signing | Warned and continued when no certificate was configured | Blocks before `release.json` and BUILD COMPLETE |
| Legacy prototype | The owner kept opening it and thinking it was the app | Loud in-page banner plus a file header; still excluded from the package |


### Source-closure additions

| Area | Now |
|---|---|
| Photo crop | Real, via `photos:crop` + `nativeImage`. Managed name + clamped rectangle in, new managed name out. Verified by reading dimensions off disk. |
| Automatic backup | `src/main/backup/auto-backup.js`, run at startup. Local-calendar-day scheduling. Manual backups are never pruned. |
| CRM note date | Migration `002-crm-note-date.sql` restores the column the form always showed. |
| Customer list filters | `createdFrom`, `createdTo`, `hasReservation`, `hasCrm` implemented in SQL. |
| Data folder | `app:openDataFolder` — no argument, fixed path, `shell.openPath`. |
| v1 updates | `V1_UPDATES_DISABLED` in `update-service.js`, above the environment. |
| Stable signing | Blocks before `release.json` and BUILD COMPLETE. Internal channel still allows unsigned. |
| Legacy prototype | Loud in-page banner + file header. Still excluded from the package. |

New gates: `tests/ipc/contract-consistency.test.js`,
`tests/electron/golden-path.test.js`, `tests/electron/photo-crop.test.js`,
`tests/database/auto-backup.test.js`.

## Source closure — verified state

| | |
|---|---|
| Full suite | **38 suites · 1353 assertions · 0 failing** (190s, Electron's Node) |
| Golden path | **45 assertions** — setup form → every Save button → cancel → delete → reports → restart → everything persisted |
| Package | `npm run package` completes on this host; the output carries no test file and no legacy prototype |
| IPC surface | 62 channels, document regenerated and gate green |
| v1 updates | Off in code. `build` also disarms the updater object it is handed |

Two tests had stopped describing the product and were corrected rather than
deleted: `electron/offline.test.js` still drove the updater through `build`
(which returns the v1 stub, so it crashed instead of failing) and now tests the
shipping refusal and the retained implementation separately;
`docs/IPC-SECURITY-SURFACE.md` was two channels behind.

The golden path had never run before this pass. It was not hanging — the
generated probe was invalid JavaScript, so Electron exited during parse and
printed nothing, which looks exactly like a hang. The suite now parses every
script it generates before spawning.

### Still not done, and not claimed

- **No Windows build. No installer executed. Nothing signed.** No Windows
  machine was involved at any point.
- `scripts/Release-Merit.ps1` has never been executed or syntax-checked — there
  is no PowerShell in this container.
- `assets/crm.ico` and `src/renderer/logo.png`: **OWNER ASSET REQUIRED.** Absent,
  and no placeholder was generated.

Next step is an internal Windows build and one real installation.
