# Merit Marketing Hub — Electron / SQLite Migration: Final Report

**Status:** SOURCE ENGINEERING READY — INTERNAL WINDOWS BUILD / INSTALL VALIDATION REQUIRED
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

### Business dates versus system instants

A business date is `TEXT 'YYYY-MM-DD'` with no zone: the day the guest arrives.
A system instant is ISO-8601 UTC: when a row was written. Conflating them shifts
a reservation a day west of UTC. `src/shared/contracts/dates.js` is the single
source for both, and the two types are never compared to each other.

The independent review found the one place this had leaked: an assignment's UTC
`changed_at` was sliced to make a business date, which put every decision made
between midnight and 03:00 in Turkey on the previous day and expired guest
protection a day early. `instantToBusinessDate` existed and was called nowhere.

## 5. Authorization: two axes, both required

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

## 6. The IPC surface as a contract

`src/shared/contracts/ipc-surface.js` documents all **62 channels** with
`auth`, `capability`, `roles`, `scope`, `protection`, `validation`,
`destructive`, `audit`, `denial` and notes.

| | |
|---|---|
| Channels | 62 |
| Anonymous (pre-login) | 6 — `app:info`, `app:needsSetup`, `auth:setup`, `auth:login`, `auth:logout`, `auth:session` |
| Authenticated | 56 |
| Record-scoped | 34 |
| Destructive | 9 |
| Audited | 31 |
| Reachable by MARKETING | 41 |

This file is not documentation *about* the system — the registry reads it at
startup and **refuses to boot** on an undocumented channel, a channel with no
handler, or a channel with no schema (`src/main/ipc/registry.js`). A new verb
cannot be added quietly.

## 7. Soft deletion, and why DELETED outranks CANCELLED

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
`reservations.deleted.read`, not a parameter on the ordinary list. Reservation
History exposes it as a third tab — Reservations | Cancelled | Deleted — shown
only to ADMIN and MANAGER, removed from the DOM for MARKETING, and refused by
the boundary regardless of what the client does. That tab did not exist until
the final correction pass: the verb and all of its tests were complete while the
screen still drew only two tabs, so the feature was unreachable by the only
people permitted to use it. Delete
permission itself is unchanged: ADMIN only. **No undelete feature was added** —
soft deletion is a data-integrity decision, not a new product surface.

## 8. Authentication

Argon2id. No plaintext password is stored anywhere, and there is no default
account, no seeded password and no recovery back door. The absence of a back
door is deliberate: a door that lets the owner in also lets in whoever finds
it.

Login returns an identical message for an unknown user and a wrong password.

## 9. The Electron security boundary

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

## 10. Why inline handlers had to go

`script-src 'self'` makes `onclick="..."` inert. Every handler became a
delegated action driven by `data-act` / `data-on` / `data-args`, or by the
event-scoped `data-act-<event>` form where one element needs two behaviours
(`src/renderer/scripts/actions.js`). 218 handlers were converted.

**This section previously claimed "zero inline handlers remain" and "the
dispatcher never evaluates a string." Both were false when written, and the
tests backing them could not have discovered it.**

- `onmouseenter` and `onmouseleave` were still on the CRM submenu and on every
  Finder row. The assertion named *"no inline event handler of any kind
  survives"* used the selector `[onclick],[onchange],[oninput],[onkeydown]`,
  which cannot match them. Being inert under CSP, those hover behaviours simply
  did not work.
- The Command Palette executed its commands with `eval(item.run)`, falling back
  to `Function(item.run)()`. Nothing tested for a code evaluator in the renderer
  at all.

Both are fixed, and both are now covered by
`tests/ui/renderer-source-safety.test.js`, which is deliberately written as
exhaustive patterns rather than a list of things to look for: any attribute
matching `on*=`, any construct that turns a string into code, any action
attribute repeated inside one start tag. The gate was verified by reintroducing
each defect and confirming it goes red — a gate nobody has watched fail is not
yet evidence of anything.

Hover is delegated through bubbling `mouseover`/`mouseout` filtered back to
enter/leave semantics via `relatedTarget`, because `mouseenter` does not bubble
and cannot be delegated from the document directly. The dispatcher resolves
names in a table and additionally refuses any resolved value that is native
code, so `data-act="eval"` cannot reach `window.eval`.

