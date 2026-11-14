'use strict';
/* DATA TOOLS, DRIVEN IN THE REAL APPLICATION.
 *
 * Import from the committed .xlsx fixture through every step of the dialog,
 * bulk selection and bulk actions on CRM Overview, the export dialog writing
 * a real .xlsx, and the monthly PDF — all against the real main process, a
 * real database and the real offscreen printer. Native dialogs are the only
 * thing replaced: the probe answers them with a fixture path and a file in
 * the test's own temporary folder, exactly where the operator would click.
 *
 * Set MERIT_SHOT_DIR to keep screenshots of each screen at 1440x900 and
 * 1366x768.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const PW = 'harbour-lantern-quiet';
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'import', 'misafirler.xlsx');

const PROBE = `
const path = require('path');
const fs = require('fs');
const { app, dialog } = require('electron');
app.setPath('userData', process.env.MERIT_TEST_USERDATA);
const OUT = path.join(process.env.MERIT_TEST_USERDATA, 'saved');
fs.mkdirSync(OUT, { recursive: true });
const saved = [];
/* The operator's clicks in the native dialogs. */
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(FIXTURE)}] });
dialog.showSaveDialog = async (_w, opts) => {
  const file = path.join(OUT, path.basename(opts.defaultPath));
  saved.push(file);
  return { canceled: false, filePath: file };
};
require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))});
const consoleErrors = [];
const SHOTS = process.env.MERIT_SHOT_DIR || '';

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  let win = null;
  const started = Date.now();
  while (!win && Date.now() - started < 20000) {
    win = BrowserWindow.getAllWindows()[0] || null;
    if (!win) await new Promise(r => setTimeout(r, 200));
  }
  if (!win) { console.log('PROBE:' + JSON.stringify({ error: 'no window' })); app.exit(1); return; }
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) consoleErrors.push({ message, source: String(source).split('/').pop(), line });
  });
  if (win.webContents.isLoading()) await new Promise(r => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);
  const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));
  const SIZES = [[1440, 900], [1366, 768]];
  const shot = async (name) => {
    if (!SHOTS) return;
    await settle(250);
    const image = await win.webContents.capturePage();
    const size = win.getContentSize().join('x');
    fs.writeFileSync(path.join(SHOTS, name + '-' + size + '.png'), image.toPNG());
  };
  /* Layout facts at the current size: nothing wider than the window. */
  const layout = (selector) => js(\`(() => {
    const node = document.querySelector(\${JSON.stringify(selector)});
    if (!node) return { missing: true };
    const r = node.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
      width: Math.round(r.width), height: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      docOverflow: document.documentElement.scrollWidth > innerWidth };
  })()\`);
  win.setContentSize(1440, 900);
  await settle(600);
  const out = { layout: {} };

  await js(\`(() => {
    document.getElementById('setupName').value = 'Owner Person';
    document.getElementById('setupUser').value = 'owner';
    document.getElementById('setupPass').value = ${JSON.stringify(PW)};
    document.getElementById('setupPass2').value = ${JSON.stringify(PW)};
    document.getElementById('setupBtn').click();
  })()\`);
  await settle(2500);

  out.seed = await js(\`(async () => {
    const a = window.api;
    const sena = (await a.profiles.create({ fullName: 'Sena Yilmaz' })).data;
    const kerem = (await a.profiles.create({ fullName: 'Kerem Saricicek' })).data;
    await a.users.create({ username: 'sena', password: ${JSON.stringify(PW)}, role: 'MARKETING', profileId: sena.id, fullName: 'Sena Yilmaz', active: true });
    const ids = [];
    for (const [code, name, owner] of [['G2001', 'Leyla Demir', kerem.id], ['G2002', 'Omar Haddad', kerem.id], ['G2003', 'Nina Petrova', null], ['G2004', 'Thomas Weber', sena.id]]) {
      const r = await a.customers.create({ code, fullName: name, registered: true, marketingProfileId: owner,
        passportNo: name === 'Thomas Weber' ? 'C01X00T47' : null });
      ids.push(r.data.id);
    }
    await a.crmNotes.create({ customerId: ids[0], note: 'Asked about the spring tournament.' });
    await refreshProfiles();
    return { ids, sena: sena.id, kerem: kerem.id };
  })()\`);

  // ------------------------------------------------------------ import
  for (const [w, h] of SIZES) {
    win.setContentSize(w, h); await settle(300);
    out.importOpen = await js(\`(async () => {
      await switchTab('customers'); await new Promise(x => setTimeout(x, 700));
      document.querySelector('#crmAction_overview [data-act="openImportDialog"]').click();
      await new Promise(x => setTimeout(x, 500));
      const r = { shown: document.getElementById('modalImport').classList.contains('show'),
        nextDisabled: document.getElementById('importNextBtn').disabled };
      document.getElementById('importChooseBtn').click();
      await new Promise(x => setTimeout(x, 1200));
      r.file = document.getElementById('importFileName').textContent;
      r.sheets = [...document.getElementById('importSheet').options].map(o => o.textContent);
      r.nextEnabled = !document.getElementById('importNextBtn').disabled;
      return r;
    })()\`);
    await shot('import-1-file');
    out.importMap = await js(\`(async () => {
      document.getElementById('importNextBtn').click();
      await new Promise(x => setTimeout(x, 400));
      const val = (k) => { const s = document.getElementById('importMap_' + k); return s ? s.options[s.selectedIndex].textContent : null; };
      return { first: val('firstName'), last: val('lastName'), phone: val('phone'), power: val('gamingPower'), owner: val('owner'),
        fullName: val('fullName'), sampleRows: document.querySelectorAll('#importSample tbody tr').length,
        sampleHasTurkish: document.getElementById('importSample').textContent.includes('Yıldız') };
    })()\`);
    await shot('import-2-columns');
    out.layout['importModal-' + w] = await layout('#modalImport .modal');
    out.layout['importSample-' + w] = await layout('#importSample');
    out.importPreview = await js(\`(async () => {
      document.getElementById('importNextBtn').click();
      await new Promise(x => setTimeout(x, 900));
      const statuses = [...document.querySelectorAll('#importPreviewBody tr')].map(t => t.children[4]?.textContent.trim());
      return { counts: document.getElementById('importCounts').innerText, statuses,
        next: document.getElementById('importNextBtn').textContent };
    })()\`);
    await shot('import-3-preview');
    out.layout['importPreview-' + w] = await layout('.import-preview-table');
    if (w === 1440) {
      // Back and close at the first size; the import itself runs at the second.
      await js(\`closeModal('modalImport')\`);
      continue;
    }
    await js(\`document.getElementById('importNextBtn').click()\`);
    await settle(500);
    out.confirm = await js(\`(() => {
      const box = document.getElementById('appConfirm');
      const text = box ? box.innerText : null;
      box?.querySelector('.btn-destructive-solid')?.click();
      return text;
    })()\`);
    await settle(1500);
    out.importDone = await js(\`(() => ({
      summary: document.getElementById('importSummary').innerText,
      next: document.getElementById('importNextBtn').textContent,
      problems: document.querySelectorAll('#importSummary .import-problems li').length,
    }))()\`);
    await shot('import-4-summary');
    await js(\`document.getElementById('importNextBtn').click()\`);
    await settle(800);
  }
  out.imported = await js(\`(async () => {
    const list = (await window.api.customers.list({ search: 'IMP-', pageSize: 100 })).data.rows;
    const audit = (await window.api.audit.list({ action: 'CUSTOMER_IMPORT' })).data.rows;
    return { codes: list.map(r => r.code).sort(), names: list.map(r => r.full_name).sort(), audit: audit.map(a => a.description) };
  })()\`);

  // ----------------------------------------------------------- bulk bar
  for (const [w, h] of SIZES) {
    win.setContentSize(w, h); await settle(300);
    out.bulk = await js(\`(async () => {
      await switchTab('customers'); await setCrmView('overview'); await new Promise(x => setTimeout(x, 800));
      clearBulkSelection('overview');
      const boxes = [...document.querySelectorAll('#custTableBody .sel-box')];
      const r = { boxes: boxes.length, barHiddenAtRest: document.getElementById('bulkBar_overview').style.display === 'none' };
      boxes[0].click(); boxes[1].click();
      await new Promise(x => setTimeout(x, 200));
      r.count = document.getElementById('bulkCount_overview').textContent;
      r.barShown = document.getElementById('bulkBar_overview').style.display !== 'none';
      r.panelStillEmpty = document.getElementById('detailPanel').classList.contains('empty');
      r.headerIndeterminate = document.getElementById('bulkAll_overview').indeterminate;
      return r;
    })()\`);
    await shot('bulk-1-bar');
    out.layout['bulkBar-' + w] = await layout('#bulkBar_overview');
    out.layout['custTable-' + w] = await layout('#custTableView .table-wrap');
    out.layout['nameHeader-' + w] = await layout('#crmPane_overview thead th:nth-child(3)');
    out.layout['selHeader-' + w] = await layout('#crmPane_overview thead th:nth-child(1)');
    out.headerFit = out.headerFit || {};
    out.headerFit[w] = await js(\`(() => [...document.querySelectorAll('#crmPane_overview thead th')]
      .filter(th => th.offsetParent).map(th => ({ text: th.textContent.trim(), fits: th.scrollWidth <= th.clientWidth + 1 })))()\`);
  }
  out.selectAll = await js(\`(async () => {
    const all = document.getElementById('bulkAll_overview');
    all.click(); await new Promise(x => setTimeout(x, 200));
    const r = { count: document.getElementById('bulkCount_overview').textContent,
      rows: document.querySelectorAll('#custTableBody tr').length };
    all.click(); await new Promise(x => setTimeout(x, 200));
    r.afterClear = document.getElementById('bulkBar_overview').style.display === 'none';
    return r;
  })()\`);

  // Select the three seeded guests owned by Kerem / nobody and act on them.
  const pick = \`(async () => {
    clearBulkSelection('overview');
    for (const tr of document.querySelectorAll('#custTableBody tr')) {
      if (/Leyla Demir|Omar Haddad|Nina Petrova/.test(tr.textContent)) tr.querySelector('.sel-box').click();
    }
    await new Promise(x => setTimeout(x, 150));
    return document.getElementById('bulkCount_overview').textContent;
  })()\`;
  out.picked = await js(pick);
  out.bulkNote = await js(\`(async () => {
    document.querySelector('#bulkBar_overview [data-act="openBulkNote"]').click();
    await new Promise(x => setTimeout(x, 300));
    document.getElementById('bulkNoteText').value = 'Sent the Bayram greeting.';
    document.getElementById('bulkNoteBtn').click();
    await new Promise(x => setTimeout(x, 1200));
    return { modalClosed: !document.getElementById('modalBulkNote').classList.contains('show'),
      cleared: document.getElementById('bulkBar_overview').style.display === 'none' };
  })()\`);
  out.picked2 = await js(pick);
  for (const [w, h] of SIZES) {
    win.setContentSize(w, h); await settle(300);
    await js(\`document.querySelector('#bulkBar_overview [data-act="openBulkAssign"]').click()\`);
    await settle(400);
    await shot('bulk-2-reassign');
    out.layout['bulkAssign-' + w] = await layout('#modalBulkAssign .modal');
    if (w === 1440) await js(\`closeModal('modalBulkAssign')\`);
  }
  out.bulkAssign = await js(\`(async () => {
    const sel = document.getElementById('bulkAssignSelect');
    sel.value = [...sel.options].find(o => o.textContent === 'Sena Yilmaz').value;
    document.getElementById('bulkAssignBtn').click();
    await new Promise(x => setTimeout(x, 1500));
    const rows = (await window.api.customers.list({ pageSize: 100 })).data.rows;
    return { owners: rows.filter(r => /Leyla Demir|Omar Haddad|Nina Petrova/.test(r.full_name)).map(r => r.marketing_name),
      noteCounts: rows.filter(r => /Leyla Demir|Omar Haddad|Nina Petrova/.test(r.full_name)).map(r => r.note_count) };
  })()\`);

  // A partial failure: archive one guest after selecting it.
  out.partial = await js(\`(async () => {
    await refreshCrmViews(); await new Promise(x => setTimeout(x, 600));
    clearBulkSelection('overview');
    const rows = [...document.querySelectorAll('#custTableBody tr')].filter(tr => /Leyla Demir|Omar Haddad/.test(tr.textContent));
    rows.forEach(tr => tr.querySelector('.sel-box').click());
    const omar = (await window.api.customers.list({ search: 'Omar Haddad' })).data.rows[0];
    await window.api.customers.delete({ id: omar.id });
    document.querySelector('#bulkBar_overview [data-act="openBulkNote"]').click();
    await new Promise(x => setTimeout(x, 300));
    document.getElementById('bulkNoteText').value = 'Second greeting.';
    document.getElementById('bulkNoteBtn').click();
    await new Promise(x => setTimeout(x, 1200));
    return { resultShown: document.getElementById('modalBulkResult').classList.contains('show'),
      title: document.getElementById('bulkResultTitle').textContent,
      body: document.getElementById('bulkResultBody').innerText };
  })()\`);
  for (const [w, h] of SIZES) { win.setContentSize(w, h); await settle(300); await shot('bulk-3-partial-result'); }
  await js(\`closeModal('modalBulkResult')\`);

  // -------------------------------------------------------- export dialog
  out.picked3 = await js(\`(async () => {
    await refreshCrmViews(); await new Promise(x => setTimeout(x, 600));
    clearBulkSelection('overview');
    for (const tr of document.querySelectorAll('#custTableBody tr')) {
      if (/Leyla Demir|Ayşe Yıldız/.test(tr.textContent)) tr.querySelector('.sel-box').click();
    }
    return document.getElementById('bulkCount_overview').textContent;
  })()\`);
  for (const [w, h] of SIZES) {
    win.setContentSize(w, h); await settle(300);
    await js(\`document.querySelector('#bulkBar_overview [data-act="exportSelected"]').click()\`);
    await settle(600);
    await shot('export-dialog');
    out.layout['export-' + w] = await layout('#modalExport .modal');
    if (w === 1440) await js(\`closeModal('modalExport')\`);
  }
  out.exportRun = await js(\`(async () => {
    const r = { subtitle: document.getElementById('exportSubtitle').textContent,
      columns: document.querySelectorAll('#exportColumns input').length,
      notesVisible: document.getElementById('exportNotesWrap').style.display !== 'none' };
    document.querySelector('input[name="exportFormat"][value="csv"]').click();
    r.notesDisabledForCsv = document.getElementById('exportAllNotes').disabled;
    document.querySelector('input[name="exportFormat"][value="xlsx"]').click();
    document.getElementById('exportAllNotes').click();
    document.querySelectorAll('#exportColumns input').forEach(b => { b.checked = ['Guest ID', 'Name', 'Latest CRM note', 'Latest note by'].includes(b.value); });
    document.getElementById('exportRunBtn').click();
    await new Promise(x => setTimeout(x, 1500));
    r.closed = !document.getElementById('modalExport').classList.contains('show');
    return r;
  })()\`);
  {
    const ExcelJS = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'exceljs'))});
    const file = saved.find(f => f.endsWith('.xlsx'));
    out.exportFile = { exists: !!file && fs.existsSync(file) };
    if (out.exportFile.exists) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(fs.readFileSync(file));
      out.exportFile.sheets = wb.worksheets.map(s => s.name);
      out.exportFile.header = wb.worksheets[0].getRow(1).values.slice(1);
      out.exportFile.names = wb.worksheets[0].getColumn(2).values.slice(2).sort();
      out.exportFile.notes = wb.worksheets[1] ? wb.worksheets[1].rowCount - 1 : null;
    }
  }

  // ------------------------------------------------------- monthly report
  for (const [w, h] of SIZES) {
    win.setContentSize(w, h); await settle(300);
    out.reportOpen = await js(\`(async () => {
      await switchTab('reports'); await new Promise(x => setTimeout(x, 700));
      document.getElementById('monthlyReportOpenBtn').click();
      await new Promise(x => setTimeout(x, 400));
      return { month: document.getElementById('monthlyReportMonth').value,
        scope: document.getElementById('monthlyReportScope').textContent };
    })()\`);
    await shot('report-monthly');
    out.layout['reportHead-' + w] = await layout('#page-reports .page-head');
    if (w === 1440) await js(\`closeModal('modalMonthlyReport')\`);
  }
  out.reportRun = await js(\`(async () => {
    document.getElementById('monthlyReportBtn').click();
    await new Promise(x => setTimeout(x, 4000));
    const audit = (await window.api.audit.list({ action: 'REPORT_MONTHLY_PDF' })).data.rows;
    return { closed: !document.getElementById('modalMonthlyReport').classList.contains('show'), audit: audit.length };
  })()\`);
  {
    const pdf = saved.find(f => f.endsWith('.pdf'));
    out.pdf = { exists: !!pdf && fs.existsSync(pdf) };
    if (out.pdf.exists) {
      const bytes = fs.readFileSync(pdf);
      out.pdf.magic = bytes.slice(0, 5).toString('latin1');
      out.pdf.size = bytes.length;
      if (SHOTS) fs.copyFileSync(pdf, path.join(SHOTS, 'monthly-report.pdf'));
    }
    out.windowsAfter = BrowserWindow.getAllWindows().length;
  }

  // --------------------------------------------------------- a marketer
  win.setContentSize(1366, 768); await settle(300);
  out.marketing = await js(\`(async () => {
    await window.api.auth.logout({});
    const s = await window.api.auth.login({ username: 'sena', password: ${JSON.stringify(PW)} });
    if (!s.ok) return { signInFailed: true };
    state.session = s.data; await enterApp(); await new Promise(x => setTimeout(x, 900));
    await switchTab('customers'); await setCrmView('overview'); await new Promise(x => setTimeout(x, 800));
    const r = { rows: document.querySelectorAll('#custTableBody tr').length };
    document.querySelector('#custTableBody .sel-box')?.click();
    await new Promise(x => setTimeout(x, 200));
    const assign = document.querySelector('#bulkBar_overview .bulk-assign-btn');
    r.assignHidden = !assign || assign.style.display === 'none';
    r.barShown = document.getElementById('bulkBar_overview').style.display !== 'none';
    return r;
  })()\`);
  await shot('marketing-bulk-bar');
  Object.assign(out.marketing, await js(\`(async () => {
    const r = {};
    await switchTab('reports'); await new Promise(x => setTimeout(x, 500));
    document.getElementById('monthlyReportOpenBtn').click();
    await new Promise(x => setTimeout(x, 300));
    r.scope = document.getElementById('monthlyReportScope').textContent;
    closeModal('modalMonthlyReport');
    return r;
  })()\`));

  out.consoleErrors = consoleErrors;
  console.log('PROBE:' + JSON.stringify(out));
  app.exit(0);
}).catch((err) => {
  console.log('PROBE:' + JSON.stringify({ error: err.message, stack: String(err.stack).split('\\n').slice(0, 5) }));
  app.exit(1);
});
`;

function runElectron(userData, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const probeFile = path.join(userData, 'data-tools-entry.js');
    fs.writeFileSync(probeFile, PROBE);
    const useXvfb = process.platform === 'linux';
    const command = useXvfb ? 'xvfb-run' : ELECTRON;
    const args = useXvfb ? ['-a', ELECTRON, '--no-sandbox', probeFile] : [probeFile];
    const env = { ...process.env, MERIT_TEST_USERDATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { env, cwd: ROOT });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, stdout, stderr }); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

