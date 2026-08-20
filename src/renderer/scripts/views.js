'use strict';
/* =====================================================================
   Page renderers. Every figure here comes from the database.
   ===================================================================== */

function pagerHTML(containerId, page, pageSize, total, fnName){
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const node = el(containerId);
  if (!node) return;
  if (total <= pageSize){ node.innerHTML = ''; node.style.display = 'none'; return; }
  node.style.display = 'flex';
  node.innerHTML = `
    <div class="pager-info">${from}–${to} of ${total}</div>
    <div class="pager-controls">
      <button class="pager-btn" ${page <= 1 ? 'disabled' : ''} data-act="${fnName}" data-on="click" data-args='[${page - 1}]'>Previous</button>
      <button class="pager-btn" ${page >= pages ? 'disabled' : ''} data-act="${fnName}" data-on="click" data-args='[${page + 1}]'>Next</button>
    </div>`;
}

/* ---------------- DASHBOARD ---------------- */
const DASH_PERIOD_LABEL = { '7':'7 Days', '30':'30 Days', '90':'3 Months', '180':'6 Months', all:'All Time' };
async function setDashboardPeriod(period){
  state.dashPeriod = period;
  el('dashPeriodFilter')?.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.getAttribute('onclick') === `setDashboardPeriod('${period}')`));
  await renderDashboard();
}
async function renderDashboard(){
  const d = await call(window.api.dashboard.load, { periodDays: state.dashPeriod });
  if (!d) return;
  const s = d.stats;
  const periodLabel = DASH_PERIOD_LABEL[state.dashPeriod] || '30 Days';

  const cells = [
    { l:'Total Guests',     n:s.totalGuests, sub:'ALL TIME',
      go: ['ADMIN','MANAGER'].includes(state.session?.role) ? "goCrmView('customerlist')" : "switchTab('customers')" },
    /* MANAGER runs the marketing team, so they see the same Active Marketing
       figure ADMIN does — same authoritative countActiveMarketingProfiles()
       value from dashboard.load, not a separately derived one. MARKETING has
       no business reason to see team-wide headcount. */
    ...(['ADMIN','MANAGER'].includes(state.session?.role)
      ? [{ l:'Active Marketing', n:s.activeMarketing, sub:'CURRENT', act:'switchTab', actArgs:['profiles'] }] : []),
    { l:'Reservations',     n:s.reservations, sub:periodLabel.toUpperCase(), act:'switchTab', actArgs:['reservations'] },
    { l:'Upcoming Check-ins',  n:s.upcomingIn, sub:'UPCOMING', act:'goReservationsUpcoming', actArgs:[] },
    { l:'Cold Guests',      n:s.cold, sub:'CURRENT', flag:s.cold > 0,        act:'goCustomersFiltered', actArgs:['COLD'] },
    { l:'No Record',        n:s.noRecord, sub:'CURRENT', flag:s.noRecord > 0, act:'goCustomersFiltered', actArgs:['NO_RECORD'] }
  ];
  const band = el('statBand');
  band.style.gridTemplateColumns = `repeat(${cells.length},1fr)`;
  band.innerHTML = cells.map(c => `
    <div class="stat-cell" data-act="${c.act}" data-on="click" data-args='${JSON.stringify(c.actArgs || [])}'>
      <span class="kpi-arrow is-hidden"></span>
      <div class="sc-l">${c.l}</div>
      <div class="sc-n">${c.n}${c.flag ? '<span class="sc-flag"></span>' : ''}</div>
      <div class="sc-sub">${c.sub}</div>
    </div>`).join('');

  /* Dashboard always reloads fresh, so piggyback the No Record tab/submenu
     badges on its live count rather than leaving them stale until the guest
     opens CRM Panel's No Record tab directly. */
  const norecTabBadge = el('norecTabBadge'); if (norecTabBadge) norecTabBadge.textContent = s.noRecord;
  const norecSubmenuBadge = el('norecSubmenuBadge'); if (norecSubmenuBadge) norecSubmenuBadge.textContent = s.noRecord;

  await resolvePhotos([...d.recent.map(r => r.photo_path), ...d.attention.map(a => a.photo_path)]);

  el('recentResList').innerHTML = d.recent.length ? d.recent.map(r => `
    <div class="list-row" data-act="goToGuest" data-on="click" data-args='[${r.customer_id},"reservations"]'>
      <div class="lr-avatar"${avatarStyle(r.photo_path)}>${photoUrl(r.photo_path) ? '' : escapeHtml(initials(r.customer_name))}</div>
      <div class="lr-main">
        <div class="lr-name">${escapeHtml(r.customer_name)}</div>
        <div class="lr-sub">${fmtDate(r.check_in)} — ${fmtDate(r.check_out)}${r.invited_by_name ? ' · ' + escapeHtml(r.invited_by_name) : ''}</div>
      </div>
      <div class="lr-right">${statusTagHTML(r.status)}</div>
    </div>`).join('') : '<div class="panel-empty">No reservations yet</div>';

  el('pendingCount').textContent = s.pending ?? 0;
  await resolvePhotos(d.pending.map(r => r.photo_path));
  el('pendingList').innerHTML = d.pending.length ? d.pending.map(r => {
    const due = r.days_away === 0 ? 'today' : (r.days_away === 1 ? 'tomorrow' : 'in ' + r.days_away + 'd');
    const tone = r.days_away <= 1 ? ' urgent' : (r.days_away <= 7 ? ' soon' : '');
    return `
    <div class="list-row" data-act="goToGuest" data-on="click" data-args='[${r.customer_id},"reservations"]'>
      <div class="lr-avatar"${avatarStyle(r.photo_path)}>${photoUrl(r.photo_path) ? '' : escapeHtml(initials(r.customer_name))}</div>
      <div class="lr-main">
        <div class="lr-name">${escapeHtml(r.customer_name)}</div>
        <div class="lr-sub">${fmtDate(r.check_in)} — ${fmtDate(r.check_out)}${r.invited_by_name ? ' · ' + escapeHtml(r.invited_by_name) : ''}</div>
      </div>
      <div class="lr-right"><span class="due-pill${tone}">${due}</span></div>
    </div>`; }).join('') : '<div class="panel-empty">No pending reservations</div>';

  /* one panel failing should never take the dashboard down with it */
  await Promise.allSettled([renderNotifications(), renderRolePanel()]);

  el('attentionList').innerHTML = d.attention.length ? d.attention.map(a => `
    <div class="list-row" data-act="goToGuest" data-on="click" data-args='[${a.id},"customers"]'>
      <div class="lr-avatar"${avatarStyle(a.photo_path)}>${photoUrl(a.photo_path) ? '' : escapeHtml(initials(a.full_name))}</div>
      <div class="lr-main">
        <div class="lr-name">${escapeHtml(a.full_name)}</div>
        <div class="lr-sub">${escapeHtml(a.reason)}${a.marketing_name ? ' · ' + escapeHtml(a.marketing_name) : ''}</div>
      </div>
    </div>`).join('') : '<div class="panel-empty">Nothing needs attention</div>';
}
/* Requires Attention identifies what needs a look and opens the guest on
   click — it is not an action-button wall; the actual actions (add
   reservation, edit, add note) live in the guest inspector / CRM workflow
   the row opens into (spec §3). */
/* The fourth dashboard tile answers a different question for each role:
   a marketer wants a call list, a manager wants to see who is producing. */
async function renderRolePanel(){
  const head = el('attentionList')?.closest('.panel')?.querySelector('.panel-title');
  const col = el('rankCol');
  const rank = el('rankPanel');
  const role = state.session?.role;

  if (role === 'MARKETING'){
    if (head) head.textContent = 'Needs A Call';
    if (col) col.style.display = 'none';
    col?.closest('.dash-grid')?.classList.remove('has-rank');
    return;
  }
  if (head) head.textContent = 'Requires Attention';
  if (!rank || !col) return;
  col.style.display = '';
  col.closest('.dash-grid')?.classList.add('has-rank');
  renderNewGuestsPanel();

  const rows = (await call(window.api.reservations.list, { pageSize:1000 }, { silent:true }).catch(() => null))?.rows || [];
  const period = state.dashPeriod;
  const cutoff = period === 'all' ? 0 : Date.now() - Number(period) * 86400000;
  const tally = {};
  rows.filter(r => Date.parse(r.check_in) >= cutoff && r.invited_by_name)
      .forEach(r => { tally[r.invited_by_name] = (tally[r.invited_by_name] || 0) + 1; });
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(1, ...ranked.map(r => r[1]));

  const title = el('rankPanelTitle');
  if (title) title.textContent = `Marketing — ${DASH_PERIOD_LABEL[period] || '30 Days'}`;
  rank.innerHTML = ranked.length ? ranked.map(([name, n], i) => `
    <div class="rank-row">
      <div class="rank-pos">${i + 1}</div>
      <div class="rank-name">${escapeHtml(name)}</div>
      <div class="rank-bar"><div class="rank-fill" data-bar-width="${Math.round(n / max * 100)}"></div></div>
      <div class="rank-val">${n}</div>
    </div>`).join('')
    : emptyState({ icon:'check', title:'No activity in this period' });
}
/* ADMIN/MANAGER-only: recently created customer records, independent of
   the now-removed NEW status (spec §18) — driven by created_at, not a
   status derivation, so it can never disagree with the guest's real
   status badge (or lack of one). */
async function renderNewGuestsPanel(){
  const wrap = el('newGuestsList');
  if (!wrap) return;
  const data = await call(window.api.customers.list, { sort:'created', dir:'desc', pageSize:8 }, { silent:true });
  const rows = data?.rows || [];
  await resolvePhotos(rows.map(c => c.photo_path));
  wrap.innerHTML = rows.length ? rows.map(c => `
    <div class="list-row" data-act="goToGuest" data-on="click" data-args='[${c.id},"customers"]'>
      <div class="lr-avatar"${avatarStyle(c.photo_path)}>${photoUrl(c.photo_path) ? '' : escapeHtml(initials(c.full_name))}</div>
      <div class="lr-main">
        <div class="lr-name">${escapeHtml(c.full_name)}</div>
        <div class="lr-sub">#${escapeHtml(c.code)}</div>
      </div>
      <div class="lr-right muted">${c.marketing_name ? escapeHtml(c.marketing_name) : '—'}</div>
    </div>`).join('') : '<div class="panel-empty">No new guests yet</div>';
}

async function goCustomersFiltered(code){
  state.cust.status = code; state.cust.page = 1;
  await switchTab('customers');
  const opt = document.querySelector(`#custFilterMenu .filter-opt[data-val="${code}"]`);
  if (opt) markFilterActive('custFilterMenu', opt);
  el('custFilterBtn').classList.add('filtered');
  await renderCustomers();
}
async function goReservationsUpcoming(){
  state.res.status = 'UPCOMING'; state.res.page = 1;
  await switchTab('reservations');
}
async function goToGuest(customerId, page){
  await switchTab(page);
  /* Overview and Customer List both host an inspector now — keep whichever
     one the guest was already on. No Record still doesn't, so fall back
     to Overview only in that case. */
  let panelId = 'resDetailPanel';
  if (page === 'customers'){
    if (state.crmView === 'norecord') await setCrmView('overview');
    panelId = state.crmView === 'customerlist' ? 'listDetailPanel' : 'detailPanel';
  }
  await showCustomerDetail(customerId, panelId);
}

