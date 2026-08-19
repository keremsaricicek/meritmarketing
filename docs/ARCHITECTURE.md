# Architecture

## The shape of the thing

Merit Marketing Hub is an Electron desktop application with a local SQLite
database. It was previously one HTML file with a mock backend over
localStorage; the business rules and the data now live in the privileged
process, and the renderer only draws.

```
Electron
├── Main process ......... lifecycle, session, authorization, IPC, database,
│                          backup, updates, diagnostics
├── Preload .............. one narrow contextBridge function per operation
└── Renderer ............. the screens. No Node, no Electron, no SQL.
```

### Dependency direction

```
renderer  →  preload  →  IPC registry  →  services  →  repositories  →  SQLite
                             ↑               ↑
                     security surface     domain rules
```

Nothing points backwards. A service never reaches for the window, a repository
never checks a role, and the domain rules touch neither.

## Layers, and what each one is for

| Layer | Responsibility | What it must never do |
|---|---|---|
| `src/renderer` | Draw the screens, collect input | Hold authority. Its state is a cache of what main said. |
| `src/preload` | Expose named operations | Expose `ipcRenderer`, `fs`, or a generic `invoke` |
| `src/main/ipc` | Sender check, session check, schema parse | Contain business rules |
| `src/main/services` | Capability, record scope, protection, the work | Trust anything from the renderer |
| `src/main/repositories` | SQL, projections, pagination | Make authorization decisions |
| `src/main/services/domain.js` | The business rules, as pure functions | Touch the database or the session |
| `src/shared` | Contracts both sides agree on | Import from main or renderer |

## Why the domain rules are pure functions

`domain.js` takes plain rows and returns answers. No database, no session. That
is what allows one definition of "qualifying reservation", "No Record", "guest
protection" and "calendar bucket" to be shared by the Dashboard, the Customer
List, Reports and the Calendar.

The alternative — each screen computing its own version — is what produced the
original defect where the No Record count and the No Record list disagreed.

## Two checks, not one

`guard(capability)` answers *may this ROLE call this verb at all*. It says
nothing about **which records**.

`customerInScope(record)` answers *may this SESSION touch THIS record*.

A verb that addresses records needs both. Checking only the first is how
horizontal escalation happens: the role is allowed to call `customers:get`, so
the call succeeds — for anybody's guest.

## The security surface

`src/shared/contracts/ipc-surface.js` records, for every channel: whether a
session is required, the capability, the roles, the record scope, whether guest
protection applies, whether the payload is validated, whether it is destructive,
whether it must audit, and the denial code.

The registry refuses to start if a handler has no entry, an entry has no
handler, or a channel has no schema. `tests/ipc/surface-enforcement.test.js`
derives its probes from that matrix, so a row claiming a check with no probe
registered fails the suite. The matrix cannot make a claim it does not prove.

## Dates

Two kinds, deliberately separate (`src/shared/contracts/dates.js`):

- **Business dates** (`check_in`, `check_out`, `last_visit`) — a day on the
  hotel's wall. `TEXT 'YYYY-MM-DD'`, no zone. Compared as strings.
- **System instants** (`created_at`, `deleted_at`, login time) — a real moment.
  ISO-8601 UTC, displayed in local time.

Treating a business date as UTC is the classic bug: `2026-08-16` parsed as UTC
midnight is the 15th at 21:00 in UTC−3, so a reservation moves a day for some
users and the calendar buckets stop being exclusive.

## Non-destructive history

Normal use never removes a reservation row. Deletion is a tombstone
(`deleted_at`, `deleted_by`, `deletion_reason`), which keeps the audit trail and
the historical Invited By attribution while removing the booking from every
operational calculation. Customers and profiles are archived on the same
principle; `ON DELETE RESTRICT` on their history means the schema agrees.

## Prepared for a central server

The renderer already talks to an authorization boundary over an async,
serialisable contract. Replacing the SQLite repositories with HTTP clients
behind the same service interfaces is the migration path — see
[FUTURE-MULTI-PC.md](FUTURE-MULTI-PC.md). Every mutable business row carries
`row_version` so optimistic concurrency does not need a later schema change.
