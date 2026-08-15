---
name: merit-security-audit
description: Aggressive security, authorization, business-logic, role-scope, data-integrity and production-readiness auditing for Merit Marketing Hub.
---

# Merit Security Audit

## Overview

Merit Marketing Hub is a casino CRM with three roles (ADMIN, MANAGER, MARKETING) whose
entire trust model rests on server-side scope enforcement inside the `window.api`
backend (currently an in-browser mock over `localStorage`, destined to become an
Electron + SQLite app). Every guest record, reservation, and KPI number is a claim
about who is allowed to see or change what. This skill exists because that claim has
been wrong before — in this exact codebase — in ways that only surfaced under
deliberate, adversarial testing: a marketing profile silently absorbing another
marketer's guest by creating a reservation, a Dashboard KPI counting records nobody
could actually find in the destination list, a status field re-derived from data that
included cancelled bookings it should have excluded.

**Core principle:** if you did not try to break it as an attacker or as a hostile
dataset, you have not audited it — you have skimmed it.

**Announce at start:** "I'm using the merit-security-audit skill to audit this."

## Hard Rules — non-negotiable

<HARD-GATE>
**UI hiding is never authorization.** A button that is hidden, a filter that is
scoped, a tab that is `mayOpen()`-gated, a `<select>` that only lists a user's own
records — none of that is a security control. It is a UX nicety layered on top of a
security control, or it is nothing at all. The only question that matters for every
capability in this app is: *what does the `window.api` handler do when called
directly, with an arbitrary payload, by a session that should not be allowed to do
this?* If the answer is "the handler doesn't check," the feature is unauthorized
regardless of what the UI shows.

**Business/API layer is authoritative.** Every `window.api.<entity>.<verb>` function
in the `<script>` block is the actual trust boundary. `guard(perm)` checks *capability*
(can this role call this verb at all); it does not check *scope* (can this specific
session touch this specific record). Scope must be checked again, explicitly, inside
the handler, using `scopeProfileId()` / `session.profile_id` / `session.role` — never
assumed from the fact that the client only sent IDs it was "supposed to" have.

**Historical attribution and current ownership are different concepts, and audits
must never conflate them.** `reservation.invited_by_profile_id` on an existing
reservation is a historical fact — it records who invited that specific stay and must
never be rewritten by a later reassignment, a later cancellation, or a later edit to
a *different* reservation for the same guest. `customer.marketing_profile_id` is
current state — who this guest is presently assigned to, which absolutely can and
should change (via authorized reassignment, via `syncMarketing()`, via guest
protection expiry). A fix that "solves" a scope bug by touching historical
`invited_by_profile_id` values on reservations that were not the one just created or
reassigned is itself a data-integrity bug. A fix that "solves" a stale-ownership bug
by never letting `marketing_profile_id` change is a functionality regression, not a
fix.

**Never claim secure, production-ready, or fully fixed without evidence.** No
finding is closed on the strength of reading the code and being convinced. Every
"fixed" claim in a report from this skill must carry the actual command/API call/UI
step that was re-run after the fix, and its actual output. "This should now be safe"
is not a finding disposition; it is a hypothesis waiting on a test.
</HARD-GATE>

## Required Methodology

1. **Root-cause analysis before fixes.** When something is wrong — a count doesn't
   match, a boundary can be crossed, a status is stale — do not patch the symptom
   (don't just clamp a displayed number, don't just hide a button harder). Trace the
   value back to where it is computed or the check back to where it is (not)
   enforced, and fix that. If two screens compute "the same" concept two different
   ways, that divergence is the root cause, not either individual screen's number.

2. **ADMIN / MANAGER / MARKETING test matrices, always.** Every capability under
   audit gets exercised as all three roles, not just the role that "should" have
   access. Role differences in *what data comes back* are expected and correct
   (§"Role scope may change the result" from prior audits still holds). Role
   differences in *whether an authorization check fires* are the bug. Build the
   matrix explicitly: capability × role × own-record-vs-someone-else's-record.