/* ---------------- RESERVATIONS ---------------- */
let resSearchTimer = null;
function onResSearch(){ clearTimeout(resSearchTimer); resSearchTimer = setTimeout(() => { state.res.page = 1; renderReservations(); }, 220); }
function goResPage(p){ state.res.page = p; renderReservations(); }
function sortReservations(col){
  const s = state.res;
  s.dir = (s.sort === col && s.dir === 'desc') ? 'asc' : 'desc';
  s.sort = col; s.page = 1;
  document.querySelectorAll('#page-reservations th.sortable').forEach(th => {
    th.classList.remove('sorted'); const a = th.querySelector('.sort-arrow'); if (a) a.textContent = '';
  });
  const th = [...document.querySelectorAll('#page-reservations th.sortable')]
    .find(t => t.getAttribute('onclick')?.includes(`'${col}'`));
  if (th){ th.classList.add('sorted'); th.querySelector('.sort-arrow').textContent = s.dir === 'desc' ? '↓' : '↑'; }
  renderReservations();
}

function resFilterParams(){
  const s = state.res;
  const p = { view:s.view, sort:s.sort, dir:s.dir };
  if (s.search) p.search = s.search;
  if (s.status) p.status = s.status;
  if (s.invitedBy) p.invitedBy = s.invitedBy;
  if (s.from) p.from = s.from;
  if (s.to) p.to = s.to;
  return p;
}
function applyResFilters(){
  const s = state.res;
  s.status = el('resFStatus').value;
  s.invitedBy = el('resFInvited').value;
  s.from = el('resFFrom').value;
  s.to = el('resFTo').value;
  s.page = 1;
  const active = !!(s.status || s.invitedBy || s.from || s.to);
  el('resFilterBtn').classList.toggle('filtered', active);
  renderReservations();
}
function clearResFilters(){
  ['resFStatus','resFInvited','resFFrom','resFTo'].forEach(id => el(id).value = '');
  applyResFilters();
  closeAllFilterMenus();
}
/* Reservations and Cancelled are one dataset viewed two ways (spec §6) —
   switching just changes the view flag sent to the same list call. */
/* May this session see Deleted history at all? The backend is the authority —
   `reservations.listDeleted` is a separate verb behind its own capability and
   refuses MARKETING outright. This only decides whether to draw the tab. */
function maySeeDeleted(){
  return ['ADMIN','MANAGER'].includes(state.session?.role) && can1('reservations.deleted.read');
}

/* Reservations and Cancelled are one dataset viewed two ways; Deleted is a
   different dataset behind a different verb, so it is not a third value of the
   same `view` parameter crossing the boundary — `renderReservations` calls
   `reservations.listDeleted` for it. Making it a parameter would have meant a
   MARKETING client could ask for it by crafting a request. */
