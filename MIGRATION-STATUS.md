# Electron / SQLite Production Migration — Status

**This file is the durable handoff record.** It is updated at every checkpoint so
that a new session can continue deterministically. It is deleted when the
migration is complete.

## Baseline

| | |
|---|---|
| Baseline commit | `fb49302bead56212adf768227a225d126e29ab57` |
| Baseline tag | `pre-electron-baseline` (local only — see blocker B1) |
| Baseline tests | 529 assertions, 18 suites, 529 passed, 0 failed |
| Branch | `claude/plugin-marketplace-ui-ux-pro-max-91h8kg` |

The pre-migration application is the single file `merit-marketing-hub.html`. Its
behaviour is the canonical reference; the migration must not change it except
where this plan explicitly says so.

## External blockers found at Phase 0

| ID | Blocker | Impact | Status |
|---|---|---|---|
| B1 | `git push` of **tags** returns HTTP 403 (branch pushes succeed) | `pre-electron-baseline` exists locally only | Local tag preserved; recovery tooling in `scripts/recovery/` |
| B2 | `crm.ico` **does not exist** anywhere in the repo or workspace | Windows icon/installer identity cannot use the owner's real icon | Build wired to `assets/crm.ico`; packaging reports the gap rather than inventing an icon |
| B3 | `logo.png` is referenced 3× by the renderer but is **not in the repo** | In-app brand mark is a broken reference today | Renderer handles the missing file gracefully; owner must supply |
| B4 | No Windows host available in this container | Windows installer + Squirrel update cannot be executed here | Windows CI job performs it; local Linux Electron smoke tests run under xvfb |
| B5 | No code-signing certificate | Artifacts are unsigned | Signing hooks configured, driven by CI secrets |
| B6 | No update-host credentials | Update feed not published | Provider abstraction complete and configurable |

## Environment verified

- Node v22.22.2, npm 10.9.7
- npm registry reachable; `better-sqlite3` compiles and enforces `foreign_keys`
- Electron 43.x, Electron Forge 7.x, `@node-rs/argon2` 2.x, `electron-updater` 6.x available
- `xvfb-run` present, so real Electron **can** be launched headlessly on Linux here

## Checkpoints

| # | Checkpoint | Status |
|---|---|---|
| 1 | Production Electron scaffold + security hardening | pending |
| 2 | SQLite schema, migrations, repositories | pending |
| 3 | Auth (Argon2id), session, IPC authorization boundary | pending |
| 4 | Domain services — business rules ported from the baseline | pending |
| 5 | Deleted Reservations (new required feature) | pending |
| 6 | Backup / restore / managed photos | pending |
| 7 | Updater, release pipeline, CI, owner scripts | pending |
| 8 | QA, security attack pass, code review, docs | pending |

## Next action

Checkpoint 1 — scaffold `src/{main,preload,renderer,shared}`, install pinned
dependencies, stand up a hardened `BrowserWindow`.