3. **Direct API attack tests, not just UI tests.** The UI is one client of
   `window.api`; it is not the boundary. For every capability, in addition to
   clicking through the real UI, call the underlying `window.api.<entity>.<verb>(...)`
   directly from the console/test harness with:
   - a session logged in as the *wrong* role for the target record,
   - IDs that belong to another scope (IDOR probes — increment/guess adjacent
     customer/reservation/profile IDs),
   - payload fields the UI would never send (e.g. a `marketingProfileId` MARKETING
     shouldn't be able to set, a `status` the client shouldn't control, a
     `cancelled_at` sent directly on create),
   - missing/null/malformed required fields,
   - values crafted to look like this app's demo-owned IDs but are for a *different*
     unowned or protected record.
   A finding that "the UI never lets you do that" is not a finding of safety unless
   the direct API call also fails.

4. **`displayed count === authoritative dataset` assertions.** For every KPI, badge,
   tab count, or "N results" label: fetch the number shown, then independently query
   the actual underlying dataset the same screen's click-through/destination view
   would show, under the *same* role and *same* filters, and assert they are equal.
   Do this for ADMIN, MANAGER, and MARKETING separately — a mismatch that only shows
   up under one role's scope is still a mismatch. Do it again after every mutating
   action in the same session (create/edit/cancel/delete/assign/activate/deactivate)
   with **no reload** — a number that is only correct after a refresh is not correct,
   it is coincidentally consistent with stale UI state.

5. **Regression tests after every fix.** A fix to one boundary must not silently
   reopen or break another. After any change made in response to a finding, re-run:
   the specific reproduction that surfaced the bug (now expected to fail/be
   blocked/match), the adjacent capabilities that share the same code path
   (`syncMarketing`, `filteredCustomers`, `filteredReservations`, `decorateCustomer`,
   `guard`/`can`/`scopeProfileId` are all shared — changing one ripples), and a
   plain-vanilla ADMIN/MANAGER/MARKETING smoke pass of the screens touched.

## Audit Checklist

Work through every applicable item for the feature/area under review. Do not skip an
item because it "seems fine" — every item below exists because a plausible-looking
implementation in this exact class of app has failed it before.

### Role boundaries & privilege escalation
- **Horizontal escalation** — can MARKETING A read, edit, cancel, delete, reassign,
  or export MARKETING B's customers/reservations by ID, by search, by export, by
  report, by finder, by inspector deep-link?
- **Vertical escalation** — can MARKETING reach any ADMIN/MANAGER-only verb
  (`profiles.create/update`, `customers.delete`, `users.*`, `settings.setPermissions`,
  `backup.*`) by calling the handler directly, bypassing a hidden/disabled UI
  control? Does `guard()` fire for *every* verb, or are any handlers missing the
  `guard('...')` call entirely (silently open to any authenticated session)?
- **IDOR** — every handler that takes an `id`: does it verify the record belongs to
  the caller's scope, or only that the record exists? Test with IDs from a different
  scope, deleted-record IDs, and non-existent IDs.
- **`window.api` direct abuse** — treat the whole `window.api.*` surface as a public
  API. For each entity (`customers`, `reservations`, `profiles`, `crmNotes`,
  `notifications`, `settings`, `users`, `audit`, `export`, `backup`), enumerate every
  verb and confirm `guard()` + scope check both exist and both actually restrict.
- **Crafted payloads** — extra/unexpected fields, wrong types, negative/zero/huge
  IDs, arrays where scalars expected, `null` vs `undefined` vs `''` for optional
  scope-relevant fields (`marketingProfileId`, `invitedByProfileId`, `profileId`).

### Reservation & customer ownership
- **Reservation scope** — `reservations.get/list/update/cancel/delete`: does each
  enforce that a MARKETING session only touches reservations where
  `invited_by_profile_id === session.profile_id`, including on the mutating verbs,
  not just `list`?
- **Customer scope** — `customers.get/update/delete/assign`: same question for
  `marketing_profile_id`. Does `customers.update` let MARKETING edit a customer they
  don't own by ID even though the UI never shows them that customer?
