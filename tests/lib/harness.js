'use strict';
/* Shared test harness for Merit Marketing Hub.
 *
 * Every suite drives the REAL application in a real browser. There are no
 * mocks: the app under test is the same single HTML file that ships, and the
 * `window.api` object the tests call is the same one the UI calls. That is
 * deliberate — the whole point of this suite is that authorization lives in
 * the handler layer, so a test that stubbed the handlers would prove nothing.
 */

const path = require('path');
const fs = require('fs');

const APP_PATH = path.resolve(__dirname, '..', '..', 'merit-marketing-hub.html');
const APP_URL = 'file://' + APP_PATH;

/* Playwright may come from a normal `npm install` in the repo, or from a
   system-wide install in a preconfigured environment. Try both so the suite
   runs from a clean checkout and in CI images alike. */
function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next */ }
  }
  throw new Error(
    'Playwright not found. Run `npm install` in the repository root, ' +
    'or set PLAYWRIGHT_ROOT to an existing installation.'
  );
}

/* Chromium likewise: prefer whatever Playwright resolves itself, fall back to
   a pinned browser directory when one is provided by the environment. */
function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(root)) {
    const direct = path.join(root, 'chromium');
    if (fs.existsSync(direct)) return direct;
    const versioned = fs.readdirSync(root)
      .filter(d => d.startsWith('chromium'))
      .map(d => path.join(root, d, 'chrome-linux', 'chrome'))
      .filter(p => fs.existsSync(p));
    if (versioned.length) return versioned.sort().pop();
  }
  return undefined; // let Playwright use its own download
}

const ADMIN = { username: 'admin', password: 'admin123' };

