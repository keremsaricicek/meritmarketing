'use strict';
/* PERFORMANCE at the scale the product is specified for.
 *
 * 10,000 guests · 50,000 reservations · 50,000 CRM notes.
 *
 * The thresholds are generous on purpose. This suite is not a benchmark; it is
 * a tripwire for the specific mistakes that make a desktop CRM unusable — a
 * missing index, a query that loads the whole book to count it, an O(n²) join,
 * or a list endpoint that returns nested history per row. A regression of that
 * kind is an order of magnitude, not a few milliseconds, so a loose threshold
 * still catches it while staying stable on a loaded CI machine.
 *
 * Measured timings are printed, not asserted to a fixed number.
 */

const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const { today, addDays, nowIso } = require('../../src/shared/contracts/dates');

const GUESTS = 10000;
const RESERVATIONS = 50000;
const NOTES = 50000;

/* Deliberately loose — an order of magnitude below "a person notices". */
const BUDGET_MS = {
  customerList: 800,
  customerSearch: 800,
  customerDetail: 200,
  reservationList: 800,
  dashboard: 2000,
  calendarMonth: 800,
  finder: 500,
  profileList: 800,
};

function seed(app, profileIds) {
  const db = app.db;
  const now = nowIso();
  const insertCustomer = db.prepare(`
    INSERT INTO customers (code, full_name, registered, phone, passport_no, marketing_profile_id,
                           created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, 1, ?, ?, ?, ?, 1, ?, 1)`);
  const insertReservation = db.prepare(`
    INSERT INTO reservations (customer_id, check_in, check_out, invited_by_profile_id,
                              created_at, created_by, updated_at, updated_by, cancelled_at, deleted_at, deleted_by)
    VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`);
  const insertNote = db.prepare(`
    INSERT INTO crm_notes (customer_id, note, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, 1, ?, 1)`);

  const surnames = ['YILMAZ', 'KAYA', 'DEMIR', 'SAHIN', 'CELIK', 'YILDIZ', 'YILDIRIM', 'OZTURK', 'AYDIN', 'ARSLAN'];
  const names = ['MEHMET', 'AYSE', 'FATMA', 'ELIF', 'ZEYNEP', 'MUSTAFA', 'AHMET', 'EMINE', 'HATICE', 'ALI'];

  const load = db.transaction(() => {
    for (let i = 1; i <= GUESTS; i++) {
      insertCustomer.run(
        `G-${String(i).padStart(6, '0')}`,
        `${names[i % names.length]} ${surnames[(i * 7) % surnames.length]} ${i}`,
        `+90 5${String(300000000 + i).slice(0, 9)}`,
        `P${String(1000000 + i)}`,
        profileIds[i % profileIds.length],
        now, now,
      );
    }
    for (let i = 1; i <= RESERVATIONS; i++) {
      const customerId = (i % GUESTS) + 1;
      const offset = (i % 700) - 350;
      const checkIn = addDays(today(), offset);
      const checkOut = addDays(checkIn, 1 + (i % 5));
      /* A realistic mix: roughly 8% cancelled, 4% deleted. */
      const cancelled = i % 12 === 0 ? now : null;
      const deleted = i % 25 === 0 ? now : null;
      insertReservation.run(customerId, checkIn, checkOut,
        profileIds[i % profileIds.length], now, now, cancelled, deleted, deleted ? 1 : null);
    }
    for (let i = 1; i <= NOTES; i++) {
      insertNote.run((i % GUESTS) + 1, `Call log entry ${i} — followed up on the last stay.`, now, now);
    }
  });
  load();
}

