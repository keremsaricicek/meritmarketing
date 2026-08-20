# IPC Security Surface

Every channel the renderer can reach in the shipping Electron application, with
the authorization contract each one is required to honour.

**Generated from [`src/shared/contracts/ipc-surface.js`](../src/shared/contracts/ipc-surface.js) —
do not edit by hand.** Run `npm run ipc:doc` after changing the contract;
`npm run ipc:check` fails when this file drifts, and the release script blocks on it.

> This is the matrix for the product that ships.
> [`tests/API-SECURITY-SURFACE.md`](../tests/API-SECURITY-SURFACE.md) documents the
> *prototype* `window.api` — the behavioural baseline the migration had to preserve.
> The two describe different artifacts and are generated and checked separately.

## At a glance

| | |
|---|---|
| Channels | **60** |
| Callable with no session | 6 |
| Record- or query-scoped | 34 |
| Destructive | 9 |
| Written to the audit log | 29 |
| Enforcing guest protection | 4 |
| Reachable by MARKETING | 40 |

## This file is load-bearing

It is not documentation *about* the system. `src/main/ipc/registry.js` reads the
contract at startup and **refuses to boot** when a channel is registered without a
matching entry, when an entry has no handler, or when a channel has no validation
schema. A verb cannot be added quietly; the application will not start.

## How to read a row

| Column | Meaning |
|---|---|
| **Channel** | The IPC channel name. The preload exposes exactly one named function per channel — there is no generic `invoke`. |
| **Auth** | `required` (a session must exist) or `anonymous` (reachable before sign-in). |
| **Capability** | The capability string `guard.requireCapability` demands. `—` for anonymous channels. |
| **Roles** | Who may call it at all. `anon` means no session needed. |
| **Scope** | How far the caller may reach *within* the channel — see below. |
| **Protection** | Whether the channel must enforce the one-year guest protection rule. |
| **Destructive** | Whether it removes or overwrites something. |
| **Audit** | Whether it writes an audit row. |
| **Denial** | The error code a refused call must return. |

### Scope values

| Value | Meaning |
|---|---|
| `none` | No record-level narrowing. The capability alone decides. |
| `query` | Returns a set. The set is narrowed to the caller's scope **before** any caller-supplied filter applies. |
| `record` | Addresses one record by id. The handler must verify that record is in the caller's scope. |
| `self` | Acts only on the calling session's own row. |

`none` is an answer, not a gap. `reservations:create` is deliberately unscoped —
any marketer may book any registered guest, which is precisely how a guest whose
protection has lapsed changes hands. Recording it as `record` would document a check
the handler does not perform, and the next reader would trust it.

### Two axes, both required

`guard.requireCapability(capability)` answers **"may this ROLE call this channel?"**

`requireCustomerInScope(record)` / `requireReservationInScope(record)` answer
**"may this SESSION touch THIS record?"**

A channel marked `record` needs both. One with only the capability check is
horizontal privilege escalation: the role may call `customers:get`, so the call
succeeds — for anybody's guest.

`scopeProfileId()` returns the caller's profile for MARKETING and `null`
(unrestricted) for ADMIN/MANAGER. It falls back to `-1` rather than `null` when a
MARKETING session has no profile, so a broken session matches nothing instead of
everything.

### Refusals must not become oracles

A channel that refuses a foreign id and one that refuses a nonexistent id must
answer **identically**, or the difference is itself a read. This applies across
every verb that takes an id, not only the ones somebody remembered to check: a
marketer who can tell "deleted" from "never existed" can classify every row in the
table, including other marketers'.

---

## The matrix