- **1-year guest protection bypass** — every path that can set/change
  `marketing_profile_id` or `invited_by_profile_id` (`reservations.create`,
  `reservations.update` with a changed `customerId`, `customers.assign`, any future
  bulk-import or backup-restore path) must run through the shared
  `isGuestProtectedFrom()` / `guestProtectionExpiry()` / `latestQualifyingVisit()`
  logic for MARKETING callers. Test: protected guest via each path individually, not
  just the New Reservation modal. Confirm a **cancelled** reservation cannot start,
  extend, or fake a qualifying visit. Confirm ADMIN/MANAGER override still preserves
  `assignment_history` and never rewrites past reservations' `invited_by_profile_id`.
- **Assignment/reassignment bypass** — can MARKETING call `customers.assign` on a
  protected guest if the CONFIGURABLE permission override is toggled on? Does the
  protection check run inside `customers.assign` itself, not only inside the
  reservation-creation path?
- **Invited By tampering** — can a MARKETING session send an arbitrary
  `invitedByProfileId` on create/update and have it accepted, instead of being forced
  to `session.profile_id`? Can a crafted payload set `invited_by_profile_id` to a
  profile that doesn't exist, is deleted, or is inactive, and have it silently
  accepted rather than rejected/warned?

### KPI, count & data-consistency integrity
- **KPI vs actual dataset mismatches** — see methodology §4. Explicitly test the
  known-fragile pattern from prior audits: a KPI counting a raw/global array
  (`db.profiles`, `db.customers`) without the same scope/kind/status filters the
  screen it links to applies.
- **No Record inconsistencies** — must be exactly "registered AND zero
  non-cancelled... (confirm current authoritative definition in code) reservations
  AND zero CRM notes," computed once and reused everywhere it's shown (Dashboard,
  CRM Panel tab, exports, reports). Verify a cancelled-only guest's classification
  matches the codebase's actual current rule, not an assumed one.
- **Cold Guest inconsistencies** — same test, for the Cold formula and its
  `last_visit`/`next_visit` inputs. Confirm cancelled reservations cannot produce a
  false-recent `last_visit` that keeps a guest out of Cold when they should be in it.
- **Cancelled reservation side effects** — audit every place a reservation's
  `cancelled_at` is read or ignored: KPI counts, `syncMarketing()`, guest protection,
  Last Visit, "N visits" pills, No Record, Cold, calendar buckets, exports, reports.
  A cancelled reservation must never count as real activity anywhere except its own
  visible "CANCELLED" record in history.
- **Duplicate counting** — a customer or reservation counted twice because it
  satisfies two roles/relationships (Created By + Assigned To + Invited By) in a
  screen that doesn't deduplicate by entity ID.
- **Stale state** — any count/badge/list that is only correct immediately after a
  fresh page load and goes wrong after a same-session mutation with no reload.

### Reports & export
- **Reports/export data leakage** — does every report type and `export.filtered`
  call re-derive scope from `session` server-side, or does it trust `params` sent
  from the client (a MARKETING client could in principle request `assignedTo`/
  `createdBy`/`invitedBy` values that aren't their own)? Does an export ever include
  fields a role shouldn't see at all (e.g. another marketer's real
  `reservation_count`/`customer_count`, masked in `profiles.list` but not
  necessarily in every export path)?

### Injection, secrets & storage
- **Unsafe innerHTML / XSS** — every `.innerHTML =` / template-literal HTML build
  must escape untrusted values (`escapeHtml`). Audit guest names, notes, passport
  numbers, profile names, cancellation reasons, and anything else a user can type
  and another user later renders — including inside `title=`, `alt=`, and inline
  `onclick="...('${...}')"` attribute construction, which escapeHtml alone does not
  make safe from quote-breakout.
- **Validation bypass** — every `fail('VALIDATION', ...)` client-side check
  (required fields, ID uniqueness, date ordering, password length) must be
  duplicated inside the actual `window.api` handler; a client that skips the form
  and calls the API directly must hit the same rejection.
- **Hardcoded credentials/secrets** — scan for literal usernames/passwords/tokens
  outside the seed-demo function (which is expected and fine for a local preview
  build), and confirm nothing resembling a real secret ships in the file.
- **localStorage security problems** — the entire "database" is one JSON blob in
  `localStorage`, readable/writable by any script in the page's origin and by the
  user via devtools. Document this as an accepted architectural limit of the current
  preview build, but flag any place that treats localStorage content as trusted
  input (e.g. re-hydrating `session` from storage without re-validating against
  `db.users`).
