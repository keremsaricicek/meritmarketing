# API Security Surface Matrix

Every operation exposed on `window.api` in `merit-marketing-hub.html`, with the
authorization contract each one is required to honour.

**Generated from [`tests/api-surface/surface.js`](api-surface/surface.js) — do not edit by
hand.** Run `npm run surface:doc` after changing the matrix.
[`tests/api-surface/doc-freshness.test.js`](api-surface/doc-freshness.test.js) fails the
suite if this file drifts, and
[`tests/api-surface/surface.test.js`](api-surface/surface.test.js) enforces the matrix
itself against the running application on every test run.

## Why this exists

Before the Electron migration, the boundary being hardened is the one between the
renderer and the business layer. Today `window.api` is an in-page object; after the
migration the same verbs become IPC channels reachable by anything running in the
renderer. Whatever is not enforced inside a handler stops being enforced at all the
moment the UI is no longer the only caller.

So the contract is recorded per verb, not per screen.

## How to read a row

| Column | Meaning |
|---|---|
| **Verb** | `namespace.method` as exposed on `window.api`. |
| **Permission** | The capability string passed to `guard()`. `—` means the verb is deliberately ungated (pre-session, or a pure UI affordance). |
| **Roles** | Who may call it at all. `anon` means callable with no session. |
| **Scope** | How far the caller may reach *within* the verb — see below. |
| **Ownership protection** | Whether the verb must enforce the one-year guest protection rule. |
| **Payload validation** | Whether the handler must validate the payload itself rather than trusting the form. |
| **Denial** | The error code a refused call must return. |

### Scope values

| Value | Meaning |
|---|---|
| `none` | No record-level narrowing. Capability alone decides the answer. |
| `query` | Returns a set. The set must be narrowed to the caller's scope *before* any caller-supplied filter is applied. |
| `record` | Addresses one record by id. The handler must verify that record is in the caller's scope. |
| `self` | Acts only on the calling session's own row (own password, own preference, own notification). |

`none` is a real answer, not a gap. `reservations.create` is deliberately unscoped —
any marketer may book any registered guest, which is exactly how a guest whose
protection has lapsed changes hands. Recording that as `record` would document a check
the handler does not have, and the next person to read the matrix would trust it.

### Two checks, not one

`guard(permission)` answers **"may this ROLE call this verb at all?"** — a capability
check. It says nothing about *which records* the call may touch.

`customerInScope(record)` / `reservationInScope(record)` answer **"may this SESSION
touch THIS record?"** — a record-level check.

A verb marked `record` needs both. A verb with only the capability check is how
horizontal escalation happens: the role is allowed to call `customers.get`, so the call
succeeds — for anybody's guest.

`scopeProfileId()` returns the caller's profile for MARKETING and `null` (unrestricted)
for ADMIN/MANAGER. It falls back to `-1` rather than `null` when a MARKETING session has
no profile, so a broken session fails closed and matches nothing, instead of failing open
and matching everything.

### Ownership protection is a separate axis again

The verbs marked `protection` can transfer a guest between marketers. Each must enforce
the one-year guest protection rule independently — the rule is not a property of the
record, it is a property of every route that could move it.

## Rules this matrix encodes

1. **UI hiding is never authorization.** A hidden button is a usability decision. Every
   row here is enforced in the handler and proved by a direct `window.api` call in the tests.
2. **The business/API layer is authoritative.** Status, scope, attribution and lifecycle
   are derived in the handler. Nothing is trusted from the client — including `status`,
   `invitedByProfileId` for MARKETING, and `marketingProfileId` on update.
3. **Historical attribution and current ownership are different concepts.**
   `reservation.invited_by_profile_id` is immutable history. `customer.marketing_profile_id`
   is mutable current state. Reassigning a guest must never rewrite who invited them.
4. **Refusals must not become oracles.** A verb that refuses a foreign id and a verb that
   refuses a nonexistent id must answer identically, or the difference itself is a read.

---