## 11. Why `node:sqlite` rather than better-sqlite3

`better-sqlite3` is a native module: it needs `electron-rebuild`, which needs
Electron headers, which are served from a host this environment's proxy blocks
(§24, B7). The workaround would have been to fight the proxy. The fix was a
design change.

Electron 43 bundles Node 24.18.1, which has SQLite built in. Switching to
`node:sqlite` removed the native module entirely — and with it node-gyp,
Python and a C++ toolchain from every machine that ever builds this app. The
blocker stopped existing rather than being worked around.

## 12. Offline by construction

A hotel back office loses its connection; the application must not care. This
is guaranteed structurally rather than by testing with the cable unplugged: a
renderer with no network API, no remote asset and `connect-src 'none'` cannot
depend on the Internet whatever the network is doing.

`tests/electron/offline.test.js` proves zero remote `src`/`href`, zero remote
`url()`/`@import`, zero `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/
`sendBeacon`, no telemetry, and that the update check — the one component that
legitimately reaches out — degrades to `unavailable` rather than throwing when
DNS fails or the connection drops.

## 13. Backup and restore

A custom container (`MMHBACKUP1`) with a per-entry SHA-256. Entry names are
validated against `^[A-Za-z0-9._-]+$`, so there is no zip-slip surface at all
rather than a filtered one.

Restore is staged: a safety backup is taken first, the archive's integrity is
verified deeply, and the presence of at least one ADMIN account in the restored
data is confirmed **before** anything is swapped — restoring a backup that
would lock the owner out of their own application is refused. Detail in
`docs/BACKUP-RECOVERY.md`.

## 14. Updates never erase data

User data lives in `%APPDATA%\Merit Marketing Hub\`, outside the program
directory. An update replaces the program, not the data. Installing an update
takes a backup first, and `install()` refuses when nothing was actually
downloaded. Detail in `docs/UPDATE.md`.

## 15. First run

A shipped installation contains no accounts, no guests, no reservations, no
profiles and no default password. `tests/database/first-run-workflow.test.js`
walks the entire clean-start path — empty install → first ADMIN → sign in →
profile → marketing account → guest → reservation → note → dashboard →
calendar → export → audit → marketer signs in scoped → sign out and back in
with data intact — and ends by asserting the whole workflow completed with no
manual database edit.

## 16. Notifications

Four producers, restored after the independent review found the feature complete
and inert — the table, its index, five channels and all the scope logic had been
carried across, and every producer left behind.

| Kind | Trigger | Storage |
|---|---|---|
| Manager activity feed | Any audited action in the feed set | Written when it happens |
| Guest assigned | `customers:assign` | Written when it happens |
| Cold guest | The guest's status is COLD | Recomputed on read |
| Check-in soon / urgent | An arrival within 7 days / 24 hours | Recomputed on read |

The split matters. An event happened once at a known moment. A standing
condition changes on its own as the calendar moves, so a row written yesterday
would go on being true after it stopped being true. Derived rows are reconciled —
one row per live condition, inserted when it starts and deleted when it lifts —
which is what stops a marketer opening the panel on Monday to forty copies of the
same cold guest, and stops a reminder outliving the booking it was about.

The feed hangs off the audit sink rather than off each verb, so a new verb joins
the feed the moment it becomes auditable. `src/main/services/audit-sink.js` is
the single sink, used by the application and by the test harness — the harness
having its own copy is precisely why the missing producers went unnoticed.

## 17. Test suite

| | |
|---|---|
| Suites | 34 |
| Assertions | **1240, 0 failing** |
| Baseline | 529 |
| Source | ~9,000 lines |
| Test code | ~6,700 lines |

Tests run on the **production runtime**, not system Node:

```
npm test            # scripts/run-tests.js — Electron's binary, ELECTRON_RUN_AS_NODE=1
```

The launcher exists because the environment assignment above is POSIX shell
syntax that cmd.exe rejects, and because the binary is `electron.exe` on
Windows. Same command on all three platforms.

Largest suites: `ipc/surface-enforcement` (127), `ipc/attack-matrix` (81),
`database/review-findings` (50), `electron/workflow` (39).

## 18. Regression protection, not a one-time audit

The security matrix is **load-bearing**. Probes are derived from it, so a verb
listed as record-scoped with no foreign-record probe registered is a test
failure — the matrix cannot claim a check it never performed. API surface
discovery is recursive, so a newly exposed verb that lacks a guard, lacks a
scope check, becomes reachable by MARKETING, or becomes widenable by a crafted
payload fails the suite rather than passing unnoticed.

## 19. Performance at the specified scale

10,000 guests · 50,000 reservations · 50,000 CRM notes
(`tests/database/performance.test.js`). Measured on this machine:

| Operation | Measured | Budget |
|---|---|---|
| Customer list (page of 25 from 10,000) | 5 ms | 800 |
| Customer search | 5 ms | 800 |
| Customer detail | 1 ms | 200 |
| Reservation list | 28 ms | 800 |
| Dashboard (all KPIs) | 219 ms | 2000 |
| Calendar month | 17 ms | 800 |
| Guest finder | 4 ms | 500 |
| Scoped list (MARKETING) | 3 ms | 800 |

Thresholds are deliberately loose
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
distinction found four files the list appeared to exclude, and later 146
vendored `.test.ts` files the root-anchored rules never reached. The archive is
now **698 entries**, down from 1104: no tests, no prototype HTML, no `.git`, no
`.env`, no source maps, no database, no docs, no recovery bundles.

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
| B6 | No update-host credentials | Feed not published | Provider abstraction complete; `MERIT_UPDATE_URL` must be HTTPS or it is refused and logged |
| B8 | The downloaded installer is **not signature-verified** | Whoever controlled a feed would get code execution on every installation | `electron-updater` skips its check without an electron-builder `app-update.yml`, which forge does not produce. Needs B5 plus the publisher name wired through. **Updates stay off until this is resolved.** |
| B9 | Squirrel.Windows maker vs `electron-updater`'s NSIS path | The update flow cannot work as configured | Decide maker-or-client before publishing a feed. Documented rather than papered over. |
| B7 | `www.electronjs.org` policy-blocked by the proxy | `electron-rebuild` cannot fetch headers | **Resolved by design change** — `node:sqlite`, so there is no native module to rebuild |

B1–B7 are external: a certificate, a host, a credential, an image file or a
network policy. **B8 and B9 are not** — they are decisions that have to be made
about the update path before it can be trusted, and pretending otherwise is
exactly the kind of claim this report exists to avoid. Automatic updates are
off, and `docs/UPDATE.md` opens by saying why.

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

**Bildirimler.** Zil simgesi çalışır: müdür hareketleri görür, pazarlama
personeli kendisine atanan misafiri, soğuyan misafirlerini ve yaklaşan
girişlerini görür. Yaklaşan giriş uyarısı, rezervasyon iptal edilirse kendi
kendine kaybolur — olmayan bir giriş için hatırlatma, hiç hatırlatma olmamasından
kötüdür.

**Güncelleme — şu anda KAPALIDIR.** Program güncellendiğinde verileriniz
silinmez ve güncellemeden önce otomatik yedek alınır; bu kısım hazırdır. Ancak
otomatik güncelleme **henüz açılmamalıdır**: indirilen kurulum dosyasının
imzası doğrulanmıyor. Yani güncelleme sunucusunu ele geçiren biri, bilgisayarınıza
istediği programı kurdurabilirdi. Bu çözülene kadar güncellemeler kapalıdır ve
yeni sürümler elden kurulur. Bu bir eksiklik değil, bilerek verilmiş bir karardır
— çalışmayan bir kilidi takmaktansa kapıyı kapalı tutmak gerekir.

**Bilinmesi gerekenler.**
- Program **tek bilgisayar** içindir; veri dosyasını ağ sürücüsüne koymayın.
- İmza sertifikası olmadığı için Windows ilk açılışta uyarı gösterebilir — bu,
  sertifika alınana kadar normaldir.
- Kurulum dosyası (installer) **henüz hiç çalıştırılmadı**; elimizde Windows
  bilgisayar yok. İlk kurulumu bir Windows makinesinde bir kez denemek gerekir.
- Program simgesi (`crm.ico`) ve logo (`logo.png`) sizden beklenmektedir. Sizin
  görselinizin yerine yapay bir simge konulmadı.

## 29. Independent code review

Two adversarial reviews were commissioned, deliberately split so neither ran out
of budget mid-audit: one on backend and data, one on the Electron boundary and
release. Both were told to attack, not to approve, and to prove findings by
running code rather than by reading it. Between them they confirmed **28
defects**. Every one is fixed, and every one has a regression test that was red
first.

### The finding that matters most

**The application did not work, and 1016 assertions could not see it.**

Every service suite called the services directly. Every IPC suite built payloads
by hand. Every UI suite drove the *original prototype HTML*. Nothing anywhere
asked the question that decides whether the product functions: does the migrated
renderer send payloads the migrated boundary accepts?

It did not.

- `auth:setup` omitted `passwordConfirm`, so a fresh installation could never
  create its administrator. A clean install was a brick.
- `bridge.js` assigned `window.api`, which `contextBridge` defines
  **non-writable**. In strict mode that throws on the file's first statement, so
  the entire adapter layer died — taking every destructive-action confirmation
  dialog, every export, photo import, and the session-expiry subscription with it.
- The guest and reservation lists sent `status:''` and a field name the surface
  does not have, so both screens failed validation and rendered nothing at all.
- Under `style-src 'self'` a style attribute written in markup is inert, so the
  sign-in card and the setup card rendered on top of each other, and every
  element hidden only that way was permanently visible.

Each is a one-word fix. All of them shipped. That is not a testing gap at the
margin; it is the difference between a test suite that measures the product and
one that measures the parts of the product that were convenient to reach.

`tests/electron/workflow.test.js` now starts the real binary, drives the real
first-run form, and checks the payload each screen actually builds against the
schema that actually receives it.

### Data integrity

| Finding | Why it mattered |
|---|---|
| `update` and `cancel` checked lifecycle before scope | Four distinguishable refusals let a marketer classify every row in the table — including other marketers' — from the error message alone |
| Derived ownership outlived the booking that derived it | A guest stayed assigned with nothing left in the database to explain why; the profile card's guest count and reservation count stopped agreeing about the same person |
| Soft delete was complete for reservations, absent for customers | An archived guest's name, ID and dates went on being rendered by the reservation list, both calendar views and the CSV, while `customers:get` answered NOT_FOUND for the id those rows carried |
| The stay list under the inspector was scoped by inviter | The panel said three stays, the list under it showed one |
| `profiles:get`/`list` masked metrics, then returned `SELECT p.*` | Every marketer received a colleague's passport number, phone, email, and the free-text field where management records an employment warning |
| The migrator's `foreign_key_check` ran after the commit | A migration that left an orphan row was committed, recorded as applied, and reported with "Your data has not been changed" |
| A UTC instant was sliced to make a business date | Every assignment made between midnight and 03:00 in Turkey landed on the previous day, expiring guest protection a day early |
| An archived Guest ID stayed claimed forever | Re-entry surfaced as a raw UNIQUE failure: "An unexpected error occurred", no field named, nothing to act on |
| `photos:remove` checked the capability, never the record | |
| Booking conflicts disclosed a foreign stay's id and dates | The record `reservations:list` deliberately hides |

The inspector's own counts were **not** changed: the prototype's helper is
unscoped too, so covering the guest's whole history is verified baseline
behaviour, and owning a guest is exactly what entitles a marketer to know when
that guest last came. The list widened to match, rather than the counts
narrowing to match the list.

### Boundary and release

| Finding | Why it mattered |
|---|---|
| `backup:restore` joined a caller-supplied name onto the backups directory | `../Downloads/planted.mmhbackup` restored an attacker's archive over the live database — users table included. `safeJoin` is what every other path in the app already used |
| The backup reader capped the compressed file, not its expansion | A ~10 MB archive could exhaust the main process during `inspect`, before the operator confirmed anything |
| `updates:install` performed no capability check at all | Its pre-update backup runs as `system: true`, which is exempt, so nothing downstream caught it either |
| `autoInstallOnAppQuit` was on | electron-updater would install silently on quit, bypassing the pre-update backup and its audit row entirely |
| Two `data-act`/`data-on`/`data-args` triples on one row | HTML keeps the first and drops the rest: double-click-to-edit was dead on three tables, Enter-to-open on two more |
| The action dispatcher fell back to `window[name]` | `eval` is a global |
| `idLike` transformed its string branch without re-validating | `"0"` and a 21-digit string passed a check for a positive integer |
| The backup list read `created_at`/`size` from a service returning `createdAt`/`byteSize` | "Invalid Date · NaN KB" |
| The pre-migration snapshot was a raw file copy | In WAL mode the committed work can live entirely in the sidecar — and this is the snapshot taken *after an unclean shutdown*. Its manifest also described an empty archive while the archive contained a database |
| `GrantFileProtocolExtraPrivileges` was left at its default | The whole UI is a `file://` document |
| `recover-push.js` built shell strings from git refs | A hostile branch name in a cloned repo ran as a command on the maintainer's machine |
| The nested `node_modules/**/tests` were not covered by the ignore list | 146 `.test.ts` files shipped; the archive is now 698 entries instead of 1104 |