| Channel | Auth | Capability | Roles | Scope | Protection | Destructive | Audit | Denial |
|---|---|---|---|---|---|---|---|---|
| `app:info` | anonymous | — | anon, ADMIN, MANAGER, MARKETING | `none` | — | — | — | — |
| `app:needsSetup` | anonymous | — | anon, ADMIN, MANAGER, MARKETING | `none` | — | — | — | — |
| `auth:setup` | anonymous | — | anon | `none` | — | — | yes | `FORBIDDEN` |
| `auth:login` | anonymous | — | anon | `none` | — | — | yes | `VALIDATION` |
| `auth:logout` | anonymous | — | anon, ADMIN, MANAGER, MARKETING | `self` | — | — | yes | — |
| `auth:session` | anonymous | — | anon, ADMIN, MANAGER, MARKETING | `self` | — | — | — | — |
| `auth:changePassword` | required | — | ADMIN, MANAGER, MARKETING | `self` | — | — | yes | `VALIDATION` |
| `customers:list` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `customers:get` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `customers:history` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `customers:summary` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `none` | — | — | — | `FORBIDDEN` |
| `customers:picker` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `none` | — | — | — | `FORBIDDEN` |
| `customers:create` | required | `customers.create` | ADMIN, MANAGER, MARKETING | `record` | — | — | yes | `FORBIDDEN` |
| `customers:update` | required | `customers.update` | ADMIN, MANAGER, MARKETING | `record` | yes | — | yes | `FORBIDDEN` |
| `customers:assign` | required | `customers.assign` | ADMIN, MANAGER | `record` | yes | — | yes | `FORBIDDEN` |
| `customers:delete` | required | `customers.delete` | ADMIN, MANAGER | `record` | — | yes | yes | `FORBIDDEN` |
| `customers:protection` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `reservations:list` | required | `reservations.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `reservations:listDeleted` | required | `reservations.deleted.read` | ADMIN, MANAGER | `query` | — | — | — | `FORBIDDEN` |
| `reservations:get` | required | `reservations.read` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `reservations:create` | required | `reservations.create` | ADMIN, MANAGER, MARKETING | `none` | yes | — | yes | `FORBIDDEN` |
| `reservations:update` | required | `reservations.update` | ADMIN, MANAGER, MARKETING | `record` | yes | — | yes | `FORBIDDEN` |
| `reservations:cancel` | required | `reservations.update` | ADMIN, MANAGER, MARKETING | `record` | — | yes | yes | `FORBIDDEN` |
| `reservations:delete` | required | `reservations.delete` | ADMIN | `record` | — | yes | yes | `FORBIDDEN` |
| `crmNotes:list` | required | `crm.read` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `crmNotes:create` | required | `crm.create` | ADMIN, MANAGER, MARKETING | `record` | — | — | yes | `FORBIDDEN` |
| `crmNotes:update` | required | `crm.update` | ADMIN, MANAGER, MARKETING | `record` | — | — | yes | `FORBIDDEN` |
| `crmNotes:delete` | required | `crm.delete` | ADMIN, MANAGER | `record` | — | yes | yes | `FORBIDDEN` |
| `profiles:list` | required | `profiles.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `profiles:get` | required | `profiles.read` | ADMIN, MANAGER, MARKETING | `none` | — | — | — | `FORBIDDEN` |
| `profiles:related` | required | `profiles.read` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `profiles:create` | required | `profiles.create` | ADMIN, MANAGER | `none` | — | — | yes | `FORBIDDEN` |
| `profiles:update` | required | `profiles.update` | ADMIN, MANAGER | `none` | — | — | yes | `FORBIDDEN` |
| `profiles:delete` | required | `profiles.delete` | ADMIN, MANAGER | `none` | — | yes | yes | `FORBIDDEN` |
| `users:list` | required | `users.read` | ADMIN | `none` | — | — | — | `FORBIDDEN` |
| `users:create` | required | `users.create` | ADMIN | `none` | — | — | yes | `FORBIDDEN` |
| `users:update` | required | `users.update` | ADMIN | `none` | — | — | yes | `FORBIDDEN` |
| `users:delete` | required | `users.delete` | ADMIN | `none` | — | yes | yes | `FORBIDDEN` |
| `settings:all` | required | `settings.read` | ADMIN, MANAGER, MARKETING | `self` | — | — | — | `FORBIDDEN` |
| `settings:set` | required | `settings.read` | ADMIN, MANAGER, MARKETING | `self` | — | — | yes | `FORBIDDEN` |
| `settings:permissions` | required | `settings.read` | ADMIN, MANAGER, MARKETING | `none` | — | — | — | `FORBIDDEN` |
| `settings:setPermissions` | required | `settings.permissions.write` | ADMIN | `none` | — | — | yes | `FORBIDDEN` |
| `notifications:list` | required | `notifications.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `notifications:unreadCount` | required | `notifications.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `notifications:markRead` | required | `notifications.update` | ADMIN, MANAGER, MARKETING | `record` | — | — | — | `FORBIDDEN` |
| `notifications:markAllRead` | required | `notifications.update` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `notifications:delete` | required | `notifications.update` | ADMIN, MANAGER, MARKETING | `record` | — | yes | — | `FORBIDDEN` |
| `dashboard:load` | required | `dashboard.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `calendar:month` | required | `calendar.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `calendar:day` | required | `calendar.read` | ADMIN, MANAGER, MARKETING | `query` | — | — | — | `FORBIDDEN` |
| `audit:list` | required | `audit.read` | ADMIN, MANAGER | `none` | — | — | — | `FORBIDDEN` |
| `export:run` | required | `export.run` | ADMIN, MANAGER, MARKETING | `query` | — | — | yes | `FORBIDDEN` |
| `photos:import` | required | `customers.update` | ADMIN, MANAGER, MARKETING | `none` | — | — | yes | `FORBIDDEN` |
| `photos:read` | required | `customers.read` | ADMIN, MANAGER, MARKETING | `none` | — | — | — | `FORBIDDEN` |
| `photos:remove` | required | `customers.update` | ADMIN, MANAGER, MARKETING | `none` | — | yes | yes | `FORBIDDEN` |
| `backup:list` | required | `backup.read` | ADMIN | `none` | — | — | — | `FORBIDDEN` |
| `backup:create` | required | `backup.create` | ADMIN | `none` | — | — | yes | `FORBIDDEN` |
| `backup:restore` | required | `backup.restore` | ADMIN | `none` | — | yes | yes | `FORBIDDEN` |
| `updates:check` | required | — | ADMIN, MANAGER, MARKETING | `none` | — | — | — | — |
| `updates:install` | required | `backup.create` | ADMIN | `none` | — | — | yes | `FORBIDDEN` |

