# Electron / SQLite Production Migration — Status

**Durable handoff record.** Updated at every checkpoint so a new session can
continue deterministically. Delete when the migration is fully complete.

## Baseline

| | |
|---|---|
| Baseline commit | `fb49302` |
| Baseline tag | `pre-electron-baseline` (local only — blocker B1) |
| Baseline tests | 529 assertions, 18 suites |
| Current | **1131 assertions, 33 suites, 0 failing** |
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
| B3 | `logo.png` is referenced 3× by the renderer but is not in the repo | In-app brand mark is a broken reference | Owner must supply |
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
