# Merit Marketing Hub — test suite

Every test drives the **real application** in a **real browser**. There are no mocks:
the file under test is the same `merit-marketing-hub.html` that ships, and the
`window.api` object the tests call is the same one the UI calls.

That is deliberate. The whole claim this suite exists to defend is that authorization
and business rules live in the handler layer, not in the screens. A test that stubbed
the handlers would prove exactly nothing about that.

## Running from a clean checkout

```bash
git clone <repo> && cd meritmarketing
npm install          # installs playwright
npm run browser      # downloads chromium (one time)
npm test             # runs everything
```

`npm install` is only needed for Playwright. The application itself has no build step
and no runtime dependencies — it is one HTML file opened over `file://`.

### If Chromium is already provisioned

In a preconfigured image (CI, container) where Playwright and Chromium already exist
system-wide, skip both install steps and run the suite directly:

```bash
node tests/run-all.js
```

The harness resolves Playwright from the local `node_modules` first, then from the
usual system-wide locations, and resolves Chromium from `CHROMIUM_PATH`, then
`PLAYWRIGHT_BROWSERS_PATH`, then Playwright's own download. Override either explicitly
when needed:

```bash
CHROMIUM_PATH=/path/to/chrome node tests/run-all.js
```

## Commands

| Command | Runs |
|---|---|
| `npm test` | Everything. |
| `npm run test:verbose` | Everything, printing each passing assertion by name. |
| `npm run test:security` | `api-surface/`, `authorization/`, `regression/`. |
| `npm run test:business` | `business/`, `integrity/`. |
| `npm run test:ui` | `ui/`. |
| `node tests/run-all.js <filter>…` | Only suites whose path contains a filter. |

Filters are plain substrings, so all of these work:

```bash
node tests/run-all.js authorization           # a directory
node tests/run-all.js guest-protection        # one suite
node tests/run-all.js kpi no-record           # several
node tests/run-all.js ui --verbose            # with per-assertion output
```

The runner exits non-zero if any assertion fails, so it drops straight into CI.

## Layout

| Directory | What lives there |
|---|---|
| `api-surface/` | The authoritative security contract for every `window.api` verb, plus the test that enforces it against the running app. |
| `authorization/` | Role boundaries, privilege escalation, IDOR, and bulk read-path leakage. Also **legitimate** access — a boundary that blocks everything is broken, not secure. |
| `business/` | The rules the product is *for*: guest protection, No Record, and the three product decisions. |
| `integrity/` | Cross-screen agreement. Every displayed number is checked against the dataset a user would get by clicking through. |
| `regression/` | One test per defect ever found, named after the finding that found it. |
| `ui/` | Controls, per-role screen rendering, hostile-input rendering, responsive layout, appearance. |
| `lib/` | The shared harness. |

## The harness

`lib/harness.js` exports a `Suite` class. A suite is a module exporting one async
function:

```js
const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('business/my-rule');
  await s.open();          // launch browser, load the app
  await s.bootstrap();     // first-run setup: creates admin, seeds the demo book
  const ids = await s.seedMarketingUser();

  await s.loginSena();
  s.denied('another marketer cannot read this guest',
    await s.api('customers', 'get', { id: ids.foreign }), 'FORBIDDEN');

  await s.close();
  return s.finish();       // folds in the console/page-error check
};
```

Useful members:

| Member | Purpose |
|---|---|
| `s.check(name, cond, detail)` | One assertion. `detail` is printed only on failure. |
| `s.denied(name, envelope, code)` | Assert an API envelope was refused with a specific code. |
| `s.api(ns, method, payload)` | Raw call, returns the full `{ ok, data, error }` envelope. |
| `s.exportCsv(entity, params)` | Run an export and return the **CSV bytes actually written** — see below. |
| `s.makeGuest(spec)` | Build a guest with controlled history (visit age, cancellation, note, owner). |
| `s.loginAdmin/loginManager/loginKerem/loginSena()` | Switch session. |
| `s.errors` | Console and page errors collected so far. |

`finish()` asserts `s.errors` is empty, so every suite checks that automatically.

### Why `exportCsv` exists

`export.filtered` returns `{ name, rows }` — a *row count*. The guest data leaves the
application inside the Blob handed to `URL.createObjectURL`. An assertion written
against the returned envelope therefore passes no matter how badly the export leaks,
because the envelope never contained guest names in the first place.

`s.exportCsv()` intercepts the object URL and returns the real payload. Always use it
for export assertions.

## Accounts

`bootstrap()` runs first-run setup and seeds the demo book.

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | ADMIN — created by `bootstrap()` |
| `manager` | `manager1` | MANAGER — seeded |
| `kerem` | `kerem1` | MARKETING — seeded |
| `sena` | `sena123` | MARKETING — **created by `seedMarketingUser()`** |

The demo seed ships only one MARKETING account. Cross-marketer tests need two, so
`seedMarketingUser()` creates `sena` and returns the profile ids
(`senaId`, `keremId`, `aleynaId`, `okanId`) the fixtures need.

## Conventions

**Assert the mechanism, not the symptom.** `reservations.create` refusing a protected
guest is the rule; the button being disabled is not.

**Prove the check is not vacuous.** A scope test that passes because every result was
empty proves nothing. Where a suite asserts "X is absent", it also asserts the caller's
*own* data is present.

**Name a regression after its finding.** `regression/security-review-findings.test.js`
uses the review's vocabulary (`C1`, `I3`, …) so a future failure is reported in the same
terms the original defect was.

**Never amend a test to match a bug.** If a suite fails after a change, the first
question is whether the behaviour or the expectation is wrong. Editing an assertion to
encode a vulnerability as expected behaviour has happened here before and is the single
most expensive mistake available in this directory.

## Isolation

Each suite launches its own browser with a fresh context, so `localStorage` — the entire
database — starts empty and is seeded from scratch. Suites cannot see each other's data
and can be run in any order or individually.

They run sequentially rather than in parallel: the whole suite takes about a hundred
seconds, and serial execution keeps failure output readable.
