# Electron / SQLite Production Migration — Status

**Durable handoff record.** Updated at every checkpoint so a new session can
continue deterministically. Delete when the migration is fully complete.

## Baseline

| | |
|---|---|
| Baseline commit | `fb49302` |
| Baseline tag | `pre-electron-baseline` (local only — blocker B1) |
| Baseline tests | 529 assertions, 18 suites |
| Current | **1016 assertions, 29 suites, 0 failing** |
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
| 9 | Independent code review | **running** — two reviewers: backend/data, Electron/release |
| 10 | Scorecard and final report | pending review findings |

## External blockers

| ID | Blocker | Effect | State |
|---|---|---|---|
| B1 | `git push` of **tags** returns HTTP 403 (branches push fine) | `pre-electron-baseline` is local only | Recovery tooling written **and verified** — a generated bundle was fetched into a fresh clone and all commits arrived |
| B2 | `assets/crm.ico` does not exist anywhere in the repo or workspace | Windows build uses the default Electron icon | Build wired to the path; Forge warns loudly; the release script **blocks a stable release** without it. No icon was invented. |
| B3 | `logo.png` is referenced 3× by the renderer but is not in the repo | In-app brand mark is a broken reference | Owner must supply |
| B4 | No Windows host in this container | Installer and Squirrel update not executed here | Windows CI job packages and smoke-tests; end-to-end update still needs one manual run |
| B5 | No code-signing certificate | Artifacts unsigned; SmartScreen will warn | Hooks configured, driven by CI secrets; `release.json` records `signed:false` honestly |
| B6 | No update-host credentials | Feed not published | Provider abstraction complete, configured by `MERIT_UPDATE_URL` |
| B7 | `www.electronjs.org` is policy-blocked by the proxy | `electron-rebuild` cannot fetch headers | **Resolved by design change**: switched to `node:sqlite`, so there is no native module to rebuild |

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

## Next action

Act on the code review findings when the agent reports, then produce the final
report and scorecard.
