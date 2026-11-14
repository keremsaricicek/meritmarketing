'use strict';
/* Data tools: guest import, the export dialog, bulk actions on the CRM tables
 * and the monthly PDF report.
 *
 * Nothing here touches a file. The main process opens and saves every file
 * through native dialogs; this side only ever holds an import token, sample
 * rows and verdicts. Every value from a spreadsheet or the database is
 * escaped before it reaches innerHTML, and every control is wired through
 * data-act attributes — the CSP leaves no other way.
 */

/* ============================================================ helpers */

/* Header matching for saved templates: case- and Turkish-letter-insensitive,
   the same fold the main process uses to guess a mapping. */
function foldHeader(text){
  return String(text || '')
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
function columnLetter(i){
  let n = i + 1, out = '';
  while (n > 0){ const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/* ============================================================ import */

const importState = {
  token: null, fileName: '', sheets: [], sheet: 0, headers: [], sample: [], rowCount: 0,
  mapping: {}, fields: [], step: 'file', preview: null, filter: 'all', templates: [],
};
const IMPORT_STEPS = ['file', 'map', 'preview', 'done'];

async function openImportDialog(){
  Object.assign(importState, { token:null, fileName:'', sheets:[], sheet:0, headers:[], sample:[], rowCount:0,
    mapping:{}, step:'file', preview:null, filter:'all' });
  el('importFileName').textContent = t('No file chosen');
  el('importSubtitle').textContent = t('From an Excel workbook (.xlsx) or a CSV file');
  el('importFileOpts').style.display = 'none';
  const choose = el('importChooseBtn');
  choose.textContent = t('Choose file…');
  choose.classList.replace('btn-outline', 'btn-gold');
  const dup = document.querySelector('input[name="importDup"][value="skip"]');
  if (dup) dup.checked = true;
  el('importTemplateName').value = '';
  setImportStep('file');
  openModal('modalImport');
  try { importState.templates = (await call(window.api.import.templates, {}, { silent:true })) || []; }
  catch (_) { importState.templates = []; }
  renderImportTemplates();
}

function setImportStep(step){
  importState.step = step;
  for (const name of IMPORT_STEPS){
    const pane = el('importPane_' + name);
    if (pane) pane.style.display = name === step ? '' : 'none';
  }
  const index = IMPORT_STEPS.indexOf(step);
  document.querySelectorAll('#importSteps li').forEach((li, i) => {
    li.classList.toggle('active', i === index);
    li.classList.toggle('done', i < index);
    if (i === index) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  const next = el('importNextBtn');
  const back = el('importBackBtn');
  const cancel = el('importCancelBtn');
  back.style.display = (step === 'map' || step === 'preview') ? '' : 'none';
  cancel.style.display = step === 'done' ? 'none' : '';
  if (step === 'file'){ next.textContent = t('Next'); next.disabled = !importState.token; }
  if (step === 'map'){ next.textContent = t('Preview'); next.disabled = false; }
  if (step === 'preview'){
    const c = importState.preview?.counts || {};
    const writes = (c.create || 0) + (c.update || 0);
    next.textContent = writes ? tn(writes, 'Import {n} guest', 'Import {n} guests') : t('Nothing to import');
    next.disabled = !writes;
  }
  if (step === 'done'){ next.textContent = t('Done'); next.disabled = false; }
}

function applyImportFile(data){
  importState.token = data.token;
  importState.fileName = data.fileName;
  importState.sheets = data.sheets;
  if (data.fields) importState.fields = data.fields;
  applyImportSheet(data);
  el('importFileName').textContent = data.fileName;
  el('importSubtitle').textContent = data.fileName;
  const choose = el('importChooseBtn');
  choose.textContent = t('Choose another file…');
  choose.classList.replace('btn-gold', 'btn-outline');
  el('importSheet').innerHTML = data.sheets.map(sh =>
    `<option value="${sh.index}">${escapeHtml(sh.name)} (${escapeHtml(plural(sh.rowCount, '{n} row', '{n} rows'))})</option>`).join('');
  el('importSheet').value = String(data.sheet);
  el('importFileOpts').style.display = '';
  setImportStep('file');
}
function applyImportSheet(view){
  importState.sheet = view.sheet;
  importState.headers = view.headers;
  importState.sample = view.sample;
  importState.rowCount = view.rowCount;
  importState.mapping = { ...view.mapping };
  importState.preview = null;
}

async function importChooseFile(){
  await withBusy(el('importChooseBtn'), t('Opening…'), async () => {
    let data = null;
    try { data = await call(window.api.import.choose, {}); } catch (_) { return; }
    if (!data || data.cancelled) return;
    applyImportFile(data);
  });
}

async function importPickSheet(value){
  if (!importState.token) return;
  let view = null;
  try { view = await call(window.api.import.sheet, { token: importState.token, sheet: Number(value) }); } catch (_) { return; }
  if (view) applyImportSheet(view);
}

function renderImportTemplates(){
  const select = el('importTemplate');
  if (!select) return;
  select.innerHTML = importState.templates.length
    ? importState.templates.map(tpl => `<option value="${escapeHtml(tpl.name)}">${escapeHtml(tpl.name)}</option>`).join('')
    : `<option value="">${te('No saved mappings yet')}</option>`;
  const none = !importState.templates.length;
  select.disabled = none;
  el('importTemplateApplyBtn').disabled = none;
  el('importTemplateDeleteBtn').disabled = none;
}

function importApplyTemplate(){
  const name = el('importTemplate').value;
  const template = importState.templates.find(t => t.name === name);
  if (!template){ toast('error', t('No mapping selected')); return; }
  const folded = importState.headers.map(foldHeader);
  const mapping = {};
  let missing = 0;
  for (const [field, header] of Object.entries(template.mapping || {})){
    const index = folded.indexOf(foldHeader(header));
    if (index >= 0) mapping[field] = index; else missing++;
  }
  importState.mapping = mapping;
  toast(missing ? 'error' : 'success', t('Applied “{name}”', { name: template.name }),
    missing ? tn(missing, '{n} column of the template is not in this sheet.', '{n} columns of the template are not in this sheet.') : t('Every column matched.'));
  if (importState.step === 'map') renderImportMapping();
}

async function importDeleteTemplate(){
  const name = el('importTemplate').value;
  if (!name) return;
  if (!(await confirmDialog({ message: t('Delete the saved mapping “{name}”?', { name }) }))) return;
  try { importState.templates = await call(window.api.import.deleteTemplate, { name }) || []; } catch (_) { return; }
  renderImportTemplates();
}

async function importSaveTemplate(){
  const name = el('importTemplateName').value.trim();
  if (!name){ toast('error', t('Name the template first')); el('importTemplateName').focus(); return; }
  const mapping = {};
  for (const [field, index] of Object.entries(importState.mapping)) mapping[field] = importState.headers[index];
  try { importState.templates = await call(window.api.import.saveTemplate, { name, mapping }) || []; } catch (_) { return; }
  renderImportTemplates();
  el('importTemplate').value = name;
  toast('success', t('Mapping saved'), t('Apply “{name}” to the next file with the same headers.', { name }));
}

function renderImportMapping(){
  const options = (selected) => `<option value=""${selected === undefined ? ' selected' : ''}>${te('Not imported')}</option>` +
    importState.headers.map((h, i) =>
      `<option value="${i}"${selected === i ? ' selected' : ''}>${columnLetter(i)} · ${escapeHtml(h)}</option>`).join('');
  el('importMapGrid').innerHTML = importState.fields.map(f => `
    <label class="import-map-label" for="importMap_${escapeHtml(f.key)}">${te(f.label)}</label>
    <select class="fm-input" id="importMap_${escapeHtml(f.key)}" data-act-change="importSetMapping" data-args-change='${escapeHtml(JSON.stringify([f.key, { $: 'value' }]))}'>${options(importState.mapping[f.key])}</select>`).join('');
  const head = importState.headers.map((h, i) => `<th scope="col"><span class="col-letter">${columnLetter(i)}</span> ${escapeHtml(h)}</th>`).join('');
  const body = importState.sample.map(r => `<tr>${r.map(c => `<td title="${escapeHtml(c)}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  el('importSample').innerHTML = importState.headers.length
    ? `<table class="import-sample-table"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${importState.headers.length}" class="muted">${te('This sheet has a header row and no data.')}</td></tr>`}</tbody></table>`
    : `<p class="muted">${te('This sheet is empty.')}</p>`;
}

function importSetMapping(field, value){
  if (value === '' || value === null || value === undefined){ delete importState.mapping[field]; }
  else {
    const index = Number(value);
    /* One column feeds one field. Choosing a column already in use moves it. */
    for (const [other, at] of Object.entries(importState.mapping)) if (other !== field && at === index) delete importState.mapping[other];
    importState.mapping[field] = index;
  }
  importState.preview = null;
  renderImportMapping();
  const select = el('importMap_' + field);
  if (select) select.focus();
}

function importDuplicateMode(){
  return document.querySelector('input[name="importDup"]:checked')?.value === 'update' ? 'update' : 'skip';
}

async function runImportPreview(){
  const m = importState.mapping;
  if (m.fullName === undefined && m.firstName === undefined && m.lastName === undefined){
    toast('error', t('Map the guest name'), t('Choose a Full name column, or Name and Surname columns.'));
    return false;
  }
  let preview = null;
  try {
    preview = await call(window.api.import.preview, {
      token: importState.token, sheet: importState.sheet, mapping: importState.mapping, duplicates: importDuplicateMode() });
  } catch (_) { return false; }
  if (!preview) return false;
  importState.preview = preview;
  importState.filter = 'all';
  renderImportPreview();
  return true;
}

const IMPORT_STATUS = {
  new: { label:'New', cls:'tag-hot' },
  duplicate: { label:'Duplicate', cls:'tag-warm' },
  invalid: { label:'Invalid', cls:'tag-deleted' },
};
const IMPORT_ACTION = { create:'Will be created', update:'Will be updated', skip:'Skipped' };

function renderImportPreview(){
  const p = importState.preview;
  if (!p) return;
  const c = p.counts;
  el('importCounts').innerHTML = `
    <div class="import-count"><b>${c.total}</b><span>${te('rows')}</span></div>
    <div class="import-count ok"><b>${c.new}</b><span>${te('new')}</span></div>
    <div class="import-count warn"><b>${c.duplicate}</b><span>${te('duplicate')}</span></div>
    <div class="import-count bad"><b>${c.invalid}</b><span>${te('invalid')}</span></div>
    <div class="import-count-plan">${c.update
      ? te('Will create {c}, update {u} and skip {s}.', { c: c.create, u: c.update, s: c.skip })
      : te('Will create {c} and skip {s}.', { c: c.create, s: c.skip })}</div>`;
  document.querySelectorAll('#importFilter button').forEach(b => {
    const on = actionArgMatches(b, importState.filter);
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  const rows = p.rows.filter(r => importState.filter === 'all' || r.status === importState.filter);
  const LIMIT = 400;
  const shown = rows.slice(0, LIMIT);
  el('importPreviewBody').innerHTML = shown.length ? shown.map(r => {
    const st = IMPORT_STATUS[r.status] || IMPORT_STATUS.invalid;
    const detail = [r.reason, ...(r.warnings || [])].filter(Boolean).map(tNotice).join(' · ') || t(IMPORT_ACTION[r.action] || '');
    return `<tr>
      <td class="muted n">${r.row}</td>
      <td title="${escapeHtml(r.name)}">${r.name ? escapeHtml(r.name) : '<span class="muted">—</span>'}</td>
      <td>${r.phone ? escapeHtml(r.phone) : '<span class="muted">—</span>'}</td>
      <td>${r.passportNo ? escapeHtml(r.passportNo) : '<span class="muted">—</span>'}</td>
      <td><span class="tag ${st.cls}"><span class="tag-dot"></span>${te(st.label)}</span></td>
      <td class="import-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</td>
    </tr>`;
  }).join('') + (rows.length > LIMIT ? `<tr class="empty-row"><td colspan="6"><div class="import-more">${te('Showing the first {n} of {total} rows.', { n: LIMIT, total: rows.length })}</div></td></tr>` : '')
    : emptyRow(6, emptyState({ icon:'check', title:t('No rows in this group') }));
}

function importFilterRows(kind){
  importState.filter = kind;
  renderImportPreview();
}

async function runImportCommit(){
  const c = importState.preview?.counts;
  if (!c) return false;
  let result = null;
  try {
    result = await call(window.api.import.commit, {
      token: importState.token, sheet: importState.sheet, mapping: importState.mapping, duplicates: importDuplicateMode() });
  } catch (_) { return false; }
  if (!result) return false;
  importState.token = null;
  const problems = (result.problems || []).map(r => `<li><span class="muted">${te('Row {n}', { n: r.row })}</span> ${r.name ? escapeHtml(r.name) : `<span class="muted">${te('(no name)')}</span>`} — ${escapeHtml(tNotice(r.reason))}</li>`).join('');
  el('importSummary').innerHTML = `
    <div class="import-done-head">
      <div class="import-done-title">${escapeHtml(tn(result.created, '{n} guest imported from {file}', '{n} guests imported from {file}', { file: result.fileName }))}</div>
      <div class="setting-hint">${result.updated ? `${escapeHtml(tn(result.updated, '{n} existing guest updated', '{n} existing guests updated'))} · ` : ''}${te('{n} rows skipped ({d} duplicate, {i} invalid) of {total}.', { n: result.skipped, d: result.duplicate, i: result.invalid, total: result.total })}</div>
      ${result.firstCodes?.length ? `<div class="setting-hint">${te('New Guest IDs start at #{code}.', { code: result.firstCodes[0] })}</div>` : ''}
    </div>
    ${problems ? `<div class="form-group-title mt-5">${te('Skipped rows')}</div><ul class="import-problems">${problems}</ul>` : ''}`;
  toast('success', t('Import complete'), result.updated
    ? t('{n} guests created, {u} updated.', { n: result.created, u: result.updated })
    : tn(result.created, '{n} guest created.', '{n} guests created.'));
  refreshCrmViews();
  return true;
}

/* withBusy() restores the button's original label when it finishes, which
   would undo the label the next step sets. This variant lets the step decide. */
async function importBusy(label, fn){
  const btn = el('importNextBtn');
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy'); btn.disabled = true; btn.textContent = label;
  try { await fn(); }
  finally { btn.classList.remove('busy'); setImportStep(importState.step); }
}

async function importNext(){
  if (importState.step === 'file'){
    if (!importState.token) return;
    renderImportMapping();
    setImportStep('map');
    return;
  }
  if (importState.step === 'map'){
    await importBusy(t('Checking…'), async () => { if (await runImportPreview()) setImportStep('preview'); });
    return;
  }
  if (importState.step === 'preview'){
    const c = importState.preview?.counts || {};
    const ok = await confirmDialog({
      message: tn((c.create || 0) + (c.update || 0), 'Import {n} guest?', 'Import {n} guests?'),
      detail: c.update
        ? t('{c} new, {u} updated; {s} rows are skipped. This is written in one step and recorded in the audit log.', { c: c.create || 0, u: c.update, s: c.skip || 0 })
        : t('{c} new; {s} rows are skipped. This is written in one step and recorded in the audit log.', { c: c.create || 0, s: c.skip || 0 }) });
    if (!ok) return;
    await importBusy(t('Importing…'), async () => { if (await runImportCommit()) setImportStep('done'); });
    return;
  }
  closeModal('modalImport');
}

function importBack(){
  if (importState.step === 'preview'){ renderImportMapping(); setImportStep('map'); }
  else if (importState.step === 'map') setImportStep('file');
}

/* ============================================================ export dialog */

const exportDialogState = { entity: null, params: {}, notes: false };

async function openExportDialog(entity, params, label){
  let cols = null;
  try { cols = await call(window.api.export.columns, { entity }); } catch (_) { return; }
  if (!cols) return;
  Object.assign(exportDialogState, { entity, params: params || {}, notes: !!cols.notes });
  el('exportSubtitle').textContent = label || t('What is on screen, with its search and filters');
  el('exportColumns').innerHTML = cols.columns.map((c, i) => `
    <label class="export-col"><input type="checkbox" checked value="${escapeHtml(c)}" id="exportCol_${i}"> ${te(c)}</label>`).join('');
  el('exportNotesWrap').style.display = cols.notes ? '' : 'none';
  el('exportAllNotes').checked = false;
  const xlsx = document.querySelector('input[name="exportFormat"][value="xlsx"]');
  if (xlsx) xlsx.checked = true;
  exportFormatChanged();
  openModal('modalExport');
}

function exportFormatChanged(){
  const xlsx = document.querySelector('input[name="exportFormat"]:checked')?.value === 'xlsx';
  const notes = el('exportAllNotes');
  notes.disabled = !xlsx;
  if (!xlsx) notes.checked = false;
  el('exportNotesWrap').classList.toggle('disabled', !xlsx);
}

function exportSelectColumns(on){
  document.querySelectorAll('#exportColumns input[type=checkbox]').forEach(b => { b.checked = !!on; });
}

async function runExportDialog(){
  const columns = [...document.querySelectorAll('#exportColumns input[type=checkbox]:checked')].map(b => b.value);
  if (!columns.length){ toast('error', t('Choose at least one column')); return; }
  const format = document.querySelector('input[name="exportFormat"]:checked')?.value === 'csv' ? 'csv' : 'xlsx';
  const includeAllNotes = format === 'xlsx' && exportDialogState.notes && el('exportAllNotes').checked;
  await withBusy(el('exportRunBtn'), t('Exporting…'), async () => {
    let r = null;
    try {
      r = await call(window.api.export.run, { entity: exportDialogState.entity, params: exportDialogState.params,
        format, columns, includeAllNotes });
    } catch (_) { return; }
    if (!r) return;
    closeModal('modalExport');
    if (r.cancelled) return;
    toast('success', t('Export complete'), r.notes
      ? t('{n} rows and {m} notes → {file}', { n: r.rows, m: r.notes, file: r.name })
      : t('{n} rows → {file}', { n: r.rows, file: r.name }));
  });
}

/* ============================================================ bulk actions */

const bulkSel = { overview: new Set(), customerlist: new Set() };
const bulkVisible = { overview: [], customerlist: [] };
/* Who each visible row is, so a failure can be named even when the guest has
   since been archived and the main process can no longer say. */
const bulkKnown = new Map();
let bulkView = 'overview';

/** The first cell of a guest row. Its click never opens the guest. */
function bulkCellHTML(view, c){
  const on = bulkSel[view]?.has(c.id) ? ' checked' : '';
  return `<td class="sel-cell" data-act="stopPropagation" data-on="click"><input type="checkbox" class="sel-box"${on} aria-label="${te('Select {name}', { name: c.full_name })}" data-act-change="toggleBulkRow" data-args-change='${escapeHtml(JSON.stringify([view, c.id, { $: 'checked' }]))}'></td>`;
}

/** Called after a table renders: the selection only ever covers this page. */
function bulkAfterRender(view, rows){
  bulkVisible[view] = rows.map(r => r.id);
  for (const r of rows) bulkKnown.set(r.id, { code: r.code, name: r.full_name });
  const visible = new Set(bulkVisible[view]);
  for (const id of [...bulkSel[view]]) if (!visible.has(id)) bulkSel[view].delete(id);
  updateBulkBar(view);
}

function updateBulkBar(view){
  const n = bulkSel[view].size;
  const bar = el('bulkBar_' + view);
  if (bar) bar.style.display = n ? '' : 'none';
  const count = el('bulkCount_' + view);
  if (count) count.textContent = t('{n} selected', { n });
  const assign = bar?.querySelector('.bulk-assign-btn');
  if (assign) assign.style.display = hasCap('customers.assign') ? '' : 'none';
  const all = el('bulkAll_' + view);
  if (all){
    const total = bulkVisible[view].length;
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    all.disabled = total === 0;
  }
}

function toggleBulkRow(view, id, checked){
  if (checked) bulkSel[view].add(Number(id)); else bulkSel[view].delete(Number(id));
  updateBulkBar(view);
}

function toggleBulkPage(view, checked){
  bulkSel[view] = new Set(checked ? bulkVisible[view] : []);
  const body = el(view === 'overview' ? 'custTableBody' : 'listTableBody');
  body?.querySelectorAll('.sel-box').forEach(b => { b.checked = !!checked; });
  updateBulkBar(view);
}

function clearBulkSelection(view){ toggleBulkPage(view, false); }

function bulkIds(view){ return [...bulkSel[view]]; }

function openBulkAssign(view){
  bulkView = view;
  const n = bulkSel[view].size;
  if (!n) return;
  el('bulkAssignSubtitle').textContent = tn(n, '{n} guest selected', '{n} guests selected');
  el('bulkAssignSelect').innerHTML = `<option value="">${te('Choose a marketer…')}</option>` +
    state.profiles.filter(p => p.employment_status === 'active' && (p.kind || 'marketing') === 'marketing')
      .map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');
  el('bulkAssignReason').value = '';
  openModal('modalBulkAssign');
}

async function runBulkAssign(){
  const profileId = el('bulkAssignSelect').value;
  if (!profileId){ toast('error', t('Choose the new owner')); return; }
  const ids = bulkIds(bulkView);
  const reason = el('bulkAssignReason').value.trim();
  await withBusy(el('bulkAssignBtn'), t('Reassigning…'), async () => {
    let r = null;
    try { r = await call(window.api.customers.bulkAssign, omitBlank({ ids, profileId: Number(profileId), reason })); } catch (_) { return; }
    if (!r) return;
    closeModal('modalBulkAssign');
    showBulkResult(t('Reassign owner'), r, ids.length, 'reassigned');
    clearBulkSelection(bulkView);
    refreshCrmViews();
  });
}

function openBulkNote(view){
  bulkView = view;
  const n = bulkSel[view].size;
  if (!n) return;
  el('bulkNoteSubtitle').textContent = tn(n, 'The same note on {n} guest', 'The same note on {n} guests');
  el('bulkNoteDate').value = todayYMD();
  el('bulkNoteText').value = '';
  openModal('modalBulkNote');
  setTimeout(() => el('bulkNoteText').focus(), 60);
}

async function runBulkNote(){
  const note = el('bulkNoteText').value.trim();
  if (!note){ toast('error', t('Write the note first')); return; }
  const ids = bulkIds(bulkView);
  const noteDate = el('bulkNoteDate').value;
  await withBusy(el('bulkNoteBtn'), t('Adding…'), async () => {
    let r = null;
    try { r = await call(window.api.crmNotes.bulkCreate, omitBlank({ ids, note, noteDate })); } catch (_) { return; }
    if (!r) return;
    closeModal('modalBulkNote');
    showBulkResult(t('Add CRM note'), r, ids.length, 'noted');
    clearBulkSelection(bulkView);
    refreshCrmViews();
  });
}

function exportSelected(view){
  const ids = bulkIds(view);
  if (!ids.length) return;
  openExportDialog('customerlist', { ids }, tn(ids.length, '{n} selected guest', '{n} selected guests'));
}

/* A short toast when everything worked; a dialog listing each failure when
   something did not, because a partial result must not look like success. */
function showBulkResult(title, r, requested, verb){
  if (!r.failed?.length){
    toast('success', title, verb === 'noted' ? tn(r.succeeded, '{n} guest noted.', '{n} guests noted.') : tn(r.succeeded, '{n} guest reassigned.', '{n} guests reassigned.'));
    return;
  }
  el('bulkResultTitle').textContent = `${title}: ${t('{n} of {total} done', { n: r.succeeded, total: requested })}`;
  el('bulkResultBody').innerHTML = `
    <p>${escapeHtml(verb === 'noted' ? tn(r.succeeded, '{n} guest noted.', '{n} guests noted.') : tn(r.succeeded, '{n} guest reassigned.', '{n} guests reassigned.'))} ${escapeHtml(tn(r.failed.length, '{n} guest could not be changed:', '{n} guests could not be changed:'))}</p>
    <ul class="import-problems">${r.failed.map(f => {
      const who = f.code ? f : (bulkKnown.get(f.id) || {});
      const label = who.code ? `<span class="muted">#${escapeHtml(who.code)}</span> ${escapeHtml(who.name)}` : `<span class="muted">${te('Guest')} ${escapeHtml(f.id)}</span>`;
      return `<li>${label} — ${escapeHtml(tNotice(f.message))}</li>`;
    }).join('')}</ul>`;
  openModal('modalBulkResult');
}

/* ============================================================ monthly report */

function openMonthlyReport(){
  const input = el('monthlyReportMonth');
  const now = todayYMD();
  input.max = now.slice(0, 7);
  if (!input.value) input.value = now.slice(0, 7);
  el('monthlyReportScope').textContent = state.session?.role === 'MARKETING'
    ? t('Covers your own guests and invitations')
    : t('Covers the whole team');
  openModal('modalMonthlyReport');
}

async function runMonthlyReport(){
  const value = el('monthlyReportMonth').value;
  const m = /^(\d{4})-(\d{2})$/.exec(value || '');
  if (!m){ toast('error', t('Choose a month')); return; }
  await withBusy(el('monthlyReportBtn'), t('Creating…'), async () => {
    let r = null;
    try { r = await call(window.api.reports.monthlyPdf, { year: Number(m[1]), month: Number(m[2]) }); } catch (_) { return; }
    if (!r) return;
    closeModal('modalMonthlyReport');
    if (!r.cancelled) toast('success', t('Monthly report saved'), `${r.label} → ${r.name}`);
  });
}