### Two things the reviews found that were worse than bugs

**The manager notification feature was complete and inert.** The table, its
index, five IPC channels and all of the scope logic were carried across; every
producer was left behind. Nothing ever wrote a row, and no test noticed because
every notification test asserted on how notifications are *read*. All four
producers from the baseline are restored, and the first assertion in the new
suite is the one that was missing: does anything write?

The root cause was structural. The activity feed hangs off the audit sink, and
the test harness had its **own copy** of that sink — so the tests exercised a
code path the application does not run. There is now one sink,
`src/main/services/audit-sink.js`, used by both.

**The security matrix a reviewer reads described the prototype.** The generated
document opens with "Every operation exposed on `window.api` in
`merit-marketing-hub.html`", and the CI gate compared it to the prototype's
matrix — so it passed, every run, while documenting the wrong artifact. Sixty-odd
of its rows name verbs the IPC surface does not have. A gate that can only tell
you whether two copies of the wrong thing match is worse than no gate, because
it produces confidence. `docs/IPC-SECURITY-SURFACE.md` is now generated from the
shipping contract, checked by its own suite, and the prototype document says what
it is in its title.

### Assertions that could not fail

Four were found and replaced with assertions that can:

- `packaged/hygiene` passed vacuously whenever nothing had been packaged — which
  is every clean CI checkout. The one gate against shipping demo credentials or
  a developer's database was green precisely when it had inspected nothing. It
  now fails, and CI and the release script package first.
