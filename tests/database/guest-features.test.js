'use strict';
/* GUEST FEATURES (1.2) — reminders, note templates, duplicate warnings,
 * merging, tags, birthdays and special dates, saved views and recently viewed
 * guests, driven through the real services against a real database.
 *
 * Every feature is checked twice: does it do the job, and does it keep to the
 * scope rule — a marketer reads and writes only their own book, and a feature
 * that has to mention a guest outside it says that the guest exists and
 * nothing else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const guests = require('../../src/main/services/guest-service');
const { migrate, loadMigrations } = require('../../src/main/database/migrator');
const { Database } = require('../../src/main/database/driver');
const { today, addDays } = require('../../src/shared/contracts/dates');
const { CONFIGURABLE, capabilitiesFor } = require('../../src/shared/contracts/roles');

const code = (e) => (e && e.code) || 'NO ERROR';
const attempt = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e }; } };

module.exports = async function () {
  const s = new Suite('database/guest-features');

  // ================================================= 0. the migration is additive
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-mig004-'));
    const old = path.join(dir, 'old');
    fs.mkdirSync(old);
    const all = loadMigrations();
    for (const m of all.filter((x) => x.version <= 3)) fs.writeFileSync(path.join(old, `${String(m.version).padStart(3, '0')}-${m.name}.sql`), m.sql);
    const db = new Database(path.join(dir, 'book.sqlite3'));
    migrate(db, { dir: old });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO customers (code, full_name, phone, created_at, updated_at) VALUES ('OLD-1', 'OLD GUEST', '0532 111 22 33', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO crm_notes (customer_id, note, note_date, created_at, updated_at) VALUES (1, 'kept note', '2026-01-02', ?, ?)`).run(now, now);
    const result = migrate(db);
    s.check('a 1.1 book migrates to schema 4', result.from === 3 && result.to >= 4, JSON.stringify(result));
    const guest = db.prepare('SELECT * FROM customers WHERE code = ?').get('OLD-1');
    s.check('existing guests survive the migration unchanged',
      guest && guest.full_name === 'OLD GUEST' && guest.phone === '0532 111 22 33' && guest.birth_date === null && guest.merged_into_id === null,
      JSON.stringify(guest));
    s.check('existing CRM notes survive the migration',
      db.prepare('SELECT note FROM crm_notes').get().note === 'kept note');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    s.check('the new tables exist',
      ['reminders', 'tags', 'customer_tags', 'customer_special_dates'].every((t) => tables.includes(t)), tables.join(','));
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'migrations', '004-guest-features.sql'), 'utf8')
      .replace(/--.*$/gm, '');
    s.check('migration 004 drops and renames nothing', !/\b(DROP|RENAME)\b/i.test(sql));
    s.check('running the migrator again changes nothing', migrate(db).applied.length === 0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const app = new TestApp('mmh-guestfx');
  try {
    await app.bootstrapAdmin();
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'SENA NUR AKMUT' });
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'KEREM SARICICEK' });
    const manager = await app.createManagerUser();

    const senaGuest = customers.create(app.ctx(), { code: 'G-SENA', fullName: 'SENA GUEST', phone: '+90 532 111 22 33',
      passportNo: 'U1234567', marketingProfileId: sena.profileId });
    const keremGuest = customers.create(app.ctx(), { code: 'G-KEREM', fullName: 'KEREM GUEST', phone: '0090-555-999 88 77',
      passportNo: 'P7654321', marketingProfileId: kerem.profileId });

    // ============================================================ 1. reminders
    await app.login('sena', sena.password);
    const yesterday = addDays(today(), -1);
    const n1 = support.crmNotes.create(app.ctx(), { customerId: senaGuest.id, note: 'Called, will call back', remindOn: today() });
    const n2 = support.crmNotes.create(app.ctx(), { customerId: senaGuest.id, note: 'Older follow-up', remindOn: yesterday });
    support.crmNotes.create(app.ctx(), { customerId: senaGuest.id, note: 'Far away', remindOn: addDays(today(), 30) });
    s.check('a note saved with "Remind me on" creates a reminder', Number.isInteger(n1.reminderId) && n1.reminderId > 0, JSON.stringify(n1));

    const due = guests.reminders.due(app.ctx());
    s.check('due reminders include today and overdue ones only', due.length === 2, JSON.stringify(due.map((r) => r.due_date)));
    s.check('due reminders are newest first', due[0].due_date === today() && due[1].due_date === yesterday, JSON.stringify(due.map((r) => r.due_date)));
    s.check('an overdue reminder says by how many days', due[1].overdue_days === 1, String(due[1].overdue_days));
    s.check('a due reminder carries its note text', due[0].note === 'Called, will call back', String(due[0].note));

    const notes = support.crmNotes.list(app.ctx(), { customerId: senaGuest.id });
    s.check('the note list shows each note\'s open reminder date',
      notes.find((n) => n.id === n1.id).remind_on === today(), JSON.stringify(notes.map((n) => n.remind_on)));

    support.notifications.list(app.ctx());
    const bell = app.db.prepare("SELECT * FROM notifications WHERE type = 'reminder_due'").all();
    s.check('a due follow-up raises one notification per guest, to the person who set it',
      bell.length === 1 && bell[0].target_user_id === sena.userId && bell[0].related_customer_id === senaGuest.id, JSON.stringify(bell));
    s.check('the notification says it is overdue', /overdue by 1 day/.test(bell[0].message), bell[0].message);
    support.notifications.list(app.ctx());
    s.check('opening the bell again does not duplicate it',
      app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE type = 'reminder_due'").get().n === 1);

    guests.reminders.markDone(app.ctx(), { id: n2.reminderId });
    guests.reminders.markDone(app.ctx(), { id: n1.reminderId });
    s.check('marking reminders done empties Due today', guests.reminders.due(app.ctx()).length === 0);
    s.check('and lifts the notification',
      app.db.prepare("SELECT COUNT(*) n FROM notifications WHERE type = 'reminder_due'").get().n === 0);
    s.check('marking done is audited',
      app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'REMINDER_DONE'").get().n === 2);

    // editing a note moves, then clears, its reminder
    support.crmNotes.update(app.ctx(), { id: n1.id, note: 'Edited', remindOn: addDays(today(), 2) });
    const moved = app.db.prepare('SELECT * FROM reminders WHERE crm_note_id = ? AND done_at IS NULL AND deleted_at IS NULL').get(n1.id);
    s.check('editing a note with a date sets a new open reminder', moved && moved.due_date === addDays(today(), 2), JSON.stringify(moved));
    support.crmNotes.update(app.ctx(), { id: n1.id, note: 'Edited again', remindOn: null });
    s.check('editing with no date clears it',
      !app.db.prepare('SELECT 1 FROM reminders WHERE crm_note_id = ? AND done_at IS NULL AND deleted_at IS NULL').get(n1.id));
    s.check('an invalid reminder date is refused',
      code(attempt(() => support.crmNotes.create(app.ctx(), { customerId: senaGuest.id, note: 'x', remindOn: '2026-02-31' })).error) === 'VALIDATION');

    s.check("a marketer cannot read another marketer's guest reminders",
      code(attempt(() => guests.reminders.forCustomer(app.ctx(), { customerId: keremGuest.id })).error) === 'FORBIDDEN');
    await app.loginAdmin();
    const kn = support.crmNotes.create(app.ctx(), { customerId: keremGuest.id, note: 'admin note', remindOn: today() });
    await app.login('sena', sena.password);
    s.check("nor mark another marketer's guest reminder done",
      code(attempt(() => guests.reminders.markDone(app.ctx(), { id: kn.reminderId })).error) === 'FORBIDDEN');
    s.check('the guest panel lists open reminders for an in-scope guest',
      guests.reminders.forCustomer(app.ctx(), { customerId: senaGuest.id }).length === 1);

    // ===================================================== 2. note templates
    await app.loginAdmin();
    support.settings.set(app.ctx(), { key: guests.TEMPLATE_KEY, value: JSON.stringify(['Called, no answer', '  Sent brochure  ']) });
    s.check('an administrator can save the template list',
      support.settings.all(app.ctx())[guests.TEMPLATE_KEY] === JSON.stringify(['Called, no answer', 'Sent brochure']));
    s.check('a template list that is not a list is refused',
      code(attempt(() => support.settings.set(app.ctx(), { key: guests.TEMPLATE_KEY, value: '{"a":1}' })).error) === 'VALIDATION');
    s.check('the defaults are the six agreed templates', guests.DEFAULT_TEMPLATES.length === 6 && guests.DEFAULT_TEMPLATES.includes('Offer sent'));
    await app.login('sena', sena.password);
    s.check('a marketer cannot change the template list',
      code(attempt(() => support.settings.set(app.ctx(), { key: guests.TEMPLATE_KEY, value: '[]' })).error) === 'FORBIDDEN');

    // ======================================================= 3. duplicates
    const own = guests.duplicates(app.ctx(), { phone: '0532-111-2233' });
    s.check('the same phone typed differently is found', own.matches.length === 1 && own.matches[0].id === senaGuest.id, JSON.stringify(own));
    s.check('the match says it was the phone', own.matches[0].match.includes('phone'));
    const viaPassport = guests.duplicates(app.ctx(), { passportNo: 'u1234567' });
    s.check('the same passport is found regardless of case', viaPassport.matches.length === 1, JSON.stringify(viaPassport));
    const foreign = guests.duplicates(app.ctx(), { phone: '+90 555 999 88 77', passportNo: 'P7654321' });
    s.check("an out-of-scope match is never named", foreign.matches.length === 0, JSON.stringify(foreign));
    s.check('but its existence is reported for both fields', foreign.elsewhere.phone === true && foreign.elsewhere.passport === true, JSON.stringify(foreign));
    s.check('the guest being edited is not its own duplicate',
      guests.duplicates(app.ctx(), { phone: '05321112233', excludeId: senaGuest.id }).matches.length === 0);
    s.check('a short number matches nothing', guests.duplicates(app.ctx(), { phone: '33' }).matches.length === 0);
    await app.loginAdmin();
    const adminView = guests.duplicates(app.ctx(), { phone: '5559998877' });
    s.check('an administrator sees the match in full', adminView.matches.length === 1 && adminView.matches[0].code === 'G-KEREM', JSON.stringify(adminView));

    // ============================================================ 4. tags
    const vip = guests.tags.create(app.ctx(), { name: 'VIP', color: 'gold' });
    const again = guests.tags.create(app.ctx(), { name: 'vip', color: 'red' });
    s.check('creating an existing tag name answers with the existing tag', again.id === vip.id && again.color === 'gold', JSON.stringify(again));
    s.check('a colour outside the palette is refused',
      code(attempt(() => guests.tags.create(app.ctx(), { name: 'Bad', color: 'url(x)' })).error) === 'VALIDATION');
    const high = guests.tags.create(app.ctx(), { name: 'High budget', color: 'green' });
    guests.tags.setForCustomer(app.ctx(), { id: senaGuest.id, tagIds: [vip.id, high.id] });
    guests.tags.setForCustomer(app.ctx(), { id: keremGuest.id, tagIds: [vip.id] });
    const row = customers.get(app.ctx(), { id: senaGuest.id });
    s.check('a guest carries its tags as ids', JSON.stringify(row.tags) === JSON.stringify([vip.id, high.id].sort((a, b) => a - b)), JSON.stringify(row.tags));
    const listed = customers.list(app.ctx(), { tagId: high.id });
    s.check('the list can be filtered by tag', listed.total === 1 && listed.rows[0].id === senaGuest.id, JSON.stringify(listed.rows.map((r) => r.code)));
    s.check('tag changes are audited', app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'CUSTOMER_TAGS'").get().n === 2);
    await app.login('sena', sena.password);
    const vipForSena = customers.list(app.ctx(), { tagId: vip.id });
    s.check("a tag filter stays inside the marketer's book", vipForSena.total === 1 && vipForSena.rows[0].id === senaGuest.id, JSON.stringify(vipForSena.rows.map((r) => r.code)));
    s.check('the tag list carries names and colours only',
      JSON.stringify(Object.keys(guests.tags.list(app.ctx())[0]).sort()) === JSON.stringify(['color', 'id', 'name']));
    s.check("a marketer cannot tag another marketer's guest",
      code(attempt(() => guests.tags.setForCustomer(app.ctx(), { id: keremGuest.id, tagIds: [] })).error) === 'FORBIDDEN');
    s.check('a marketer cannot recolour a shared tag',
      code(attempt(() => guests.tags.update(app.ctx(), { id: vip.id, color: 'red' })).error) === 'FORBIDDEN');

    // ================================================== 5. birthdays / dates
    const inThree = addDays(today(), 3);
    customers.update(app.ctx(), { id: senaGuest.id, birthDate: `1980-${inThree.slice(5)}` });
    guests.specialDates.set(app.ctx(), { id: senaGuest.id, dates: [{ label: 'Wedding anniversary', month: Number(today().slice(5, 7)), day: Number(today().slice(8, 10)) }] });
    const detail = customers.get(app.ctx(), { id: senaGuest.id });
    s.check('the birth date is stored', detail.birth_date === `1980-${inThree.slice(5)}`, detail.birth_date);
    s.check('special dates come back with the guest', detail.special_dates.length === 1 && detail.special_dates[0].label === 'Wedding anniversary', JSON.stringify(detail.special_dates));
    s.check('an impossible special date is refused',
      code(attempt(() => guests.specialDates.set(app.ctx(), { id: senaGuest.id, dates: [{ label: 'x', month: 2, day: 30 }] })).error) === 'VALIDATION');
    const dash = support.dashboard.load(app.ctx(), {});
    s.check('the dashboard lists dates in the next seven days',
      dash.upcomingDates.length === 2 && dash.upcomingDates[0].date === today() && dash.upcomingDates[1].kind === 'birthday',
      JSON.stringify(dash.upcomingDates));
    s.check('a birthday says how old the guest turns', /Birthday \(\d+\)/.test(dash.upcomingDates[1].label), dash.upcomingDates[1].label);
    s.check('29 February falls on the 28th in a common year', guests.nextOccurrence(2, 29, '2027-01-01') === '2027-02-28');
    support.notifications.list(app.ctx());
    const special = app.db.prepare("SELECT * FROM notifications WHERE type = 'special_date'").all();
    s.check('a special date today raises a notification to the owning marketer',
      special.length === 1 && special[0].target_profile_id === sena.profileId && /Wedding anniversary/.test(special[0].message), JSON.stringify(special));
    await app.login('kerem', kerem.password);
    s.check("another marketer's dashboard does not show those dates",
      support.dashboard.load(app.ctx(), {}).upcomingDates.length === 0);

    // ====================================================== 6. saved views
    await app.login('sena', sena.password);
    const v1 = guests.views.save(app.ctx(), { screen: 'overview', name: 'My cold guests', state: { status: 'COLD', search: '' } });
    guests.views.save(app.ctx(), { screen: 'reservations', name: 'Upcoming', state: { status: 'UPCOMING' } });
    const v1b = guests.views.save(app.ctx(), { screen: 'overview', name: 'my cold guests', state: { status: 'COLD', search: 'x' } });
    s.check('saving under an existing name replaces that view', v1b.id === v1.id && guests.views.list(app.ctx(), { screen: 'overview' }).length === 1);
    s.check('a saved view keeps its state', guests.views.list(app.ctx(), { screen: 'overview' })[0].state.search === 'x');
    s.check('views are listed per screen', guests.views.list(app.ctx(), { screen: 'reservations' }).length === 1);
    await app.login('kerem', kerem.password);
    s.check('saved views are personal', guests.views.list(app.ctx(), {}).length === 0);
    s.check("one user cannot delete another's view", code(attempt(() => guests.views.remove(app.ctx(), { id: v1.id })).error) === 'NOT_FOUND');
    await app.login('sena', sena.password);
    guests.views.remove(app.ctx(), { id: v1.id });
    s.check('a view can be deleted', guests.views.list(app.ctx(), { screen: 'overview' }).length === 0);

    // =================================================== 7. recently viewed
    for (let i = 0; i < 12; i++) customers.create(app.ctx(), { code: `R-${i}`, fullName: `RECENT ${i}` });
    const mine = customers.list(app.ctx(), { pageSize: 50, sort: 'code', dir: 'asc' }).rows.filter((r) => r.code.startsWith('R-'));
    for (const r of mine) guests.recent.viewed(app.ctx(), { id: r.id });
    guests.recent.viewed(app.ctx(), { id: senaGuest.id });
    const recentList = guests.recent.list(app.ctx());
    s.check('recently viewed keeps the last ten', recentList.length === 10, String(recentList.length));
    s.check('most recent first', recentList[0].id === senaGuest.id, JSON.stringify(recentList.map((r) => r.code)));
    s.check("a marketer cannot record another marketer's guest as viewed",
      code(attempt(() => guests.recent.viewed(app.ctx(), { id: keremGuest.id })).error) === 'FORBIDDEN');
    await app.loginAdmin();
    customers.assign(app.ctx(), { id: mine[mine.length - 1].id, profileId: kerem.profileId });
    await app.login('sena', sena.password);
    s.check('a guest reassigned away drops out of the list', !guests.recent.list(app.ctx()).some((r) => r.id === mine[mine.length - 1].id));

    // ============================================================ 8. merge
    s.check('merging is configurable and off for managers by default',
      Object.prototype.hasOwnProperty.call(CONFIGURABLE, 'customers.merge') && capabilitiesFor('MANAGER', {})['customers.merge'] !== true);
    s.check('a marketer cannot merge',
      code(attempt(() => guests.merge(app.ctx(), { primaryId: senaGuest.id, duplicateId: mine[0].id })).error) === 'FORBIDDEN');
    await app.login('manager', manager.password);
    s.check('a manager cannot merge without the grant',
      code(attempt(() => guests.merge(app.ctx(), { primaryId: senaGuest.id, duplicateId: mine[0].id })).error) === 'FORBIDDEN');

    await app.loginAdmin();
    const primary = customers.create(app.ctx(), { code: 'M-PRIMARY', fullName: 'MERGE PRIMARY', phone: '111111111' });
    const dup = customers.create(app.ctx(), { code: 'M-DUP', fullName: 'MERGE DUP', phone: '222222222', email: 'dup@example.com', passportNo: 'DUPPASS' });
    support.crmNotes.create(app.ctx(), { customerId: dup.id, note: 'dup note', remindOn: addDays(today(), 5) });
    reservations.create(app.ctx(), { customerId: dup.id, checkIn: addDays(today(), 40), checkOut: addDays(today(), 42) });
    guests.tags.setForCustomer(app.ctx(), { id: dup.id, tagIds: [vip.id] });
    guests.tags.setForCustomer(app.ctx(), { id: primary.id, tagIds: [vip.id, high.id] });
    guests.specialDates.set(app.ctx(), { id: dup.id, dates: [{ label: 'Name day', month: 6, day: 1 }] });
    const merged = guests.merge(app.ctx(), { primaryId: primary.id, duplicateId: dup.id });
    s.check('merge reports what it moved',
      merged.moved.notes === 1 && merged.moved.reservations === 1 && merged.moved.reminders === 1 && merged.moved.specialDates === 1, JSON.stringify(merged));
    const after = customers.get(app.ctx(), { id: primary.id });
    s.check("the primary keeps its own fields", after.phone === '111111111' && after.full_name === 'MERGE PRIMARY');
    s.check('and gains the ones it was missing', after.email === 'dup@example.com' && after.passport_no === 'DUPPASS', JSON.stringify(after));
    s.check('notes and stays now belong to the primary', after.note_count === 1 && after.reservation_count === 1, JSON.stringify(after));
    s.check('tags are combined without doubling', JSON.stringify(after.tags) === JSON.stringify([vip.id, high.id].sort((a, b) => a - b)), JSON.stringify(after.tags));
    s.check('special dates move across', after.special_dates.some((d) => d.label === 'Name day'));
    const gone = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(dup.id);
    s.check('the duplicate is archived with a pointer to the primary',
      gone.deleted_at !== null && gone.merged_into_id === primary.id, JSON.stringify(gone));
    s.check('the merge is audited',
      app.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'CUSTOMER_MERGE' AND entity_id = ?").get(primary.id).n === 1);
    s.check('a guest cannot be merged into itself',
      code(attempt(() => guests.merge(app.ctx(), { primaryId: primary.id, duplicateId: primary.id })).error) === 'VALIDATION');
    s.check('an archived duplicate cannot be merged twice',
      code(attempt(() => guests.merge(app.ctx(), { primaryId: primary.id, duplicateId: dup.id })).error) === 'NOT_FOUND');

    /* A failure half-way must leave nothing half-moved. */
    const p2 = customers.create(app.ctx(), { code: 'M-P2', fullName: 'P2' });
    const d2 = customers.create(app.ctx(), { code: 'M-D2', fullName: 'D2' });
    support.crmNotes.create(app.ctx(), { customerId: d2.id, note: 'must stay put' });
    const realAudit = app.audit.bind(app);
    app.audit = () => { throw new Error('boom'); };
    const failed = attempt(() => guests.merge(app.ctx(), { primaryId: p2.id, duplicateId: d2.id }));
    app.audit = realAudit;
    s.check('a merge that fails part-way is rolled back',
      failed.error && app.db.prepare('SELECT customer_id FROM crm_notes WHERE note = ?').get('must stay put').customer_id === d2.id
        && app.db.prepare('SELECT deleted_at FROM customers WHERE id = ?').get(d2.id).deleted_at === null);

    /* Granting the capability is enough for a manager. */
    support.settings.setPermissions(app.ctx(), { matrix: { MANAGER: { 'customers.merge': true } } });
    await app.login('manager', manager.password);
    const ok = attempt(() => guests.merge(app.ctx(), { primaryId: p2.id, duplicateId: d2.id }));
    s.check('a manager granted customers.merge can merge', ok.value && ok.value.merged === d2.id, String(ok.error && ok.error.message));
  } finally {
    app.close();
  }

  return s.finish();
};