function setResView(view){
  const s = state.res;
  if (view === 'deleted' && !maySeeDeleted()) return;
  if (s.view === view) return;
  s.view = view; s.page = 1;
  for (const [id, name] of [['resViewActiveTab','active'], ['resViewCancelledTab','cancelled'], ['resViewDeletedTab','deleted']]){
    const tab = el(id);
    if (!tab) continue;
    tab.classList.toggle('active', view === name);
    tab.setAttribute('aria-selected', String(view === name));
  }
  /* the status refinement (Upcoming/Checked in/Completed) only makes
     sense inside the active view — every row in Cancelled already is,
     and a deleted booking has left the lifecycle entirely */
  const hideStatus = view !== 'active';
  el('resFStatus').style.display = hideStatus ? 'none' : '';
  el('resFStatusLabel').style.display = hideStatus ? 'none' : '';
  if (hideStatus){ el('resFStatus').value = ''; state.res.status = ''; }
  renderReservations();
}
function fillFilterProfileSelects(){
  const opts = '<option value="">Anyone</option>' +
    state.profiles.map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}${p.employment_status === 'inactive' ? ' (inactive)' : ''}</option>`).join('');
  const a = el('resFInvited'); if (a){ const v = a.value; a.innerHTML = opts; a.value = v; }
  const b = el('custFMarketing'); if (b){ const v = b.value; b.innerHTML = opts; b.value = v; }
}

async function renderReservations(){
  const s = state.res;
  s.search = el('resSearch')?.value.trim() || '';
  fillFilterProfileSelects();
  /* the tab badges must always agree with what the list actually shows —
     they share the same search/invitedBy/date filters as the visible
     view (status only ever applies within Reservations, never Cancelled),
     otherwise a badge can promise a row the filtered list won't render */
  const shared = {};
  if (s.search) shared.search = s.search;
  if (s.invitedBy) shared.invitedBy = s.invitedBy;
  if (s.from) shared.from = s.from;
  if (s.to) shared.to = s.to;

  const showDeletedTab = maySeeDeleted();
  /* Sign out as an administrator and back in as a marketer in the same window
     and the view flag would still say "deleted". Reset it rather than trusting
     that nobody will manage it — the backend would refuse anyway, but the
     screen should not be asking. */
  if (s.view === 'deleted' && !showDeletedTab){ s.view = 'active'; s.page = 1; }
  const deletedView = s.view === 'deleted';
  const deletedTab = el('resViewDeletedTab');
  if (deletedTab) deletedTab.style.display = showDeletedTab ? '' : 'none';

  /* The visible list comes from whichever verb owns the view. Deleted uses the
     dedicated one; the badge for it is only ever requested when this session is
     allowed to have it, so a refusal never appears as a broken count. */
  const listCall = deletedView
    ? call(window.api.reservations.listDeleted, { ...shared, page:s.page, pageSize:s.pageSize })
    : call(window.api.reservations.list, { ...resFilterParams(), page:s.page, pageSize:s.pageSize });

  const [data, activeCount, cancelledCount, deletedCount] = await Promise.all([
    listCall,
    call(window.api.reservations.list, { ...shared, ...(s.status ? { status:s.status } : {}), view:'active', pageSize:1 }, { silent:true }),
    call(window.api.reservations.list, { ...shared, view:'cancelled', pageSize:1 }, { silent:true }),
    showDeletedTab
      ? call(window.api.reservations.listDeleted, { ...shared, pageSize:1 }, { silent:true }).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!data) return;
  s.total = data.total; s.rows = data.rows;
  el('resViewActiveCount').textContent = activeCount?.total ?? 0;
  el('resViewCancelledCount').textContent = cancelledCount?.total ?? 0;
  if (deletedTab) el('resViewDeletedCount').textContent = deletedCount?.total ?? 0;

  const tbody = el('resTableBody');
  const cancelledView = s.view === 'cancelled';
  /* The column holds the deletion reason in this view, so it says so. */
  const notesHeader = el('resNotesHeader');
  if (notesHeader) notesHeader.textContent = deletedView ? 'DELETION REASON' : 'NOTES';

  /* A deleted booking is a record of something that was undone. It carries who
     removed it, when, and why — and it offers no actions, because editing or
     cancelling a reservation that is no longer operational is meaningless. */
  if (deletedView){
    tbody.innerHTML = data.rows.length ? data.rows.map(r => `
      <tr tabindex="0" aria-label="${escapeHtml(r.customer_name)}, deleted reservation">
        <td class="muted">#${escapeHtml(r.customer_code)}</td>
        <td>${escapeHtml(r.customer_name)}</td>
        <td>${fmtDate(r.check_in)}</td>
        <td>${fmtDate(r.check_out)}</td>
        <td>${invitedByHTML(r.invited_by_name, r.invited_by_status)}</td>
        <td class="muted">${r.deletion_reason ? escapeHtml(r.deletion_reason) : '—'}</td>
        <td>
          <div class="status-cell">
            ${statusTagHTML('DELETED')}
            <span class="deleted-meta">${escapeHtml(r.deleted_by_username || 'unknown')} · ${fmtDateTime(r.deleted_at)}</span>
          </div>
        </td>
      </tr>`).join('')
      : emptyRow(7, s.search
          ? emptyState({ icon:'search', title:'Nothing matched that search',
              text:`No deleted reservation matches “${s.search}”.`,
              actions:[{ label:'Clear search', act:'clearSearchAnd', actArgs:['resSearch','onResSearch'] }] })
          : emptyState({ icon:'check', title:'No deleted reservations',
              text:'Reservations an administrator deletes are kept here, with the reason and who removed them.' }));
    pagerHTML('resPager', s.page, s.pageSize, s.total, 'goResPage');
    return;
  }
  tbody.innerHTML = data.rows.length ? data.rows.map(r => `
    <tr class="clickable" tabindex="0" data-activatable data-act="showCustomerDetail" data-on="click" data-args='[${r.customer_id},"resDetailPanel"]' data-act-dblclick="openReservationModal" data-args-dblclick='[${r.id}]' aria-label="${escapeHtml(r.customer_name)}, ${fmtDate(r.check_in)} to ${fmtDate(r.check_out)}">
      <td class="muted">#${escapeHtml(r.customer_code)}</td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td>${fmtDate(r.check_in)}</td>
      <td>${fmtDate(r.check_out)}</td>
      <td>${invitedByHTML(r.invited_by_name, r.invited_by_status)}</td>
      <td class="muted">${r.status === 'CANCELLED' && r.cancellation_reason ? 'Cancelled — ' + escapeHtml(r.cancellation_reason)
        : r.reservation_note ? escapeHtml(r.reservation_note) : '—'}</td>
      <td>
        <div class="status-cell">
          ${statusTagHTML(r.status)}
          <div class="row-actions">
            <button class="ra-btn" title="Edit" data-act="rowEditReservation" data-on="click" data-args='[${r.id}]'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            ${!cancelledView ? `
            <button class="ra-btn danger" title="Cancel reservation" data-act="rowCancelReservation" data-on="click" data-args='[${r.id}]'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
            </button>` : ''}
          </div>
        </div>
      </td>
    </tr>`).join('')
    : emptyRow(7, s.search
        ? emptyState({ icon:'search', title:'Nothing matched that search',
            text:`No reservation matches “${s.search}”.`,
            actions:[{ label:'Clear search', act:'clearSearchAnd', actArgs:['resSearch','onResSearch'] }] })
        : cancelledView
          ? emptyState({ icon:'check', title:'No cancelled reservations',
              text:'Cancelled reservations will appear here.' })
          : emptyState({ icon:'calendar', title:'No reservations yet',
              text:'Reservations you create will appear here.',
              actions:[{ label:'New Reservation', act:'openReservationModal', actArgs:[], primary:true }] }));
  pagerHTML('resPager', s.page, s.pageSize, s.total, 'goResPage');
}

/* ---------- cancel reservation (replaces destructive delete in normal use) ---------- */
let cancellingReservationId = null;
let cancellingReservationCustomerId = null;
async function openCancelReservationModal(id){
  cancellingReservationId = id;
  const r = state.res.rows.find(x => x.id === id) || (await call(window.api.reservations.get, { id }, { silent:true }));
  if (!r) return;
  cancellingReservationCustomerId = r.customer_id;
  el('cancelResSummary').textContent = `${r.customer_name} · ${fmtDate(r.check_in)} — ${fmtDate(r.check_out)}`;
  el('cancelResReason').value = '';
  el('cancelResOtherText').value = '';
  el('cancelResOtherField').style.display = 'none';
  openModal('modalCancelReservation');
}
function onCancelReasonChange(){
  const isOther = el('cancelResReason').value === 'Other';
  el('cancelResOtherField').style.display = isOther ? '' : 'none';
  if (isOther) setTimeout(() => el('cancelResOtherText')?.focus(), 30);
}
async function confirmCancelReservation(){
  if (!cancellingReservationId) return;
  clearFieldErrors(el('modalCancelReservation'));
  const picked = el('cancelResReason').value;
  /* a predefined reason already explains itself in the Notes/context it
     ends up in — "Other" is the one case that needs the marketer's own
     words instead, so it's the custom text that gets stored, not the
     literal word "Other" (spec §14) */
  if (picked === 'Other'){
    const custom = el('cancelResOtherText').value.trim();
    if (!custom){ showFieldError('cancelResOtherText', 'Describe the reason, or pick one of the listed options instead.'); return; }
  }
  const reason = picked === 'Other' ? el('cancelResOtherText').value.trim() : (picked || undefined);
  const r = await call(window.api.reservations.cancel, { id:cancellingReservationId, reason });
  if (r){
    toast('success','Reservation cancelled');
    closeModal('modalCancelReservation');
    if (el('modalReservation').classList.contains('show')) closeModal('modalReservation');
    const customerId = cancellingReservationCustomerId;
    cancellingReservationId = null; cancellingReservationCustomerId = null;
    await refreshReservationViews(customerId);
  }
}

/* ---------- delete reservation (permanent — reservations.delete, ADMIN
   only; a wholly different action from Cancel, which keeps the record) ---------- */
let deletingReservationId = null;
let deletingReservationCustomerId = null;
async function openDeleteReservationModal(id){
  if (!id || !can1('reservations.delete')) return;
  deletingReservationId = id;
  const r = state.res.rows.find(x => x.id === id) || (await call(window.api.reservations.get, { id }, { silent:true }));
  if (!r) return;
  deletingReservationCustomerId = r.customer_id;
  el('deleteResSummary').textContent = `${r.customer_name} · ${fmtDate(r.check_in)} — ${fmtDate(r.check_out)}`;
  el('deleteResStatusLine').innerHTML = `Current status: ${statusTagHTML(r.status)}`;
  el('deleteResReason').value = '';
  el('deleteResReasonError').textContent = '';
  el('deleteResReasonError').classList.remove('show');
  openModal('modalDeleteReservation');
}
async function confirmDeleteReservation(){
  if (!deletingReservationId) return;
  /* A deletion without a stated reason is an unanswerable question six months
     later, so the service requires one and the form must collect it. */
  const reason = el('deleteResReason').value.trim();
  if (!reason){
    el('deleteResReasonError').textContent = 'Give a reason so the record explains itself later.';
    el('deleteResReasonError').classList.add('show');
    el('deleteResReason').focus();
    return;
  }
  const r = await call(window.api.reservations.delete, { id:deletingReservationId, reason });
  if (r){
    toast('success','Reservation permanently deleted');
    closeModal('modalDeleteReservation');
    if (el('modalReservation').classList.contains('show')) closeModal('modalReservation');
    const customerId = deletingReservationCustomerId;
    deletingReservationId = null; deletingReservationCustomerId = null;
    await refreshReservationViews(customerId);
  }
}

/* ---------------- CRM PANEL ---------------- */
let custSearchTimer = null;
function onCustSearch(){ clearTimeout(custSearchTimer); custSearchTimer = setTimeout(() => { state.cust.page = 1; renderCustomers(); }, 220); }
function goCustPage(p){ state.cust.page = p; renderCustomers(); }
function setCustFilter(val, node){
  state.cust.status = val; state.cust.page = 1;
  markFilterActive('custFilterMenu', node);
  el('custFilterBtn').classList.toggle('filtered', !!val);
  closeAllFilterMenus();
  renderCustomers();
}
function sortCustomers(col){
  const s = state.cust;
  s.dir = (s.sort === col && s.dir === 'desc') ? 'asc' : 'desc';
  s.sort = col; s.page = 1;
  document.querySelectorAll('#crmPane_overview th.sortable').forEach(th => {
    th.classList.remove('sorted'); const a = th.querySelector('.sort-arrow'); if (a) a.textContent = '';
  });
  const th = [...document.querySelectorAll('#crmPane_overview th.sortable')]
    .find(t => t.getAttribute('onclick')?.includes(`'${col}'`));
  if (th){ th.classList.add('sorted'); th.querySelector('.sort-arrow').textContent = s.dir === 'desc' ? '↓' : '↑'; }
  renderCustomers();
}

/* An unset filter is ABSENT, not an empty string. The boundary schemas are
   strict and typed: `status:''` is not a valid status, `from:''` is not a
   business date, and `marketing` is not a field name the surface has — it is
   `assignedTo`. Sending those made the whole list call fail validation, so the
   screen rendered nothing at all rather than rendering unfiltered. */
function custFilterParams(){
  const s = state.cust;
  const p = { sort:s.sort, dir:s.dir };
  if (s.search) p.search = s.search;
  if (s.status) p.status = s.status;
  if (s.marketing) p.assignedTo = s.marketing;
  return p;
}
function applyCustFilters(){
  state.cust.marketing = el('custFMarketing').value;
  state.cust.page = 1;
  el('custFilterBtn').classList.toggle('filtered', !!(state.cust.status || state.cust.marketing));
  renderCustomers();
}
function clearCustFilters(){
  state.cust.status = ''; state.cust.marketing = '';
  el('custFMarketing').value = '';
  const all = document.querySelector('#custFilterMenu .filter-opt[data-val=""]');
  if (all) markFilterActive('custFilterMenu', all);
  el('custFilterBtn').classList.remove('filtered');
  closeAllFilterMenus();
  renderCustomers();
}

/* CRM Panel's three tabs share one dataset of guests, and every pane's
   DOM exists at once (only the active one is shown) — so a mutation that
   can change any guest's record/marketing status must refresh all three,
   not just whichever tab happened to be on screen when it fired. Calling
   this instead of renderCustomers() alone is what keeps an already-open
   No Record or Customer List tab from showing stale rows after a note,
   assignment, or edit made from somewhere else (spec §19/§21). */
async function refreshCrmViews(){
  await Promise.all([renderCustomers(), renderCustomerList(), renderNoRecord()]);
}
/* Every screen that can show a reservation's fingerprint — the Reservations/
   Cancelled list+counts, Dashboard's KPIs/Recent/Pending, the Action
   Calendar's day buckets, and any open guest inspector — must move together
   after a create/edit/cancel/delete, or one of them keeps a ghost row or a
   stale count until the guest happens to revisit it (spec §22/§28). */
async function refreshReservationViews(customerId){
  await Promise.all([
    renderReservations(), renderDashboard(), renderCalendar(), renderProfiles(),
    customerId != null ? refreshOpenInspectors(customerId) : Promise.resolve()
  ]);
}
async function renderCustomers(){
  const s = state.cust;
  s.search = el('custSearch')?.value.trim() || '';
  fillFilterProfileSelects();
  const data = await call(window.api.customers.list, {
    ...custFilterParams(), page:s.page, pageSize:s.pageSize });
  if (!data) return;
  s.total = data.total; s.rows = data.rows;

  const tbody = el('custTableBody');
  tbody.innerHTML = data.rows.length ? data.rows.map(c => `
    <tr class="clickable" tabindex="0" data-activatable data-act="showCustomerDetail" data-on="click" data-args='[${c.id},"detailPanel"]' data-act-dblclick="openCustomerModal" data-args-dblclick='[${c.id}]' aria-label="${escapeHtml(c.full_name)}, #${escapeHtml(c.code)}">
      <td class="muted">#${escapeHtml(c.code)}</td>
      <td>${escapeHtml(c.full_name)}</td>
      <td>${invitedByHTML(c.marketing_name, c.marketing_status)}</td>
      <td class="muted">${c.note_count ? `${c.note_count} note${c.note_count > 1 ? 's' : ''}` : '—'}</td>
      <td>
        <div class="status-cell">
          ${statusTagHTML(c.status)}
          ${canAssign() ? `
            <span class="row-menu-wrap">
              <button class="row-dots" data-act="toggleRowMenu" data-on="click" data-args='["rowMenu_${c.id}",{"$":"event"}]' aria-label="More actions for ${escapeHtml(c.full_name)}" aria-haspopup="true">⋯</button>
              <div class="row-menu" id="rowMenu_${c.id}" role="menu">
                <div class="row-menu-item" role="menuitem" tabindex="0" data-activatable data-act="openAssignModal" data-on="click" data-args='[${c.id},{"$":"event"}]'>ASSIGN</div>
                <div class="row-menu-item" role="menuitem" tabindex="0" data-activatable data-act="rowEditCustomer" data-on="click" data-args='[${c.id}]'>EDIT</div>
              </div>
            </span>` : ''}
        </div>
      </td>
      <td class="muted">${fmtDate(c.updated_at)}</td>
    </tr>`).join('')
    : emptyRow(6, s.search
        ? emptyState({ icon:'search', title:'No matching guests',
            text:`Nothing matches “${s.search}”.`,
            actions:[{ label:'Clear search', act:'clearSearchAnd', actArgs:['custSearch','onCustSearch'] },
                     { label:'New Customer', act:'openCustomerModal', actArgs:[], primary:true }] })
        : emptyState({ icon:'guests', title:'No guests yet',
            text:'Register a guest to start building the book.',
            actions:[{ label:'New Customer', act:'openCustomerModal', actArgs:[], primary:true }] }));
  pagerHTML('custPager', s.page, s.pageSize, s.total, 'goCustPage');
}

/* ---------------- CUSTOMER LIST (registered only) ---------------- */
let listSearchTimer = null;
function onListSearch(){ clearTimeout(listSearchTimer); listSearchTimer = setTimeout(renderCustomerList, 220); }
function sortList(col){
  const s = state.list;
  s.dir = (s.sort === col && s.dir === 'desc') ? 'asc' : 'desc';
  s.sort = col;
  document.querySelectorAll('#crmPane_customerlist th.sortable').forEach(th => {
    th.classList.remove('sorted'); const a = th.querySelector('.sort-arrow'); if (a) a.textContent = '';
  });
  const th = [...document.querySelectorAll('#crmPane_customerlist th.sortable')]
    .find(t => t.getAttribute('onclick')?.includes(`'${col}'`));
  if (th){ th.classList.add('sorted'); th.querySelector('.sort-arrow').textContent = s.dir === 'desc' ? '↓' : '↑'; }
  renderCustomerList();
}
function fillListFilterSelects(){
  const opts = '<option value="">Anyone</option>' +
    state.profiles.map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}${p.employment_status === 'inactive' ? ' (inactive)' : ''}</option>`).join('');
  const a = el('listFCreatedBy'); if (a){ const v = a.value; a.innerHTML = opts; a.value = v; }
  const b = el('listFAssignedTo'); if (b){ const v = b.value; b.innerHTML = opts; b.value = v; }
}
function applyListFilters(){
  const s = state.list;
  const isMarketing = state.session?.role === 'MARKETING';
  s.status = el('listFStatus').value;
  s.createdBy = isMarketing ? '' : el('listFCreatedBy').value;
  s.assignedTo = el('listFAssignedTo').value;
  s.hasReservation = el('listFHasRes').value;
  s.hasCrm = el('listFHasCrm').value;
  s.createdFrom = el('listFCreatedFrom').value;
  s.createdTo = el('listFCreatedTo').value;
  const active = !!(s.status || s.createdBy || s.assignedTo || s.hasReservation || s.hasCrm || s.createdFrom || s.createdTo);
  el('listFilterBtn').classList.toggle('filtered', active);
  renderCustomerList();
}
function clearListFilters(){
  ['listFStatus','listFCreatedBy','listFAssignedTo','listFHasRes','listFHasCrm','listFCreatedFrom','listFCreatedTo']
    .forEach(id => el(id).value = '');
  applyListFilters();
  closeAllFilterMenus();
}
function listFilterParams(){
  const s = state.list;
  return { status:s.status, createdBy:s.createdBy, assignedTo:s.assignedTo,
    hasReservation:s.hasReservation, hasCrm:s.hasCrm, createdFrom:s.createdFrom, createdTo:s.createdTo };
}
async function renderCustomerList(){
  const q = el('listSearch')?.value.trim() || '';
  const s = state.list;
  fillListFilterSelects();
  const data = await call(window.api.customers.list,
    { search:q, registeredOnly:true, sort:s.sort, dir:s.dir, pageSize:500, ...listFilterParams() });
  if (!data) return;
  el('listTableBody').innerHTML = data.rows.length ? data.rows.map(c => `
    <tr class="clickable" tabindex="0" data-activatable data-act="showCustomerDetail" data-on="click" data-args='[${c.id},"listDetailPanel"]' data-act-dblclick="openCustomerModal" data-args-dblclick='[${c.id}]' aria-label="${escapeHtml(c.full_name)}, #${escapeHtml(c.code)}">
      <td class="muted">#${escapeHtml(c.code)}</td>
      <td>${escapeHtml(c.full_name)}</td>
      <td class="muted">${escapeHtml(c.created_by_label)}</td>
      <td>${invitedByHTML(c.marketing_name, c.marketing_status)}</td>
      <td>${statusTagHTML(c.status)}</td>
      <td class="muted">${fmtDate(c.created_at)}</td>
    </tr>`).join('')
    : emptyRow(6, q || s.status || s.createdBy || s.assignedTo
        ? emptyState({ icon:'search', title:'No guests match the active filters',
            actions:[{ label:'Clear filters', act:'clearListFiltersAndSearch', actArgs:[] }] })
        : emptyState({ icon:'guests', title:'No guests registered yet',
            text:'Everyone added through New Customer shows up here.',
            actions:[{ label:'New Customer', act:'openCustomerModal', actArgs:[], primary:true }] }));
}