- `first-run-workflow` asserted "no manual database edit" as a literal `true`.
  It now checks it: every live row must have an audit trail behind it.
- `performance` asserted a report string as `true`. It now asserts that every
  budgeted operation actually produced a measurement.
- The shared harness asserted "no console errors" in suites that never opened a
  page, adding a guaranteed pass to every database and IPC suite.

## 30. Scorecard

See [`docs/SCORECARD.md`](SCORECARD.md). Twelve of fourteen dimensions score 8
or above. Two do not, and they are the same story told twice: **updates (5/10)**
and **release readiness (6/10)**. Everything the application does on the machine
it is installed on is finished and tested; everything about getting it onto that
machine and keeping it current needs a certificate, a Windows host and a
decision about the update client.

## 31. Verdict

**ENGINEERING READY — EXTERNAL RELEASE SETUP REQUIRED.**

The engineering is complete and verified: **1353 assertions across 38 suites, 0
failing**, on the production runtime, including a suite that starts the real
binary and drives the real forms — setup, guest, profile, user, reservation,
cancel, delete, reports, settings — then restarts the application and checks
that every one of those records survived.

That last clause is the honest lesson of this migration. Until the independent
reviews ran, this report would have said "1016 assertions, 0 failing" about an
application that could not create its first administrator, whose two main
screens rendered nothing, and whose entire adapter layer died on load. Every one
of those was a one-word fix. None of them was hard to find once something
actually looked. A test count is a measure of how much was checked, never a
measure of whether the product works — and the difference between those two
things is the whole reason an independent review is a phase and not a courtesy.