## The matrix

### `auth`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `auth.firstRun` | — | anon, ADMIN, MANAGER, MARKETING | none | no | no | — |
| `auth.setup` | — | anon | none | no | yes | VALIDATION |
| `auth.login` | — | anon | none | no | yes | VALIDATION |
| `auth.session` | — | anon, ADMIN, MANAGER, MARKETING | self | no | no | — |
| `auth.logout` | — | anon, ADMIN, MANAGER, MARKETING | self | no | no | — |
| `auth.changePassword` | — | ADMIN, MANAGER, MARKETING | self | no | yes | VALIDATION |

### `users`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `users.list` | users.read | ADMIN, MANAGER | none | no | no | FORBIDDEN |
| `users.create` | users.create | ADMIN | none | no | yes | FORBIDDEN |
| `users.update` | users.update | ADMIN | none | no | yes | FORBIDDEN |
| `users.delete` | users.delete | ADMIN | none | no | yes | FORBIDDEN |

### `customers`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `customers.list` | customers.read | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |
| `customers.picker` | customers.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `customers.get` | customers.read | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |
| `customers.summary` | customers.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `customers.create` | customers.create | ADMIN, MANAGER, MARKETING | record | no | yes | FORBIDDEN |
| `customers.update` | customers.update | ADMIN, MANAGER, MARKETING | record | yes | yes | FORBIDDEN |
| `customers.assign` | customers.assign | ADMIN, MANAGER | record | yes | yes | FORBIDDEN |
| `customers.delete` | customers.delete | ADMIN, MANAGER | record | no | yes | FORBIDDEN |

### `reservations`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `reservations.list` | reservations.read | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |
| `reservations.get` | reservations.read | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |
| `reservations.create` | reservations.create | ADMIN, MANAGER, MARKETING | none | yes | yes | FORBIDDEN |
| `reservations.update` | reservations.update | ADMIN, MANAGER, MARKETING | record | yes | yes | FORBIDDEN |
| `reservations.cancel` | reservations.update | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |
| `reservations.delete` | reservations.delete | ADMIN | none | no | yes | FORBIDDEN |

### `profiles`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `profiles.list` | profiles.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `profiles.get` | profiles.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `profiles.create` | profiles.create | ADMIN, MANAGER | none | no | yes | FORBIDDEN |
| `profiles.update` | profiles.update | ADMIN, MANAGER | none | no | yes | FORBIDDEN |
| `profiles.delete` | profiles.delete | ADMIN | none | no | yes | FORBIDDEN |
| `profiles.relatedCustomers` | profiles.read | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |

### `crmNotes`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `crmNotes.list` | crmNotes.read | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |
| `crmNotes.create` | crmNotes.create | ADMIN, MANAGER, MARKETING | record | no | yes | FORBIDDEN |
| `crmNotes.update` | crmNotes.update | ADMIN, MANAGER | record | no | yes | FORBIDDEN |
| `crmNotes.delete` | crmNotes.delete | ADMIN, MANAGER | record | no | no | FORBIDDEN |

### `notifications`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `notifications.list` | notifications.read | ADMIN, MANAGER, MARKETING | self | no | no | FORBIDDEN |
| `notifications.unreadCount` | notifications.read | ADMIN, MANAGER, MARKETING | self | no | no | FORBIDDEN |
| `notifications.markRead` | notifications.update | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |
| `notifications.markAllRead` | notifications.update | ADMIN, MANAGER, MARKETING | self | no | no | FORBIDDEN |
| `notifications.delete` | notifications.update | ADMIN, MANAGER, MARKETING | record | no | no | FORBIDDEN |
| `notifications.clearRead` | notifications.update | ADMIN, MANAGER, MARKETING | self | no | no | FORBIDDEN |
| `notifications.dismissAll` | notifications.update | ADMIN, MANAGER, MARKETING | self | no | no | FORBIDDEN |

### `dashboard`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `dashboard.load` | dashboard.read | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |

### `calendar`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `calendar.month` | reservations.read | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |
| `calendar.day` | reservations.read | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |

### `reports`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `reports.access` | reports.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |

### `audit`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `audit.list` | audit.read | ADMIN, MANAGER | none | no | no | FORBIDDEN |

### `settings`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `settings.all` | settings.read | ADMIN, MANAGER, MARKETING | self | no | no | FORBIDDEN |
| `settings.set` | settings.read | ADMIN, MANAGER, MARKETING | self | no | yes | FORBIDDEN |
| `settings.permissions` | settings.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `settings.setPermissions` | — | ADMIN | none | no | yes | FORBIDDEN |

### `photos`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `photos.pick` | customers.update | ADMIN, MANAGER, MARKETING | none | no | yes | FORBIDDEN |
| `photos.read` | customers.read | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `photos.save` | customers.update | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |
| `photos.remove` | customers.update | ADMIN, MANAGER, MARKETING | none | no | no | FORBIDDEN |

### `backup`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `backup.list` | backup.read | ADMIN | none | no | no | FORBIDDEN |
| `backup.create` | backup.create | ADMIN | none | no | no | FORBIDDEN |
| `backup.restore` | backup.read | ADMIN | none | no | yes | FORBIDDEN |
| `backup.openFolder` | — | ADMIN, MANAGER, MARKETING | none | no | no | — |

### `export`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `export.run` | export.run | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |
| `export.filtered` | export.run | ADMIN, MANAGER, MARKETING | query | no | no | FORBIDDEN |
| `export.openFolder` | — | ADMIN, MANAGER, MARKETING | none | no | no | — |

### `(top level)`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `onMenuAction` | — | anon, ADMIN, MANAGER, MARKETING | none | no | no | — |

### `dialog`

| Verb | Permission | Roles | Scope | Ownership protection | Payload validation | Denial |
|---|---|---|---|---|---|---|
| `dialog.confirm` | — | anon, ADMIN, MANAGER, MARKETING | none | no | no | — |

---

## Enforcement

`tests/api-surface/surface.test.js` runs on every `npm test`:

1. **Discovers the live surface** by recursively walking `window.api` in the running
   application and comparing it to this matrix. A newly exposed verb that is not
   documented here fails the run; so does a documented verb that no longer exists. The
   walk is recursive and includes bare top-level functions, because a one-level scan only
   catches verbs shaped like the ones that already exist.
2. **Probes every verb unauthenticated.** Anything whose roles omit `anon` must refuse
   before a session exists.
3. **Probes every verb as MARKETING and as MANAGER.** Anything not listing that role must
   return its documented denial code.
4. **Probes record scope, driven by the matrix.** Every verb marked `scope: 'record'` is
   called against another marketer's record and must be refused. A row claiming `record`
   with no registered probe fails the suite — so the claim cannot be made without being
   proved.
5. **Probes ownership protection, driven by the matrix.** Same contract for every verb
   marked `protection: true`, and afterwards ownership is re-read to confirm nothing moved.
6. **Probes crafted payloads.** Filter parameters naming another marketer's profile must
   narrow the caller's own set, never select a different one. Export checks read the CSV
   bytes actually written, because the `export.filtered` envelope carries only a row count.

The failure this is designed to catch is not a bug in today's code — it is tomorrow's new
verb added without a guard, or with a row that overstates what the handler does.

### Adding a verb

1. Write the handler with its `guard()` and, if it addresses records, its scope check.
2. Add the row to `tests/api-surface/surface.js`.
3. If the row says `scope: 'record'` or `protection: true`, register a probe in
   `surface.test.js` (`FOREIGN_PROBE` / `PROTECTION_PROBE`). The suite fails until you do.
4. Run `npm run surface:doc` to regenerate this file.
5. Run `npm test`. If the matrix and the implementation disagree, fix the
   **implementation** unless the matrix itself is wrong — amending the matrix to match a
   permissive handler is how a boundary quietly disappears.
