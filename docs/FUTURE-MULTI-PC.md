# Running on more than one computer

## Today

```
One Windows PC
   └── Merit Marketing Hub (Electron)
          └── local SQLite in %APPDATA%
```

One machine, one database, no network needed. This is the right architecture
for the current requirement and should not be complicated before it has to be.

## What NOT to do

**Do not put the SQLite file on a shared network drive.** It is the obvious idea
and it corrupts data. SQLite's locking depends on filesystem primitives that SMB
and NFS implement incompletely; WAL mode requires shared memory that does not
work across a network at all. The result is not a clean error — it is silent
corruption discovered weeks later.

## The real path, when it is needed

```
Windows clients                     Server
┌────────────────┐            ┌──────────────────┐
│ Electron app   │  HTTPS     │ API service      │
│  renderer      │ ─────────► │  auth            │
│  IPC bridge    │            │  services ───────┼──► PostgreSQL
│  API client    │            │  repositories    │
└────────────────┘            └──────────────────┘
```

## Why this is a swap rather than a rewrite

The boundaries that make it possible already exist:

| Already true | Why it matters |
|---|---|
| The renderer never issues SQL | It talks to an authorization boundary, not a database |
| Every call is already async and serialisable | An IPC call and an HTTP call have the same shape |
| Services own authorization, not handlers | The same service works behind IPC or HTTP, protected identically |
| Repositories are a seam | Swap the SQLite implementation for an HTTP client |
| Domain rules are pure functions | They move to the server unchanged |
| `row_version` on every mutable row | Optimistic concurrency without a schema change |
| Session lives in the privileged process | Becomes a server session with no change in shape |

The work is: implement the repository interfaces against HTTP, host the existing
services behind an authenticated API, migrate the schema to PostgreSQL, and
decide the conflict policy that a single-user desktop never needed.

## What genuinely changes

- **Concurrency.** Two people editing one guest is currently impossible.
  `row_version` is there to support "this record changed while you were editing".
- **Offline.** The desktop is offline-first today. A networked version must
  decide whether it degrades, queues, or refuses.
- **Migrations** become a coordinated deployment rather than a local step.
- **Backups** move to the server. The local backup system still has a role for
  exports.

## What should not change

The business rules, the role model, guest protection, the audit trail, and the
non-destructive treatment of history. Those are the product; the storage
underneath is an implementation detail.
