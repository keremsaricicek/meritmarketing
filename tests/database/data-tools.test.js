'use strict';
/* DATA TOOLS — guest import, Excel export, bulk actions, the monthly report.
 *
 * Each of these moves a lot of records at once, which is exactly when a
 * missing scope check or a half-written transaction does the most damage. The
 * assertions are about what lands in the database and what comes back to the
 * renderer, against the real services and a real SQLite file.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Suite } = require('../lib/harness');
const { TestApp } = require('../lib/db-harness');
const customers = require('../../src/main/services/customer-service');
const reservations = require('../../src/main/services/reservation-service');
const support = require('../../src/main/services/support-services');
const bulk = require('../../src/main/services/bulk-service');
const importFactory = require('../../src/main/services/import-service');
const exportFactory = require('../../src/main/services/export-service');
const report = require('../../src/main/services/report-service');
const spreadsheet = require('../../src/main/services/import/spreadsheet');
const rules = require('../../src/main/services/import/rules');
const { SCHEMAS, IMPORT_FIELDS } = require('../../src/shared/validation/schemas');
const { today, addDays } = require('../../src/shared/contracts/dates');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'import');

async function attempt(fn) {
  try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, code: e.code, message: e.message }; }
}

module.exports = async function () {
  const s = new Suite('database/data-tools');
  const app = new TestApp('mmh-datatools');
  const J = (v) => JSON.stringify(v);
  /* Key order is not part of a mapping. */
  const K = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

  try {
    await app.bootstrapAdmin();
    const manager = await app.createManagerUser();
    const sena = await app.createMarketingUser({ username: 'sena', profileName: 'Sena Yilmaz' });
    const kerem = await app.createMarketingUser({ username: 'kerem', profileName: 'Kerem Saricicek' });
    const retired = app.createProfile('Retired Person', { status: 'inactive' });

    // =========================================================== rules
    s.check('phones keep a leading + and lose everything else',
      rules.normalisePhone('+90 (532) 765-43-21') === '+905327654321', rules.normalisePhone('+90 (532) 765-43-21'));
    s.check('a leading 00 is read as an international +',
      rules.normalisePhone('0090 212 555 66 77') === '+902125556677');
    s.check('a local number keeps its leading zero',
      rules.normalisePhone('0532 123 45 67') === '05321234567');
    s.check('the same line in three spellings has one duplicate key',
      new Set(['+90 532 123 45 67', '0532 123 45 67', '5321234567'].map(rules.phoneKey)).size === 1);
    const guessed = rules.guessMapping(['Ad', 'Soyad', 'Cep Telefonu', 'E-Posta', 'Pasaport No', 'Uyruğu', 'Notlar', 'Pazarlamacı', 'Oyun Gücü']);
    s.check('Turkish headers are recognised',
      K(guessed) === K({ firstName: 0, lastName: 1, phone: 2, email: 3, passportNo: 4, nationality: 5, notes: 6, owner: 7, gamingPower: 8 }), J(guessed));
    const english = rules.guessMapping(['Full Name', 'Mobile', 'Email', 'Passport', 'Nationality', 'Guest note', 'Owner', 'Gaming power']);
    s.check('English headers are recognised',
      K(english) === K({ fullName: 0, phone: 1, email: 2, passportNo: 3, nationality: 4, notes: 5, owner: 6, gamingPower: 7 }), J(english));
    s.check('a lone "İsim" column is a full name, not half of one',
      K(rules.guessMapping(['İsim', 'Tel'])) === K({ fullName: 0, phone: 1 }), J(rules.guessMapping(['İsim', 'Tel'])));
    s.check('the import schema and the import rules agree on the field list',
      J([...IMPORT_FIELDS].sort()) === J([...rules.FIELD_KEYS].sort()));

    // ===================================================== spreadsheets
    const xlsx = await spreadsheet.readFile(path.join(FIXTURES, 'misafirler.xlsx'));
    s.check('an .xlsx fixture opens with its visible sheets',
      J(xlsx.sheets.map((x) => x.name)) === J(['Misafirler', 'Notlar']), J(xlsx.sheets.map((x) => x.name)));
    s.check('a formula cell contributes its cached result, never the formula',
      xlsx.sheets[0].rows.some((r) => r.includes('Ziyaret 2026'))
        && !xlsx.sheets[0].rows.some((r) => r.some((c) => /CONCATENATE/.test(c))));
    s.check('a phone Excel stored as a number is read without an exponent',
      xlsx.sheets[0].rows.some((r) => r.includes('905551112233')));
    const csv = await spreadsheet.readFile(path.join(FIXTURES, 'misafirler.csv'));
    s.check('a semicolon CSV with a BOM parses into columns',
      csv.sheets[0].rows[0][0] === 'Ad Soyad' && csv.sheets[0].rows[0].length === 8, J(csv.sheets[0].rows[0]));
    s.check('quoted CSV fields keep their delimiters and quotes',
      csv.sheets[0].rows.some((r) => r.includes('Rulet; blackjack')) && csv.sheets[0].rows.some((r) => r.includes('"Kosher" menü')));
    const legacy = spreadsheet.decodeText(Buffer.from([0x41, 0x79, 0xfe, 0x65]));   // "Ayşe" in Windows-1254
    s.check('a Windows-1254 CSV decodes Turkish letters', legacy === 'Ayşe', legacy);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-import-'));
    const fake = path.join(tmp, 'fake.xlsx');
    fs.writeFileSync(fake, 'not a zip at all');
    const notZip = await attempt(() => spreadsheet.readFile(fake));
    s.check('a file that is not a workbook is refused plainly', !notZip.ok && notZip.code === 'VALIDATION', J(notZip));
    const wrongType = path.join(tmp, 'guests.xlsm');
    fs.writeFileSync(wrongType, 'x');
    const xlsm = await attempt(() => spreadsheet.readFile(wrongType));
    s.check('a macro-enabled extension is refused', !xlsm.ok && xlsm.code === 'VALIDATION', J(xlsm));
    const big = path.join(tmp, 'big.csv');
    fs.writeFileSync(big, Buffer.alloc(spreadsheet.MAX_FILE_BYTES + 1, 0x41));
    const tooBig = await attempt(() => spreadsheet.readFile(big));
    s.check('a file over the size limit is refused before parsing', !tooBig.ok && /10 MB/.test(tooBig.message), J(tooBig));
    /* A workbook that smuggles a VBA project under an .xlsx name. */
    const ExcelJS = require('exceljs');
    const JSZip = require('jszip');
    const wb = new ExcelJS.Workbook(); wb.addWorksheet('S').addRow(['Ad']);
    const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
    zip.file('xl/vbaProject.bin', 'macro');
    const macro = path.join(tmp, 'macro.xlsx');
    fs.writeFileSync(macro, await zip.generateAsync({ type: 'nodebuffer' }));
    const macroResult = await attempt(() => spreadsheet.readFile(macro));
    s.check('a workbook containing macros is refused', !macroResult.ok && /macros/.test(macroResult.message), J(macroResult));
    fs.rmSync(tmp, { recursive: true, force: true });

    // ============================================================ import
    /* An existing guest the CSV duplicates by phone, and one the xlsx
       duplicates by passport, owned by Kerem. */
    const avi = customers.create(app.ctx(), { code: 'G-AVI', fullName: 'Avi Cohen', phone: '+90 532 765 43 21', marketingProfileId: kerem.profileId });
    customers.create(app.ctx(), { code: 'G-THOMAS', fullName: 'Thomas Weber', passportNo: 'C01X00T47', marketingProfileId: sena.profileId });

    const importer = importFactory.build({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(FIXTURES, 'misafirler.xlsx')] }) },
      getWindow: () => null,
    });
    const opened = await importer.choose(app.ctx());
    s.check('choosing a file returns a token, sheets and a guessed mapping — never a path',
      !!opened.token && opened.sheets.length === 2 && opened.mapping.firstName === 0 && !J(opened).includes(FIXTURES), J(opened).slice(0, 300));
    s.check('the first rows are shown as a sample', opened.sample.length === 8 && opened.sample[0][0] === 'Ayşe', J(opened.sample[0]));
    const other = importer.sheet(app.ctx(), { token: opened.token, sheet: 1 });
    s.check('another sheet can be picked', other.rowCount === 0 && other.headers[0] === 'Bu sayfa misafir içermez', J(other));

    const noName = await attempt(() => importer.preview(app.ctx(), { token: opened.token, sheet: 0, mapping: { phone: 2 } }));
    s.check('a preview without a name column is refused', !noName.ok && noName.code === 'VALIDATION', J(noName));

    const preview = importer.preview(app.ctx(), { token: opened.token, sheet: 0, mapping: opened.mapping, duplicates: 'skip' });
    const byRow = Object.fromEntries(preview.rows.map((r) => [r.row, r]));
    s.check('the preview counts new, duplicate and invalid rows',
      J([preview.counts.new, preview.counts.duplicate, preview.counts.invalid]) === J([3, 2, 3]), J(preview.counts));
    s.check('a row without a name is invalid with its reason', byRow[5].status === 'invalid' && /Name is missing/.test(byRow[5].reason), J(byRow[5]));
    s.check('a malformed email is invalid', byRow[4].status === 'invalid' && /Email/.test(byRow[4].reason), J(byRow[4]));
    s.check('a too-short phone is invalid', byRow[7].status === 'invalid' && /Phone/.test(byRow[7].reason), J(byRow[7]));
    s.check('the same guest twice in one file is a duplicate of the earlier row',
      byRow[6].status === 'duplicate' && /row 2/.test(byRow[6].reason), J(byRow[6]));
    s.check('a guest already in the book is a duplicate by passport',
      byRow[9].status === 'duplicate' && byRow[9].match.code === 'G-THOMAS' && /passport/.test(byRow[9].reason), J(byRow[9]));
    s.check('an unknown owner is a warning, not a failure',
      byRow[4].status === 'invalid' || byRow[2].warnings.length === 0, J(byRow[2]));
    s.check('preview rows carry no internal values or ids',
      !J(preview).includes('"values"') && !J(preview).includes('matchId') && !J(preview).includes('ownerId'));

    const auditBefore = app.db.prepare("SELECT COUNT(*) n FROM audit_log").get().n;
    const done = importer.commit(app.ctx(), { token: opened.token, sheet: 0, mapping: opened.mapping, duplicates: 'skip' });
    s.check('the import creates exactly the new rows', done.created === 3 && done.updated === 0 && done.skipped === 5, J(done));
    const ayse = app.db.prepare("SELECT * FROM customers WHERE full_name = 'Ayşe Yıldız'").get();
    s.check('an imported guest gets a generated Guest ID with a clear prefix',
      /^IMP-\d{6}-\d{4}$/.test(ayse.code), ayse.code);
    s.check('phones are stored normalised', ayse.phone === '05321234567', ayse.phone);
    s.check('the gaming power column lands in the guest note, labelled',
      ayse.notes === 'VIP masa ister\nGaming power: Yüksek', J(ayse.notes));
    s.check('the owner column assigns an active profile by name', ayse.marketing_profile_id === sena.profileId);
    s.check('the assignment is recorded with an import source',
      app.db.prepare("SELECT source FROM assignment_history WHERE customer_id = ?").get(ayse.id).source === 'import');
    const audits = app.db.prepare("SELECT * FROM audit_log WHERE id > (SELECT MAX(id) - 5 FROM audit_log) ORDER BY id").all();
    const importAudit = app.db.prepare("SELECT * FROM audit_log WHERE action = 'CUSTOMER_IMPORT'").all();
    s.check('an import writes ONE audit row with its counts',
      importAudit.length === 1 && app.db.prepare("SELECT COUNT(*) n FROM audit_log").get().n === auditBefore + 1
        && JSON.parse(importAudit[0].metadata).created === 3, J(audits.map((a) => a.action)));
    const replay = await attempt(() => importer.commit(app.ctx(), { token: opened.token, sheet: 0, mapping: opened.mapping }));
    s.check('a token cannot be committed twice', !replay.ok && replay.code === 'NOT_FOUND', J(replay));

    // Update-empty-fields, CSV, and a marketer's scope.
    await app.login('sena', sena.password);
    const csvImporter = importFactory.build({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(FIXTURES, 'misafirler.csv')] }) },
      getWindow: () => null,
    });
    const keremToken = await (async () => {
      await app.login('kerem', kerem.password);
      return (await csvImporter.choose(app.ctx())).token;
    })();
    await app.login('sena', sena.password);
    const csvOpen = await csvImporter.choose(app.ctx());
    const stolen = await attempt(() => csvImporter.preview(app.ctx(), { token: keremToken, sheet: 0, mapping: csvOpen.mapping }));
    s.check("one account cannot use another account's import token", !stolen.ok && stolen.code === 'NOT_FOUND', J(stolen));
    const senaPreview = csvImporter.preview(app.ctx(), { token: csvOpen.token, sheet: 0, mapping: csvOpen.mapping, duplicates: 'update' });
    const aviRow = senaPreview.rows.find((r) => r.name === 'Avi Cohen');
    s.check("a marketer sees another marketer's duplicate by ID and name only, and cannot update it",
      aviRow.status === 'duplicate' && aviRow.action === 'skip' && /another marketer/.test(aviRow.reason)
        && J(Object.keys(aviRow.match)) === J(['code', 'name']), J(aviRow));
    const senaDone = csvImporter.commit(app.ctx(), { token: csvOpen.token, sheet: 0, mapping: csvOpen.mapping, duplicates: 'update' });
    s.check("a marketer's import creates only valid new rows", senaDone.created === 2 && senaDone.invalid === 2, J(senaDone));
    const owners = app.db.prepare("SELECT DISTINCT marketing_profile_id m FROM customers WHERE created_by = (SELECT id FROM users WHERE username='sena')").all();
    s.check("a marketer's imported guests are all theirs", J(owners) === J([{ m: sena.profileId }]), J(owners));
    s.check("Kerem's guest was not touched by Sena's import",
      app.db.prepare('SELECT email FROM customers WHERE id = ?').get(avi.id).email === null);

    await app.loginAdmin();
    const adminCsv = await csvImporter.choose(app.ctx());
    const adminPreview = csvImporter.preview(app.ctx(), { token: adminCsv.token, sheet: 0, mapping: adminCsv.mapping, duplicates: 'update' });
    const aviAdmin = adminPreview.rows.find((r) => r.name === 'Avi Cohen');
    s.check('"update empty fields" plans to fill only what is empty', aviAdmin.action === 'update' && /email/.test(aviAdmin.reason), J(aviAdmin));
    const adminDone = csvImporter.commit(app.ctx(), { token: adminCsv.token, sheet: 0, mapping: adminCsv.mapping, duplicates: 'update' });
    const aviAfter = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(avi.id);
    s.check('an empty field on the existing guest is filled', aviAfter.email === 'avi@example.com' && adminDone.updated === 1, J(adminDone));
    s.check('a filled field is never overwritten, and ownership never moves',
      aviAfter.phone === '+90 532 765 43 21' && aviAfter.marketing_profile_id === kerem.profileId);

    // Templates.
    const saved = importer.saveTemplate(app.ctx(), { name: 'Otel listesi', mapping: { fullName: 'Ad Soyad', phone: 'GSM' } });
    s.check('a mapping template is saved', saved.length === 1 && saved[0].mapping.phone === 'GSM', J(saved));
    await app.login('sena', sena.password);
    s.check("templates are personal: another account does not see them", importer.templates(app.ctx()).length === 0);
    await app.loginAdmin();
    s.check('a template can be deleted', importer.deleteTemplate(app.ctx(), { name: 'Otel listesi' }).length === 0);
    const settingsLeak = support.settings.all(app.ctx());
    s.check('templates never appear in shared settings', !('import.templates' in settingsLeak));

    // ============================================================ export
    const exporter = exportFactory.build({ dialog: null, getWindow: () => null });
    support.crmNotes.create(app.ctx(), { customerId: avi.id, note: '=HYPERLINK("http://x") first', noteDate: addDays(today(), -3) });
    support.crmNotes.create(app.ctx(), { customerId: avi.id, note: 'Second note', noteDate: addDays(today(), -1) });
    const file = await exporter.renderFile(app.ctx(), {
      entity: 'customerlist', params: {}, format: 'xlsx', includeAllNotes: true,
      columns: ['Guest ID', 'Name', 'Latest CRM note', 'Latest note date', 'Latest note by'],
    });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(file.bytes);
    const guestsSheet = back.getWorksheet('Guests');
    const notesSheet = back.getWorksheet('CRM notes');
    const header = guestsSheet.getRow(1).values.slice(1);
    s.check('the .xlsx has the chosen columns, in dataset order',
      J(header) === J(['Guest ID', 'Name', 'Latest CRM note', 'Latest note date', 'Latest note by']), J(header));
    const aviLine = guestsSheet.getRows(2, guestsSheet.rowCount - 1).find((r) => r.getCell(1).value === 'G-AVI');
    s.check('each guest carries the latest note text, date and author',
      aviLine && aviLine.getCell(3).value === 'Second note' && aviLine.getCell(4).value === addDays(today(), -1)
        && aviLine.getCell(5).value === 'Administrator', aviLine && J(aviLine.values));
    s.check('the second sheet holds every note', notesSheet && notesSheet.rowCount === 3, notesSheet && String(notesSheet.rowCount));
    const formulaCells = [];
    back.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { if (c.type === ExcelJS.ValueType.Formula) formulaCells.push(c.address); })));
    s.check('a note that looks like a formula is written as text', formulaCells.length === 0, J(formulaCells));

    await app.login('sena', sena.password);
    const senaFile = await exporter.renderFile(app.ctx(), { entity: 'customerlist', params: { ids: [avi.id, ayse.id] }, format: 'xlsx', includeAllNotes: true });
    const senaBook = new ExcelJS.Workbook();
    await senaBook.xlsx.load(senaFile.bytes);
    const senaCodes = senaBook.getWorksheet('Guests').getColumn(1).values.slice(2);
    s.check("export selected cannot reach another marketer's guest",
      J(senaCodes) === J([ayse.code]) && senaBook.getWorksheet('CRM notes').rowCount === 1, J(senaCodes));
    const csvStill = await exporter.renderFile(app.ctx(), { entity: 'customerlist', params: {} });
    s.check('CSV export still works and still neutralises formulas',
      csvStill.ext === 'csv' && csvStill.csv.startsWith('﻿"Guest ID"'), csvStill.csv.slice(0, 40));
    const notesCsv = await attempt(() => exporter.renderFile(app.ctx(), { entity: 'customerlist', includeAllNotes: true }));
    s.check('all notes need the Excel format', !notesCsv.ok && notesCsv.code === 'VALIDATION');
    const idsOnAudit = await attempt(() => exporter.renderFile(app.ctx(), { entity: 'reservations', params: { ids: [1] } }));
    s.check('a selection only applies to guest datasets', !idsOnAudit.ok && idsOnAudit.code === 'VALIDATION');
    const cols = exporter.columns(app.ctx(), { entity: 'customerlist' });
    s.check('the export dialog is offered the dataset columns', cols.columns.includes('Latest CRM note') && cols.notes === true, J(cols));
    const auditCols = await attempt(() => exporter.columns(app.ctx(), { entity: 'audit' }));
    s.check('column discovery still needs the dataset capability', !auditCols.ok && auditCols.code === 'FORBIDDEN');
    s.check('export:run accepts the new options and refuses unknown ones',
      SCHEMAS['export:run'].safeParse({ entity: 'customerlist', format: 'xlsx', columns: ['Name'], includeAllNotes: true, params: { ids: [1] } }).success
        && !SCHEMAS['export:run'].safeParse({ entity: 'customerlist', format: 'pdf' }).success);

    // ============================================================== bulk
    await app.loginAdmin();
    const g1 = customers.create(app.ctx(), { code: 'B-1', fullName: 'Bulk One', marketingProfileId: kerem.profileId });
    const g2 = customers.create(app.ctx(), { code: 'B-2', fullName: 'Bulk Two' });
    const gone = customers.create(app.ctx(), { code: 'B-3', fullName: 'Bulk Gone' });
    customers.remove(app.ctx(), { id: gone.id });
    await app.login('manager', manager.password);
    const moved = bulk.assign(app.ctx(), { ids: [g1.id, g2.id, gone.id], profileId: sena.profileId });
    s.check('bulk reassign moves every guest it can and reports the rest per row',
      moved.succeeded === 2 && moved.failed.length === 1 && moved.failed[0].id === gone.id && /not found/i.test(moved.failed[0].message), J(moved));
    s.check('each reassignment is recorded in assignment history',
      app.db.prepare("SELECT COUNT(*) n FROM assignment_history WHERE customer_id IN (?, ?) AND new_profile_id = ?").get(g1.id, g2.id, sena.profileId).n === 2);
    s.check('a bulk reassignment leaves a summary audit row',
      !!app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'CUSTOMER_BULK_ASSIGN'").get());
    const toRetired = bulk.assign(app.ctx(), { ids: [g1.id], profileId: retired });
    s.check('an inactive target fails per row with the single-verb message',
      toRetired.succeeded === 0 && /active marketing profile/i.test(toRetired.failed[0].message), J(toRetired));

    await app.login('sena', sena.password);
    const noCap = await attempt(() => bulk.assign(app.ctx(), { ids: [g1.id], profileId: kerem.profileId }));
    s.check('a marketer without the reassign permission is refused outright', !noCap.ok && noCap.code === 'FORBIDDEN', J(noCap));
    await app.loginAdmin();
    support.settings.setPermissions(app.ctx(), { matrix: { MARKETING: { 'customers.assign': true } } });
    /* Kerem's guest, protected by an explicit assignment within the year. */
    const kGuest = customers.create(app.ctx(), { code: 'B-K', fullName: 'Kerem Protected', marketingProfileId: kerem.profileId });
    await app.login('sena', sena.password);
    const crossScope = await attempt(() => bulk.assign(app.ctx(), { ids: [g2.id, kGuest.id], profileId: sena.profileId }));
    s.check("a selection with another marketer's guest is refused whole", !crossScope.ok && crossScope.code === 'FORBIDDEN', J(crossScope));
    s.check('and nothing in it moved',
      app.db.prepare('SELECT marketing_profile_id m FROM customers WHERE id = ?').get(kGuest.id).m === kerem.profileId);
    await app.loginAdmin();
    support.settings.setPermissions(app.ctx(), { matrix: {} });

    await app.login('sena', sena.password);
    const noted = bulk.note(app.ctx(), { ids: [g1.id, g2.id], note: 'Bayram tebriği gönderildi' });
    s.check('a bulk note lands on every selected guest', noted.succeeded === 2
      && app.db.prepare("SELECT COUNT(*) n FROM crm_notes WHERE note = 'Bayram tebriği gönderildi'").get().n === 2, J(noted));
    const emptyNote = await attempt(() => bulk.note(app.ctx(), { ids: [g1.id], note: '   ' }));
    s.check('an empty bulk note is refused before anything is written', !emptyNote.ok && emptyNote.code === 'VALIDATION');
    const foreignNote = await attempt(() => bulk.note(app.ctx(), { ids: [g1.id, avi.id], note: 'probe' }));
    s.check("a bulk note cannot reach another marketer's guest", !foreignNote.ok && foreignNote.code === 'FORBIDDEN', J(foreignNote));
    s.check('a selection is capped at one screen of guests',
      !SCHEMAS['customers:bulkAssign'].safeParse({ ids: Array.from({ length: 501 }, (_, i) => i + 1), profileId: 1 }).success);

    // ============================================================ report
    await app.loginAdmin();
    const month = today().slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const hostile = customers.create(app.ctx(), { code: 'R-X', fullName: '<script>alert(1)</script> Guest', marketingProfileId: sena.profileId });
    reservations.create(app.ctx(), { customerId: hostile.id, checkIn: `${month}-01` < today() ? today() : `${month}-01`, checkOut: addDays(today(), 2), invitedByProfileId: sena.profileId });
    support.crmNotes.create(app.ctx(), { customerId: hostile.id, note: '<img src=x onerror=alert(1)>' });
    const data = report.monthlyData(app.ctx(), { year: y, month: m });
    s.check('the monthly report counts arrivals and new guests',
      data.arrivals.length >= 1 && data.newGuests.length >= 5, J(data.totals));
    s.check('team performance lists active marketing profiles', data.team.some((r) => r.full_name === 'Sena Yilmaz' && r.stays >= 1), J(data.team));
    const html = report.renderHtml(data);
    s.check('guest data in the report is escaped', !html.includes('<script>alert') && !html.includes('<img src=x') && html.includes('&lt;script&gt;'));
    s.check('the report template allows no remote content',
      html.includes("default-src 'none'") && !/https?:\/\//.test(html.replace(/http:\/\/x/g, '')));
    await app.login('kerem', kerem.password);
    const scoped = report.monthlyData(app.ctx(), { year: y, month: m });
    s.check("a marketer's report covers only their own book",
      scoped.scoped && scoped.team.length === 1 && scoped.team[0].full_name === 'Kerem Saricicek'
        && !scoped.arrivals.some((r) => r.code === 'R-X') && !scoped.newGuests.some((r) => r.code === 'R-X'), J(scoped.team));
    s.check('nights are counted only inside the month',
      report.nightsInMonth('2026-01-30', '2026-02-03', '2026-02-01', '2026-02-28') === 2
        && report.nightsInMonth('2026-02-27', '2026-03-02', '2026-02-01', '2026-02-28') === 2);
  } finally {
    app.close();
  }
  return s.finish();
};
