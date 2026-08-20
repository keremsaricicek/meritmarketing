# Scorecard

Fourteen dimensions, scored against evidence. A score without a citation is an
opinion, so every row names the file, the test or the measured number behind it.

Two dimensions score below 8, and both are scored honestly rather than excused:
the update path cannot be trusted yet, and the Windows installer has never been
run. Neither is a code gap.

| # | Dimension | Score | Evidence |
|---|---|---|---|
| 1 | Product preservation | 8/10 | No screen redesigned. The 529 baseline assertions still run against `merit-marketing-hub.html`. Where a reviewer proposed changing behaviour — scoping the guest inspector's counts — the prototype's own `custRes` helper was checked first, found unscoped, and the *list* was widened to match the counts instead. Losing points because two whole features were built everywhere except where a person could use them: the notification producers were missing until the second review, and the **Deleted Reservations screen did not exist at all** until the third — the verb, its capability, its scope rules and its tests were complete, and no administrator could reach deleted history. A feature that is unreachable is not implemented. |
| 2 | Architecture and layering | 9/10 | `renderer → preload → registry → services → repositories → SQLite`, nothing pointing back. Domain rules are pure functions (`src/main/services/domain.js`), which is what lets one definition of "qualifying", "No Record" and "protection" serve every screen. The audit sink was duplicated in the test harness until this pass — one copy of a rule is the whole point, and there were two. |
| 3 | Data model and integrity | 10/10 | 11 tables, 19 indexes, CHECK constraints that make invalid states unrepresentable: `check_out >= check_in`, `deleted_at IS NULL OR deleted_by IS NOT NULL`, `role <> 'MARKETING' OR profile_id IS NOT NULL`. Soft-delete columns present from migration 1, not retrofitted. `database/migrations/001-initial-schema.sql`. |
| 4 | Authorization | 10/10 | Two axes, both enforced. 34 of 60 channels record- or query-scoped. `tests/ipc/surface-enforcement.test.js` (127 assertions) and `tests/ipc/attack-matrix.test.js` (81) probe every verb. The oracle the review found — four distinguishable refusals from `update`/`cancel` — is closed and regression-tested across every id-addressed verb, not just the two that were reported. |
| 5 | Electron security boundary | 9/10 | `contextIsolation`, `sandbox`, `nodeIntegration:false`, `devTools` off when packaged, navigation and popups blocked, permissions denied, six fuses burned including `GrantFileProtocolExtraPrivileges:false`. The independent review verified the fuses *by reading the built binary* and confirmed `require`, `process` and `module` are all `undefined` in a live page. Losing a point because the boundary was sound while the renderer inside it ran `eval(item.run)` for every Command Palette command — a code evaluator behind a CSP written to forbid one, found only on the third inspection. |
| 6 | IPC surface and validation | 10/10 | 60 channels, 60 schemas, all `.strict()`. The registry refuses to boot on an undocumented channel, a handler-less entry or a schema-less channel — verified by registering a rogue channel and watching it throw. `export:run` was the last unvalidated payload and is now typed. |
| 7 | Authentication and secrets | 10/10 | Argon2id via `@node-rs/argon2`, rehash-on-login, per-account time-boxed lockout, identical message for unknown user and wrong password. `users` has only `password_hash`; no column exists that could hold a plaintext. Repo-wide search for tokens, PEM/PFX blobs and thumbprints: nothing. CI uses no secrets at all. |
| 8 | Soft deletion and Deleted visibility | 10/10 | Three disjoint views by construction. Every SQL statement touching `reservations` filters `deleted_at`; the differential test over 58 boundary fixtures found 0 mismatches between the SQL filters and the JS rule. `listDeleted` is a separate verb behind its own capability. The customer-side gap the review found — an archived guest still rendered by the reservation list, both calendars and the CSV — is closed and covered. |
| 9 | Backup and recovery | 9/10 | Custom container, per-entry SHA-256, entry names validated so there is no zip-slip surface rather than a filtered one. Restore is staged: safety backup, deep integrity check, and an admin-presence check *before* the swap — a backup that would lock the owner out is refused. Losing a point because the container's own filename was the one path in the application not passing through `safeJoin`, which made a planted archive restorable over the live database. |
| 10 | Updates and data safety | 5/10 | User data lives outside the program directory, an update takes a backup first and `install()` refuses when nothing was downloaded — all verified. But **the downloaded installer is not signature-verified** (B8) and **the Squirrel maker does not compose with electron-updater's NSIS path** (B9). Whoever controlled a feed today would get code execution. Updates must stay off until both are resolved; `docs/UPDATE.md` says so in its opening section. |
| 11 | Offline operation | 10/10 | Guaranteed structurally, not by testing with the cable out: zero remote assets, zero network APIs in the renderer, `connect-src 'none'`. The one component that reaches out is driven with a DNS failure and an `ERR_INTERNET_DISCONNECTED` event and degrades to "unavailable". `tests/electron/offline.test.js`, 29 assertions. |
| 12 | Test quality and regression protection | 7/10 | 34 suites, 1240 assertions, on the production runtime. The security matrix is load-bearing: a verb listed as record-scoped with no probe registered is a failure. But this is the dimension the reviews hurt most, three times over. 1016 assertions could not see that the application did not start. Four assertions could not fail at all. And an assertion literally named *"no inline event handler of any kind survives"* tested a hand-written list of four event names while `onmouseenter` and `onmouseleave` sat in the markup. Every one of those gates was an enumeration. `tests/ui/renderer-source-safety.test.js` (77 assertions) replaces them with exhaustive patterns — any `on*=`, any string-to-code construct, any repeated action attribute in one tag — and was verified by reintroducing each defect and watching it go red. The score reflects that three rounds of review were needed to reach that. |
| 13 | Performance at scale | 10/10 | 10,000 guests · 50,000 reservations · 50,000 CRM notes. Measured: customer list **5ms** (budget 800), search **5ms**, detail **1ms**, reservation list **28ms**, dashboard **219ms** (budget 2000), calendar month **17ms**, finder **4ms**, scoped list **3ms**. `EXPLAIN QUERY PLAN` assertions confirm the hot queries use indexes, not scans. |
| 14 | Release readiness and honesty | 6/10 | `release.json` now records `signed` from `Get-AuthenticodeSignature` rather than from a certificate existing on disk, and blocks when a configured certificate did not produce valid signatures. The package ships nothing it should not (698 entries, verified against the archive rather than the ignore list). But **no installer has been executed**, **nothing is signed**, and **no end-to-end update has run** — B4, B5, B6. The engineering is done; the release is not. |

**Weighted position: engineering complete and verified; release blocked on
external dependencies.**

## What the two low scores mean in practice

Dimension 10 and dimension 14 are the same story told twice. Everything the
application does on the machine it is installed on is finished and tested.
Everything about *getting it onto that machine and keeping it current* needs
things that cannot be created here: a code-signing certificate, a Windows host,
and a decision about the update client.

Scoring those 9/10 because the code is written would be the kind of claim this
whole report exists to avoid.

## Deliberately not scored

- **UI/UX quality.** No screen was redesigned; scoring it would be scoring the
  baseline's work, not the migration's.
- **Windows-specific behaviour.** The ASAR integrity fuse is a no-op on Linux,
  and Authenticode, Squirrel install and SmartScreen were never exercised. An
  unverified dimension is left unscored rather than given a number.
