'use strict';
/* =====================================================================
   Guest record page, activity feed, Team control and Audit Log filters.
   Same rules as the other screens: every figure comes from the main
   process, every interpolated value goes through escapeHtml, and every
   control is a data-act name resolved by the delegated dispatcher.
   ===================================================================== */

/* ---------------- shared bits ---------------- */
const KIND_LABELS = { guest:'Guests', note:'CRM notes', stay:'Reservations', assign:'Assignments' };
const KIND_ICONS = {
  guest:'<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c.9-3.9 3.6-5.9 6.5-5.9s5.6 2 6.5 5.9"/>',
  note:'<path d="M4 5h16v11H9l-5 4Z"/>',
  stay:'<path d="M3 18V8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/>',
  assign:'<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  alert:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  cold:'<path d="M12 2v20M4.9 6.5l14.2 11M19.1 6.5L4.9 17.5"/>',
  arrive:'<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  lock:'<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
};
function kindIcon(kind){
  return `<span class="ev-icon k-${escapeHtml(kind)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${KIND_ICONS[kind] || KIND_ICONS.note}</svg></span>`;
}
/* Audit timestamps are UTC instants; group and label them on the local clock. */
function localInstant(v){
  if (!v) return null;
  const d = new Date(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}
function fmtTime(d){ return d ? `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` : ''; }
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function dayHeading(ymd){
  const d = new Date(`${ymd}T00:00:00`);
  const label = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (ymd === todayYMD()) return `Today · ${label}`;
  if (ymd === daysAgoYMD(1)) return `Yesterday · ${label}`;
  return label;
}
function plural(n, one, many){ return `${n} ${n === 1 ? one : (many || one + 's')}`; }

/* =====================================================================
   GUEST RECORD — the full page behind "Full record"
   ===================================================================== */
async function openGuestPage(customerId){
  const from = workspace.active === 'guest' ? (state.guestPage.from || 'customers') : workspace.active;
  state.guestPage = { id:Number(customerId), name:'', from, filter:'all' };
  await switchTab('guest', { forceReload:true });
}
function setGuestHistoryFilter(filter){
  state.guestPage.filter = filter;
  document.querySelectorAll('#guestHistoryFilter button').forEach(b =>
    b.classList.toggle('active', actionArgMatches(b, filter)));
  document.querySelectorAll('#guestHistoryList .gh-item').forEach(row => {
    row.classList.toggle('hidden', filter !== 'all' && row.dataset.kind !== filter);
  });
}
function guestPageBack(){
  const target = state.guestPage.from && state.guestPage.from !== 'guest' ? state.guestPage.from : 'customers';
  switchTab(target);
}

async function renderGuestPage(){
  const wrap = el('guestPageBody');
  const g = state.guestPage;
  if (!wrap || !g?.id) return;
  const customerId = g.id;
  let c = null;
  try { c = await call(window.api.customers.get, { id:customerId }, { silent:true }); }
  catch (e){
    wrap.innerHTML = emptyState({ icon:'guests',
      title: e.code === 'FORBIDDEN' ? 'This guest is no longer assigned to you' : 'Guest could not be loaded' });
    return;
  }
  if (!c){ wrap.innerHTML = emptyState({ icon:'guests', title:'Guest not found' }); return; }

  const [resList, cancelledList, notes, history] = await Promise.all([
    call(window.api.reservations.list, { customerId, pageSize:200, sort:'check_in', dir:'desc' }, { silent:true }).catch(() => null),
    call(window.api.reservations.list, { customerId, pageSize:200, sort:'check_in', dir:'desc', view:'cancelled' }, { silent:true }).catch(() => null),
    call(window.api.crmNotes.list, { customerId }, { silent:true }).catch(() => []),
    call(window.api.customers.history, { id:customerId }, { silent:true }).catch(() => [])
  ]);
  /* The guest may have changed while the calls were in flight. */
  if (state.guestPage.id !== customerId) return;

  g.name = c.full_name;
  renderWorkspaceStrip(); updateCrumbs();
  await resolvePhotos([c.photo_name]);

  const stays = [...(resList?.rows || []), ...(cancelledList?.rows || [])]
    .filter(r => r.customer_id === c.id)
    .sort((a, b) => String(b.check_in).localeCompare(String(a.check_in)));
  const noteList = sortNotesNewestFirst(notes || []);
  const assignments = [...(history || [])].reverse();
  const nextStay = [...stays].reverse().find(r => r.status === 'UPCOMING' || r.status === 'CHECKED_IN');

  /* History: everything that happened to the guest, newest first. */
  const events = [
    ...noteList.map(n => ({ kind:'note', sortKey: n.created_at || n.note_date, when: n.created_at ? fmtDateTime(n.created_at) : fmtDate(n.note_date),
      title:'CRM note', who:n.created_by_name || n.created_by_username || '', body:n.note })),
    ...stays.map(r => ({ kind:'stay', sortKey: r.created_at || r.check_in, when: fmtDate(r.check_in),
      title:`Reservation ${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}`,
      who: r.invited_by_name ? 'invited by ' + r.invited_by_name : '',
      body: r.status === 'CANCELLED' ? `Cancelled${r.cancellation_reason ? ' — ' + r.cancellation_reason : ''}` : (r.reservation_note || ''),
      status:r.status })),
    ...assignments.filter(h => h.event_type !== 'CREATED' || h.new_profile_id).map(h => ({ kind:'assign', sortKey:h.changed_at, when:fmtDateTime(h.changed_at),
      title: h.new_profile_name ? `Assigned to ${h.new_profile_name}` : 'Unassigned',
      who: h.actor_username ? 'by ' + h.actor_username : '',
      body: h.previous_profile_name ? `Previously ${h.previous_profile_name}` : '' })),
    { kind:'guest', sortKey:c.created_at, when:fmtDateTime(c.created_at), title:`Registered as #${c.code}`,
      who: c.created_by_label ? 'by ' + c.created_by_label : '', body:'' }
  ].filter(e => e.sortKey).sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
  const lastActivity = events[0]?.sortKey || null;
  const count = (k) => events.filter(e => e.kind === k).length;
  const filter = ['all','note','stay'].includes(g.filter) ? g.filter : 'all';

  const historyHTML = events.map(e => `
    <div class="gh-item${filter !== 'all' && e.kind !== filter ? ' hidden' : ''}" data-kind="${escapeHtml(e.kind)}">
      ${kindIcon(e.kind)}
      <div class="gh-main">
        <div class="gh-top"><b>${escapeHtml(e.title)}</b>${e.who ? `<span class="muted">${escapeHtml(e.who)}</span>` : ''}${e.status ? statusTagHTML(e.status) : ''}
          <span class="gh-when">${escapeHtml(e.when)}</span></div>
        ${e.body ? `<div class="gh-body">${escapeHtml(e.body)}</div>` : ''}
      </div>
    </div>`).join('');

  const staysHTML = stays.length ? stays.map(r => {
    const due = (r.status === 'UPCOMING') ? pendingDue(r).label : '';
    return `<div class="rz-item">
      <div class="rz-dates"><span>${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}</span>${statusTagHTML(r.status)}</div>
      <div class="rz-meta">${r.invited_by_name ? 'Invited by ' + invitedByHTML(r.invited_by_name, r.invited_by_status) : 'No inviter'}${due ? ' · ' + escapeHtml(due) : ''}</div>
      ${r.reservation_note ? `<div class="rz-note">${escapeHtml(r.reservation_note)}</div>` : ''}
    </div>`; }).join('') : '<div class="empty-mini">No reservations yet.</div>';

  const assignHTML = assignments.length ? assignments.slice(0, 6).map(h => `
    <div class="rz-item">
      <div class="rz-dates"><span>${h.new_profile_name ? escapeHtml(h.new_profile_name) : 'Unassigned'}</span><span class="muted">${fmtDate(h.changed_at)}</span></div>
      <div class="rz-meta">${h.previous_profile_name ? 'from ' + escapeHtml(h.previous_profile_name) : 'first assignment'}${h.actor_username ? ' · by ' + escapeHtml(h.actor_username) : ''}</div>
    </div>`).join('') : '<div class="empty-mini">No assignment changes recorded.</div>';

  const fact = (label, value) => `<div class="gp-fact"><div class="gp-fact-l">${label}</div><div class="gp-fact-v">${value}</div></div>`;
  const row = (label, value) => `<div class="gc-field"><div class="gf-l">${label}</div><div class="gf-v">${value ? escapeHtml(value) : '—'}</div></div>`;
  const backLabel = escapeHtml(pageLabel(g.from || 'customers'));

  wrap.innerHTML = `
    <div class="gp-back">
      <button class="btn-link" data-act="guestPageBack" data-on="click" data-args='[]'>← Back to ${backLabel}</button>
    </div>
    <section class="gp-head panel">
      <div class="gp-head-main">
        <div class="avatar xl"${avatarStyle(c.photo_name)}>${photoUrl(c.photo_name) ? '' : escapeHtml(initials(c.full_name))}</div>
        <div class="gp-ident">
          <h1 class="page-title" tabindex="-1">${escapeHtml(c.full_name)}</h1>
          <div class="gp-sub">#${escapeHtml(c.code)}${c.nationality ? ' · ' + escapeHtml(c.nationality) : ''} ${statusTagHTML(c.status)}</div>
        </div>
        ${guestActionsHTML(c, 'gp-actions')}
      </div>
      <div class="gp-facts">
        ${fact('Assigned to', c.marketing_name ? invitedByHTML(c.marketing_name, c.marketing_status) : '<span class="muted">Unassigned</span>')}
        ${fact('Next stay', nextStay ? `${fmtDate(nextStay.check_in)} – ${fmtDate(nextStay.check_out)}` : '<span class="muted">None booked</span>')}
        ${fact('Last activity', lastActivity ? fmtDate(lastActivity) : '—')}
        ${fact('CRM notes', String(noteList.length))}
      </div>
    </section>
    <div class="gp-grid">
      <div class="gp-col">
        <section class="panel gp-card">
          <div class="panel-head"><h2 class="panel-title">Guest note</h2>
            ${can1('customers.update') ? `<button class="btn-link" data-act="openCustomerModal" data-on="click" data-args='[${c.id}]'>Edit</button>` : ''}</div>
          <div class="gp-card-body">${guestNoteHTML(c) || '<div class="empty-mini">No guest note.</div>'}</div>
        </section>
        <section class="panel gp-card">
          <div class="panel-head"><h2 class="panel-title">Contact &amp; identity</h2></div>
          <div class="gp-card-body">
            ${row('Phone', c.phone)}${row('Email', c.email)}${row('Passport', c.passport_no)}${row('Nationality', c.nationality)}
            ${row('Registered', fmtDate(c.created_at))}${row('Created by', c.created_by_label)}
          </div>
        </section>
      </div>
      <section class="panel gp-history">
        <div class="panel-head">
          <h2 class="panel-title">History <span class="muted gp-hint">newest first</span></h2>
          <div class="seg" id="guestHistoryFilter" role="group" aria-label="Filter history">
            <button class="${filter === 'all' ? 'active' : ''}" data-act="setGuestHistoryFilter" data-on="click" data-args='["all"]'>All <span>${events.length}</span></button>
            <button class="${filter === 'note' ? 'active' : ''}" data-act="setGuestHistoryFilter" data-on="click" data-args='["note"]'>CRM notes <span>${count('note')}</span></button>
            <button class="${filter === 'stay' ? 'active' : ''}" data-act="setGuestHistoryFilter" data-on="click" data-args='["stay"]'>Stays <span>${count('stay')}</span></button>
          </div>
        </div>
        ${can1('crmNotes.create') ? `<div class="gp-composer">${noteComposerHTML(c.id, 'guestPageComposer', true)}</div>` : ''}
        <div class="gh-list" id="guestHistoryList">${historyHTML || '<div class="panel-empty">Nothing has happened yet</div>'}</div>
      </section>
      <div class="gp-col">
        <section class="panel gp-card">
          <div class="panel-head"><h2 class="panel-title">Reservations <span class="count-pill">${stays.length}</span></h2>
            ${can1('reservations.create') ? `<button class="btn-link" data-act="openReservationModal" data-on="click" data-args='[null,${c.id}]'>Add</button>` : ''}</div>
          <div class="gp-card-body">${staysHTML}</div>
        </section>
        <section class="panel gp-card">
          <div class="panel-head"><h2 class="panel-title">Assignment</h2>
            ${canAssign() ? `<button class="btn-link" data-act="openAssignModal" data-on="click" data-args='[${c.id}]'>Reassign</button>` : ''}</div>
          <div class="gp-card-body">${assignHTML}</div>
        </section>
      </div>
    </div>`;
}

/* =====================================================================
   CRM OVERVIEW — filter chips, Table | Activity, Today's activity
   ===================================================================== */
function custActiveFilters(){
  const out = [];
  const s = state.cust;
  if (s.status){
    const label = ({ COLD:'Cold', NO_RECORD:'No record', ACTIVE:'Active' })[s.status] || s.status;
    out.push({ key:'status', label:`Status: ${label}` });
  }
  if (s.marketing){
    const p = state.profiles.find(x => String(x.id) === String(s.marketing));
    out.push({ key:'marketing', label:`Marketing: ${p ? p.full_name : '#' + s.marketing}` });
  }
  return out;
}
function renderCustFilterChips(){
  const filters = custActiveFilters();
  const btn = el('custFilterBtn');
  if (btn){
    btn.classList.toggle('filtered', filters.length > 0);
    btn.setAttribute('aria-label', filters.length ? `Filter (${filters.length} active)` : 'Filter');
    const n = el('custFilterCount');
    if (n){ n.textContent = String(filters.length); n.classList.toggle('hidden', filters.length === 0); }
  }
  const wrap = el('custChips');
  if (!wrap) return;
  wrap.classList.toggle('hidden', filters.length === 0);
  wrap.innerHTML = filters.map(f => `
    <span class="chip">${escapeHtml(f.label)}
      <button class="chip-x" data-act="removeCustFilter" data-on="click" data-args='["${jsonAttr(f.key)}"]' aria-label="Remove ${escapeHtml(f.label)}">×</button>
    </span>`).join('') + (filters.length ? '<button class="btn-link chip-clear" data-act="clearCustFilters" data-on="click" data-args=\'[]\'>Clear all</button>' : '');
}
function removeCustFilter(key){
  if (key === 'status'){
    state.cust.status = '';
    const all = document.querySelector('#custFilterMenu .filter-opt[data-val=""]');
    if (all) markFilterActive('custFilterMenu', all);
  }
  if (key === 'marketing'){
    state.cust.marketing = '';
    const sel = el('custFMarketing'); if (sel) sel.value = '';
  }
  state.cust.page = 1;
  renderCustomers();
}

async function setCustMode(mode){
  state.custMode = mode === 'activity' ? 'activity' : 'table';
  el('custTableView')?.classList.toggle('hidden', state.custMode !== 'table');
  el('custActivityView')?.classList.toggle('hidden', state.custMode !== 'activity');
  document.querySelectorAll('#custModeSwitch button').forEach(b => {
    const on = actionArgMatches(b, state.custMode);
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
  /* search, filter and export act on the table; the feed has its own controls */
  el('custSearch')?.closest('.toolbar')?.classList.toggle('mode-activity', state.custMode === 'activity');
  if (state.custMode === 'activity') el('custChips')?.classList.add('hidden'); else renderCustFilterChips();
  updateCrumbs();
  if (state.custMode === 'activity') await renderActivity();
}
async function openTodaysActivity(){
  state.act.range = 'today'; state.act.kind = '';
  if (workspace.active !== 'customers' || state.crmView !== 'overview') await goCrmView('overview');
  await setCustMode('activity');
}
function activityWindow(){
  const t = todayYMD();
  switch (state.act.range){
    case 'yesterday': return { from:daysAgoYMD(1), to:daysAgoYMD(1), label:'yesterday' };
    case '7': return { from:daysAgoYMD(6), to:t, label:'last 7 days' };
    case '30': return { from:daysAgoYMD(29), to:t, label:'last 30 days' };
    default: return { from:t, to:t, label:'today' };
  }
}
async function setActivityRange(range){ state.act.range = range; await renderActivity(); }
async function setActivityKind(kind){ state.act.kind = kind || ''; await renderActivity(); }
async function setActivityActor(userId){ state.act.actorUserId = userId || null; await renderActivity(); }

let activitySeq = 0;
async function renderActivity(){
  const wrap = el('custActivityView');
  if (!wrap) return;
  const seq = ++activitySeq;
  const win = activityWindow();
  const teamCap = hasCap('activity.team');
  const payload = omitBlank({ from:win.from, to:win.to, kind:state.act.kind,
    actorUserId: teamCap && state.act.actorUserId ? Number(state.act.actorUserId) : '' });
  let data = null;
  try { data = await call(window.api.activity.feed, payload, { silent:true }); }
  catch (e){ wrap.innerHTML = emptyState({ icon:'check', title:'Activity could not be loaded', text:e.message || '' }); return; }
  if (seq !== activitySeq || !data) return;

  const teamWide = !!data.teamWide;
  const rangeBtn = (val, label) => `<button class="${state.act.range === val ? 'active' : ''}" data-act="setActivityRange" data-on="click" data-args='["${jsonAttr(val)}"]'>${label}</button>`;
  const kindBtn = (val, label) => `<button class="${state.act.kind === val ? 'active' : ''}" data-act="setActivityKind" data-on="click" data-args='["${jsonAttr(val)}"]'>${label}</button>`;
  const k = data.byKind || {};
  const actor = teamWide && state.act.actorUserId ? (data.byActor || []).find(a => String(a.userId) === String(state.act.actorUserId)) : null;
  const scopeLabel = !teamWide ? 'Only your actions' : (actor ? escapeHtml(actor.name) : 'Everyone');
  const summary = [
    [data.total, 'Actions'], [k.note || 0, 'CRM notes'], [k.guest || 0, 'Guest changes'],
    [k.stay || 0, 'Reservations'], [k.assign || 0, 'Assignments']
  ];

  const members = teamWide ? `
    <section class="panel act-members">
      <div class="panel-head"><h2 class="panel-title">By team member</h2></div>
      <div class="panel-body">
        <div class="am-row${!state.act.actorUserId ? ' active' : ''}" role="button" tabindex="0" data-activatable data-act="setActivityActor" data-on="click" data-args='[null]'>
          <div class="lr-avatar">All</div>
          <div class="lr-main"><div class="lr-name">Everyone</div><div class="lr-sub">${plural((data.byActor || []).length, 'person', 'people')} active</div></div>
          <div class="am-n">${data.total}</div>
        </div>
        ${(data.byActor || []).map(a => {
          const bits = [a.note ? plural(a.note, 'note') : '', a.guest ? plural(a.guest, 'guest change') : '',
            a.stay ? plural(a.stay, 'reservation') : '', a.assign ? plural(a.assign, 'assignment') : ''].filter(Boolean).join(' · ');
          const on = a.userId != null && String(a.userId) === String(state.act.actorUserId);
          return `<div class="am-row${on ? ' active' : ''}" role="button" tabindex="0" data-activatable data-act="setActivityActor" data-on="click" data-args='[${a.userId == null ? 'null' : Number(a.userId)}]'>
            <div class="lr-avatar">${escapeHtml(initials(a.name))}</div>
            <div class="lr-main"><div class="lr-name">${escapeHtml(a.name)}</div><div class="lr-sub">${escapeHtml(bits || 'No actions')}</div></div>
            <div class="am-n">${a.total}</div>
          </div>`; }).join('')}
      </div>
    </section>` : '';

  /* Group by local calendar day, newest first. */
  const groups = [];
  for (const ev of data.events || []){
    const d = localInstant(ev.created_at);
    const ymd = d ? todayYMD(d) : 'unknown';
    let g = groups[groups.length - 1];
    if (!g || g.ymd !== ymd){ g = { ymd, items:[] }; groups.push(g); }
    g.items.push({ ev, d });
  }
  const feed = groups.length ? groups.map(g => `
    <div class="act-day">${escapeHtml(g.ymd === 'unknown' ? 'Undated' : dayHeading(g.ymd))}</div>
    ${g.items.map(({ ev, d }) => `
      <div class="act-ev">
        <div class="act-time">${escapeHtml(fmtTime(d))}</div>
        ${kindIcon(ev.kind)}
        <div class="act-main">
          <div class="act-line"><b>${escapeHtml(ev.actor_name || 'System')}</b>
            ${ev.redacted ? '<span class="muted">worked on a guest outside your book</span>'
              : `<span>${escapeHtml(ev.description || ev.action)}</span>`}</div>
          ${!ev.redacted && ev.note_text ? `<div class="act-note">${escapeHtml(ev.note_text)}</div>` : ''}
          ${!ev.redacted && ev.customer_id ? `<button class="btn-link act-open" data-act="openGuestPage" data-on="click" data-args='[${Number(ev.customer_id)}]'>Open guest</button>` : ''}
        </div>
      </div>`).join('')}`).join('')
    : emptyState({ icon:'check', title:`No activity ${win.label}`, text: teamWide ? 'Nobody has recorded any work in this period.' : 'You have not recorded any work in this period.' });

  wrap.innerHTML = `
    <div class="act-toolbar">
      <div class="seg" role="group" aria-label="Period">
        ${rangeBtn('today', 'Today')}${rangeBtn('yesterday', 'Yesterday')}${rangeBtn('7', 'Last 7 days')}${rangeBtn('30', 'Last 30 days')}
      </div>
      <div class="seg" role="group" aria-label="Kind of action">
        ${kindBtn('', 'All')}${kindBtn('note', 'CRM notes')}${kindBtn('guest', 'Guests')}${kindBtn('stay', 'Reservations')}${kindBtn('assign', 'Assignments')}
      </div>
      <span class="scope-pill">${teamWide ? 'Team view' : 'My activity'}</span>
    </div>
    <div class="act-summary" id="actSummary">
      ${summary.map(([n, l]) => `<div class="as-cell"><div class="as-n">${Number(n) || 0}</div><div class="as-l">${l}</div></div>`).join('')}
    </div>
    <div class="act-layout${teamWide ? ' has-members' : ''}">
      ${members}
      <section class="panel act-feed">
        <div class="panel-head"><h2 class="panel-title">${teamWide ? 'Activity' : 'My activity'} <span class="muted gp-hint">${scopeLabel} · ${escapeHtml(win.label)} · newest first</span></h2></div>
        <div class="act-feed-body" id="actFeed">${feed}
          ${data.truncated ? '<div class="act-trunc">Showing the newest 500 actions. Narrow the period or pick a person to see the rest.</div>' : ''}
        </div>
      </section>
    </div>`;
}

/* =====================================================================
   TEAM CONTROL
   ===================================================================== */
const ROLE_LABEL = { ADMIN:'Administrator', MANAGER:'Manager', MARKETING:'Marketing' };
let teamSeq = 0;
async function renderTeamControl(){
  const wrap = el('teamBody');
  if (!wrap) return;
  const seq = ++teamSeq;
  let d = null;
  try { d = await call(window.api.team.overview, {}, { silent:true }); }
  catch (e){ wrap.innerHTML = emptyState({ icon:'guests', title:'Team control could not be loaded', text:e.message || '' }); return; }
  if (seq !== teamSeq || !d) return;
  const stamp = el('teamUpdated'); if (stamp) stamp.textContent = `Updated ${fmtTime(new Date())}`;

  const a = d.alerts || {};
  const names = (x) => (x?.names || []).join(', ');
  const card = (icon, tone, title, n, sub, act, args, link) => `
    <div class="alert-card${n ? ' t-' + tone : ''}">
      <div class="ac-head">${kindIcon(icon)}<span>${title}</span></div>
      <div class="ac-n">${Number(n) || 0}</div>
      <div class="ac-sub">${sub ? escapeHtml(sub) : '<span class="muted">Nothing to review</span>'}</div>
      <button class="btn-link" data-act="${act}" data-on="click" data-args='${JSON.stringify(args).replace(/'/g, '&#39;')}'>${link} →</button>
    </div>`;
  const arrivals = (a.arrivals48h?.items || []).map(i => `${i.full_name} · ${fmtDate(i.check_in)}`).join(', ');
  const alerts = [
    card('alert', 'warn', 'Unassigned guests', a.unassigned?.count, names(a.unassigned), 'goCrmView', ['customerlist'], 'Review'),
    card('cold', 'cold', 'Cold guests', a.cold?.count, names(a.cold), 'goCustomersFiltered', ['COLD'], 'Review'),
    card('note', 'warn', 'No record', a.noRecord?.count, names(a.noRecord), 'goCrmView', ['norecord'], 'Open list'),
    card('arrive', 'info', 'Check-ins in 48 h', a.arrivals48h?.count, arrivals, 'goReservationsUpcoming', [], 'Open'),
    ...(a.lockedAccounts ? [card('lock', 'danger', 'Locked accounts', a.lockedAccounts, 'Too many failed sign-ins', 'switchTab', ['users'], 'Users')] : [])
  ].join('');

  const num = (v) => v == null ? '<span class="muted">—</span>' : (Number(v) === 0 ? '<span class="muted">0</span>' : String(Number(v)));
  const members = (d.members || []).map(m => {
    const login = localInstant(m.last_login_at);
    const today = login && todayYMD(login) === todayYMD();
    const loginText = login ? (today ? `Today ${fmtTime(login)}` : fmtDateTime(m.last_login_at)) : 'Never';
    const flags = [!m.active ? '<span class="tag tag-none"><span class="tag-dot"></span>Disabled</span>' : '',
      m.locked ? '<span class="tag tag-deleted"><span class="tag-dot"></span>Locked</span>' : ''].join('');
    return `<tr>
      <td><div class="tm-name"><span class="lr-avatar">${escapeHtml(initials(m.full_name || m.username))}</span>
        <div><div>${escapeHtml(m.full_name || m.username)}</div><div class="muted tm-sub">${escapeHtml(m.username)}${m.profile_name ? ' · ' + escapeHtml(m.profile_name) : ''}</div></div></div></td>
      <td><span class="role-pill ${escapeHtml(String(m.role).toLowerCase())}">${escapeHtml(ROLE_LABEL[m.role] || m.role)}</span> ${flags}</td>
      <td><span class="login-dot${today ? ' on' : ''}"></span>${escapeHtml(loginText)}</td>
      <td class="n">${num(m.actions_today)}</td>
      <td class="n">${num(m.notes_7d)}</td>
      <td class="n">${m.profile_id ? num(m.reservations_30d) : '<span class="muted">—</span>'}</td>
      <td class="n">${m.profile_id ? num(m.guests) : '<span class="muted">—</span>'}</td>
      <td class="n">${m.attention == null ? '<span class="muted">—</span>' : (m.attention ? `<b class="tm-attn">${Number(m.attention)}</b>` : '<span class="muted">0</span>')}</td>
      <td class="n"><button class="btn-link" data-act="openMemberActivity" data-on="click" data-args='[${Number(m.id)}]'>Activity</button></td>
    </tr>`;
  }).join('');

  const sensitive = (d.sensitive || []).map(r => {
    const t = localInstant(r.created_at);
    return `<div class="sens-row">
      ${kindIcon(/ASSIGN/.test(r.action) ? 'assign' : (/DELETE|LOCK|BLOCK/.test(r.action) ? 'alert' : 'lock'))}
      <div class="sens-main"><div class="sens-title">${escapeHtml(sentenceAction(r.action))}</div>
        <div class="muted sens-sub">${escapeHtml(r.description || '')}${r.actor_name ? ' · by ' + escapeHtml(r.actor_name) : ''}</div></div>
      <div class="sens-when muted">${t ? (todayYMD(t) === todayYMD() ? fmtTime(t) : fmtDateTime(r.created_at)) : ''}</div>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="alert-row">${alerts}</div>
    <section class="panel team-panel">
      <div class="panel-head"><h2 class="panel-title">Team <span class="count-pill">${(d.members || []).length}</span></h2>
        <span class="muted gp-hint">Counts are live; "today" is this computer's calendar day</span></div>
      <div class="table-scroll">
        <table class="team-table">
          <thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Last sign-in</th>
            <th scope="col" class="n">Actions today</th><th scope="col" class="n">Notes 7d</th><th scope="col" class="n">Reservations 30d</th>
            <th scope="col" class="n">Guests</th><th scope="col" class="n">Cold / no record</th><th scope="col"><span class="visually-hidden">Open</span></th></tr></thead>
          <tbody id="teamTableBody">${members || emptyRow(9, emptyState({ icon:'guests', title:'No accounts yet' }))}</tbody>
        </table>
      </div>
    </section>
    <section class="panel team-panel">
      <div class="panel-head"><h2 class="panel-title">Sensitive actions <span class="muted gp-hint">newest first</span></h2>
        ${mayOpen('audit') ? '<button class="btn-link" data-act="switchTab" data-on="click" data-args=\'["audit"]\'>Audit Log</button>' : ''}</div>
      <div class="sens-list" id="teamSensitive">${sensitive || '<div class="panel-empty">No sensitive actions recorded</div>'}</div>
    </section>`;
}
function sentenceAction(action){
  const s = String(action || '').toLowerCase().replace(/_/g, ' ').replace(/\bcrm\b/g, 'CRM');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
async function openMemberActivity(userId){
  state.act.actorUserId = userId; state.act.range = 'today'; state.act.kind = '';
  await goCrmView('overview');
  await setCustMode('activity');
}

/* =====================================================================
   AUDIT LOG FILTERS
   ===================================================================== */
async function applyAuditFilters(){
  const s = state.audit;
  s.actorUserId = el('auditFActor')?.value || '';
  s.action = el('auditFAction')?.value || '';
  s.from = el('auditFFrom')?.value || '';
  s.to = el('auditFTo')?.value || '';
  s.page = 1;
  await renderAudit();
}
async function removeAuditFilter(key){
  const ids = { actorUserId:'auditFActor', action:'auditFAction', from:'auditFFrom', to:'auditFTo' };
  if (ids[key] && el(ids[key])) el(ids[key]).value = '';
  await applyAuditFilters();
}
async function clearAuditFilters(){
  ['auditFActor','auditFAction','auditFFrom','auditFTo'].forEach(id => { const n = el(id); if (n) n.value = ''; });
  closeAllFilterMenus();
  await applyAuditFilters();
}
function auditFilterPayload(){
  const s = state.audit;
  /* actorUserId only when a person is chosen — never an empty value. */
  return omitBlank({ action:s.action, from:s.from, to:s.to,
    actorUserId: s.actorUserId ? Number(s.actorUserId) : '' });
}
function fillAuditFacets(facets){
  if (!facets) return;
  const actor = el('auditFActor'), action = el('auditFAction');
  if (actor){
    actor.innerHTML = '<option value="">Anyone</option>' + (facets.actors || []).map(a =>
      `<option value="${Number(a.id)}">${escapeHtml(a.name || a.username)}${a.username && a.name !== a.username ? ' (' + escapeHtml(a.username) + ')' : ''}</option>`).join('');
    actor.value = state.audit.actorUserId || '';
  }
  if (action){
    action.innerHTML = '<option value="">Any action</option>' + (facets.actions || []).map(x =>
      `<option value="${escapeHtml(x)}">${escapeHtml(sentenceAction(x))}</option>`).join('');
    action.value = state.audit.action || '';
  }
}
function renderAuditChips(){
  const s = state.audit;
  const chips = [];
  if (s.actorUserId){
    const a = (s.facets?.actors || []).find(x => String(x.id) === String(s.actorUserId));
    chips.push({ key:'actorUserId', label:`Person: ${a ? (a.name || a.username) : '#' + s.actorUserId}` });
  }
  if (s.action) chips.push({ key:'action', label:`Action: ${sentenceAction(s.action)}` });
  if (s.from) chips.push({ key:'from', label:`From ${fmtDate(s.from)}` });
  if (s.to) chips.push({ key:'to', label:`To ${fmtDate(s.to)}` });
  const btn = el('auditFilterBtn');
  if (btn){
    btn.classList.toggle('filtered', chips.length > 0);
    const n = el('auditFilterCount');
    if (n){ n.textContent = String(chips.length); n.classList.toggle('hidden', chips.length === 0); }
  }
  const wrap = el('auditChips');
  if (!wrap) return;
  wrap.classList.toggle('hidden', chips.length === 0);
  wrap.innerHTML = chips.map(c => `<span class="chip">${escapeHtml(c.label)}
      <button class="chip-x" data-act="removeAuditFilter" data-on="click" data-args='["${jsonAttr(c.key)}"]' aria-label="Remove ${escapeHtml(c.label)}">×</button></span>`).join('')
    + (chips.length ? '<button class="btn-link chip-clear" data-act="clearAuditFilters" data-on="click" data-args=\'[]\'>Clear all</button>' : '');
}
/* The export carries the same filters as the table, so the file matches the screen. */
async function exportAuditFiltered(){
  const r = await call(window.api.export.run, { entity:'audit_logs', params:auditFilterPayload() });
  if (r) toast('success', 'Export complete', `${r.rows} rows → ${r.name}`);
}

/* =====================================================================
   UPDATES (Settings) — status comes from main's updates:status events and
   from updates.check(); installing is ADMIN-only and main enforces it.
   ===================================================================== */
const updatesState = { status:null, subscribed:false };
const UPDATE_STATE_TEXT = {
  idle:'Waiting for the next scheduled check',
  checking:'Checking for updates…',
  'not-available':'You are up to date',
  downloading:'Downloading a new version in the background…',
  downloaded:'A new version is ready to install',
  installing:'Restarting to finish the update…',
  failed:'The update failed',
  unavailable:'Updates are unavailable right now'
};
function subscribeUpdates(){
  if (updatesState.subscribed || !window.api?.updates?.onStatus) return;
  updatesState.subscribed = true;
  window.api.updates.onStatus((status) => { updatesState.status = status || null; paintUpdates(); });
}
function paintUpdates(){
  const st = updatesState.status;
  const version = el('updVersion'), status = el('updStatus'), last = el('updLastChecked'),
        btn = el('updInstallBtn'), check = el('updCheckBtn');
  if (!version) return;
  if (!st){ status.textContent = 'Not checked yet'; btn?.classList.add('hidden'); return; }
  version.textContent = st.currentVersion ? `Merit Marketing Hub ${st.currentVersion}${st.channel ? ' · ' + st.channel + ' channel' : ''}` : '—';
  const base = UPDATE_STATE_TEXT[st.state] || st.state || '';
  /* main's message is the more specific sentence when it has one */
  status.textContent = st.message || base;
  if (st.state === 'downloaded' && st.version) status.textContent = `Version ${st.version} is ready. Restart to finish updating.`;
  const failed = st.state === 'failed' || (st.state === 'unavailable' && st.lastError);
  status.classList.toggle('upd-bad', !!failed);
  last.textContent = [st.lastCheckedAt ? `Last checked ${fmtDateTime(st.lastCheckedAt)}` : (st.enabled ? 'Not checked yet' : ''),
    st.lastError ? `Reason: ${st.lastError}` : ''].filter(Boolean).join(' · ');
  const ready = st.state === 'downloaded';
  /* Only an administrator can install; for anyone else the button is not offered. */
  btn?.classList.toggle('hidden', !(ready && isAdmin()));
  if (btn) btn.disabled = !(ready && isAdmin());
  if (check) check.disabled = !st.enabled || ['checking','downloading','installing'].includes(st.state);
}
async function refreshUpdatesSection(){
  subscribeUpdates();
  if (!updatesState.status){
    try { updatesState.status = await call(window.api.updates.check, {}, { silent:true }); } catch (_) { /* shown as not checked */ }
  }
  paintUpdates();
}
async function checkForUpdates(){
  const err = el('updError'); err?.classList.add('hidden');
  await withBusy(el('updCheckBtn'), 'Checking…', async () => {
    try { updatesState.status = await call(window.api.updates.check, {}, { silent:true }); }
    catch (e){ if (err){ err.textContent = e.message; err.classList.remove('hidden'); } }
  });
  paintUpdates();
}
async function installUpdate(){
  const err = el('updError'); err?.classList.add('hidden');
  const ok = await confirmDialog({ message: 'Restart and install the update now?',
    detail: 'A safety backup is taken first. Everyone using this computer is signed out while the application restarts.' });
  if (!ok) return;
  await withBusy(el('updInstallBtn'), 'Preparing…', async () => {
    try { await call(window.api.updates.install, {}, { silent:true }); }
    catch (e){
      /* e.g. the safety backup failed: nothing was installed, say why */
      if (err){ err.textContent = e.message || 'The update was not installed.'; err.classList.remove('hidden'); }
      toast('error', 'Update not installed', e.message);
    }
  });
}
