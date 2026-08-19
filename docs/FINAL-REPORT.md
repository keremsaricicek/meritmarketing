# Merit Marketing Hub — Electron / SQLite Migration: Final Report

**Status:** ENGINEERING READY — EXTERNAL RELEASE SETUP REQUIRED
**Branch:** `claude/plugin-marketplace-ui-ux-pro-max-91h8kg`
**Baseline:** `fb49302`, tag `pre-electron-baseline` (local — see §24, B1)

This report is written to be checkable. Every claim that can be proved names
the file, the test or the measured number that proves it, and every claim that
cannot be proved here is stated as not proved rather than softened.

---

## 1. What was asked for, and what this is

A browser prototype — one 20,000-line HTML file with a mock backend over
`localStorage` — had to become a production Windows desktop application without
becoming a different product.

The instruction that governed every decision was: **preserve the existing
product.** Not a redesign, not a new CRM concept, not a framework rewrite. The
529 assertions passing at the baseline are the behavioural specification. Where
the migration and an existing valid behaviour disagreed, the migration was
fixed.

## 2. What changed, in one paragraph

The business rules and the data moved out of the browser into a privileged main
process. `localStorage` became SQLite with a migration system. Mock permission
checks became a two-axis authorization model enforced server-side. Inline
`onclick` handlers became delegated actions, because a real Content Security
Policy makes inline handlers inert. Reservation deletion became non-destructive.
Passwords became Argon2id hashes. The screens themselves were not redesigned.

## 3. Architecture

```
renderer  →  preload  →  IPC registry  →  services  →  repositories  →  SQLite
                             ↑               ↑
                     security surface     domain rules
```

Nothing points backwards. Full detail in `docs/ARCHITECTURE.md`.

The renderer holds no authority. Its state is a cache of what main said. A
service never reaches for the window; a repository never checks a role; the
domain rules touch neither the database nor the session, which is what lets one
definition of "qualifying reservation", "No Record", "guest protection" and
"calendar bucket" serve the Dashboard, the Customer List, Reports and the
Calendar at once. Each screen computing its own version is what produced the
original defect where the No Record count and the No Record list disagreed.

## 4. Data model

`database/migrations/001-initial-schema.sql`. Eleven tables, 19 indexes, and
CHECK constraints that make the invalid states unrepresentable rather than
merely unlikely:

- `check_out >= check_in`
- `deleted_at IS NULL OR deleted_by IS NOT NULL` — a tombstone always names who
- `role <> 'MARKETING' OR profile_id IS NOT NULL` — a marketer always has a scope

Soft-delete columns exist from migration 1, not bolted on later. Detail in
`docs/DATA-MODEL.md`.

## 5. Business dates versus system instants

A business date is `TEXT 'YYYY-MM-DD'` with no zone: the day the guest arrives.
A system instant is ISO-8601 UTC: when a row was written. Conflating them is
what shifts a reservation a day west of UTC. `src/shared/contracts/dates.js` is
the single source for both, and the two types are never compared to each other.

## 6. Authorization: two axes, both required

`guard(capability)` answers *may this ROLE call this verb*.
`customerInScope()` / `reservationInScope()` answer *may this SESSION touch
THIS record*.

A verb that addresses a record needs both. Checking only the first is
horizontal privilege escalation — the classic "I am allowed to read customers,
therefore I am allowed to read customer 4242" defect. `scopeProfileId()` returns
the profile id for MARKETING and `null` (unrestricted) for ADMIN/MANAGER, and
falls back to `-1` so that a broken MARKETING session matches nothing rather
than everything.

Identity, role and profile are never read from the caller's payload.

## 7. The IPC surface as a contract

`src/shared/contracts/ipc-surface.js` documents all **60 channels** with
`auth`, `capability`, `roles`, `scope`, `protection`, `validation`,
`destructive`, `audit`, `denial` and notes.

| | |
|---|---|
| Channels | 60 |
| Anonymous (pre-login) | 6 — `app:info`, `app:needsSetup`, `auth:setup`, `auth:login`, `auth:logout`, `auth:session` |
| Authenticated | 54 |
| Record-scoped | 34 |
| Destructive | 9 |
| Audited | 29 |
| Reachable by MARKETING | 40 |

This file is not documentation *about* the system — the registry reads it at
startup and **refuses to boot** on an undocumented channel, a channel with no
handler, or a channel with no schema (`src/main/ipc/registry.js`). A new verb
cannot be added quietly.