/* Change a reservation's state straight from the table. */
/* ---------------- NO RECORD ---------------- */
let norecTimer = null;
function onNorecSearch(){ clearTimeout(norecTimer); norecTimer = setTimeout(renderNoRecord, 220); }

async function renderNoRecord(){
  const q = el('norecSearch')?.value.trim() || '';
  const data = await call(window.api.customers.list,
    { search:q, noRecord:true, registeredOnly:true, sort:'created', dir:'desc', pageSize:500 });
  if (!data) return;
  const canAssignHere = ['ADMIN','MANAGER'].includes(state.session?.role);

  el('norecTableBody').innerHTML = data.rows.length ? data.rows.map(c => `
    <tr class="clickable" tabindex="0" data-act="openCustomerModal" data-on="dblclick" data-args='[${c.id}]' data-act-keydown="enterOpensCustomer" data-args-keydown='[${c.id}]' aria-label="${escapeHtml(c.full_name)}, #${escapeHtml(c.code)}. Press Enter to open.">
      <td class="muted">#${escapeHtml(c.code)}</td>
      <td>${escapeHtml(c.full_name)}</td>
      <td>${c.phone ? escapeHtml(c.phone) : '—'}</td>
      <td>${c.passport_no ? escapeHtml(c.passport_no) : '—'}</td>
      <td class="muted">${fmtDate(c.created_at)}</td>
      <td>
        <div class="status-cell">
          ${c.marketing_name ? invitedByHTML(c.marketing_name, c.marketing_status) : '<span class="muted">unassigned</span>'}
          ${canAssignHere ? `
            <span class="row-menu-wrap">
              <button class="row-dots" data-act="toggleRowMenu" data-on="click" data-args='["norecMenu_${c.id}",{"$":"event"}]' aria-label="More actions for ${escapeHtml(c.full_name)}" aria-haspopup="true">⋯</button>
              <div class="row-menu" id="norecMenu_${c.id}" role="menu">
                <div class="row-menu-item" role="menuitem" tabindex="0" data-activatable data-act="openAssignModal" data-on="click" data-args='[${c.id},{"$":"event"}]'>ASSIGN</div>
                <div class="row-menu-item" role="menuitem" tabindex="0" data-activatable data-act="rowEditCustomer" data-on="click" data-args='[${c.id}]'>EDIT</div>
              </div>
            </span>` : ''}
        </div>
      </td>
    </tr>`).join('')
    : emptyRow(6, q
        ? emptyState({ icon:'search', title:'No matching guests',
            actions:[{ label:'Clear search', act:'clearSearchAnd', actArgs:['norecSearch','onNorecSearch'] }] })
        : emptyState({ icon:'check', title:'Every guest has activity',
            text:'Nobody is sitting untouched right now.',
            actions:[{ label:'Open Overview', act:'setCrmView', actArgs:['overview'] }] }));

  const badge = el('norecBadge');
  if (badge){ badge.textContent = data.total; badge.classList.toggle('has', data.total > 0); badge.classList.toggle('show', data.total > 0); }
  const tabBadge = el('norecTabBadge');
  if (tabBadge){ tabBadge.textContent = data.total; }
  const submenuBadge = el('norecSubmenuBadge');
  if (submenuBadge){ submenuBadge.textContent = data.total; }
}

/* ---------------- GUEST CARD ---------------- */
let expandSeq = 0;
function toggleGuestExpand(panelId, btn){
  const node = el(panelId);
  if (!node) return;
  const open = node.classList.toggle('open');
  btn.classList.toggle('open', open);
  btn.querySelector('.et-label').textContent = open ? 'HIDE DETAILS' : 'SHOW DETAILS';
}