## Notes

- `app:info` — Version, channel and schema version for the About surface. No data.
- `app:needsSetup` — Boolean "has a first administrator been created". Leaks nothing else.
- `auth:setup` — Refuses once any user exists, so it cannot mint a second administrator.
- `auth:login` — Identical message for unknown user and wrong password.
- `auth:session` — Sanitized session only — never a password hash.
- `auth:changePassword` — Requires the current password; only ever changes the caller's own.
- `customers:list` — Scope is applied to the SQL before any caller filter.
- `customers:history` — Separate from the list so history never rides along on every row.
- `customers:summary` — Identity-only for out-of-scope guests: no phone, passport, status or owner.
- `customers:picker` — Deliberately unscoped so the finder cannot breed duplicates; withholds phone out of scope.
- `customers:create` — MARKETING may only create guests owned by themselves.
- `customers:update` — REJECTS a changed marketing_profile_id; ownership moves only through assign.
- `customers:assign` — The authorized override. Writes explicit history; never rewrites historical Invited By.
- `customers:delete` — Archive, not destroy — reservations and audit history survive.
- `reservations:list` — Active and Cancelled are two disjoint views; neither includes deleted rows.
- `reservations:listDeleted` — A separate VERB, not a view parameter — MARKETING cannot reach it by crafting a request.
- `reservations:get` — A deleted row answers NOT_FOUND to anyone who may not see deleted history.
- `reservations:create` — Deliberately unscoped: any marketer may book any guest, and protection is the only gate.
- `reservations:update` — Retargeting re-validates existence, scope and protection — it is a create in disguise.
- `reservations:cancel` — Idempotent; a repeat submit does not rewrite the recorded reason.
- `reservations:delete` — Soft delete. Hard ADMIN check beyond the capability; requires a reason.
- `profiles:list` — Other marketers' guest and reservation counts are masked for MARKETING.
- `profiles:related` — A profile's guest book is that marketer's book — own profile only for MARKETING.
- `profiles:delete` — Archive, not destroy — historical Invited By attribution must stay readable.
- `users:list` — Projection never includes password_hash.
- `users:update` — A role change or disable invalidates that user's session immediately.
- `users:delete` — Disable, not destroy; the last active administrator cannot be removed.
- `settings:all` — Personal keys resolve to the caller's own choice.
- `settings:set` — Personal keys are self-scoped; shared keys need settings.write.
- `settings:setPermissions` — Only configurable capabilities move; ADMIN-only ones are silently ignored.
- `notifications:unreadCount` — Fails closed rather than answering 0 without a session.
- `notifications:markRead` — A foreign id and a missing id answer identically.
- `dashboard:load` — Active Marketing is included for ADMIN and MANAGER only.
- `audit:list` — Read-only: there is deliberately no audit update or delete verb anywhere.
- `export:run` — Scope applies to the dataset; the file path comes from a native Save dialog, never the renderer.
- `photos:import` — Opens a native picker in the main process; validates type, signature and size.
- `photos:read` — Resolves inside the managed photo directory only; traversal is refused.
- `backup:list` — A backup is a full database dump including credentials — ADMIN only, not configurable.
- `backup:restore` — Validates, stages, and only then switches; current data survives any failure.
- `updates:check` — Network failure here must never affect anything else.
- `updates:install` — Blocked unless a verified pre-update backup exists.

## Payload validation

Every channel has a `zod` schema in
[`src/shared/validation/schemas.js`](../src/shared/validation/schemas.js), and every
schema is `.strict()` — an unrecognised field is a rejection, not something
silently carried into an UPDATE. That is what closes mass assignment on ownership,
timestamps and `row_version`, and it is why `__proto__` and `constructor` payloads
are refused as unrecognised keys rather than needing a special case.

| | |
|---|---|
| Channels without a schema | **none** |
| Schemas without a channel | **none** |

The registry refuses to start if either column is non-empty.