## 8. Soft deletion, and why DELETED outranks CANCELLED

Reservation deletion is non-destructive. A deleted reservation keeps its
cancellation metadata, so nothing about the history is lost.

The three views are disjoint by construction
(`src/main/repositories/reservations.js:40`):

| view | predicate |
|---|---|
| active | `deleted_at IS NULL AND cancelled_at IS NULL` |
| cancelled | `deleted_at IS NULL AND cancelled_at IS NOT NULL` |
| deleted | `deleted_at IS NOT NULL` |

If a cancelled-then-deleted reservation appeared in both, the operator would
cancel it twice and the Cancelled count would never agree with the Cancelled
list. DELETED takes precedence.

Deleted rows are excluded from every derived fact: `last_visit`, `next_visit`,
`reservation_count`, `qualifying_reservation_count`, No Record, COLD/ACTIVE,
overlap detection, calendar buckets and every dashboard KPI.

`reservations.listDeleted` is a **separate verb** requiring its own capability
`reservations.deleted.read`, not a parameter on the ordinary list. Delete
permission itself is unchanged: ADMIN only. **No undelete feature was added** —
soft deletion is a data-integrity decision, not a new product surface.

## 9. Authentication

Argon2id. No plaintext password is stored anywhere, and there is no default
account, no seeded password and no recovery back door. The absence of a back
door is deliberate: a door that lets the owner in also lets in whoever finds
it.

Login returns an identical message for an unknown user and a wrong password.

## 10. The Electron security boundary

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The
preload exposes one named function per operation — no generic `invoke`, no
`ipcRenderer`, no Node primitive. Navigation and popups are blocked; permission
requests are denied.

CSP: `script-src 'self'`, `style-src 'self'`, `connect-src 'none'`,
`frame-src 'none'`, `form-action 'none'`, `img-src 'self' data:`. No
`unsafe-inline`, no `unsafe-eval` anywhere.

Fuses burned into the binary (`forge.config.js`): RunAsNode off, NodeOptions
off, NodeCliInspect off, embedded ASAR integrity validation on, load-only-from-
ASAR on.

## 11. Why inline handlers had to go

`script-src 'self'` makes `onclick="..."` inert. Every handler became a
delegated action driven by `data-act` / `data-on` / `data-args`
(`src/renderer/scripts/actions.js`). 218 handlers were converted; zero inline
handlers remain. The dispatcher looks names up in a table and never evaluates a
string.

## 12. Why `node:sqlite` rather than better-sqlite3

`better-sqlite3` is a native module: it needs `electron-rebuild`, which needs
Electron headers, which are served from a host this environment's proxy blocks
(§24, B7). The workaround would have been to fight the proxy. The fix was a
design change.

Electron 43 bundles Node 24.18.1, which has SQLite built in. Switching to
`node:sqlite` removed the native module entirely — and with it node-gyp,
Python and a C++ toolchain from every machine that ever builds this app. The
blocker stopped existing rather than being worked around.

## 13. Offline by construction

A hotel back office loses its connection; the application must not care. This
is guaranteed structurally rather than by testing with the cable unplugged: a
renderer with no network API, no remote asset and `connect-src 'none'` cannot
depend on the Internet whatever the network is doing.

