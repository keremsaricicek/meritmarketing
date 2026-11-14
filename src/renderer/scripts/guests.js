'use strict';
/* =====================================================================
   Guest features (1.2): follow-up reminders, quick note templates,
   duplicate warnings, merging, tags, birthdays and special dates, saved
   views, keyboard shortcuts and recently viewed guests.

   Same rules as every other screen: every figure comes from the main
   process, every interpolated value goes through escapeHtml, and every
   control is a data-act name resolved by the delegated dispatcher.
   ===================================================================== */

/* ---------------- shared ---------------- */
const TAG_PALETTE = ['slate','red','orange','amber','green','teal','blue','violet','pink','gold'];
const TAG_PALETTE_LABEL = { slate:'Slate', red:'Red', orange:'Orange', amber:'Amber', green:'Green',
  teal:'Teal', blue:'Blue', violet:'Violet', pink:'Pink', gold:'Gold' };
const DEFAULT_NOTE_TEMPLATES = ['Called, no answer', 'Called, interested', 'Offer sent', 'Will call back',
  'Invitation accepted', 'Not interested'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function shortDay(ymd){
  if (!ymd) return '';
  const [, m, d] = String(ymd).split('-').map(Number);
  return `${d} ${MONTH_SHORT[m - 1] ? t(MONTH_SHORT[m - 1]) : ''}`;
}
/* "today", "tomorrow", "in 3 days", "2 days ago" — for a business date. */
function relativeDay(ymd){
  const n = daysBetween(todayYMD(), String(ymd).slice(0, 10));
  if (!Number.isFinite(n)) return '';
  if (n === 0) return t('today');
  if (n === 1) return t('tomorrow');
  if (n === -1) return t('yesterday');
  return n > 0 ? t('in {n} days', { n }) : t('{n} days ago', { n: -n });
}
function excerpt(text, max = 90){
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/* =====================================================================
   NOTE TEMPLATES
   ===================================================================== */
function noteTemplates(){
  const raw = state.settings?.['crm.note_templates'];
  if (raw){
    try { const list = JSON.parse(raw); if (Array.isArray(list)) return list.map(String).filter(Boolean); } catch (_) {}
  }
  /* The built-in set follows the operator's language until somebody saves
     their own list. */
  return DEFAULT_NOTE_TEMPLATES.map(x => t(x));
}
function noteTemplatesHTML(inputId){
  const list = noteTemplates();
  if (!list.length) return '';
  return `<div class="note-templates" role="group" aria-label="${te('Quick note templates')}">${list.map((tpl, i) =>
    `<button type="button" class="tpl-chip" data-act="applyNoteTemplate" data-on="click" data-args='["${jsonAttr(inputId)}",${i}]'>${escapeHtml(tpl)}</button>`
  ).join('')}</div>`;
}
/* One click writes the template; a second template is added on its own line
   rather than replacing what is already there. */
function applyNoteTemplate(inputId, index){
  const input = el(inputId);
  const text = noteTemplates()[index];
  if (!input || !text) return;
  const current = input.value.trim();
  input.value = current ? `${current}\n${text}` : text;
  input.focus();
  input.setSelectionRange?.(input.value.length, input.value.length);
}
function renderTemplateSettings(){
  const box = el('setNoteTemplates');
  if (box) box.value = noteTemplates().join('\n');
}
async function saveNoteTemplates(){
  const lines = (el('setNoteTemplates')?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  try {
    await call(window.api.settings.set, { key:'crm.note_templates', value: JSON.stringify(lines) }, { silent:true });
    state.settings['crm.note_templates'] = JSON.stringify(lines);
    toast('success', t('Templates saved'));
  } catch (e){ toast('error', t('Templates not saved'), e.message); }
}
async function resetNoteTemplates(){
  const box = el('setNoteTemplates');
  if (box) box.value = DEFAULT_NOTE_TEMPLATES.map(x => t(x)).join('\n');
  await saveNoteTemplates();
}

/* =====================================================================
   REMINDERS
   ===================================================================== */
function reminderDuePill(r){
  const days = daysBetween(todayYMD(), r.due_date);
  if (days < 0) return `<span class="due-pill urgent">${te('overdue {n}d', { n: -days })}</span>`;
  if (days === 0) return `<span class="due-pill soon">${te('today')}</span>`;
  return `<span class="due-pill">${escapeHtml(shortDay(r.due_date))}</span>`;
}
/* The guest panel's follow-ups: every open reminder on this guest, with Done. */
function remindersHTML(list, customerId){
  if (!list || !list.length) return '';
  return `<div class="reminder-block">
    <div class="pane-title">${te('Follow-ups')} <span class="muted gi-count">${list.length}</span></div>
    ${list.map(r => `
      <div class="reminder-row${r.due ? ' is-due' : ''}">
        <div class="rr-main">
          <div class="rr-top">${reminderDuePill(r)}<span class="muted">${escapeHtml(fmtDate(r.due_date))}${r.created_by_name ? ' · ' + escapeHtml(r.created_by_name) : ''}</span></div>
          ${r.note ? `<div class="rr-note">${escapeHtml(excerpt(r.note, 140))}</div>` : ''}
        </div>
        <button class="btn btn-outline btn-sm" data-act="markReminderDone" data-on="click" data-args='[${Number(r.id)},${Number(customerId)}]'>${te('Done')}</button>
      </div>`).join('')}
  </div>`;
}
async function markReminderDone(id, customerId){
  try {
    await call(window.api.reminders.done, { id }, { silent:true });
    toast('success', t('Follow-up done'));
    await Promise.allSettled([
      customerId ? refreshOpenInspectors(customerId) : Promise.resolve(),
      workspace.active === 'dashboard' ? renderGuestDashboardPanels() : Promise.resolve(),
      refreshNotifBadge()
    ]);
  } catch (e){ toast('error', t('Could not mark done'), e.message); }
}

/* =====================================================================
   DASHBOARD — Due today, Upcoming dates, Recently viewed
   ===================================================================== */
let dashGuestData = null;
function setDashGuestData(d){ dashGuestData = d; }
async function renderGuestDashboardPanels(data){
  const d = data || await call(window.api.dashboard.load, { periodDays: state.dashPeriod }, { silent:true }).catch(() => null);
  if (d) dashGuestData = d;
  const due = dashGuestData?.dueReminders || [];
  const dates = dashGuestData?.upcomingDates || [];
  await resolvePhotos([...due.map(r => r.photo_name), ...dates.map(x => x.photo_name)]);

  const dueNode = el('dueTodayList');
  if (dueNode){
    el('dueTodayCount').textContent = due.length;
    dueNode.innerHTML = due.length ? due.map(r => `
      <div class="list-row" data-act="goToGuest" data-on="click" data-args='[${Number(r.customer_id)},"customers"]'>
        <div class="lr-avatar"${avatarStyle(r.photo_name)}>${photoUrl(r.photo_name) ? '' : escapeHtml(initials(r.full_name))}</div>
        <div class="lr-main">
          <div class="lr-name">${escapeHtml(r.full_name)}</div>
          <div class="lr-sub">${r.note ? escapeHtml(excerpt(r.note, 70)) : '#' + escapeHtml(r.code)}</div>
        </div>
        <div class="lr-right lr-actions">${reminderDuePill(r)}
          <button class="btn btn-outline btn-sm" data-act="dashReminderDone" data-on="click" data-args='[${Number(r.id)},{"$":"event"}]' aria-label="${te('Mark the follow-up with {name} done', { name: r.full_name })}">${te('Done')}</button>
        </div>
      </div>`).join('')
      : emptyState({ icon:'check', title:t('No follow-ups due'), text:t('Add “Remind me on” to a CRM note to see it here on the day.') });
  }

  const datesNode = el('upcomingDatesList');
  if (datesNode){
    el('upcomingDatesCount').textContent = dates.length;
    datesNode.innerHTML = dates.length ? dates.map(x => `
      <div class="list-row" data-act="goToGuest" data-on="click" data-args='[${Number(x.customer_id)},"customers"]'>
        <div class="lr-avatar"${avatarStyle(x.photo_name)}>${photoUrl(x.photo_name) ? '' : escapeHtml(initials(x.full_name))}</div>
        <div class="lr-main">
          <div class="lr-name">${escapeHtml(x.full_name)}</div>
          <div class="lr-sub">${escapeHtml(tNotice(x.label))} · ${escapeHtml(shortDay(x.date))}</div>
        </div>
        <div class="lr-right"><span class="due-pill${x.days_away === 0 ? ' soon' : ''}">${escapeHtml(relativeDay(x.date))}</span></div>
      </div>`).join('')
      : `<div class="panel-empty">${te('No birthdays or special dates this week')}</div>`;
  }
  await renderRecentGuestsPanel();
}
async function dashReminderDone(id, ev){
  ev?.stopPropagation();
  await markReminderDone(id, null);
}

/* =====================================================================
   RECENTLY VIEWED
   ===================================================================== */
let recentGuestsCache = [];
/* Fire and forget: remembering a view must never slow down opening a guest. */
function markGuestViewed(customerId){
  if (!customerId || !window.api.customers.viewed) return;
  window.api.customers.viewed({ id: Number(customerId) }).catch(() => {});
}
async function loadRecentGuests(){
  try { recentGuestsCache = (await call(window.api.customers.recent, {}, { silent:true })) || []; }
  catch (_) { recentGuestsCache = []; }
  return recentGuestsCache;
}
async function renderRecentGuestsPanel(){
  const node = el('recentGuestsList');
  if (!node) return;
  const rows = await loadRecentGuests();
  await resolvePhotos(rows.map(r => r.photo_name));
  node.innerHTML = rows.length ? rows.map(c => `
    <div class="list-row compact" data-act="goToGuest" data-on="click" data-args='[${Number(c.id)},"customers"]'>
      <div class="lr-avatar"${avatarStyle(c.photo_name)}>${photoUrl(c.photo_name) ? '' : escapeHtml(initials(c.full_name))}</div>
      <div class="lr-main">
        <div class="lr-name">${escapeHtml(c.full_name)}</div>
        <div class="lr-sub">#${escapeHtml(c.code)}${c.marketing_name ? ' · ' + escapeHtml(c.marketing_name) : ''}</div>
      </div>
    </div>`).join('') : `<div class="panel-empty">${te('Guests you open appear here')}</div>`;
}
/* Palette, empty query: the last guests opened, above the commands. */
async function paletteRecentItems(){
  const rows = await loadRecentGuests();
  return rows.map(c => ({ kind:t('Guest'), group:t('Recently viewed'), count:rows.length, title:c.full_name,
    sub:[`#${c.code}`, c.marketing_name ? t('Assigned to {name}', { name: c.marketing_name }) : ''].filter(Boolean).join(' · '),
    action:'goToGuest', args:[c.id, 'customers'] }));
}

/* =====================================================================
   TAGS
   ===================================================================== */
async function refreshTags(){
  try { state.tags = (await call(window.api.tags.list, {}, { silent:true })) || []; }
  catch (_) { state.tags = []; }
  fillTagFilterSelects();
  return state.tags;
}
/* Another user may have created a tag since this window loaded the
   vocabulary. A guest carrying an id we do not know yet refreshes it once,
   rather than silently showing no chip. */
async function ensureTagsFor(ids){
  const known = new Set((state.tags || []).map(t => t.id));
  if ((ids || []).some(id => !known.has(Number(id)))) await refreshTags();
}
function tagById(id){ return (state.tags || []).find(t => t.id === Number(id)) || null; }
function tagColor(t){ return TAG_PALETTE.includes(t?.color) ? t.color : 'slate'; }
function tagChipHTML(t){
  return `<span class="tag-chip tc-${tagColor(t)}">${escapeHtml(t.name)}</span>`;
}
function tagChipsHTML(ids){
  const tags = (ids || []).map(tagById).filter(Boolean);
  return tags.length ? `<span class="tag-chips">${tags.map(tagChipHTML).join('')}</span>` : '';
}
function fillTagFilterSelects(){
  for (const id of ['custFTag', 'listFTag']){
    const sel = el(id); if (!sel) continue;
    const v = sel.value;
    sel.innerHTML = `<option value="">${te('Any tag')}</option>` +
      (state.tags || []).map(t => `<option value="${Number(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    sel.value = v;
  }
}
/* The tag row in the guest panel and full record, with the edit button. */
function guestTagsRowHTML(c){
  const canEdit = can1('customers.update');
  const chips = tagChipsHTML(c.tags);
  if (!chips && !canEdit) return '';
  return `<div class="guest-tags">${chips || ''}${canEdit ? `<button type="button" class="tag-add" data-act="openTagsModal" data-on="click" data-args='[${Number(c.id)}]' title="${te('Edit tags (T)')}">${chips ? te('Edit tags') : te('+ Add tag')}</button>` : ''}</div>`;
}

let tagsModal = { customerId:null, picked:new Set(), color:'slate' };
async function openTagsModal(customerId){
  if (!customerId) return;
  let c = null;
  try { c = await call(window.api.customers.get, { id:Number(customerId) }, { silent:true }); }
  catch (e){ toast('error', t('Could not open tags'), e.message); return; }
  if (!c) return;
  await refreshTags();
  tagsModal = { customerId:c.id, picked:new Set(c.tags || []), color:'slate' };
  el('tagsModalSubtitle').textContent = `${c.full_name} · #${c.code}`;
  el('newTagName').value = '';
  renderTagPicker();
  renderTagColorPicker();
  openModal('modalTags');
}
function renderTagPicker(){
  const node = el('tagPicker'); if (!node) return;
  node.innerHTML = (state.tags || []).length ? state.tags.map(t => {
    const on = tagsModal.picked.has(t.id);
    return `<button type="button" class="tag-pick tc-${tagColor(t)}${on ? ' on' : ''}" aria-pressed="${on}" data-act="toggleTagPick" data-on="click" data-args='[${Number(t.id)}]'>
      <span class="tp-check" aria-hidden="true">${on ? '✓' : ''}</span>${escapeHtml(t.name)}</button>`;
  }).join('') : `<div class="empty-mini">${te('No tags yet — create the first one below.')}</div>`;
}
function toggleTagPick(id){
  if (tagsModal.picked.has(id)) tagsModal.picked.delete(id); else tagsModal.picked.add(id);
  renderTagPicker();
}
function renderTagColorPicker(){
  const node = el('newTagColors'); if (!node) return;
  node.innerHTML = TAG_PALETTE.map(c => `<button type="button" class="swatch tc-${c}${tagsModal.color === c ? ' on' : ''}" aria-pressed="${tagsModal.color === c}" aria-label="${te(TAG_PALETTE_LABEL[c])}" title="${te(TAG_PALETTE_LABEL[c])}" data-act="pickNewTagColor" data-on="click" data-args='["${jsonAttr(c)}"]'></button>`).join('');
}
function pickNewTagColor(color){
  if (!TAG_PALETTE.includes(color)) return;
  tagsModal.color = color;
  renderTagColorPicker();
}
function newTagKey(e){ if (e.key === 'Enter'){ e.preventDefault(); addNewTag(); } }
async function addNewTag(){
  const input = el('newTagName');
  const name = input.value.trim();
  clearFieldErrors(el('modalTags'));
  if (!name){ showFieldError('newTagName', t('Type a name for the tag.')); return; }
  try {
    const created = await call(window.api.tags.create, { name, color: tagsModal.color }, { silent:true });
    await refreshTags();
    tagsModal.picked.add(created.id);
    input.value = '';
    renderTagPicker();
  } catch (e){ if (!applyServerError(e, { name:'newTagName', color:'newTagName' })) toast('error', t('Tag not created'), e.message); }
}
async function saveTags(){
  const id = tagsModal.customerId; if (!id) return;
  const btn = el('tagsSaveBtn');
  await withBusy(btn, t('Saving…'), async () => {
    try {
      await call(window.api.customers.setTags, { id, tagIds:[...tagsModal.picked] }, { silent:true });
      closeModal('modalTags');
      toast('success', t('Tags saved'));
      await Promise.all([refreshOpenInspectors(id), refreshCrmViews()]);
    } catch (e){ toast('error', t('Tags not saved'), e.message); }
  });
}
/* Settings: rename, recolour or delete a shared tag. */
async function renderTagSettings(){
  const node = el('tagSettingsList'); if (!node) return;
  await refreshTags();
  node.innerHTML = state.tags.length ? state.tags.map(t => `
    <div class="tag-setting-row">
      ${tagChipHTML(t)}
      <label class="visually-hidden" for="tagName_${Number(t.id)}">${te('Tag name')}</label>
      <input class="fm-input" id="tagName_${Number(t.id)}" value="${escapeHtml(t.name)}" maxlength="40" data-act="renameTag" data-on="change" data-args='[${Number(t.id)},{"$":"value"}]'>
      <label class="visually-hidden" for="tagColor_${Number(t.id)}">${te('Tag colour')}</label>
      <select class="fm-input" id="tagColor_${Number(t.id)}" data-act="recolorTag" data-on="change" data-args='[${Number(t.id)},{"$":"value"}]'>
        ${TAG_PALETTE.map(c => `<option value="${c}"${c === tagColor(t) ? ' selected' : ''}>${te(TAG_PALETTE_LABEL[c])}</option>`).join('')}
      </select>
      <button class="btn btn-ghost btn-sm" data-act="deleteTag" data-on="click" data-args='[${Number(t.id)}]'>${te('Delete')}</button>
    </div>`).join('') : `<div class="empty-mini">${te("No tags yet. Tags are created from a guest's panel.")}</div>`;
}
async function renameTag(id, name){
  try { await call(window.api.tags.update, { id, name }, { silent:true }); toast('success', t('Tag renamed')); }
  catch (e){ toast('error', t('Tag not renamed'), e.message); }
  await renderTagSettings();
}
async function recolorTag(id, color){
  try { await call(window.api.tags.update, { id, color }, { silent:true }); }
  catch (e){ toast('error', t('Colour not changed'), e.message); }
  await renderTagSettings();
}
async function deleteTag(id){
  const tag = tagById(id);
  if (!await confirmDialog({ title:t('Delete tag'), message:t('Delete the tag “{name}”?', { name: tag ? tag.name : '' }),
    detail:t('It is removed from every guest that carries it.'), confirmLabel:t('Delete') })) return;
  try { await call(window.api.tags.delete, { id }, { silent:true }); toast('success', t('Tag deleted')); }
  catch (e){ toast('error', t('Tag not deleted'), e.message); }
  await renderTagSettings();
}

/* =====================================================================
   BIRTHDAYS AND SPECIAL DATES
   ===================================================================== */
function datesSummaryHTML(c){
  const parts = [];
  if (c.birth_date){
    const [, m, d] = c.birth_date.split('-').map(Number);
    parts.push(`<div class="gc-field"><div class="gf-l">${te('Birthday')}</div><div class="gf-v">${escapeHtml(`${d} ${t(MONTH_SHORT[m - 1])}`)} <span class="muted">${escapeHtml(fmtDate(c.birth_date))}</span></div></div>`);
  }
  for (const s of c.special_dates || []){
    parts.push(`<div class="gc-field"><div class="gf-l">${escapeHtml(s.label)}</div><div class="gf-v">${escapeHtml(`${Number(s.day)} ${t(MONTH_SHORT[Number(s.month) - 1])}`)}</div></div>`);
  }
  return parts.join('');
}
let datesModal = { customerId:null, rows:[] };
async function openDatesModal(customerId){
  let c = null;
  try { c = await call(window.api.customers.get, { id:Number(customerId) }, { silent:true }); }
  catch (e){ toast('error', t('Could not open dates'), e.message); return; }
  if (!c) return;
  datesModal = { customerId:c.id, rows:(c.special_dates || []).map(s => ({ label:s.label, month:s.month, day:s.day })) };
  el('datesModalSubtitle').textContent = `${c.full_name} · #${c.code}`;
  el('datesBirth').value = c.birth_date || '';
  clearFieldErrors(el('modalDates'));
  renderDateRows();
  openModal('modalDates');
}
function renderDateRows(){
  const node = el('datesRows'); if (!node) return;
  node.innerHTML = datesModal.rows.length ? datesModal.rows.map((r, i) => `
    <div class="date-row">
      <label class="visually-hidden" for="dateLabel_${i}">${te('Label')}</label>
      <input type="text" id="dateLabel_${i}" maxlength="60" placeholder="${te('e.g. Wedding anniversary')}" value="${escapeHtml(r.label)}" data-act="setDateRow" data-on="input" data-args='[${i},"label",{"$":"value"}]'>
      <label class="visually-hidden" for="dateMonth_${i}">${te('Month')}</label>
      <select id="dateMonth_${i}" data-act="setDateRow" data-on="change" data-args='[${i},"month",{"$":"value"}]'>
        ${MONTH_SHORT.map((m, k) => `<option value="${k + 1}"${Number(r.month) === k + 1 ? ' selected' : ''}>${te(m)}</option>`).join('')}
      </select>
      <label class="visually-hidden" for="dateDay_${i}">${te('Day')}</label>
      <select id="dateDay_${i}" data-act="setDateRow" data-on="change" data-args='[${i},"day",{"$":"value"}]'>
        ${Array.from({ length:31 }, (_, k) => `<option value="${k + 1}"${Number(r.day) === k + 1 ? ' selected' : ''}>${k + 1}</option>`).join('')}
      </select>
      <button type="button" class="btn-icon" aria-label="${te('Remove this date')}" data-act="removeDateRow" data-on="click" data-args='[${i}]'>✕</button>
    </div>`).join('') : `<div class="empty-mini">${te('No special dates.')}</div>`;
}
function setDateRow(i, field, value){
  const r = datesModal.rows[i]; if (!r) return;
  r[field] = field === 'label' ? value : Number(value);
}
function addDateRow(){
  if (datesModal.rows.length >= 20) return;
  const now = new Date();
  datesModal.rows.push({ label:'', month:now.getMonth() + 1, day:now.getDate() });
  renderDateRows();
  setTimeout(() => el(`dateLabel_${datesModal.rows.length - 1}`)?.focus(), 20);
}
function removeDateRow(i){ datesModal.rows.splice(i, 1); renderDateRows(); }
async function saveDates(){
  const id = datesModal.customerId; if (!id) return;
  clearFieldErrors(el('modalDates'));
  const rows = datesModal.rows.map(r => ({ label:String(r.label || '').trim(), month:Number(r.month), day:Number(r.day) }));
  if (rows.some(r => !r.label)){ showFieldError('datesRowsAnchor', t('Give every date a label, or remove it.')); return; }
  const birth = el('datesBirth').value;
  await withBusy(el('datesSaveBtn'), t('Saving…'), async () => {
    try {
      await call(window.api.customers.update, { id, birthDate: birth || null }, { silent:true });
      await call(window.api.customers.setDates, { id, dates:rows }, { silent:true });
      closeModal('modalDates');
      toast('success', t('Dates saved'));
      await refreshOpenInspectors(id);
    } catch (e){
      if (!applyServerError(e, { birthDate:'datesBirth', dates:'datesRowsAnchor' })) toast('error', t('Dates not saved'), e.message);
    }
  });
}

/* =====================================================================
   DUPLICATE GUEST WARNING
   ===================================================================== */
/* The check returns guests in the caller's own book by name, and only the
   fact that one exists for anybody else's. The warning shows the same. */
async function findDuplicateGuests({ phone, passportNo, excludeId }){
  if (!phone && !passportNo) return null;
  const payload = omitBlank({ phone, passportNo, excludeId: excludeId ?? undefined });
  try { return await call(window.api.customers.duplicates, payload, { silent:true }); }
  catch (_) { return null; }
}
function duplicateWarningHTML(result, { editing }){
  const rows = (result?.matches || []).map(m => `
    <div class="dup-row">
      <div class="dup-main"><b>${escapeHtml(m.full_name)}</b> <span class="muted">#${escapeHtml(m.code)}</span>
        <div class="muted dup-why">${te(m.match.includes('passport') && m.match.length > 1 ? 'Same phone and passport number' : m.match.includes('passport') ? 'Same passport number' : 'Same phone')}</div></div>
      <button type="button" class="btn btn-outline btn-sm" data-act="openDuplicateGuest" data-on="click" data-args='[${Number(m.id)}]'>${te('Open existing')}</button>
    </div>`).join('');
  const ph = !!result?.elsewhere?.phone, pp = !!result?.elsewhere?.passport;
  const elsewhereKey = ph && pp ? "A guest with this phone number and passport number already exists in another marketer's book."
    : ph ? "A guest with this phone number already exists in another marketer's book."
    : pp ? "A guest with this passport number already exists in another marketer's book." : '';
  const elsewhere = elsewhereKey ? `<div class="dup-elsewhere">${te(elsewhereKey)}</div>` : '';
  return `<div class="dup-title">${te('Possible duplicate guest')}</div>
    ${rows}${elsewhere}
    <div class="dup-actions">
      <button type="button" class="btn btn-gold btn-sm" data-act="saveCustomerAnyway" data-on="click" data-args='[]'>${editing ? te('Save anyway') : te('Create anyway')}</button>
    </div>`;
}
function hasDuplicates(result){
  return !!result && ((result.matches || []).length > 0 || result.elsewhere?.phone || result.elsewhere?.passport);
}
function hideDuplicateWarning(){
  const box = el('custDupWarning');
  if (box){ box.innerHTML = ''; box.classList.remove('show'); }
}
async function openDuplicateGuest(id){
  closeModal('modalCustomer');
  await goToGuest(id, 'customers');
}

/* =====================================================================
   MERGE GUESTS
   ===================================================================== */
let mergeState = { primary:null, duplicate:null };
async function openMergeModal(primaryId){
  if (!hasCap('customers.merge')) return;
  let primary = null;
  try { primary = await call(window.api.customers.get, { id:Number(primaryId) }, { silent:true }); }
  catch (e){ toast('error', t('Could not open merge'), e.message); return; }
  if (!primary) return;
  mergeState = { primary, duplicate:null };
  el('mergeDuplicateSelect').value = '';
  renderMergeModal();
  openModal('modalMerge');
}
function mergeCardHTML(c, role){
  if (!c) return `<div class="merge-card empty"><div class="merge-role">${te(role)}</div>
    <button type="button" class="finder-trigger" data-act="openMergeFinder" data-on="click" data-args='[]'>${te('Find the duplicate guest…')}</button></div>`;
  const row = (l, v) => `<div class="merge-field"><span>${te(l)}</span><b>${v ? escapeHtml(v) : '—'}</b></div>`;
  return `<div class="merge-card">
    <div class="merge-role">${te(role)}</div>
    <div class="merge-name">${escapeHtml(c.full_name)} <span class="muted">#${escapeHtml(c.code)}</span></div>
    ${row('Phone', c.phone)}${row('Passport', c.passport_no)}${row('Email', c.email)}
    ${row('Stays', String(c.reservation_count ?? 0))}${row('CRM notes', String(c.note_count ?? 0))}
    ${role === 'Duplicate' ? `<button type="button" class="btn-link" data-act="openMergeFinder" data-on="click" data-args='[]'>${te('Choose a different guest')}</button>` : ''}
  </div>`;
}
function renderMergeModal(){
  el('mergeCards').innerHTML = mergeCardHTML(mergeState.primary, 'Keep') + mergeCardHTML(mergeState.duplicate, 'Duplicate');
  el('mergeConfirmBtn').disabled = !mergeState.duplicate;
}
function openMergeFinder(){
  openFinder({ mode:'customer', targetInputId:'mergeDuplicateSelect', title:t('Find duplicate guest'),
    subtitle:t('Search by ID, name or phone'), onSelect:onMergeDuplicatePicked });
}
async function onMergeDuplicatePicked(){
  const id = Number(el('mergeDuplicateSelect').value);
  if (!id) return;
  if (id === mergeState.primary?.id){ toast('error', t('Choose another guest'), t('A guest cannot be merged into itself.')); return; }
  try { mergeState.duplicate = await call(window.api.customers.get, { id }, { silent:true }); }
  catch (e){ toast('error', t('Could not load that guest'), e.message); mergeState.duplicate = null; }
  renderMergeModal();
}
async function confirmMerge(){
  const { primary, duplicate } = mergeState;
  if (!primary || !duplicate) return;
  await withBusy(el('mergeConfirmBtn'), t('Merging…'), async () => {
    try {
      const r = await call(window.api.customers.merge, { primaryId:primary.id, duplicateId:duplicate.id }, { silent:true });
      closeModal('modalMerge');
      const m = r?.moved || {};
      toast('success', t('Guests merged'), t('{notes} notes and {stays} stays moved to {name}.', { notes: m.notes || 0, stays: m.reservations || 0, name: primary.full_name }));
      await Promise.allSettled([refreshOpenInspectors(primary.id), refreshCrmViews(), renderReservations()]);
    } catch (e){ toast('error', t('Guests not merged'), e.message); }
  });
}

/* =====================================================================
   SAVED VIEWS
   ===================================================================== */
const VIEW_MENU = { overview:'viewsMenu_overview', customerlist:'viewsMenu_customerlist', reservations:'viewsMenu_reservations' };
function captureViewState(screen){
  if (screen === 'overview'){
    const s = state.cust;
    return omitBlank({ search: el('custSearch')?.value.trim() || '', status:s.status, marketing:s.marketing, tagId:s.tagId, sort:s.sort, dir:s.dir });
  }
  if (screen === 'customerlist'){
    const s = state.list;
    return omitBlank({ search: el('listSearch')?.value.trim() || '', status:s.status, createdBy:s.createdBy, assignedTo:s.assignedTo,
      hasReservation:s.hasReservation, hasCrm:s.hasCrm, createdFrom:s.createdFrom, createdTo:s.createdTo, tagId:s.tagId, sort:s.sort, dir:s.dir });
  }
  const s = state.res;
  return omitBlank({ search: el('resSearch')?.value.trim() || '', view:s.view, status:s.status, invitedBy:s.invitedBy,
    from:s.from, to:s.to, sort:s.sort, dir:s.dir });
}
async function toggleViewsMenu(screen, ev){
  const id = VIEW_MENU[screen]; if (!id) return;
  toggleFilterMenu(id, ev);
  if (el(id).classList.contains('open')) await renderViewsMenu(screen);
}
async function renderViewsMenu(screen){
  const node = el(VIEW_MENU[screen]); if (!node) return;
  let views = [];
  try { views = (await call(window.api.views.list, { screen }, { silent:true })) || []; } catch (_) {}
  node.innerHTML = `
    <div class="fm-title">${te('Saved views')}</div>
    ${views.length ? views.map(v => `
      <div class="view-item">
        <button type="button" class="view-open" data-act="applySavedView" data-on="click" data-args='["${jsonAttr(screen)}",${Number(v.id)}]'>${escapeHtml(v.name)}</button>
        <button type="button" class="view-del" aria-label="${te('Delete saved view {name}', { name: v.name })}" title="${te('Delete')}" data-act="deleteSavedView" data-on="click" data-args='["${jsonAttr(screen)}",${Number(v.id)}]'>✕</button>
      </div>`).join('') : `<div class="empty-mini">${te('No saved views yet.')}</div>`}
    <div class="fm-sep"></div>
    <div class="fm-title">${te('Save current search and filters')}</div>
    <div class="fm-row">
      <label class="visually-hidden" for="viewName_${screen}">${te('View name')}</label>
      <input class="fm-input" id="viewName_${screen}" maxlength="60" placeholder="${te('Name this view')}" autocomplete="off"
             data-act-keydown="viewNameKey" data-args-keydown='["${jsonAttr(screen)}",{"$":"event"}]'>
      <button type="button" class="btn btn-gold btn-sm" data-act="saveCurrentView" data-on="click" data-args='["${jsonAttr(screen)}"]'>${te('Save')}</button>
    </div>`;
  node.dataset.views = JSON.stringify(views.map(v => ({ id:v.id, name:v.name, state:v.state })));
}
function viewNameKey(screen, e){ if (e.key === 'Enter'){ e.preventDefault(); saveCurrentView(screen); } }
async function saveCurrentView(screen){
  const input = el(`viewName_${screen}`);
  const name = input?.value.trim();
  if (!name){ input?.focus(); toast('error', t('Name the view'), t('Type a name, then save.')); return; }
  try {
    await call(window.api.views.save, { screen, name, state:captureViewState(screen) }, { silent:true });
    toast('success', t('View saved'), name);
    await renderViewsMenu(screen);
  } catch (e){ toast('error', t('View not saved'), e.message); }
}
async function deleteSavedView(screen, id){
  try { await call(window.api.views.delete, { id }, { silent:true }); }
  catch (e){ toast('error', t('View not deleted'), e.message); }
  await renderViewsMenu(screen);
}
async function applySavedView(screen, id){
  const node = el(VIEW_MENU[screen]);
  let views = [];
  try { views = JSON.parse(node?.dataset.views || '[]'); } catch (_) {}
  const v = views.find(x => Number(x.id) === Number(id));
  if (!v) return;
  const st = v.state || {};
  closeAllFilterMenus();
  if (screen === 'overview'){
    Object.assign(state.cust, { status:st.status || '', marketing:st.marketing || '', tagId:st.tagId || '',
      sort:st.sort || 'updated', dir:st.dir || 'desc', page:1 });
    el('custSearch').value = st.search || '';
    el('custFMarketing').value = state.cust.marketing;
    if (el('custFTag')) el('custFTag').value = state.cust.tagId;
    const opt = document.querySelector(`#custFilterMenu .filter-opt[data-val="${CSS.escape(state.cust.status)}"]`);
    if (opt) markFilterActive('custFilterMenu', opt);
    await renderCustomers();
  } else if (screen === 'customerlist'){
    const fields = { status:'listFStatus', createdBy:'listFCreatedBy', assignedTo:'listFAssignedTo', hasReservation:'listFHasRes',
      hasCrm:'listFHasCrm', createdFrom:'listFCreatedFrom', createdTo:'listFCreatedTo', tagId:'listFTag' };
    fillListFilterSelects();
    for (const [k, id] of Object.entries(fields)){ if (el(id)) el(id).value = st[k] ?? ''; }
    state.list.sort = st.sort || 'created'; state.list.dir = st.dir || 'desc';
    el('listSearch').value = st.search || '';
    applyListFilters();
  } else {
    const s = state.res;
    Object.assign(s, { status:st.status || '', invitedBy:st.invitedBy || '', from:st.from || '', to:st.to || '',
      sort:st.sort || 'check_in', dir:st.dir || 'desc', page:1 });
    el('resSearch').value = st.search || '';
    el('resFStatus').value = s.status; el('resFInvited').value = s.invitedBy;
    el('resFFrom').value = s.from; el('resFTo').value = s.to;
    el('resFilterBtn').classList.toggle('filtered', !!(s.status || s.invitedBy || s.from || s.to));
    const view = ['active','cancelled','deleted'].includes(st.view) ? st.view : 'active';
    if (s.view !== view) setResView(view); else renderReservations();
  }
  toast('success', t('View opened'), v.name);
}

/* =====================================================================
   KEYBOARD SHORTCUTS — guest panel and full record
   ===================================================================== */
/* Which guest is "the open guest" right now: the full record, or the guest
   panel of the list on screen when it is showing someone. */
function guestShortcutTarget(){
  if (workspace.active === 'guest') return state.guestPage?.id || null;
  let panelId = null;
  if (workspace.active === 'customers'){
    if (state.crmView === 'overview' && state.custMode !== 'activity') panelId = 'detailPanel';
    else if (state.crmView === 'customerlist') panelId = 'listDetailPanel';
  } else if (workspace.active === 'reservations') panelId = 'resDetailPanel';
  const panel = panelId ? el(panelId) : null;
  if (!panel || panel.classList.contains('empty') || panel.classList.contains('collapsed')) return null;
  return Number(panel.dataset.customerId) || null;
}
/* N new note · R new reservation · E edit guest · T tags. Returns true when
   the key was handled. On a list, E with a row picked by J/K keeps editing
   that row, as before. */
function handleGuestShortcut(key){
  const id = guestShortcutTarget();
  if (!id) return false;
  switch (key){
    case 'n': if (!can1('crmNotes.create')) return false; openCrmNoteModal(id); return true;
    case 'r': if (!can1('reservations.create')) return false; openReservationModal(null, id); return true;
    case 'e':
      if (workspace.active !== 'guest' && currentRow()) return false;
      if (!can1('customers.update')) return false;
      openCustomerModal(id); return true;
    case 't': if (!can1('customers.update')) return false; openTagsModal(id); return true;
    default: return false;
  }
}

/* =====================================================================
   CUSTOMER LIST — active-filter chips
   ===================================================================== */
const LIST_FILTER_FIELDS = { status:'listFStatus', createdBy:'listFCreatedBy', assignedTo:'listFAssignedTo',
  hasReservation:'listFHasRes', hasCrm:'listFHasCrm', createdFrom:'listFCreatedFrom', createdTo:'listFCreatedTo', tagId:'listFTag' };
function listActiveFilters(){
  const s = state.list;
  const profile = (id) => state.profiles.find(p => String(p.id) === String(id))?.full_name || '#' + id;
  const out = [];
  if (s.status) out.push({ key:'status', label:`${t('Status')}: ${({ COLD:t('Cold'), NO_RECORD:t('No record') })[s.status] || s.status}` });
  if (s.createdBy) out.push({ key:'createdBy', label:`${t('Created by')}: ${profile(s.createdBy)}` });
  if (s.assignedTo) out.push({ key:'assignedTo', label:`${t('Assigned to')}: ${profile(s.assignedTo)}` });
  if (s.hasReservation) out.push({ key:'hasReservation', label: s.hasReservation === 'yes' ? t('Has reservation') : t('No reservation') });
  if (s.hasCrm) out.push({ key:'hasCrm', label: s.hasCrm === 'yes' ? t('Has CRM activity') : t('No CRM activity') });
  if (s.createdFrom) out.push({ key:'createdFrom', label:t('Created from {date}', { date: fmtDate(s.createdFrom) }) });
  if (s.createdTo) out.push({ key:'createdTo', label:t('Created to {date}', { date: fmtDate(s.createdTo) }) });
  if (s.tagId){ const tag = tagById(s.tagId); out.push({ key:'tagId', label:`${t('Tag')}: ${tag ? tag.name : '#' + s.tagId}` }); }
  return out;
}
function renderListFilterChips(){
  const filters = listActiveFilters();
  const btn = el('listFilterBtn');
  if (btn){
    btn.classList.toggle('filtered', filters.length > 0);
    btn.setAttribute('aria-label', filters.length ? t('Filter ({n} active)', { n: filters.length }) : t('Filter'));
  }
  const n = el('listFilterCount');
  if (n){ n.textContent = String(filters.length); n.classList.toggle('hidden', filters.length === 0); }
  const wrap = el('listChips');
  if (!wrap) return;
  wrap.classList.toggle('hidden', filters.length === 0);
  wrap.innerHTML = filters.map(f => `
    <span class="chip">${escapeHtml(f.label)}
      <button class="chip-x" data-act="removeListFilter" data-on="click" data-args='["${jsonAttr(f.key)}"]' aria-label="${te('Remove {name}', { name: f.label })}">×</button>
    </span>`).join('') + (filters.length ? `<button class="btn-link chip-clear" data-act="clearListFilters" data-on="click" data-args='[]'>${te('Clear all')}</button>` : '');
}
function removeListFilter(key){
  const id = LIST_FILTER_FIELDS[key];
  if (id && el(id)) el(id).value = '';
  applyListFilters();
}