async function showCustomerDetail(customerId, panelId){
  const panel = el(panelId || 'detailPanel');
  if (!panel) return;
  state.selectedCustomerId = customerId;
  panel.dataset.customerId = String(customerId);
  /* A marketer keeps their own historical reservations for a guest even after
     management reassigns that guest to someone else — so a row they may
     legitimately see can point at a record they may no longer read. That is a
     correct authorization outcome, not an error: show a quiet empty state
     instead of letting the rejection surface as a crash. */
  let c = null;
  try { c = await call(window.api.customers.get, { id: customerId }, { silent:true }); }
  catch (e){
    panel.classList.add('empty');
    panel.innerHTML = e.code === 'FORBIDDEN' ? 'This guest is no longer assigned to you.' : 'Guest could not be loaded.';
    delete panel.dataset.customerId; return;
  }
  if (!c){ panel.classList.add('empty'); panel.innerHTML = 'Guest not found.'; delete panel.dataset.customerId; return; }

  /* Reservations and Cancelled are two views of one dataset everywhere
     else in the app (spec §6/§41) — the guest inspector's history must be
     the same: a cancelled stay is still part of this guest's record, just
     visibly marked, not silently missing from the timeline (spec §15). */
  const [resList, cancelledList, notes] = await Promise.all([
    call(window.api.reservations.list, { pageSize:200, sort:'check_in', dir:'desc' }, { silent:true }),
    call(window.api.reservations.list, { pageSize:200, sort:'check_in', dir:'desc', view:'cancelled' }, { silent:true }),
    call(window.api.crmNotes.list, { customerId }, { silent:true })
  ]);
  const stays = [...(resList?.rows || []), ...(cancelledList?.rows || [])]
    .filter(r => r.customer_id === c.id)
    .sort((a,b) => b.check_in.localeCompare(a.check_in));
  const noteList = notes || [];
  await resolvePhotos([c.photo_path]);
  const uid = 'gc' + (++expandSeq);

  const staysHTML = stays.length ? stays.map(r => `
    <div class="rz-item">
      <div class="rz-dates"><span>${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}</span>${statusTagHTML(r.status)}</div>
      <div class="rz-meta">Invited By: ${invitedByHTML(r.invited_by_name, r.invited_by_status)}</div>
      ${r.status === 'CANCELLED' && r.cancellation_reason ? `<div class="rz-note">Cancelled — “${escapeHtml(r.cancellation_reason)}”</div>`
        : r.reservation_note ? `<div class="rz-note">“${escapeHtml(r.reservation_note)}”</div>` : ''}
    </div>`).join('')
    : emptyState({ icon:'calendar', title:'No stays yet',
        actions:[{ label:'New Reservation', act:'openReservationModal', actArgs:[], primary:true }] });

  const notesHTML = noteList.length ? noteList.map(n => `
    <div class="note-block crm">
      <div class="nb-date"><span>${fmtDate(n.note_date)}</span><span>${escapeHtml(n.created_by_name || '')}</span></div>
      ${escapeHtml(n.note)}
    </div>`).join('')
    : emptyState({ icon:'check', title:'No CRM notes',
        actions:[{ label:'Add note', act:'openCrmNoteModal', actArgs:[c.id], primary:true }] });

  /* everything that ever happened to this guest, newest first */
  const events = [
    ...stays.map(r => ({ when:r.check_in, kind:'res',
      title:`Stay ${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}`,
      body:[r.invited_by_name ? 'Invited by ' + r.invited_by_name : '', r.reservation_note || '']
            .filter(Boolean).join(' · ') })),
    ...noteList.map(n => ({ when:n.note_date, kind:'note',
      title:'CRM note' + (n.created_by_name ? ' · ' + n.created_by_name : ''), body:n.note })),
    { when:(c.created_at || '').slice(0,10), kind:'assign', title:'Registered',
      body:`Added to the system as #${c.code}` }
  ].filter(e => e.when).sort((a,b) => String(b.when).localeCompare(String(a.when)));

  const timelineHTML = events.length ? `<div class="timeline">${events.map(e => `
    <div class="tl-item t-${e.kind}">
      <div class="tl-dot"></div>
      <div class="tl-when">${fmtDate(e.when)}</div>
      <div class="tl-title">${escapeHtml(e.title)}</div>
      ${e.body ? `<div class="tl-body">${escapeHtml(e.body)}</div>` : ''}
    </div>`).join('')}</div>`
    : emptyState({ icon:'check', title:'Nothing has happened yet' });

  const lastActivity = events[0]?.when || null;
  const nextStay = stays.find(r => r.status === 'UPCOMING' || r.status === 'CHECKED_IN');

  /* Overview answers "where do things stand" at a glance — facts and the
     most recent activity, not a duplicate of the full Reservations/Notes/
     Activity tabs. Quick actions are gated by the same permissions the
     server enforces, so nothing here promises an action the API refuses. */
  const overviewHTML = `
    <div class="gi-quick-actions">
      ${can1('reservations.create') ? `<button class="gi-action" data-act="openReservationModal" data-on="click" data-args='[null,${c.id}]'>Add Reservation</button>` : ''}
      ${can1('crmNotes.create') ? `<button class="gi-action" data-act="openCrmNoteModal" data-on="click" data-args='[${c.id}]'>Add CRM Note</button>` : ''}
      ${can1('customers.update') ? `<button class="gi-action" data-act="openCustomerModal" data-on="click" data-args='[${c.id}]'>Edit Guest</button>` : ''}
      ${canAssign() ? `<button class="gi-action" data-act="openAssignModal" data-on="click" data-args='[${c.id}]'>Reassign</button>` : ''}
    </div>
    <div class="gi-facts">
      <div class="gc-field"><div class="gf-l">Phone</div><div class="gf-v">${c.phone ? escapeHtml(c.phone) : '—'}</div></div>
      <div class="gc-field"><div class="gf-l">Email</div><div class="gf-v">${c.email ? escapeHtml(c.email) : '—'}</div></div>
      <div class="gc-field"><div class="gf-l">Created By</div><div class="gf-v">${escapeHtml(c.created_by_label)}</div></div>
      <div class="gc-field"><div class="gf-l">Assigned To</div><div class="gf-v">${invitedByHTML(c.marketing_name, c.marketing_status)}</div></div>
      <div class="gc-field"><div class="gf-l">Registered</div><div class="gf-v">${fmtDate(c.created_at)}</div></div>
      <div class="gc-field"><div class="gf-l">Last Activity</div><div class="gf-v">${lastActivity ? fmtDate(lastActivity) : '—'}</div></div>
    </div>
    ${nextStay ? `<div class="pane-title mt-4">Next Stay</div>
      <div class="rz-item"><div class="rz-dates"><span>${fmtDate(nextStay.check_in)} – ${fmtDate(nextStay.check_out)}</span>${statusTagHTML(nextStay.status)}</div></div>` : ''}
    <div class="pane-title mt-4">Recent Activity</div>
    ${events.length ? `<div class="timeline">${events.slice(0,3).map(e => `
      <div class="tl-item t-${e.kind}"><div class="tl-dot"></div><div class="tl-when">${fmtDate(e.when)}</div>
      <div class="tl-title">${escapeHtml(e.title)}</div></div>`).join('')}</div>`
      : emptyState({ icon:'check', title:'Nothing has happened yet' })}`;

  const statusM = statusMeta(c.status);
  panel.classList.remove('empty', 'collapsed');
  panel.innerHTML = `
    <button class="dp-rail" data-act="toggleDetailPanel" data-on="click" data-args='["${panelId}"]' title="Expand" aria-label="Expand guest panel">
      <span class="dp-rail-toggle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </span>
      <div class="avatar"${avatarStyle(c.photo_path)}>${photoUrl(c.photo_path) ? '' : escapeHtml(initials(c.full_name))}</div>
      <span class="${statusM ? statusM.cls : 'tag-none'}"><span class="dp-rail-status tag-dot"></span></span>
    </button>
    <div class="detail-head">
      <button class="detail-collapse-btn" data-act="toggleDetailPanel" data-on="click" data-args='["${panelId}"]' title="Collapse" aria-label="Collapse guest panel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <button class="detail-edit-btn" data-act="openCustomerModal" data-on="click" data-args='[${c.id}]' title="Edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <div class="avatar xxl"${avatarStyle(c.photo_path)}>${photoUrl(c.photo_path) ? '' : escapeHtml(initials(c.full_name))}</div>
      <div class="gc-name">${escapeHtml(c.full_name)}</div>
      <div class="setting-hint">#${escapeHtml(c.code)}${c.nationality ? ' · ' + escapeHtml(c.nationality) : ''}</div>
      <div class="mt-9">${statusTagHTML(c.status)}</div>
    </div>
    <div class="card-tabs" id="${uid}_tabs">
      <button class="card-tab active" data-act="switchCardTab" data-on="click" data-args='["${uid}","overview",{"$":"this"}]'>Overview</button>
      <button class="card-tab" data-act="switchCardTab" data-on="click" data-args='["${uid}","stays",{"$":"this"}]'>Reservations<span class="ct-count">${stays.length}</span></button>
      <button class="card-tab" data-act="switchCardTab" data-on="click" data-args='["${uid}","notes",{"$":"this"}]'>CRM Notes<span class="ct-count">${noteList.length}</span></button>
      <button class="card-tab" data-act="switchCardTab" data-on="click" data-args='["${uid}","timeline",{"$":"this"}]'>Activity</button>
    </div>
    <div class="card-body-scroll">
      <div class="card-pane active" id="${uid}_overview">${overviewHTML}</div>
      <div class="card-pane" id="${uid}_stays">${staysHTML}</div>
      <div class="card-pane" id="${uid}_notes">
        <div class="pane-head">
          <div class="pane-title">${noteList.length} note${noteList.length === 1 ? '' : 's'}</div>
          <button class="btn btn-outline btn-sm" data-act="openCrmNoteModal" data-on="click" data-args='[${c.id}]'>ADD NOTE</button>
        </div>
        ${notesHTML}
      </div>
      <div class="card-pane" id="${uid}_timeline">${timelineHTML}</div>
    </div>`;
}
/* A guest can be open in more than one inspector at once (e.g. Reservation
   History's rail and Customer List's rail both showing the same person) —
   after any mutation that changes what an inspector displays, re-render
   every open panel currently showing that guest rather than only the one
   the action happened to be triggered from, so none of them go stale. */
async function refreshOpenInspectors(customerId){
  const panelIds = ['detailPanel','listDetailPanel','resDetailPanel'];
  await Promise.all(panelIds
    .filter(id => el(id)?.dataset.customerId === String(customerId))
    .map(id => showCustomerDetail(customerId, id)));
}
function switchCardTab(uid, name, btn){
  ['overview','stays','notes','timeline'].forEach(n => el(`${uid}_${n}`)?.classList.toggle('active', n === name));
  [...el(`${uid}_tabs`).children].forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}
/* collapsing is a pure display toggle — nothing is re-rendered, so the
   selected guest and active card tab are exactly as left */
function toggleDetailPanel(panelId){
  el(panelId)?.classList.toggle('collapsed');
}
function showReservationCustomerDetail(id){ showCustomerDetail(id, 'resDetailPanel'); }
/* client-side mirror of the server's can() — used only to decide which
   quick actions to render; the API guard is always the real authority */
function can1(perm){
  const role = state.session?.role;
  if (!role) return false;
  if (role === 'ADMIN') return true;
  const grants = { MANAGER:['customers.update','customers.assign','reservations.create','crmNotes.create'],
                    MARKETING:['customers.update','reservations.create','crmNotes.create'] };
  return (grants[role] || []).includes(perm);
}

/* ---------------- ACTION CALENDAR ---------------- */
const CAL_MIN_YEAR = 2026, CAL_MIN_MONTH = 1; /* the business has no data before January 2026 */
const CAL_WEEKDAY_MON0 = (jsDay) => (jsDay + 6) % 7; /* JS Sunday=0 → Monday-first index */
let calYear = null, calMonth = null, calSelectedDate = null;
function calInit(){
  const t = new Date();
  calYear = t.getFullYear(); calMonth = t.getMonth() + 1;
  if (calYear < CAL_MIN_YEAR){ calYear = CAL_MIN_YEAR; calMonth = CAL_MIN_MONTH; }
}
function calGoToday(){ calInit(); renderCalendar(); }
function calShiftMonth(delta){
  calMonth += delta;
  if (calMonth < 1){ calMonth = 12; calYear--; }
  if (calMonth > 12){ calMonth = 1; calYear++; }
  if (calYear < CAL_MIN_YEAR || (calYear === CAL_MIN_YEAR && calMonth < CAL_MIN_MONTH)){
    calYear = CAL_MIN_YEAR; calMonth = CAL_MIN_MONTH;
  }
  renderCalendar();
}
const CAL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
async function renderCalendar(){
  if (calYear === null) calInit();
  el('calMonthLabel').textContent = `${CAL_MONTH_NAMES[calMonth - 1]} ${calYear}`;
  el('calPrevBtn').disabled = calYear === CAL_MIN_YEAR && calMonth === CAL_MIN_MONTH;

  const data = await call(window.api.calendar.month, { year:calYear, month:calMonth }, { silent:true });
  const buckets = data?.buckets || {};

  const first = new Date(calYear, calMonth - 1, 1);
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const leadDays = CAL_WEEKDAY_MON0(first.getDay());
  const totalCells = Math.ceil((leadDays + daysInMonth) / 7) * 7;
  const todayStr = todayYMD();

  let html = '';
  for (let i = 0; i < totalCells; i++){
    const dayNum = i - leadDays + 1;
    const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
    if (!inMonth){ html += `<div class="cal-day outside"></div>`; continue; }
    const dateStr = `${calYear}-${String(calMonth).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`;
    const b = buckets[dateStr] || { arrivals:0, active:0, departures:0 };
    const stats = [];
    if (b.arrivals) stats.push(`<span class="cal-stat"><span class="cal-dot arr"></span>${b.arrivals}</span>`);
    if (b.active) stats.push(`<span class="cal-stat"><span class="cal-dot act"></span>${b.active}</span>`);
    if (b.departures) stats.push(`<span class="cal-stat"><span class="cal-dot dep"></span>${b.departures}</span>`);
    html += `
    <div class="cal-day${dateStr === todayStr ? ' today' : ''}" data-act="openCalDay" data-on="click" data-args='["${dateStr}"]' role="gridcell" tabindex="0" data-activatable aria-label="${dateStr}, ${b.arrivals} arrivals, ${b.active} in house, ${b.departures} departures">
      <span class="cal-day-n">${dayNum}</span>
      <div class="cal-day-stats">${stats.join('')}</div>
    </div>`;
  }
  el('calGrid').innerHTML = html;
}
async function openCalDay(dateStr){
  calSelectedDate = dateStr;
  el('calDayModalTitle').textContent = fmtDate(dateStr);
  const data = await call(window.api.calendar.day, { date:dateStr });
  if (!data) return;
  const row = (r) => `
    <div class="mini-card" data-act="calDayGoToGuest" data-on="click" data-args='[${r.customer_id}]' class="clickable">
      <div class="mc-top"><span>${escapeHtml(r.customer_name)}</span>${statusTagHTML(r.status)}</div>
      <div class="mc-sub">${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}${r.invited_by_name ? ' · ' + escapeHtml(r.invited_by_name) : ''}</div>
    </div>`;
  el('calDayArrCount').textContent = data.arrivals.length;
  el('calDayArrList').innerHTML = data.arrivals.length ? data.arrivals.map(row).join('') : '<div class="empty-mini">No arrivals.</div>';
  el('calDayActCount').textContent = data.active.length;
  el('calDayActList').innerHTML = data.active.length ? data.active.map(row).join('') : '<div class="empty-mini">No guests in house.</div>';
  el('calDayDepCount').textContent = data.departures.length;
  el('calDayDepList').innerHTML = data.departures.length ? data.departures.map(row).join('') : '<div class="empty-mini">No departures.</div>';
  openModal('modalCalDay');
}

