# Security

## Threat model

This is an internal desktop application holding guest names, phone numbers and
passport numbers, used by staff on shared office machines. The realistic threats
are:

1. **A marketer reading or taking another marketer's book.** Commission runs on
   guest ownership, so this is the motivated attack, not a hypothetical one.
2. **Hostile data.** Guest names, notes and passport fields are operator-typed
   and end up in HTML, in CSV and in SQL.
3. **An unattended unlocked workstation.**
4. **A stolen database file** from a backup drive or a decommissioned machine.

Explicitly **not** claimed: protection against a Windows administrator on the
machine itself. Someone with local admin can read the database file. Local
SQLite is not tamper-proof against them and this document does not pretend
otherwise.

## Authentication

- **Argon2id** (`@node-rs/argon2`), OWASP parameters: 19 MiB, t=2, p=1.
  Memory-hard, which is what matters for a stolen file. Parameters live inside
  the hash string, so raising them later rehashes users on next login.
- **No default account and no recovery backdoor.** A fresh install has an empty
  users table; first run creates the first ADMIN and then setup refuses forever.
  A setup verb that still works on a populated database is an unauthenticated
  admin-creation endpoint.
- **No username oracle.** Unknown user and wrong password return the identical
  message.
- **Backoff, not lockout.** Five failures locks the account for five minutes.
  A permanently bricked manager account on a Saturday night is an outage.
- **Password change requires the current password**, and refuses reuse.
- The renderer never receives a password hash. `users:list` does not project it.

## Authorization

Three separate questions, asked in order (`src/main/services/guard.js`):

1. Is anybody signed in?
2. May this **role** call this verb? (`capability`)
3. May this **session** touch this **record**? (`scope`)

`scopeProfileId()` returns the caller's profile for MARKETING and `null`
(unrestricted) for ADMIN/MANAGER. It falls back to `-1`, so a MARKETING session
without a profile matches **nothing** rather than everything.

**UI hiding is never authorization.** Every rule is enforced in a service and
proved by a direct IPC call in the tests.

## What the renderer cannot do

- No `require`, `process`, `module`, `global` or `Buffer` — asserted in
  `tests/electron/launch.test.js` against the running app.
- No `ipcRenderer` and no generic `invoke(channel, payload)`. The bridge is one
  named function per operation, so a compromised renderer can only call
  operations that already exist — each of which re-checks authorization anyway.
- `connect-src 'none'`: the renderer has no network, so it cannot exfiltrate.
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- Navigation blocked, popups denied, permissions denied by default, no
  `shell.openExternal` bridge, DevTools gated to development builds.
- `script-src 'self'` with **zero inline handlers**, which is what makes an
  injected `onclick` in a guest's name inert.

## Input handling

- Every channel has a zod schema, and every schema is `.strict()`. An unexpected
  field is a rejection, not something carried into an `UPDATE` — that is what
  closes mass assignment on ownership, timestamps and `row_version`.
- All SQL is parameterised. Sort fields are whitelist lookups, never
  interpolated.
- Paging is bounded; an unbounded `pageSize` is a denial of service.
- CSV cells beginning `=`, `+`, `-` or `@` are prefixed, so a guest named
  `=cmd|'/c calc'!A1` is text rather than a formula.
- Photo type comes from the content signature, not the extension. Internal names
  are generated; the original filename never becomes a path component.
- Every filesystem resolution goes through `safeJoin`, which refuses traversal
  and separators.

## Refusals must not become oracles

A verb that refuses a foreign id and a verb that refuses a nonexistent id answer
identically. Otherwise the difference is itself a read. This is asserted for
deleted reservations and for notifications.

The guest-protection message is exactly:

> Guest protection period has not expired.

It deliberately does not name the owner or the expiry date.

## Audit

Append-only from the application's point of view: there is no audit update or
delete verb anywhere in the IPC surface. Logged: first-run setup, login success
and failure, logout, guest and reservation lifecycle including deletion with its
reason and previous state, assignment and reassignment, profile and user
changes, permission changes, backup, restore and update events.

Never logged: passwords, password hashes, tokens. The diagnostics logger redacts
by key name, so a field called `password` is redacted wherever it appears.

## Known limitations

| Limitation | Why it is accepted |
|---|---|
| A local Windows administrator can read or alter the database | Out of scope for a local-first desktop app. Mitigation is OS disk encryption. |
| The audit log is not cryptographically tamper-evident | It is a business record, not a forensic one. Claiming otherwise would be false. |
| Artifacts are unsigned until a certificate is supplied | See [RELEASE.md](RELEASE.md). SmartScreen will warn until then. |