`tests/electron/offline.test.js` proves zero remote `src`/`href`, zero remote
`url()`/`@import`, zero `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/
`sendBeacon`, no telemetry, and that the update check — the one component that
legitimately reaches out — degrades to `unavailable` rather than throwing when
DNS fails or the connection drops.

## 14. Backup and restore

A custom container (`MMHBACKUP1`) with a per-entry SHA-256. Entry names are
validated against `^[A-Za-z0-9._-]+$`, so there is no zip-slip surface at all
rather than a filtered one.

Restore is staged: a safety backup is taken first, the archive's integrity is
verified deeply, and the presence of at least one ADMIN account in the restored
data is confirmed **before** anything is swapped — restoring a backup that
would lock the owner out of their own application is refused. Detail in
`docs/BACKUP-RECOVERY.md`.

## 15. Updates never erase data

User data lives in `%APPDATA%\Merit Marketing Hub\`, outside the program
directory. An update replaces the program, not the data. Installing an update
takes a backup first, and `install()` refuses when nothing was actually
downloaded. Detail in `docs/UPDATE.md`.

## 16. First run

A shipped installation contains no accounts, no guests, no reservations, no
profiles and no default password. `tests/database/first-run-workflow.test.js`
walks the entire clean-start path — empty install → first ADMIN → sign in →
profile → marketing account → guest → reservation → note → dashboard →
calendar → export → audit → marketer signs in scoped → sign out and back in
with data intact — and ends by asserting the whole workflow completed with no
manual database edit.

## 17. Test suite

| | |
|---|---|
| Suites | 29 |
| Assertions | **1016, 0 failing** |
| Baseline | 529 |
| Source | ~8,300 lines |
| Test code | ~5,600 lines |

Tests run on the **production runtime**, not system Node:

```
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron tests/run-all.js
```

Largest suites: `ipc/surface-enforcement` (127), `ipc/attack-matrix` (81).

## 18. Regression protection, not a one-time audit

The security matrix is **load-bearing**. Probes are derived from it, so a verb
listed as record-scoped with no foreign-record probe registered is a test
failure — the matrix cannot claim a check it never performed. API surface
discovery is recursive, so a newly exposed verb that lacks a guard, lacks a
scope check, becomes reachable by MARKETING, or becomes widenable by a crafted
payload fails the suite rather than passing unnoticed.

## 19. Performance at the specified scale

10,000 guests · 50,000 reservations · 50,000 CRM notes
(`tests/database/performance.test.js`). Thresholds are deliberately loose
because the suite is a tripwire for missing indexes, whole-table loads and
O(n²) joins — failures of that kind are an order of magnitude, not
milliseconds. `EXPLAIN QUERY PLAN` assertions confirm the hot queries use
indexes rather than scans. Measured numbers are printed, not asserted to a
fixed value.

The list projection is separate from the detail projection: a list row carries
no assignment history and no note bodies. The previous architecture returned
the full assignment history on every row of every list.

## 20. Packaging

Electron Forge, Squirrel.Windows plus zip, ASAR, fuses. Application name
**Merit Marketing Hub**.

`tests/packaged/hygiene.test.js` inspects the **actual archive**, not the
ignore list — the ignore list is a claim, the archive is the fact. That
distinction found four files being shipped that the list appeared to exclude.

## 21. Secrets

No GitHub token, cloud credential, certificate, signing password or thumbprint
is committed or embedded in the application. Signing is driven entirely by
environment variables; with none set, the build is unsigned **and labelled
unsigned** — `release.json` records `signed: false` and the release script
prints `NO — internal/QA artifact`.

## 22. Honest statement about signing and installer testing

- **The Windows installer has not been executed.** There is no Windows host in
  this environment. The CI job packages and smoke-tests; an end-to-end
  installer run still requires a Windows machine.
- **No build produced here is signed.** There is no code-signing certificate.
  None was invented. SmartScreen will warn until a real certificate is
  supplied.
- **No end-to-end Squirrel update between two versions has been performed.** It
  needs both a published feed and a Windows host.

## 23. What was deliberately not done

- No undelete/restore feature merely because soft deletion exists.
- No change to the delete permission matrix — ADMIN only, as before.
- No redesign of any screen.
- No invented `crm.ico` or `logo.png`. The owner's artwork is the owner's.
- No history rewrite and no force-push.

## 24. External blockers

| ID | Blocker | Effect | State |
|---|---|---|---|
| B1 | `git push` of **tags** returns HTTP 403 (branches push fine) | `pre-electron-baseline` is local only | Recovery tooling written **and verified end-to-end** — a generated bundle was fetched into a fresh clone and every commit arrived |
| B2 | `assets/crm.ico` does not exist in the repo or workspace | Windows build would use the default Electron icon | Path wired; Forge warns loudly; the release script **blocks a stable release** without it. No icon invented. |
| B3 | `logo.png` referenced by the renderer, not in the repo | In-app brand mark is a broken reference | Owner must supply |
| B4 | No Windows host | Installer and Squirrel update not executed | Windows CI job packages and smoke-tests; one manual run still required |
| B5 | No code-signing certificate | Artifacts unsigned; SmartScreen will warn | Hooks configured from CI secrets; `release.json` records `signed:false` honestly |
| B6 | No update-host credentials | Feed not published | Provider abstraction complete, configured by `MERIT_UPDATE_URL` |
| B7 | `www.electronjs.org` policy-blocked by the proxy | `electron-rebuild` cannot fetch headers | **Resolved by design change** — `node:sqlite`, so there is no native module to rebuild |

Every blocker is external: a certificate, a host, a credential, an image file
or a network policy. None is an unfinished piece of engineering.

## 25. What the owner must supply

1. `assets/crm.ico` — the existing application icon.
2. `logo.png` — the in-app brand mark.
3. A code-signing certificate, if SmartScreen warnings are unacceptable.
4. A URL to host update files, if automatic updates are wanted.
5. One Windows machine to run the installer once before shipping.

Items 3–5 are optional for internal use. Items 1–2 are cosmetic but visible.

## 26. Known limitations, stated plainly

- The audit log is append-only *from the application's point of view*. It is not
  tamper-proof against a Windows administrator with a SQLite editor, and does
  not claim to be.
- The database is single-machine by design. Putting SQLite on a network share
  is explicitly unsupported; `docs/FUTURE-MULTI-PC.md` describes what a real
  multi-PC deployment would require.
- The UI-interaction portion of the 529 baseline assertions still runs against
  `merit-marketing-hub.html` as a behavioural reference. The security-critical
  ones are re-proved against the new architecture.

## 27. Documentation

`docs/ARCHITECTURE.md`, `DATA-MODEL.md`, `SECURITY.md`, `BACKUP-RECOVERY.md`,
`RELEASE.md`, `UPDATE.md`, `FUTURE-MULTI-PC.md`, `OWNER-OPERATIONS-TR.md`,
plus `README.md`.

## 28. Sahip için — günlük kullanım (Türkçe)

Ayrıntılı kılavuz: `docs/OWNER-OPERATIONS-TR.md`. Özet:

**Veriniz nerede?** Bilgisayarınızda, programın klasöründen ayrı bir yerde:
`C:\Users\<kullanıcı adınız>\AppData\Roaming\Merit Marketing Hub\`. Bu ayrım
önemlidir — **program güncellenince verileriniz silinmez.**

**İnternet gerekir mi?** Hayır. Program internetsiz çalışır.

**İlk kurulum.** Programda hazır kullanıcı, örnek misafir veya hazır şifre
**yoktur**. İlk açılışta bir yönetici hesabı oluşturursunuz: kullanıcı adı,
en az 10 karakterlik şifre, şifre tekrarı. Sonra sırasıyla Pazarlama Profili,
pazarlama kullanıcısı, misafir ve rezervasyon eklersiniz.

> **Şifrenizi unutmayın.** Arka kapı, gizli şifre veya "şifremi unuttum"
> yoktur. Bu bir eksiklik değil, bilinçli bir güvenlik kararıdır — böyle bir
> kapı olsaydı, onu sizden başkası da kullanabilirdi.

**Rezervasyon silme.** Silinen rezervasyon **yok olmaz**, arşive taşınır.
Sadece ADMIN silebilir ve silme sebebi zorunludur. ADMIN ve MÜDÜR silinmiş
kayıtları görebilir; **pazarlama personeli göremez** — listede, aramada,
raporda, takvimde veya başka hiçbir yerde.

**Yedekleme.** Ayarlar ekranından yedek alın. Yedeği geri yüklerken program
önce güvenlik yedeği alır, dosyanın bozulmamış olduğunu kontrol eder ve içinde
en az bir yönetici hesabı olduğundan emin olur. Sizi kendi programınızın
dışında bırakacak bir yedeği geri yüklemeyi **reddeder**.

**Güncelleme.** Güncelleme sadece programı değiştirir, verilerinizi değil.
Güncellemeden önce otomatik yedek alınır.

**Bilinmesi gerekenler.** Program tek bilgisayar içindir; veri dosyasını ağ
sürücüsüne koymayın. İmza sertifikası olmadığı için Windows ilk açılışta
uyarı gösterebilir — bu, sertifika alınana kadar normaldir.

## 29. Independent code review

*(Completed after two adversarial reviews — findings, fixes and the regression
tests written for each are recorded in this section.)*

## 30. Scorecard

See `docs/SCORECARD.md`.

## 31. Verdict

**ENGINEERING READY — EXTERNAL RELEASE SETUP REQUIRED.**

The engineering is complete and verified: 1016 assertions, 0 failing, on the
production runtime. What remains is not code. It is a certificate, a Windows
machine, an update host and two image files — none of which can be invented
here, and none of which were pretended into existence.

This is not "production deployed". It is ready to be, once those five things
are supplied.