What remains is not code. It is a code-signing certificate, a Windows machine,
an update host, a decision about the update client, and two image files. None of
those can be invented here, and none was pretended into existence:

- **No build produced here is signed.** There is no certificate.
- **No Windows installer has been executed.** There is no Windows host.
- **Automatic updates must stay off** until the downloaded installer is
  signature-verified (B8) and the maker and update client are reconciled (B9).

This is not "production deployed". It is ready to be, once those things are
supplied.


## 32. The source-closure pass — what a third inspection found

The two adversarial reviews checked the architecture, the boundary and the SQL.
They were right about all of it. What none of them checked, and what 1240
assertions could not see, was whether **pressing the buttons works** — because
every test called `window.api.customers.create(...)` directly.

Thirteen defects lived in that gap. The representative one: the renderer read
every guest and profile photo as `photo_path`, a field that exists in no table,
no query and no service, in twenty-five places. Every avatar in the product was
blank and nothing failed, because reading an absent property is not an error.

Three of them were not merely broken but actively misleading, which is worse:

- **Crop** cropped on a canvas, called a `photos.save` that always returned
  VALIDATION, silently kept the ORIGINAL photo's name and cached the cropped
  image in memory. It looked applied until the next launch.
- **Automatic Backup** saved its preference and never made a backup. The
  operator would have found out on the day they needed one.