- **Electron security risks** — this app is destined for Electron. Flag anything
  that would become dangerous once wired to `nodeIntegration`/`contextBridge`/IPC:
  unsanitized paths passed toward file I/O, unbounded `dialog`/`shell.openExternal`-
  style calls, any assumption that renderer-side checks are sufficient once a real
  main-process IPC boundary exists.
- **Future SQLite/database integrity** — flag any business rule currently enforced
  only in JS-array-filter logic (uniqueness of customer `code`, passport uniqueness,
  cascade-delete of a customer's reservations/notes/notifications) that will need an
  equivalent constraint/transaction in the eventual SQLite schema, so it isn't lost
  in translation.

### Operational integrity
- **Audit-log integrity** — does every privileged/destructive action
  (create/update/delete/assign/cancel/permission-change/login/logout) write an
  `audit()` entry with the real actor, or can an action complete silently? Can the
  audit log itself be read or tampered with by a role that shouldn't see it?
- **Backup/restore integrity** — does `backup.restore` re-run migrations
  (`migrateAttribution`, `migrateProfileKind`, etc.) and `syncReservationStatuses()`
  after loading, or can a restored backup reintroduce a since-fixed data shape and
  silently break scope/status derivation? Is restore itself role-gated?
- **Destructive actions** — every delete (`customers.delete`, `reservations.delete`,
  profile delete) must be both `guard()`-checked and, where the UI has a stricter
  rule than the base permission (e.g. `reservations.delete` is ADMIN-only regardless
  of the `PERMISSIONS`/`CONFIGURABLE` override matrix), hard-coded-checked in the
  handler too — confirm the override matrix cannot be used to grant a destructive
  capability the codebase intends to be non-configurable.
- **Fail-open authorization** — for every `try { guard(...) } catch (e) { return
  fail(...) }` pattern, confirm the *only* path to `ok(...)` is past a successful
  guard/scope check — no early return, no missing `else`, no code path that reaches
  the success branch when a check throws or returns falsy without being caught.
- **Data corruption** — mutations that partially apply (e.g. a multi-step save that
  writes `db.reservations` but fails before `syncMarketing()`/`save()`), leaving
  derived state inconsistent with source records; concurrent-mutation races if this
  is ever multi-tab/multi-window.

## Required Report Format

For every finding:

```
### [SEVERITY] Short title

**Area:** (one or more checklist categories above)
**Reproduction steps:** exact steps — role logged in as, exact UI clicks or exact
  window.api call with full payload, in order, numbered.
**Expected:** what a correctly-scoped/secure/consistent system would do.
**Actual:** what actually happened — exact output, exact number, exact error (or
  lack of one).
**Root cause:** the specific function/line/logic responsible — not "the check is
  missing" but *which* check, in *which* handler, checking *what* incorrectly.
**Fix:** what was changed (file/function), and why this is the root-cause fix rather
  than a symptom patch.
**Verification evidence:** the reproduction steps re-run after the fix, with actual
  output showing the expected result now holds, plus the regression checks from
  Methodology §5 and their results.
```

Severity guide for this app specifically:
- **CRITICAL** — cross-role data exposure or mutation (horizontal/vertical
  escalation, IDOR that reaches another scope's records, guest-protection bypass
  that reassigns ownership, any fail-open authorization path).
- **HIGH** — data integrity corruption reachable without crossing a role boundary
  (duplicate counting, cancelled reservations polluting derived state, stale
  ownership after a legitimate mutation, XSS from user-entered text).
- **MEDIUM** — KPI/count mismatches that don't misattribute ownership but mislead an
  authorized user about their own correctly-scoped data; validation bypass that
  produces bad-but-visible data rather than a security hole.
- **LOW** — audit-log gaps, cosmetic inconsistency between two correct-but-differently-
  worded definitions, hardening opportunities for the future Electron/SQLite target
  that aren't exploitable in the current build.

A finding with no severity, no reproduction steps, or no verification evidence is not
a finished finding — file it as open and keep testing.