/* ---------------- PROFILES ---------------- */
/* Eight weekly buckets of activity, newest on the right. */
function weeklySeries(rows, weeks = 8){
  const buckets = new Array(weeks).fill(0);
  const now = Date.now();
  rows.forEach(r => {
    const age = Math.floor((now - Date.parse(r.check_in)) / (7 * 86400000));
    if (age >= 0 && age < weeks) buckets[weeks - 1 - age]++;
  });
  return buckets;
}
function sparkHTML(series){
  const max = Math.max(1, ...series);
  return `<div class="pc-spark">${series.map(v =>
    `<div class="spark-bar${v ? ' on' : ''}" data-bar-height="${Math.max(6, Math.round(v / max * 100))}" title="${v}"></div>`
  ).join('')}</div>`;
}

async function renderProfiles(){
  await refreshProfiles();
  const grid = el('profileGrid');
  if (!state.profiles.length){
    grid.innerHTML = emptyState({ icon:'guests', title:'No marketing profiles yet',
      text:'Add the people who bring guests in.',
      actions:[{ label:'New Profile', act:'openProfileModal', actArgs:[], primary:true }] });
    return;
  }
  /* one query, then the series are derived per person */
  const all = await call(window.api.reservations.list, { pageSize:1000, sort:'check_in', dir:'desc' }, { silent:true });
  const rows = all?.rows || [];
  const cutoff = Date.now() - 30 * 86400000;

  grid.innerHTML = state.profiles.map(p => {
    const mine = rows.filter(r => r.invited_by_profile_id === p.id);
    const recent = mine.filter(r => Date.parse(r.check_in) >= cutoff).length;
    const last = mine.length ? fmtDate(mine[0].check_in) : '—';
    const inactive = p.employment_status === 'inactive';
    const url = photoUrl(p.photo_path);
    return `
    <div class="profile-card${inactive ? ' inactive' : ''}" data-act="openProfileDetail" data-on="dblclick" data-args='[${p.id}]' title="Double-click for the full profile">
      <div class="pc-photo${url ? '' : ' no-photo'}">
        ${url ? `<div class="pc-photo-img" data-avatar="${escapeHtml(url)}"></div>` : `<div class="pc-initials">${escapeHtml(initials(p.full_name))}</div>`}
        ${inactive ? '<div class="pc-inactive-tag">Inactive</div>' : ''}
      </div>
      <div class="pc-content">
        <div class="pc-ident">
          <div class="pc-name">${escapeHtml(p.full_name)}</div>
          <div class="pc-sub">${p.nationality ? escapeHtml(p.nationality) : '—'}</div>
        </div>
        <div class="pc-metrics">
          <div class="pc-metric"><div class="n">${recent}</div><div class="l">30 DAYS</div></div>
          <div class="pc-metric"><div class="n">${p.customer_count}</div><div class="l">GUESTS</div></div>
          <div class="pc-metric"><div class="n fs-11">${last}</div><div class="l">LAST SEEN</div></div>
        </div>
        ${sparkHTML(weeklySeries(mine))}
      </div>
    </div>`;
  }).join('');
}

let currentDetailProfileId = null;
let pdInvitedPeriod = '30';
function periodFromDays(period){
  if (period === 'all') return '';
  return daysAgoYMD(Number(period));
}
function setPdView(view, btn){
  ['overview','invited','guests','customers'].forEach(v => el(`pdPane_${v}`)?.classList.toggle('active', v === view));
  [...el('pdViewTabs').children].forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  if (btn){ btn.classList.add('active'); btn.setAttribute('aria-selected','true'); }
}
async function openProfileDetail(id){
  const p = state.profiles.find(x => x.id === id);
  if (!p) return;
  currentDetailProfileId = id;
  pdInvitedPeriod = '30';
  setPdView('overview', el('pdViewTabs').children[0]);
  const inactive = p.employment_status === 'inactive';

  const url = photoUrl(p.photo_path);
  const av = el('pdAvatar');
  if (url){ av.style.backgroundImage = `url('${url}')`; av.textContent=''; }
  else { av.style.backgroundImage='none'; av.textContent = initials(p.full_name); }
  av.classList.toggle('inactive-photo', inactive);

  el('pdName').textContent = p.full_name;

  const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const chips = [];
  chips.push(`<span class="pd-chip">${icon('<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>')}${escapeHtml(p.nationality || 'Nationality not set')}</span>`);
  if (p.passport_no) chips.push(`<span class="pd-chip">${icon('<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M8.5 17h7"/>')}${escapeHtml(p.passport_no)}</span>`);
  if (p.phone) chips.push(`<span class="pd-chip">${icon('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>')}${escapeHtml(p.phone)}</span>`);
  chips.push(inactive
    ? `<span class="pd-chip ink-3">${icon('<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>')}No longer with the company</span>`
    : `<span class="pd-chip ink-teal">${icon('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>')}Active</span>`);
  el('pdChips').innerHTML = chips.join('');

  el('pdInvitedFilter').querySelectorAll('button').forEach((b,i) => b.classList.toggle('active', i === 0));
  const [custData, related, recentInvited] = await Promise.all([
    call(window.api.customers.list, { assignedTo:id, pageSize:500 }, { silent:true }),
    call(window.api.profiles.relatedCustomers, { id }, { silent:true }),
    call(window.api.reservations.list, { invitedBy:id, pageSize:3, sort:'check_in', dir:'desc' }, { silent:true })
  ]);
  const guests = custData?.rows || [];
  const relList = related || [];

  const recentRows = recentInvited?.rows || [];
  el('pdRecentInvited').innerHTML = recentRows.length ? recentRows.map(r => `
    <div class="mini-card">
      <div class="mc-top"><span>${escapeHtml(r.customer_name)}</span>${statusTagHTML(r.status)}</div>
      <div class="mc-sub">${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}</div>
    </div>`).join('') : '<div class="empty-mini">No reservations invited yet.</div>';

  el('pdGuestCount').textContent = guests.length;
  el('pdGuestList').innerHTML = guests.length ? guests.map(c => `
    <div class="mini-card">
      <div class="mc-top"><span>${escapeHtml(c.full_name)}</span>${statusTagHTML(c.status)}</div>
      <div class="mc-sub">#${escapeHtml(c.code)} · ${c.phone ? escapeHtml(c.phone) : '—'}</div>
    </div>`).join('') : '<div class="empty-mini">No assigned guests.</div>';

  el('pdCustCount').textContent = relList.length;
  /* ID and name only — the Created/Assigned/Invited relationship text was
     dropped from the display (spec §17); the underlying attribution that
     put a guest in this list at all is unchanged, just not spelled out
     here anymore */
  el('pdCustList').innerHTML = relList.length ? relList.map(c => `
    <div class="mini-card">
      <div class="mc-top"><span>${escapeHtml(c.full_name)}</span>${statusTagHTML(c.status)}</div>
      <div class="mc-sub">#${escapeHtml(c.code)}</div>
    </div>`).join('') : '<div class="empty-mini">No related guests yet.</div>';

  const invitedTotal = await refreshPdInvited();

  const weeks = Math.max(1, daysBetween(p.created_at, new Date().toISOString()) / 7);
  el('pdStats').innerHTML = `
    <div class="pd-stat"><div class="n">${guests.length}</div><div class="l">Guests</div></div>
    <div class="pd-stat"><div class="n">${invitedTotal}</div><div class="l">Reservations Invited</div></div>
    <div class="pd-stat"><div class="n">${(invitedTotal/weeks).toFixed(1)}</div><div class="l">Avg Res / Week</div></div>
    <div class="pd-stat"><div class="n">${(guests.length/weeks).toFixed(1)}</div><div class="l">Avg Guests / Week</div></div>`;

  openModal('modalProfileDetail');
}
async function refreshPdInvited(){
  if (currentDetailProfileId === null) return 0;
  const resData = await call(window.api.reservations.list,
    { invitedBy:currentDetailProfileId, from:periodFromDays(pdInvitedPeriod), pageSize:500, sort:'check_in', dir:'desc' },
    { silent:true });
  const invited = resData?.rows || [];
  el('pdInvitedCount').textContent = invited.length;
  el('pdInvitedList').innerHTML = invited.length ? invited.map(r => `
    <div class="mini-card">
      <div class="mc-top"><span>${escapeHtml(r.customer_name)}</span>${statusTagHTML(r.status)}</div>
      <div class="mc-sub">${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}</div>
      ${r.reservation_note ? `<div class="mc-note">"${escapeHtml(r.reservation_note)}"</div>` : ''}
    </div>`).join('') : '<div class="empty-mini">No invitations in this period.</div>';
  return invited.length;
}
async function setPdInvitedPeriod(period){
  pdInvitedPeriod = period;
  [...el('pdInvitedFilter').children].forEach(b => b.classList.toggle('active', b.getAttribute('onclick') === `setPdInvitedPeriod('${period}')`));
  await refreshPdInvited();
}
async function exportProfileSection(section){
  if (currentDetailProfileId === null) return;
  const entity = { invited:'profile_invited', guests:'profile_guests', customers:'profile_customers' }[section];
  const params = { profileId:currentDetailProfileId };
  if (section === 'invited') params.from = periodFromDays(pdInvitedPeriod);
  const r = await call(window.api.export.filtered, { entity, params });
  if (r) toast('success','Export complete', `${r.rows} rows → ${r.name}`);
}
function editProfileFromDetail(){ if (currentDetailProfileId !== null) openProfileModal(currentDetailProfileId); }