- **The archive dialog** promised the guest's reservations would be removed and
  that it could not be undone. The backend does a soft archive and keeps every
  one of them.

Two claims elsewhere in this repository were made true rather than restated:
`MERIT_UPDATE_URL` was still enough to arm the updater that documentation called
disabled, and a stable release with no certificate warned and continued to a
successful exit.

The lesson is the one this migration keeps re-learning in a new costume: a test
that bypasses the layer where the defect lives cannot find the defect, and a
count of passing assertions is not evidence about the part of the system nobody
pointed a test at. `tests/electron/golden-path.test.js` is the correction —
first-run through the setup form, save through every real Save button, restart,
and check it all survived.

## 33. Source closure — the state this repository is in

The last source pass ended with the golden path actually running. That matters
more than the number it produced, because for three attempts it produced
nothing at all and the reason was not a hang: the generated probe contained an
invalid nested template literal, so Electron exited during parse, before any
output. Silence and a timeout are indistinguishable from the outside, which is
why the suite now parses every script it generates before spawning and reports
the syntax error at the line that caused it. Two lessons in one defect — an
absent result is not a slow result, and a harness that cannot say why it failed
will be re-run instead of read.

What the golden path proves, by pressing the buttons rather than calling the
services (45 assertions):

| | |
|---|---|
| First run | The setup **form** creates the first administrator |
| Every editor | Profile, guest, guest edit, user, reservation save through their own Save buttons and the modal closes |
| Lifecycle | Cancel moves a booking to Cancelled; delete without a reason is refused by the form; delete with a reason moves it to Deleted, where the row offers no actions |
| Reports | All five report types run on default filters with no validation refusal |
| Contract | **No strict-schema refusal occurred anywhere in the flow**, and the renderer logged no errors |
| Injection | A hostile guest name creates no element, injects no script, survives no `svg onload`, executes no handler, and is displayed as text |
| Restart | Second launch does not ask for setup again, the administrator signs in through the **login form**, and the edited guest, the profile, the user, the cancelled booking and the deleted booking are all still there |
| Backup | The preference persisted **and automatic backups were actually created** |
| Updates | A configured feed does not enable checking in v1, and installing is refused |

Two things were corrected in this pass and are worth recording because both
were tests that had stopped describing the product:

- `tests/electron/offline.test.js` still drove the updater through `build`,
  which in v1 returns the disabled stub. It crashed rather than failed, and
  behind the crash sat four assertions describing behaviour that no longer
  shipped. It now tests both questions separately: what v1 does (refuses
  everything, attaches no listener, and disarms the updater object it is
  handed) and what the updater must still do when B8 and B9 are resolved.
- `docs/IPC-SECURITY-SURFACE.md` described 60 channels. There are 62;
  `photos:crop` and `app:openDataFolder` were missing. The freshness gate
  caught it, which is what it is for.

### What is true, and what is still not

Verified here:

- 1353 assertions, 38 suites, 0 failing, on Electron's Node.
- `npm run package` completes on this host.
- The packaged output contains no test file and no legacy prototype.

Not verified here, and not claimed:

- **No Windows build has been produced.** No installer has been executed. No
  Windows machine was involved at any point.
- **Nothing is signed.** There is no certificate.
- **`scripts/Release-Merit.ps1` has never been executed or syntax-checked** —
  there is no PowerShell in this container.
- `assets/crm.ico` and `src/renderer/logo.png` are absent. **OWNER ASSET
  REQUIRED.** No placeholder was generated; the release script blocks a stable
  build without them.

The correct next step is an **internal** Windows build, followed by a real
installation on a real Windows machine. Nothing in the source is waiting on
anything else.
