# Merit Marketing Hub

A Windows desktop application for casino marketing, guest relationships and
reservations. Electron front-end, local SQLite, offline-first.

## Requirements

- **Node 20 or newer** (CI pins 22; Electron 43 bundles Node 24 internally)
- Windows for packaging; Linux and macOS work for development and tests

## Getting started

```bash
npm ci          # exact dependencies from the lock file
npm start       # run the app in development
npm test        # the full suite
```

`npm ci`, never `npm install`, for anything reproducible — the lock file is the
point.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Run the application in development |
| `npm test` | Everything: domain, database, IPC, Electron, browser regression |
| `npm run test:database` | Domain rules, authentication, deleted reservations |
| `npm run test:electron` | Launches the real Electron binary and the IPC boundary |
| `npm run test:security` | Authorization and regression suites |
| `npm run surface:check` | Fails if the security matrix document has drifted |
| `npm run make` | Build the Windows installer |
| `npm run extract:renderer` | Regenerate renderer assets from the legacy single file |

Tests run under Electron's own Node so they use the **same SQLite runtime as
production** rather than a different driver.

## Where data lives

Never in the installation directory. On Windows:

```
%APPDATA%\Merit Marketing Hub\
├── data\merit-marketing.sqlite3
├── photos\
├── backups\
├── logs\
└── state\
```

An update replaces application code and never touches this folder.

## Layout

```
src/
  main/        privileged process: services, repositories, database, IPC, backup
  preload/     the contextBridge — one named function per operation
  renderer/    the screens; no Node, no Electron, no SQL
  shared/      contracts both sides agree on
database/migrations/   numbered, checksummed schema migrations
tests/         domain, database, ipc, electron, and the browser regression suite
scripts/       release, recovery, renderer extraction
docs/          architecture, security, data model, backup, release, update
```

## Documentation

| Document | For |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the layers fit together and why |
| [DATA-MODEL.md](docs/DATA-MODEL.md) | Tables, constraints, derived values |
| [SECURITY.md](docs/SECURITY.md) | Threat model, authorization, known limits |
| [BACKUP-RECOVERY.md](docs/BACKUP-RECOVERY.md) | Backups, restore, crash recovery |
| [RELEASE.md](docs/RELEASE.md) | Gates, versioning, signing, provenance |
| [UPDATE.md](docs/UPDATE.md) | The update flow and feed configuration |
| [FUTURE-MULTI-PC.md](docs/FUTURE-MULTI-PC.md) | Moving to several machines later |
| [OWNER-OPERATIONS-TR.md](docs/OWNER-OPERATIONS-TR.md) | Türkçe sahip kılavuzu |
| [tests/README.md](tests/README.md) | Test conventions and the vacuity checklist |
| [tests/API-SECURITY-SURFACE.md](tests/API-SECURITY-SURFACE.md) | The legacy API matrix |

## First run

There is no default account and no demo data. The first launch asks you to
create the first administrator; after that, setup is closed permanently.

## The legacy file

`merit-marketing-hub.html` is the pre-migration single-file prototype. It is
kept because the browser regression suite still runs against it as a behavioural
reference, and it is excluded from packaged builds. It is not the application.