/* ---------------- NOTIFICATIONS ---------------- */
const NOTIF_ICONS = {
  cold_guest:    '<path d="M12 2v20M4.9 6.5l14.2 11M19.1 6.5L4.9 17.5"/>',
  checkin_soon:  '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  checkin_urgent:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  assignment:    '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="7" r="4"/><path d="M17 11l2 2 4-4"/>'
};
const NOTIF_TONE = { cold_guest:'cold', checkin_soon:'soon', checkin_urgent:'urgent', assignment:'assign' };

async function renderNotifications(){
  const node = el('notifList');
  if (!node) return;
  const list = await call(window.api.notifications.list, {}, { silent:true });
  if (!list || !list.length){
    node.innerHTML = emptyState({ icon:'bell', title:'Nothing needs you right now',
      text:'Alerts about upcoming stays and cold guests appear here.' });
    refreshNotifBadge(); return;
  }
  node.innerHTML = list.map(n => `
    <div class="notif-item${n.read ? '' : ' unread'}"
         ${n.related_customer_id ? `data-act="openNotification" data-on="click" data-args='[${n.id},${n.related_customer_id}]' class="clickable"` : `data-act="markNotificationRead" data-on="click" data-args='[${n.id}]'`}>
      <div class="notif-icon t-${NOTIF_TONE[n.type] || 'assign'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NOTIF_ICONS[n.type] || NOTIF_ICONS.assignment}</svg>
      </div>
      <div class="notif-main">
        <div class="notif-title">${escapeHtml(n.title)}</div>
        <div class="notif-text">${escapeHtml(n.message)}</div>
      </div>
      <div class="notif-time">${fmtDate(n.created_at)}</div>
      ${n.read ? '' : '<div class="notif-dot"></div>'}
      <button class="notif-x" title="Dismiss" data-act="dismissNotification" data-on="click" data-args='[${n.id},{"$":"event"}]'>✕</button>
    </div>`).join('');
  refreshNotifBadge();
}
async function openNotification(id, customerId){
  await call(window.api.notifications.markRead, { id }, { silent:true });
  await goToGuest(customerId, 'customers');
  refreshNotifBadge();
}
async function dismissNotification(id, ev){
  ev?.stopPropagation();
  await call(window.api.notifications.delete, { id }, { silent:true });
  await renderNotifications();
  refreshNotifBadge();
}
async function markNotificationRead(id){
  await call(window.api.notifications.markRead, { id }, { silent:true });
  renderNotifications();
}
/* "Mark all read" also clears the list — a read alert has served its purpose. */
async function markAllNotificationsRead(){
  await call(window.api.notifications.dismissAll, {}, { silent:true });
  await renderNotifications();
  refreshNotifBadge();
}
/* Called un-awaited from a dozen places, and unreadCount now fails closed
   rather than answering 0 without a session — so a rejection here would surface
   as an unhandled promise rejection in the middle of an unrelated action. A
   badge that cannot be read is simply a badge that does not update. */
async function refreshNotifBadge(){
  const badge = el('notifBadge');
  if (!badge || !state.session) return;
  try {
    const n = await call(window.api.notifications.unreadCount, {}, { silent:true });
    badge.textContent = n || 0;
    badge.classList.toggle('has', (n || 0) > 0);
  } catch (_) { /* leave the badge as it was */ }
}

/* ---------------- REPORTS — a builder, not a fixed dashboard: pick a
   report type, set contextual filters, generate, then export exactly
   what was generated ---------------- */
let reportType = 'reservations';
let reportPeriod = '30';
let reportRows = [], reportExportEntity = null, reportExportParams = {};