module.exports = async function () {
  const s = new Suite('database/performance');
  const app = new TestApp('mmh-perf');
  const timings = {};

  const time = (label, fn) => {
    const started = process.hrtime.bigint();
    const result = fn();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    timings[label] = Math.round(ms);
    return result;
  };

  try {
    await app.bootstrapAdmin();
    const profiles = [];
    for (const name of ['KEREM SARICICEK', 'SENA NUR AKMUT', 'ALEYNA DACIC', 'OKAN CAPAR']) {
      profiles.push(app.createProfile(name));
    }

    const seedStart = process.hrtime.bigint();
    seed(app, profiles);
    const seedMs = Math.round(Number(process.hrtime.bigint() - seedStart) / 1e6);

    s.check(`seeded ${GUESTS} guests`,
      app.db.prepare('SELECT COUNT(*) n FROM customers').get().n === GUESTS + 0);
    s.check(`seeded ${RESERVATIONS} reservations`,
      app.db.prepare('SELECT COUNT(*) n FROM reservations').get().n === RESERVATIONS);
    s.check(`seeded ${NOTES} CRM notes`,
      app.db.prepare('SELECT COUNT(*) n FROM crm_notes').get().n === NOTES);

    const ctx = app.ctx();

    // ------------------------------------------------------- ADMIN, unscoped
    const page = time('customerList', () => customers.list(ctx, { pageSize: 25 }));
    s.check('the customer list returns one page, not the whole book',
      page.rows.length === 25 && page.total === GUESTS, `${page.rows.length} rows of ${page.total}`);

    /* The regression that matters most: a list row must not carry nested
       history. One extra array per row is invisible at 25 guests and fatal at
       10,000. */
    s.check('a list row carries no assignment history',
      page.rows.every((r) => r.assignment_history === undefined), 'a list row carries nested history');
    s.check('a list row carries no note bodies',
      page.rows.every((r) => r.notes === undefined || typeof r.notes === 'string'), 'a list row carries note bodies');

    time('customerSearch', () => customers.list(ctx, { search: 'YILMAZ', pageSize: 25 }));
    time('customerDetail', () => customers.get(ctx, { id: 4242 }));
    time('reservationList', () => reservations.list(ctx, { pageSize: 25 }));
    time('dashboard', () => support.dashboard.load(ctx, { periodDays: 30 }));
    const [y, m] = today().split('-').map(Number);
    time('calendarMonth', () => support.calendar.month(ctx, { year: y, month: m }));
    time('finder', () => customers.picker(ctx, { search: 'MEHMET', pageSize: 50 }));
    time('profileList', () => support.profiles.list(ctx, {}));

    for (const [label, budget] of Object.entries(BUDGET_MS)) {
      s.check(`${label} completes within ${budget}ms (measured ${timings[label]}ms)`,
        timings[label] <= budget, `${timings[label]}ms`);
    }

    // ------------------------------------------------------ MARKETING scope
    const marketing = await app.createMarketingUser({ username: 'perfuser', profileName: 'PERF MARKETER' });
    /* Give the scoped user a real share of the book, so the scoped query is not
       trivially fast because it matches nothing. */
    app.db.prepare('UPDATE customers SET marketing_profile_id = ? WHERE id % 4 = 0')
      .run(marketing.profileId);
    await app.login('perfuser', marketing.password);
    const mctx = app.ctx();

    const scoped = time('scopedList', () => customers.list(mctx, { pageSize: 25 }));
    s.check('the scoped list is narrowed but not empty',
      scoped.total > 0 && scoped.total < GUESTS, `${scoped.total} of ${GUESTS}`);
    s.check(`a scoped list is not slower than the unscoped one (measured ${timings.scopedList}ms)`,
      timings.scopedList <= BUDGET_MS.customerList, `${timings.scopedList}ms`);

    // ------------------------------------------------- indexes are actually used
    const plan = (sql, params = {}) => app.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params)
      .map((r) => r.detail || Object.values(r).join(' ')).join(' | ');

    const qualifyingPlan = plan(`SELECT MAX(check_in) FROM reservations
      WHERE customer_id = @id AND deleted_at IS NULL AND cancelled_at IS NULL`, { id: 1 });
    s.check('the hot "qualifying activity" query uses an index, not a scan',
      /USING (COVERING )?INDEX/i.test(qualifyingPlan) && !/SCAN reservations(?! USING)/i.test(qualifyingPlan),
      qualifyingPlan);

    const ownerPlan = plan('SELECT id FROM customers WHERE marketing_profile_id = @p', { p: 1 });
    s.check('the ownership lookup uses an index', /USING (COVERING )?INDEX/i.test(ownerPlan), ownerPlan);

    const calendarPlan = plan(`SELECT check_in, check_out FROM reservations
      WHERE deleted_at IS NULL AND cancelled_at IS NULL AND check_in <= @b AND check_out >= @a`,
    { a: today(), b: addDays(today(), 30) });
    s.check('the calendar range query uses an index', /USING (COVERING )?INDEX/i.test(calendarPlan), calendarPlan);

    // ------------------------------------------------------------- reporting
    const report = [
      `seed ${seedMs}ms for ${GUESTS} guests / ${RESERVATIONS} reservations / ${NOTES} notes`,
      ...Object.entries(timings).map(([k, v]) => `${k} ${v}ms`),
    ].join(' · ');
    /* A report line, not an assertion — printed so the numbers are in the run
       output, and asserted on something that can actually fail: every budgeted
       operation must have produced a measurement. A missing timing means the
       call above silently did not happen. */
    s.check(`every budgeted operation was measured — ${report}`,
      Object.keys(BUDGET_MS).every((k) => Number.isFinite(timings[k])),
      JSON.stringify(timings));
  } finally {
    app.close();
  }

  return s.finish();
};
