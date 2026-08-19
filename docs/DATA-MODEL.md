# Data model

Schema version **1**. Source of truth: `database/migrations/001-initial-schema.sql`.

## Tables

| Table | Holds | Deletion |
|---|---|---|
| `users` | Login accounts, Argon2id hash, role, linked profile | Disabled (`active = 0`) |
| `profiles` | Marketing and staff profiles | Archived (`archived_at`) |
| `customers` | Guests and unregistered leads | Archived (`deleted_at`) |
| `reservations` | Stays | **Tombstoned** (`deleted_at`) |
| `crm_notes` | Guest activity notes | Tombstoned |
| `assignment_history` | Every ownership change | Never |
| `notifications` | Per-profile alerts | Hard delete (transient) |
| `audit_log` | What happened, who did it | Never, by any application verb |
| `settings` | Shared configuration | — |
| `user_preferences` | Per-user theme and density | Cascades with the user |
| `photos` | Photo metadata; files live on disk | Hard delete with the file |
| `schema_migrations` | Applied migrations and checksums | Never |

## The distinctions that matter

**Current ownership vs historical attribution.**
`customers.marketing_profile_id` is *who owns this guest now* — mutable.
`reservations.invited_by_profile_id` is *who actually invited them on that stay*
— immutable. Reassigning a guest never rewrites the second. Commission
conversations run on it.

**Explicit vs derived assignment.**
`assignment_history.event_type` is `explicit` (a manager decided) or `derived`
(the system inferred it from a booking). Only `explicit` events anchor the
one-year protection clock. Counting derived events would restart the window on
every booking — including one cancelled seconds later — permanently locking a
guest to whoever invited them first.

**Cancelled vs deleted.**
Cancelled is operational history with its own tab. Deleted is removed from
operations entirely. `DELETED` outranks `CANCELLED`, so a cancelled booking that
is later deleted appears only under Deleted — never both, which is how a count
stops agreeing with its list. Cancellation metadata survives the deletion.

**Registered vs unregistered.**
`customers.registered` distinguishes a guest of the property from a lead. Status
badges (`NO_RECORD`, `COLD`, `ACTIVE`) apply to registered guests only.

## Derived, never stored

These are computed on read, so they can never disagree with the facts:

| Value | Rule |
|---|---|
| Reservation status | `deleted → DELETED`, `cancelled → CANCELLED`, else from the dates |
| Qualifying reservation | Not cancelled **and** not deleted |
| Guest status | `NO_RECORD` / `COLD` / `ACTIVE`, registered guests only |
| Last / next visit | Latest and next qualifying `check_in` |
| Protection expiry | One year from `max(latest qualifying visit, last explicit assignment)` |
| Calendar bucket | Arrival, in-house or departure — mutually exclusive |
| Active Marketing | Active profiles of kind `marketing` |

A stored `status` column would be a value a client could set. There is none.

## Constraints the database enforces itself

- Foreign keys on every relationship, enforced (`foreign_keys = ON`, verified at
  open rather than assumed)
- `reservations`: `check_out >= check_in`; a tombstone must name its actor
- `users`: a `MARKETING` account must have a profile, or its scope is undefined
- `UNIQUE` on `users.username` and `customers.code`, case-insensitive
- `CHECK` on every enum-like column
- `ON DELETE RESTRICT` from reservations and notes to customers, so a hard
  delete of a guest with history is refused by the engine, not just by policy

## Indexes

Chosen from the queries that actually run, not speculatively. The hot one is
`idx_res_qualifying (customer_id, deleted_at, cancelled_at, check_in DESC)`,
which serves "qualifying activity for this guest" — the question behind Last
Visit, No Record, Cold and protection.