async function renderReports(){
  const access = await call(window.api.reports.access, {}, { silent:true }).catch(() => null);
  el('reportTypeTabs').style.display = access ? '' : 'none';
  el('reportFilters').closest('.panel').style.display = access ? '' : 'none';
  el('reportResultsWrap').style.display = 'none';
  if (!access){
    el('reportEmptyWrap').innerHTML = emptyState({ icon:'guests', title:'Reports are restricted',
      text:'Your role does not have access to reports. Ask an administrator to grant it in Settings.' });
    return;
  }
  el('reportEmptyWrap').innerHTML = '';
  const scopeNote = el('reportScope');
  const isMarketing = state.session?.role === 'MARKETING';
  if (scopeNote) scopeNote.textContent = isMarketing ? 'Your own figures' : 'All marketing profiles';
  /* Marketing Performance ranks every profile against each other — an
     ADMIN/MANAGER view, same restriction as the Dashboard's Team panel */
  el('reportMarketingTab').classList.toggle('hidden', isMarketing);
  if (isMarketing && reportType === 'marketing'){
    reportType = 'reservations';
    document.querySelectorAll('#reportTypeTabs .view-switch-tab').forEach(b => {
      b.classList.remove('active'); b.setAttribute('aria-selected','false');
    });
    const resTab = document.querySelector('#reportTypeTabs .view-switch-tab');
    resTab?.classList.add('active'); resTab?.setAttribute('aria-selected','true');
  }
  renderReportFilters();
}
function setReportType(type, btn){
  reportType = type;
  document.querySelectorAll('#reportTypeTabs .view-switch-tab').forEach(b => {
    b.classList.remove('active'); b.setAttribute('aria-selected','false');
  });
  if (btn){ btn.classList.add('active'); btn.setAttribute('aria-selected','true'); }
  renderReportFilters();
  el('reportResultsWrap').style.display = 'none';
  el('reportEmptyWrap').innerHTML = '';
}
function fillProfileSelect(id){
  const sel = el(id); if (!sel) return;
  /* every report a MARKETING user can reach is already scoped to their own
     profile server-side, so a selector offering other marketers is dead
     weight at best — lock it to self instead (spec §7) */
  if (state.session?.role === 'MARKETING'){
    const self = state.profiles.find(p => p.id === state.session.profile_id);
    sel.innerHTML = `<option value="${state.session.profile_id}">${escapeHtml(self?.full_name || state.session.full_name || 'Me')}</option>`;
    sel.value = String(state.session.profile_id);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = '<option value="">All</option>' +
    state.profiles.map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');
}
function setReportPeriod(period){
  reportPeriod = period;
  el('rptMarketingPeriod')?.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.getAttribute('onclick') === `setReportPeriod('${period}')`));
}
function renderReportFilters(){
  const wrap = el('reportFilters');
  if (reportType === 'reservations'){
    wrap.innerHTML = `
      <div class="report-filter-grid">
        <div class="field"><label for="rptResStatus">Status</label>
          <select class="fm-input" id="rptResStatus"><option value="">All statuses</option>
            <option value="UPCOMING">Upcoming</option><option value="CHECKED_IN">Checked in</option>
            <option value="COMPLETED">Completed</option></select></div>
        <div class="field"><label for="rptResInvited">Invited By</label><select class="fm-input" id="rptResInvited"></select></div>
        <div class="field"><label for="rptResFrom">Check-in From</label><input class="fm-input" type="date" id="rptResFrom"></div>
        <div class="field"><label for="rptResTo">Check-in To</label><input class="fm-input" type="date" id="rptResTo"></div>
      </div>`;
    fillProfileSelect('rptResInvited');
  } else if (reportType === 'guests'){
    wrap.innerHTML = `
      <div class="report-filter-grid">
        <div class="field"><label for="rptGStatus">Status</label>
          <select class="fm-input" id="rptGStatus"><option value="">All statuses</option>
            <option value="COLD">Cold</option><option value="NO_RECORD">No Record</option></select></div>
        <div class="field"><label for="rptGAssignedTo">Assigned To</label><select class="fm-input" id="rptGAssignedTo"></select></div>
        <div class="field"><label for="rptGFrom">Registered From</label><input class="fm-input" type="date" id="rptGFrom"></div>
        <div class="field"><label for="rptGTo">Registered To</label><input class="fm-input" type="date" id="rptGTo"></div>
      </div>`;
    fillProfileSelect('rptGAssignedTo');
  } else if (reportType === 'marketing'){
    wrap.innerHTML = `
      <div class="field"><label>Period</label>
        <div class="split-filter" id="rptMarketingPeriod">
          <button data-act="setReportPeriod" data-on="click" data-args='["7"]'>7D</button>
          <button class="active" data-act="setReportPeriod" data-on="click" data-args='["30"]'>30D</button>
          <button data-act="setReportPeriod" data-on="click" data-args='["90"]'>3M</button>
          <button data-act="setReportPeriod" data-on="click" data-args='["180"]'>6M</button>
          <button data-act="setReportPeriod" data-on="click" data-args='["all"]'>ALL</button>
        </div>
      </div>`;
    reportPeriod = '30';
  } else if (reportType === 'cold'){
    wrap.innerHTML = `
      <div class="report-filter-grid">
        <div class="field"><label for="rptColdAssignedTo">Assigned To</label><select class="fm-input" id="rptColdAssignedTo"></select></div>
      </div>`;
    fillProfileSelect('rptColdAssignedTo');
  } else if (reportType === 'norecord'){
    wrap.innerHTML = `
      <div class="report-filter-grid">
        <div class="field"><label for="rptNRFrom">Registered From</label><input class="fm-input" type="date" id="rptNRFrom"></div>
        <div class="field"><label for="rptNRTo">Registered To</label><input class="fm-input" type="date" id="rptNRTo"></div>
      </div>`;
  }
}
async function runReport(){
  await withBusy(el('reportGenerateBtn'), 'GENERATING…', async () => {
    if (reportType === 'reservations'){
      const params = { status: el('rptResStatus').value, invitedBy: el('rptResInvited').value,
        from: el('rptResFrom').value, to: el('rptResTo').value, pageSize:1000, sort:'check_in', dir:'desc' };
      const data = await call(window.api.reservations.list, params, { silent:true });
      reportRows = (data?.rows || []).map(r => ({ Guest:r.customer_name, 'Check In':fmtDate(r.check_in),
        'Check Out':fmtDate(r.check_out), Status:r.status, 'Invited By':r.invited_by_name || '—',
        Note:r.reservation_note || '—' }));
      reportExportEntity = 'reservations';
      reportExportParams = { status:params.status, invitedBy:params.invitedBy, from:params.from, to:params.to };
    } else if (reportType === 'guests'){
      const params = { status: el('rptGStatus').value,
        assignedTo: el('rptGAssignedTo').value, createdFrom: el('rptGFrom').value, createdTo: el('rptGTo').value,
        registeredOnly:true, pageSize:1000 };
      const data = await call(window.api.customers.list, params, { silent:true });
      reportRows = (data?.rows || []).map(c => ({ ID:c.code, Name:c.full_name, Phone:c.phone || '—',
        Status:c.status, 'Assigned To':c.marketing_name || '—',
        Reservations:c.reservation_count, Registered:fmtDate(c.created_at) }));
      reportExportEntity = 'customerlist'; reportExportParams = params;
    } else if (reportType === 'marketing'){
      const from = reportPeriod === 'all' ? '' : daysAgoYMD(Number(reportPeriod));
      const periodLabel = DASH_PERIOD_LABEL[reportPeriod] || '30 Days';
      const data = await call(window.api.reservations.list, { from, pageSize:1000 }, { silent:true });
      const tally = {};
      (data?.rows || []).forEach(r => { if (r.invited_by_profile_id) tally[r.invited_by_profile_id] = (tally[r.invited_by_profile_id] || 0) + 1; });
      const col = `Reservations (${periodLabel})`;
      reportRows = state.profiles.map(p => ({ Profile:p.full_name, Status:p.employment_status,
        [col]: tally[p.id] || 0, 'Guests Assigned':p.customer_count, 'Total Reservations Invited':p.reservation_count }))
        .sort((a,b) => b[col] - a[col]);
      reportExportEntity = 'report_marketing'; reportExportParams = { from, periodLabel };
    } else if (reportType === 'cold'){
      const params = { status:'COLD', assignedTo: el('rptColdAssignedTo').value, registeredOnly:true, pageSize:1000 };
      const data = await call(window.api.customers.list, params, { silent:true });
      reportRows = (data?.rows || []).map(c => ({ Name:c.full_name, Phone:c.phone || '—',
        'Assigned To':c.marketing_name || '—', 'Last Visit':c.last_visit ? fmtDate(c.last_visit) : '—',
        'Days Since Visit':c.last_visit ? daysBetween(c.last_visit, todayYMD()) : '—' }));
      reportExportEntity = 'customerlist'; reportExportParams = params;
    } else if (reportType === 'norecord'){
      const params = { noRecord:true, registeredOnly:true, createdFrom: el('rptNRFrom').value, createdTo: el('rptNRTo').value, pageSize:1000 };
      const data = await call(window.api.customers.list, params, { silent:true });
      reportRows = (data?.rows || []).map(c => ({ ID:c.code, Name:c.full_name,
        'Created By':c.created_by_label, Registered:fmtDate(c.created_at) }));
      reportExportEntity = 'norecord'; reportExportParams = params;
    }
    renderReportTable();
  });
}
function renderReportTable(){
  const wrap = el('reportResultsWrap');
  if (!reportRows.length){
    wrap.style.display = 'none';
    el('reportEmptyWrap').innerHTML = emptyState({ icon:'search', title:'No results',
      text:'Nothing matched those filters — try widening the range.' });
    return;
  }
  el('reportEmptyWrap').innerHTML = '';
  wrap.style.display = '';
  const cols = Object.keys(reportRows[0]);
  el('reportResultsHead').innerHTML = `<tr>${cols.map(c => `<th scope="col">${escapeHtml(c.toUpperCase())}</th>`).join('')}</tr>`;
  el('reportResultsBody').innerHTML = reportRows.map(r =>
    `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c]))}</td>`).join('')}</tr>`).join('');
  el('reportResultCount').textContent = `${reportRows.length} result${reportRows.length === 1 ? '' : 's'}`;
}
async function exportReportResults(){
  if (!reportExportEntity) return;
  const r = await call(window.api.export.filtered, { entity:reportExportEntity, params:reportExportParams });
  if (r) toast('success', 'Export complete', `${r.rows} rows → ${r.name}`);
}

/* ---------------- USERS ---------------- */
async function renderUsers(){
  const users = await call(window.api.users.list, {});
  el('usersTableBody').innerHTML = (users || []).length ? users.map(u => `
    <tr class="clickable" tabindex="0" data-act="openUserModal" data-on="dblclick" data-args='[${u.id}]' data-act-keydown="enterOpensUser" data-args-keydown='[${u.id}]' aria-label="${escapeHtml(u.username)}. Press Enter to open.">
      <td>${escapeHtml(u.username)}</td>
      <td>${u.full_name ? escapeHtml(u.full_name) : '<span class="muted">—</span>'}</td>
      <td><span class="role-pill ${u.role.toLowerCase()}">${u.role}</span></td>
      <td>${statusTagHTML(u.active ? 'ACCOUNT_ACTIVE' : 'ACCOUNT_DISABLED')}</td>
      <td class="muted">${u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
    </tr>`).join('') : emptyRow(5, emptyState({ icon:'guests', title:'No accounts yet',
        actions:[{ label:'New User', act:'openUserModal', actArgs:[], primary:true }] }));
}

/* ---------------- AUDIT ---------------- */
function goAuditPage(p){ state.audit.page = p; renderAudit(); }
async function renderAudit(){
  const s = state.audit;
  const data = await call(window.api.audit.list, { page:s.page, pageSize:s.pageSize });
  if (!data) return;
  s.total = data.total;
  el('auditTableBody').innerHTML = data.rows.length ? data.rows.map(r => `
    <tr>
      <td class="muted">${fmtDateTime(r.created_at)}</td>
      <td>${r.username ? escapeHtml(r.username) : '<span class="muted">system</span>'}</td>
      <td><span class="audit-action">${escapeHtml(r.action)}</span></td>
      <td class="muted">${r.entity_type ? escapeHtml(r.entity_type) + (r.entity_id ? ' #' + r.entity_id : '') : '—'}</td>
      <td class="muted">${r.description ? escapeHtml(r.description) : '—'}</td>
    </tr>`).join('') : emptyRow(5, emptyState({ icon:'check', title:'No activity recorded yet' }));
  pagerHTML('auditPager', s.page, s.pageSize, s.total, 'goAuditPage');
}

/* ---------------- SETTINGS ---------------- */
async function renderSettings(){
  const s = await call(window.api.settings.all, {});
  state.settings = s || {};
  el('setTheme').value = s?.['appearance.theme'] || 'light';
  el('setDensity').value = s?.['appearance.density'] || 'comfortable';
  const who = el('settingsWhoAmI');
  if (who) who.textContent = `Signed in as ${state.session?.username || ''} · ${state.session?.role || ''}`;

  /* Backup, restore and permissions are administrator territory. */
  el('backupSection').style.display = isAdmin() ? 'block' : 'none';
  el('permissionsSection').style.display = isAdmin() ? 'block' : 'none';
  if (!isAdmin()) return;

  el('setAutoBackup').checked = (s?.['backup.auto_enabled'] ?? 'true') === 'true';
  el('setBackupFreq').value = s?.['backup.frequency'] || 'startup';
  el('setBackupKeep').value = s?.['backup.keep'] || '10';
  el('setManagerFeed').checked = (s?.['notifications.manager_feed'] ?? 'true') === 'true';
  await Promise.all([loadBackups(), renderPermissionMatrix()]);
}

/* Grant or revoke any capability, per role, from one grid. */
async function renderPermissionMatrix(){
  const m = await call(window.api.settings.permissions, {});
  if (!m) return;
  const rows = Object.entries(m.labels).map(([key, label]) => `
    <div class="perm-row">
      <div class="perm-name">${escapeHtml(label)}</div>
      ${['MANAGER','MARKETING'].map(role => `
        <div class="perm-cell">
          <label class="switch">
            <input type="checkbox" ${m.roles[role][key] ? 'checked' : ''}
                   data-act="togglePermission" data-on="change" data-args='["${role}","${jsonAttr(key)}",{"$":"checked"}]'>
            <span class="track"><span class="knob"></span></span>
          </label>
        </div>`).join('')}
    </div>`).join('');
  el('permGrid').innerHTML = `
    <div class="perm-row">
      <div class="perm-head text-left">Capability</div>
      <div class="perm-head">Manager</div>
      <div class="perm-head">Marketing</div>
    </div>${rows}`;
}
async function togglePermission(role, key, value){
  const m = await call(window.api.settings.permissions, {}, { silent:true });
  const matrix = { MANAGER:{}, MARKETING:{} };
  ['MANAGER','MARKETING'].forEach(r => Object.keys(m.labels).forEach(k => { matrix[r][k] = m.roles[r][k]; }));
  matrix[role][key] = value;
  const res = await call(window.api.settings.setPermissions, { matrix });
  if (res) toast('success', value ? 'Permission granted' : 'Permission revoked');
}
/* Preferences persist as you change them — no save button, no noise. */
async function saveSetting(key, value){
  await call(window.api.settings.set, { key, value: String(value) });
}
async function loadBackups(){
  const list = await call(window.api.backup.list, {});
  el('backupList').innerHTML = (list || []).length ? list.map(b => `
    <div class="list-row">
      <div class="lr-main">
        <div class="lr-name">${escapeHtml(b.name)}</div>
        <div class="lr-sub">${fmtDateTime(b.createdAt)} · ${(b.byteSize/1024).toFixed(0)} KB</div>
      </div>
      <button class="pager-btn" data-act="doRestore" data-on="click" data-args='["${jsonAttr(b.name)}"]'>Restore</button>
    </div>`).join('') : '<div class="panel-empty">No backups yet</div>';
}
async function doBackupNow(){
  await withBusy(el('backupNowBtn'), 'WORKING…', async () => {
    const r = await call(window.api.backup.create, {});
    if (r) toast('success','Backup created', r.name);
    await loadBackups();
  });
}
async function doRestore(name){
  const sure = await window.api.dialog.confirm({
    title:'Restore database', message:`Restore from ${name}?`,
    detail:'Current data will be replaced. A safety backup is taken first.',
    confirmLabel:'Restore', type:'warning'
  });
  if (!sure?.data) return;
  const r = await call(window.api.backup.restore, { name });
  if (r){
    toast('success','Database restored', `Safety copy: ${r.safetyBackup}`);
    await switchTab('dashboard');
  }
}
async function openDataFolder(){ await call(window.api.backup.openFolder, {}); }
async function exportEntity(entity){
  const r = await call(window.api.export.run, { entity });
  if (r) toast('success','Export complete', `${r.rows} rows → ${r.name}`);
}

/** Exports exactly what is on screen: same search, filters and sort order. */
async function exportCurrentView(entity){
  const params = entity === 'norecord' ? { search: el('norecSearch')?.value.trim() || '', noRecord:true, registeredOnly:true }
               : entity === 'reservations' ? resFilterParams()
               : entity === 'customerlist' ? { search: el('listSearch')?.value.trim() || '', sort:state.list.sort, dir:state.list.dir }
               : custFilterParams();
  const r = await call(window.api.export.filtered, { entity, params });
  if (r) toast('success','Export complete', `${r.rows} rows → ${r.name}`);
}

/* ---------------- appearance ---------------- */
/* Light is the default surface; dark is the variant. */
function applyTheme(theme, persist){
  document.body.classList.toggle('theme-dark', theme === 'dark');
  if (persist) saveSetting('appearance.theme', theme);
}
function applyDensity(density, persist){
  document.body.classList.toggle('density-compact', density === 'compact');
  if (persist) saveSetting('appearance.density', density);
}