class Suite {
  constructor(name) {
    this.name = name;
    this.results = [];
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  check(name, condition, detail) {
    if (condition) { this.passed++; this.results.push({ ok: true, name }); }
    else { this.failed++; this.results.push({ ok: false, name, detail: detail === undefined ? '' : String(detail) }); }
  }

  /** Assert a raw API envelope was denied with a specific error code. */
  denied(name, envelope, expectedCode) {
    const code = envelope && envelope.ok === false ? envelope.error.code : 'ALLOWED';
    this.check(name, code === expectedCode, `got ${code}`);
  }

  async open({ width = 1600, height = 950 } = {}) {
    const { chromium } = loadPlaywright();
    this.browser = await chromium.launch({ executablePath: chromiumExecutable() });
    this.context = await this.browser.newContext({ viewport: { width, height } });
    this.page = await this.context.newPage();
    this.page.on('pageerror', e => this.errors.push('PAGEERROR: ' + e.message));
    this.page.on('console', m => {
      if (m.type() === 'error' && !m.text().includes('ERR_FILE_NOT_FOUND')) {
        this.errors.push('CONSOLE: ' + m.text());
      }
    });
    await this.page.goto(APP_URL);
    await this.page.waitForTimeout(300);
    return this.page;
  }

  /** First-run setup creates the admin account and seeds the demo book. */
  async bootstrap() {
    await this.page.evaluate(async (a) => {
      document.getElementById('setupName').value = 'Admin User';
      document.getElementById('setupUser').value = a.username;
      document.getElementById('setupPass').value = a.password;
      document.getElementById('setupPass2').value = a.password;
      await window.doSetup();
    }, ADMIN);
    await this.page.waitForTimeout(600);
  }

  async login(username, password) {
    await this.page.evaluate(() => window.doLogout());
    await this.page.waitForTimeout(250);
    await this.page.evaluate(([u, p]) => {
      document.getElementById('loginUser').value = u;
      document.getElementById('loginPass').value = p;
    }, [username, password]);
    await this.page.evaluate(() => window.doLogin());
    await this.page.waitForTimeout(450);
  }

  loginAdmin() { return this.login(ADMIN.username, ADMIN.password); }

  /** Seeded demo accounts. `sena` is created by seedMarketingUser(). */
  loginManager() { return this.login('manager', 'manager1'); }
  loginKerem() { return this.login('kerem', 'kerem1'); }
  loginSena() { return this.login('sena', 'sena123'); }

  /** Creates a second MARKETING login so cross-marketer tests are possible.
   *  The demo seed ships only one MARKETING account (kerem). */
  async seedMarketingUser() {
    return this.page.evaluate(async () => {
      const profs = (await window.api.profiles.list({ includeStaff: true })).data;
      const sena = profs.find(p => p.full_name === 'SENA NUR AKMUT');
      const kerem = profs.find(p => p.full_name === 'KEREM SARICICEK');
      const aleyna = profs.find(p => p.full_name === 'ALEYNA DACIC');
      const okan = profs.find(p => p.full_name === 'OKAN CAPAR');
      await window.api.users.create({
        username: 'sena', password: 'sena123', role: 'MARKETING',
        profileId: sena.id, active: true,
      });
      return { senaId: sena.id, keremId: kerem.id, aleynaId: aleyna.id, okanId: okan.id };
    });
  }

  /** Build a guest with a controlled history. Runs as whoever is signed in. */
  makeGuest(spec) {
    return this.page.evaluate(async (s) => {
      const created = await window.api.customers.create({
        code: s.code, fullName: s.name,
        registered: s.registered !== false,
        phone: s.phone || null, passportNo: s.passport || null,
        marketingProfileId: s.createOwner || undefined,
      });
      if (!created.ok) return { error: created.error };
      const id = created.data.id;
      if (s.visitMonthsAgo !== undefined) {
        const d = new Date();
        d.setUTCMonth(d.getUTCMonth() - s.visitMonthsAgo);
        const ci = d.toISOString().slice(0, 10);
        const co = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);
        const r = await window.api.reservations.create({
          customerId: id, checkIn: ci, checkOut: co, invitedByProfileId: s.invitedBy || undefined,
        });
        if (r.ok && s.cancel) await window.api.reservations.cancel({ id: r.data.id, reason: 'Duplicate' });
      }
      if (s.futureVisit) {
        const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + 1);
        const ci = d.toISOString().slice(0, 10);
        const co = new Date(d.getTime() + 2 * 86400000).toISOString().slice(0, 10);
        await window.api.reservations.create({
          customerId: id, checkIn: ci, checkOut: co, invitedByProfileId: s.invitedBy || undefined,
        });
      }
      if (s.note) await window.api.crmNotes.create({ customerId: id, note: s.note });
      if (s.assignTo) await window.api.customers.assign({ id, profileId: s.assignTo });
      return { id };
    }, spec);
  }

  /** Raw API call returning the full { ok, data, error } envelope. */
  api(namespace, method, payload) {
    return this.page.evaluate(([ns, m, p]) => window.api[ns][m](p || {}), [namespace, method, payload]);
  }

  /** Run an export and return the CSV bytes the app actually wrote.
   *
   *  export.filtered's envelope reports only { name, rows } — a row COUNT. The
   *  guest data leaves the application inside the Blob handed to
   *  URL.createObjectURL, so an assertion against the envelope can never detect
   *  a leak; it passes because the envelope never contained names in the first
   *  place. This intercepts the object URL to read the real payload, leaving
   *  the export code path itself untouched.
   */
  exportCsv(entity, params = {}) {
    return this.page.evaluate(async ([entity, params]) => {
      let captured = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { captured = blob; return orig(blob); };
      let envelope;
      try { envelope = await window.api.export.filtered({ entity, params }); }
      finally { URL.createObjectURL = orig; }
      return {
        ok: envelope.ok,
        code: envelope.error ? envelope.error.code : null,
        rows: envelope.data ? envelope.data.rows : null,
        csv: captured ? await captured.text() : null,
      };
    }, [entity, params]);
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  /** Suites call this last; it folds console/page errors into the result. */
  finish() {
    this.check('no console or page errors', this.errors.length === 0, this.errors.join(' | '));
    return { name: this.name, passed: this.passed, failed: this.failed, results: this.results };
  }
}

module.exports = { Suite, APP_URL, APP_PATH, ADMIN, loadPlaywright, chromiumExecutable };