module.exports = async function () {
  const s = new Suite('electron/data-tools-ui');
  if (!fs.existsSync(ELECTRON)) {
    s.check('the Electron binary is installed', false, `not found at ${ELECTRON}`);
    return s.finish();
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mmh-datatools-ui-'));
  try {
    const run = await runElectron(userData);
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE:'));
    s.check('the application starts and the data-tools probe completes', !!line,
      `exit=${run.code} timedOut=${!!run.timedOut}\n${run.stdout.slice(-800)}\n${run.stderr.slice(-1200)}`);
    if (!line) return s.finish();
    const p = JSON.parse(line.slice('PROBE:'.length));
    if (p.error) {
      s.check('the probe ran without throwing', false, `${p.error}\n${(p.stack || []).join('\n')}`);
      return s.finish();
    }
    const J = (v) => JSON.stringify(v);

    // import
    s.check('Import guests opens with Next disabled until a file is chosen',
      p.importOpen.shown && p.importOpen.nextDisabled === true, J(p.importOpen));
    s.check('the chosen file and its sheets are shown, never a path',
      p.importOpen.file === 'misafirler.xlsx' && p.importOpen.sheets.length === 2 && p.importOpen.nextEnabled, J(p.importOpen));
    s.check('Turkish headers are mapped automatically',
      /Ad$/.test(p.importMap.first) && /Soyad$/.test(p.importMap.last) && /Telefon$/.test(p.importMap.phone)
        && /Oyun Gücü$/.test(p.importMap.power) && /Pazarlamacı$/.test(p.importMap.owner) && p.importMap.fullName === 'Not imported', J(p.importMap));
    s.check('the first rows of the sheet are shown with Turkish text intact',
      p.importMap.sampleRows === 8 && p.importMap.sampleHasTurkish, J(p.importMap));
    s.check('the preview shows the counts and a status per row',
      /8 rows 3 new 2 duplicate 3 invalid/.test(p.importPreview.counts.replace(/\s+/g, ' '))
        && p.importPreview.statuses.filter((x) => x === 'Invalid').length === 3, J(p.importPreview));
    s.check('the import button says how many guests it writes', p.importPreview.next === 'Import 3 guests', p.importPreview.next);
    s.check('importing asks for confirmation first', /Import 3 guests\?/.test(p.confirm || ''), String(p.confirm));
    s.check('the summary reports what happened',
      /3 guests imported from misafirler\.xlsx/.test(p.importDone.summary) && p.importDone.problems === 5 && p.importDone.next === 'Done',
      J(p.importDone));
    s.check('the imported guests are in the book with generated Guest IDs',
      p.imported.codes.length === 3 && p.imported.codes.every((c) => /^IMP-\d{6}-\d{4}$/.test(c))
        && p.imported.names.includes('Ayşe Yıldız'), J(p.imported));
    s.check('the import left one audit row with its counts',
      p.imported.audit.length === 1 && /3 created/.test(p.imported.audit[0]), J(p.imported.audit));

    // bulk
    s.check('every guest row has a selection checkbox', p.bulk.boxes >= 7, J(p.bulk));
    s.check('the bulk bar is hidden until something is selected', p.bulk.barHiddenAtRest, J(p.bulk));
    s.check('selecting rows shows the bar with a count', p.bulk.barShown && p.bulk.count === '2 selected', J(p.bulk));
    s.check('clicking a checkbox does not open the guest', p.bulk.panelStillEmpty, J(p.bulk));
    s.check('a partial page selection shows as indeterminate', p.bulk.headerIndeterminate === true, J(p.bulk));
    s.check('Select all on page selects every row on the page',
      p.selectAll.count === `${p.selectAll.rows} selected` && p.selectAll.afterClear, J(p.selectAll));
    s.check('three seeded guests are selected for the bulk actions', p.picked === '3 selected' && p.picked2 === '3 selected', `${p.picked} / ${p.picked2}`);
    s.check('a bulk note closes its dialog and clears the selection', p.bulkNote.modalClosed && p.bulkNote.cleared, J(p.bulkNote));
    s.check('bulk reassign moves every selected guest to the chosen owner',
      J(p.bulkAssign.owners) === J(['Sena Yilmaz', 'Sena Yilmaz', 'Sena Yilmaz']), J(p.bulkAssign));
    s.check('the bulk note landed on every selected guest',
      p.bulkAssign.noteCounts.sort().join(',') === '1,1,2', J(p.bulkAssign.noteCounts));
    s.check('a partial failure is listed per guest, not hidden behind a success toast',
      p.partial.resultShown && /1 of 2 done/.test(p.partial.title) && /not found/i.test(p.partial.body), J(p.partial));

    // export
    s.check('Export selected opens the export dialog for the selection',
      p.picked3 === '2 selected' && /2 selected guests/.test(p.exportRun.subtitle) && p.exportRun.columns >= 10, J(p.exportRun));
    s.check('all notes are offered for Excel only', p.exportRun.notesVisible && p.exportRun.notesDisabledForCsv, J(p.exportRun));
    s.check('the .xlsx holds the selected guests and chosen columns',
      p.exportFile.exists && J(p.exportFile.header) === J(['Guest ID', 'Name', 'Latest CRM note', 'Latest note by'])
        && J(p.exportFile.names) === J(['Ayşe Yıldız', 'Leyla Demir']), J(p.exportFile));
    s.check('the notes sheet holds every note of the selection',
      J(p.exportFile.sheets) === J(['Guests', 'CRM notes']) && p.exportFile.notes === 3, J(p.exportFile));

    // report
    s.check('the monthly report defaults to this month and says its scope',
      /^\d{4}-\d{2}$/.test(p.reportOpen.month) && p.reportOpen.scope === 'Covers the whole team', J(p.reportOpen));
    s.check('the monthly report is a real PDF', p.pdf.exists && p.pdf.magic === '%PDF-' && p.pdf.size > 5000, J(p.pdf));
    s.check('creating the report is audited', p.reportRun.closed && p.reportRun.audit === 1, J(p.reportRun));
    s.check('the offscreen printing window is gone afterwards', p.windowsAfter === 1, String(p.windowsAfter));

    // layout
    for (const [key, box] of Object.entries(p.layout)) {
      s.check(`layout: ${key} fits the window`,
        !box.missing && box.left >= 0 && box.right <= box.vw && !box.docOverflow, J(box));
    }
    for (const w of [1440, 1366]) {
      const bar = p.layout[`bulkBar-${w}`];
      s.check(`layout: the bulk bar is one line at ${w}`, bar && bar.height <= 52, J(bar));
      const name = p.layout[`nameHeader-${w}`];
      s.check(`layout: the name column stays readable at ${w}`, name && name.width >= 120, J(name));
      const clipped = (p.headerFit[w] || []).filter((h) => !h.fits).map((h) => h.text);
      s.check(`layout: every Overview header fits its column at ${w}`, clipped.length === 0, J(clipped));
      const modal = p.layout[`importModal-${w}`];
      s.check(`layout: the import dialog fits vertically at ${w}`, modal && modal.top >= 0 && modal.bottom <= modal.vh, J(modal));
      const sample = p.layout[`importSample-${w}`];
      s.check(`layout: the sample rows have room at ${w}`, sample && sample.height >= 150, J(sample));
    }

    // marketer
    s.check("a marketer sees only their own guests and no Reassign owner button",
      p.marketing.rows === 5 && p.marketing.barShown && p.marketing.assignHidden, J(p.marketing));
    s.check("a marketer's monthly report says it covers their own book",
      p.marketing.scope === 'Covers your own guests and invitations', J(p.marketing));

    s.check('the renderer logged no errors or warnings', p.consoleErrors.length === 0,
      p.consoleErrors.map((e) => `${e.source}:${e.line} ${e.message}`).join(' | '));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return s.finish();
};
