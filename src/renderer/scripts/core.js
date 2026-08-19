'use strict';
/* =====================================================================
   Core: API wrapper, session, navigation, toasts, shared helpers.
   The renderer holds no business rules — it asks the main process and
   renders what comes back.
   ===================================================================== */

/* ---------- safe DOM helpers (no innerHTML for user data) ---------- */
function escapeHtml(str){
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* Escape a value for embedding inside JSON that itself sits inside a
   single-quoted HTML attribute. JSON.stringify handles the quoting and control
   characters; the apostrophe would otherwise close the attribute early. */
function jsonAttr(value){
  return JSON.stringify(String(value)).slice(1, -1).replace(/'/g, '&#39;');
}
function el(id){ return document.getElementById(id); }
/* Renderer-side mirror of the main process's local-date rule (spec §14) —
   the local calendar date of the machine running the app, never a UTC
   conversion. Keep this the ONLY "what day is it" helper on this side. */
function todayYMD(d = new Date()){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function daysAgoYMD(n){ const d = new Date(); d.setDate(d.getDate()-n); return todayYMD(d); }
function fmtDate(v){
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return '—';
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}
function fmtDateTime(v){
  if (!v) return '—';
  const d = new Date(v.includes('T') ? v : v.replace(' ','T') + 'Z');
  if (isNaN(d)) return '—';
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function initials(name){
  return (name||'?').split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
}
function daysBetween(a,b){ return Math.round((Date.parse(b)-Date.parse(a))/86400000); }

/* ---------- application state (a cache of what main told us) ---------- */
const state = {
  session: null,
  profiles: [],
  settings: {},
  photoCache: new Map(),
  cust: { page:1, pageSize:50, search:'', status:'', marketing:'', sort:'updated', dir:'desc', total:0, rows:[] },
  res:  { page:1, pageSize:50, search:'', status:'', invitedBy:'', from:'', to:'', sort:'check_in', dir:'desc', total:0, rows:[] },
  list: { sort:'created', dir:'desc' },
  audit:{ page:1, pageSize:50, total:0 },
  selectedCustomerId: null,
  dashPeriod: '30',
  crmView: 'overview'
};
const isAdmin = () => state.session?.role === 'ADMIN';
const canAssign = () => ['ADMIN','MANAGER'].includes(state.session?.role);

/* ---------- IPC call wrapper: one place for error handling ---------- */
async function call(fn, payload, { silent = false } = {}){
  try {
    const res = await fn(payload);
    if (!res || res.ok) return res ? res.data : null;
    if (res.error?.code === 'UNAUTHENTICATED'){ handleSignedOut(); return null; }
    if (!silent) toast('error', 'Could not complete', res.error?.message || 'Unexpected error.');
    const err = new Error(res.error?.message || 'Error');
    err.code = res.error?.code; err.field = res.error?.field; err.conflicts = res.error?.conflicts;
    throw err;
  } catch (e) {
    if (e instanceof TypeError){ toast('error','Connection problem','The application backend did not respond.'); }
    throw e;
  }
}

/* ---------- toasts ---------- */
function toast(kind, title, msg){
  const stack = el('toastStack');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `<div style="flex:1;min-width:0">
      <div class="t-title">${escapeHtml(title)}</div>
      ${msg ? `<div class="t-msg">${escapeHtml(msg)}</div>` : ''}
    </div><button class="t-close" aria-label="Dismiss">✕</button>`;
  node.querySelector('.t-close').onclick = () => dismiss();
  stack.appendChild(node);
  const timer = setTimeout(dismiss, kind === 'error' ? 6000 : 3500);
  function dismiss(){
    clearTimeout(timer);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 180);
  }
}

/* ---------- button busy state (blocks double submits) ---------- */
async function withBusy(button, label, fn){
  if (!button) return fn();
  if (button.classList.contains('busy')) return;
  const original = button.textContent;
  button.classList.add('busy');
  button.textContent = label;
  try { return await fn(); }
  finally { button.classList.remove('busy'); button.textContent = original; }
}

/* ---------- field-level validation display ---------- */
function clearFieldErrors(scope){
  (scope || document).querySelectorAll('.field-error').forEach(e => { e.classList.remove('show'); e.textContent=''; });
  (scope || document).querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
}
function showFieldError(inputId, message){
  const box = el('err-' + inputId);
  const input = el(inputId);
  if (box){ box.textContent = message; box.classList.add('show'); }
  if (input?.closest('.field')) input.closest('.field').classList.add('invalid');
  if (!box) toast('error','Check the form', message);
}

/* ---------- photos: resolved lazily through main, then cached ---------- */
async function resolvePhotos(names){
  const wanted = [...new Set(names.filter(Boolean))].filter(n => !state.photoCache.has(n));
  await Promise.all(wanted.map(async (n) => {
    try { state.photoCache.set(n, await call(window.api.photos.read, { name:n }, { silent:true })); }
    catch (_) { state.photoCache.set(n, null); }
  }));
}
const photoUrl = (name) => (name && state.photoCache.get(name)) || null;
function avatarStyle(name){
  const url = photoUrl(name);
  return url ? ` style="background-image:url('${url}')"` : '';
}

/* ---------- status presentation ---------- */
function statusMeta(code){
  switch(code){
    case 'COLD':       return { label:'COLD', cls:'tag-cold' };
    case 'NO_RECORD':  return { label:'NO RECORD', cls:'tag-none' };
    case 'UPCOMING':   return { label:'UPCOMING', cls:'tag-hot' };
    case 'CHECKED_IN': return { label:'CHECKED IN', cls:'tag-warm' };
    case 'COMPLETED':  return { label:'COMPLETED', cls:'tag-cold' };
    case 'CANCELLED':  return { label:'CANCELLED', cls:'tag-none' };
    /* users list reuses this for account state, kept independent of the
       customer-status vocabulary above */
    case 'ACCOUNT_ACTIVE':   return { label:'ACTIVE', cls:'tag-hot' };
    case 'ACCOUNT_DISABLED': return { label:'DISABLED', cls:'tag-none' };
    /* ACTIVE (a guest that is neither COLD nor NO_RECORD) carries no badge —
       only COLD and NO RECORD are highlighted statuses */
    default:           return null;
  }
}
function statusTagHTML(code){
  const m = statusMeta(code);
  return m ? `<span class="tag ${m.cls}"><span class="tag-dot"></span>${m.label}</span>` : '';
}
function invitedByHTML(name, status){
  if (!name) return '<span class="muted">—</span>';
  return status === 'inactive'
    ? `<span class="invited-inactive">${escapeHtml(name)}</span>`
    : escapeHtml(name);
}

/* ---------- auth ---------- */
function loginKey(e){ if (e.key === 'Enter') doLogin(); }
function setupKey(e){ if (e.key === 'Enter') doSetup(); }

async function bootstrap(){
  const firstRun = await call(window.api.auth.firstRun, {}, { silent:true });
  el('loginCard').style.display = firstRun ? 'none' : 'block';
  el('setupCard').style.display = firstRun ? 'block' : 'none';
  (firstRun ? el('setupName') : el('loginUser')).focus();
}

async function doSetup(){
  const err = el('setupError');
  err.classList.remove('show');
  const name = el('setupName').value.trim();
  const user = el('setupUser').value.trim();
  const pass = el('setupPass').value;
  const pass2 = el('setupPass2').value;
  if (!name || !user || !pass){ err.textContent='All fields are required.'; err.classList.add('show'); return; }
  if (pass !== pass2){ err.textContent='Passwords do not match.'; err.classList.add('show'); return; }

  await withBusy(el('setupBtn'), 'CREATING…', async () => {
    try {
      state.session = await call(window.api.auth.setup, { username:user, password:pass, fullName:name }, { silent:true });
      await enterApp();
      toast('success','Welcome','Your administrator account is ready.');
    } catch (e){ err.textContent = e.message; err.classList.add('show'); }
  });
}

async function doLogin(){
  const err = el('loginError');
  err.classList.remove('show');
  const username = el('loginUser').value.trim();
  const password = el('loginPass').value;
  if (!username || !password){ err.textContent='Enter your username and password.'; err.classList.add('show'); return; }

  await withBusy(el('loginBtn'), 'SIGNING IN…', async () => {
    try {
      state.session = await call(window.api.auth.login, { username, password }, { silent:true });
      await enterApp();
    } catch (e){ err.textContent = e.message; err.classList.add('show'); el('loginPass').value=''; }
  });
}

function resetViewState(){
  state.photoCache.clear();
  state.profiles = [];
  state.settings = {};
  state.selectedCustomerId = null;
  state.cust = { page:1, pageSize:50, search:'', status:'', marketing:'', sort:'updated', dir:'desc', total:0, rows:[] };
  state.res  = { page:1, pageSize:50, search:'', status:'', invitedBy:'', from:'', to:'', view:'active', sort:'check_in', dir:'desc', total:0, rows:[] };
  state.list = { sort:'created', dir:'desc', status:'', createdBy:'', assignedTo:'',
    hasReservation:'', hasCrm:'', createdFrom:'', createdTo:'' };
  state.audit = { page:1, pageSize:50, total:0 };
  ['resSearch','custSearch','listSearch','norecSearch'].forEach(id => { const n = el(id); if (n) n.value = ''; });
  ['detailPanel','resDetailPanel','listDetailPanel'].forEach(id => {
    const n = el(id); if (n){ n.classList.add('empty'); n.innerHTML = 'No guest selected'; }
  });
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('filtered'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
}

async function enterApp(){
  el('loginPass').value = '';
  el('loginScreen').classList.add('hidden');
  resetViewState();
  resetWorkspaceState();
  await refreshProfiles();
  try {
    const prefs = await call(window.api.settings.all, {}, { silent:true });
    applyTheme(prefs?.['appearance.theme'] || 'light', false);
    applyDensity(prefs?.['appearance.density'] || 'comfortable', false);
  } catch (_) {}
  await applyRoleToChrome();
  await switchTab('dashboard');
  refreshNotifBadge();
}

async function doLogout(){
  await call(window.api.auth.logout, {}, { silent:true });
  handleSignedOut();
}
function handleSignedOut(){
  state.session = null;
  resetViewState();
  resetWorkspaceState();
  document.querySelectorAll('.overlay.show').forEach(o => o.classList.remove('show'));
  closeAppMenu();
  el('loginUser').value = ''; el('loginPass').value = '';
  el('loginScreen').classList.remove('hidden');
  bootstrap();
}

/* Which roles may open which screen. Anything not listed is visible to all. */
const PAGE_ROLES = {
  profiles:     ['ADMIN','MANAGER'],
  /* MARKETING needs Customer List to create/work with their own guests —
     filteredCustomers() already scopes every query to their assigned
     guests server-side, so opening the tab can never surface anyone
     else's record */
  customerlist: ['ADMIN','MANAGER','MARKETING'],
  norecord:     ['ADMIN','MANAGER'],
  users:        ['ADMIN'],
  audit:        ['ADMIN','MANAGER']
};
function mayOpen(page){
  const allowed = PAGE_ROLES[page];
  return !allowed || allowed.includes(state.session?.role);
}

async function applyRoleToChrome(){
  document.querySelectorAll('.nav-item').forEach(node => {
    node.classList.toggle('hidden', !mayOpen(node.dataset.page));
  });
  /* Customer List / No Record are CRM Panel tabs, not standalone
     destinations — the same role gate applies to their internal tab
     button and to their entry in the CRM Panel application-menu submenu */
  el('crmTabCustomerList')?.classList.toggle('hidden', !mayOpen('customerlist'));
  el('crmTabNoRecord')?.classList.toggle('hidden', !mayOpen('norecord'));
  el('crmSubmenuCustomerList')?.classList.toggle('hidden', !mayOpen('customerlist'));
  el('crmSubmenuNoRecord')?.classList.toggle('hidden', !mayOpen('norecord'));
  /* MARKETING is already scoped server-side to their own invited reservations,
     so an Invited By selector offering other marketers can only ever return
     zero rows for any choice but themselves — hide it rather than leave a
     control on screen that can't do anything useful. */
  const marketingScoped = state.session?.role === 'MARKETING';
  el('resFInvitedLabel')?.classList.toggle('hidden', marketingScoped);
  el('resFInvited')?.classList.toggle('hidden', marketingScoped);
  if (marketingScoped && state.res) state.res.invitedBy = '';
  /* Created By is meaningless once Customer List is already scoped to a
     marketer's own guests (spec §4) — a marketer's guests may have been
     created by someone else entirely, so filtering by it can only ever
     hide records that legitimately belong to them */
  el('listFCreatedByWrap')?.classList.toggle('hidden', marketingScoped);
  if (marketingScoped && state.list) state.list.createdBy = '';
  const av = el('sessionAvatar');
  await resolvePhotos([state.session?.photo_path]).catch(() => {});
  const url = photoUrl(state.session?.photo_path);
  if (url){ av.style.backgroundImage = `url('${url}')`; av.textContent = ''; }
  else { av.style.backgroundImage = 'none'; av.textContent = initials(state.session?.full_name || state.session?.username || '?'); }
  el('sessionName').textContent = state.session?.full_name || state.session?.username || '';
  el('sessionRole').textContent = ({ ADMIN:'Administrator', MANAGER:'Manager', MARKETING:'Marketing' })[state.session?.role] || '';
  const who = el('settingsWhoAmI');
  if (who) who.textContent = `Signed in as ${state.session?.username || ''}`;
}

async function refreshProfiles(){
  state.profiles = (await call(window.api.profiles.list, {})) || [];
  await resolvePhotos([state.session?.photo_path, ...state.profiles.map(p => p.photo_path)]);
  const opts = state.profiles.map(p => `<option value="${escapeHtml(p.full_name)}"></option>`).join('');
  const dl = el('profileNames'); if (dl) dl.innerHTML = opts;
}

/* ---------- navigation ---------- */
/* ---------- application menu (M trigger) ---------- */
let submenuCloseTimer = null;
function toggleAppMenu(ev){
  ev?.stopPropagation();
  el('appMenu').classList.contains('show') ? closeAppMenu() : openAppMenu();
}
function openAppMenu(){
  const trigger = el('appMenuTrigger');
  const r = trigger.getBoundingClientRect();
  const menu = el('appMenu');
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.left = r.left + 'px';
  menu.classList.add('show');
  el('appMenuBackdrop').classList.add('show');
  trigger.setAttribute('aria-expanded', 'true');
}
function closeAppMenu(){
  el('appMenu').classList.remove('show');
  el('appMenuBackdrop').classList.remove('show');
  el('appMenuTrigger').setAttribute('aria-expanded', 'false');
  closeCrmSubmenu();
}
/* the submenu is positioned relative to its parent item and repositioned
   to stay on screen — a short close delay keeps it open while the pointer
   crosses the gap from the parent row into the submenu itself */
function positionSubmenu(anchorEl){
  const sub = el('crmSubmenu');
  const r = anchorEl.getBoundingClientRect();
  const subWidth = 220;
  let left = r.right + 4;
  if (left + subWidth > window.innerWidth - 8) left = r.left - subWidth - 4;
  left = Math.max(8, left);
  let top = r.top - 8;
  const subHeight = sub.offsetHeight || 160;
  if (top + subHeight > window.innerHeight - 8) top = window.innerHeight - subHeight - 8;
  sub.style.left = left + 'px';
  sub.style.top = Math.max(8, top) + 'px';
}
function openCrmSubmenu(ev){
  ev?.stopPropagation();
  cancelCloseSubmenu();
  const item = el('appMenuCrmItem');
  el('crmSubmenu').classList.add('show');
  positionSubmenu(item);
}
function scheduleOpenCrmSubmenu(){
  cancelCloseSubmenu();
  openCrmSubmenu();
}
function closeCrmSubmenu(){
  el('crmSubmenu').classList.remove('show');
}
function scheduleCloseSubmenu(){
  cancelCloseSubmenu();
  submenuCloseTimer = setTimeout(closeCrmSubmenu, 220);
}
function cancelCloseSubmenu(){
  if (submenuCloseTimer){ clearTimeout(submenuCloseTimer); submenuCloseTimer = null; }
}

/* ---------- workspace tabs ---------- */
const PAGE_LABELS = {
  dashboard:'Dashboard', reservations:'Reservation History', calendar:'Action Calendar',
  profiles:'Profiles', customers:'CRM Panel', reports:'Reports', audit:'Audit Log',
  users:'Users', settings:'Settings'
};
const workspace = { open:['dashboard'], active:'dashboard', history:['dashboard'], loaded:new Set() };
function resetWorkspaceState(){
  workspace.open = ['dashboard']; workspace.active = 'dashboard';
  workspace.history = ['dashboard']; workspace.loaded.clear();
}
function pushWorkspaceHistory(page){
  workspace.history = workspace.history.filter(p => p !== page);
  workspace.history.push(page);
}
function renderWorkspaceStrip(){
  const strip = el('workspaceStrip');
  if (!strip) return;
  strip.innerHTML = workspace.open.map(page => {
    const active = page === workspace.active;
    const label = escapeHtml(PAGE_LABELS[page] || page);
    return `<button class="ws-tab${active ? ' active' : ''}" role="tab" aria-selected="${active}" data-act="activateWorkspaceTab" data-on="click" data-args='["${page}"]'>
      <span class="ws-tab-label">${label}</span>
      ${page !== 'dashboard' ? `<span class="ws-tab-close" data-act="closeWorkspaceTab" data-on="click" data-args='[{"$":"event"},"${page}"]' title="Close ${label}" aria-label="Close ${label}">✕</span>` : ''}
    </button>`;
  }).join('');
}
/* opening from the application menu always focuses/creates exactly one
   tab per destination — CRM Panel's submenu picks also just steer its
   internal view, they never spawn a second CRM Panel tab */
async function openWorkspaceTab(page, crmView){
  await switchTab(page);
  if (page === 'customers' && crmView) await setCrmView(crmView);
}
function activateWorkspaceTab(page){
  switchTab(page);
}
function closeWorkspaceTab(ev, page){
  ev.stopPropagation();
  if (page === 'dashboard') return;
  workspace.open = workspace.open.filter(p => p !== page);
  workspace.history = workspace.history.filter(p => p !== page);
  workspace.loaded.delete(page);
  if (workspace.active === page){
    const next = workspace.history[workspace.history.length - 1] || 'dashboard';
    switchTab(next);
  } else {
    renderWorkspaceStrip();
  }
}
/* F10 — workspace reset, never touches persisted data: closes every
   non-home tab, clears transient filters/search/selection, returns home */
function resetWorkspace(){
  closeAppMenu(); closeAllFilterMenus(); closeAllRowMenus();
  resetWorkspaceState();
  resetViewState();
  switchTab('dashboard', { forceReload:true });
}

const PAGE_LOADERS = {
  dashboard: () => renderDashboard(),
  reservations: () => renderReservations(),
  calendar: () => renderCalendar(),
  profiles: () => renderProfiles(),
  customers: () => setCrmView('overview'),
  notifications: () => renderNotifications(),
  reports: () => renderReports(),
  users: () => renderUsers(),
  audit: () => renderAudit(),
  settings: () => renderSettings()
};

/* CRM Panel's three tabs are one module, one dataset of guests viewed
   three ways — Overview (working view + inspector), Customer List
   (registered guests, create here), No Record (needs a first touch). */
async function setCrmView(view, btn){
  state.crmView = view;
  ['overview','customerlist','norecord'].forEach(v => {
    el(`crmPane_${v}`)?.classList.toggle('active', v === view);
    el(`crmAction_${v}`)?.classList.toggle('hidden', v !== view);
  });
  const tabs = [...el('crmViewTabs').children];
  tabs.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  const activeBtn = btn || tabs.find(b => b.getAttribute('onclick')?.includes(`'${view}'`));
  if (activeBtn){ activeBtn.classList.add('active'); activeBtn.setAttribute('aria-selected','true'); }
  if (view === 'overview') await renderCustomers();
  else if (view === 'customerlist') await renderCustomerList();
  else if (view === 'norecord') await renderNoRecord();
  /* No Record's tab/submenu badges must reflect the real count as soon as
     CRM Panel opens, not only after the guest actually visits that tab. */
  if (view !== 'norecord') refreshNoRecordBadge();
}
async function refreshNoRecordBadge(){
  const data = await call(window.api.customers.list,
    { noRecord:true, registeredOnly:true, pageSize:1 }, { silent:true });
  if (!data) return;
  const badge = el('norecBadge');
  if (badge){ badge.textContent = data.total; badge.classList.toggle('has', data.total > 0); badge.classList.toggle('show', data.total > 0); }
  const tabBadge = el('norecTabBadge');
  if (tabBadge){ tabBadge.textContent = data.total; }
  const submenuBadge = el('norecSubmenuBadge');
  if (submenuBadge){ submenuBadge.textContent = data.total; }
}
async function goCrmView(view){
  await switchTab('customers');
  await setCrmView(view);
}
/* the single choke point every navigation call site already goes
   through — opening/activating a workspace tab, and (re)loading its
   content only when it's new to the workspace or Dashboard (which is
   a live summary and always refreshes) */
async function switchTab(page, opts = {}){
  if (!state.session) return;
  if (!mayOpen(page)) page = 'dashboard';
  const wasOpen = workspace.open.includes(page);
  if (!wasOpen) workspace.open.push(page);
  workspace.active = page;
  pushWorkspaceHistory(page);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-page]').forEach(n => { n.classList.remove('active'); n.removeAttribute('aria-current'); });
  el('page-' + page).classList.add('active');
  const activeNav = document.querySelector(`.nav-item[data-page="${page}"]`);
  activeNav?.classList.add('active');
  activeNav?.setAttribute('aria-current', 'page');
  closeAppMenu(); closeAllFilterMenus(); closeAllRowMenus(); resetRowCursor();
  renderWorkspaceStrip();
  const forceReload = opts.forceReload ?? (page === 'dashboard' || !wasOpen);
  if (forceReload){
    window.scrollTo(0,0);
    try { await PAGE_LOADERS[page]?.(); } catch (_) {}
  }
  workspace.loaded.add(page);
  el('page-' + page).querySelector('h1')?.focus();
}

/* ---------- popovers ---------- */
function closeAllFilterMenus(){ document.querySelectorAll('.filter-menu').forEach(m => m.classList.remove('open')); }
function closeAllRowMenus(){ document.querySelectorAll('.row-menu').forEach(m => m.classList.remove('open')); }
function toggleFilterMenu(id, ev){
  ev?.stopPropagation();
  const node = el(id); const was = node.classList.contains('open');
  closeAllFilterMenus(); closeAllRowMenus();
  if (!was) node.classList.add('open');
}
function toggleRowMenu(id, ev){
  ev?.stopPropagation();
  const node = el(id); const was = node.classList.contains('open');
  closeAllRowMenus(); closeAllFilterMenus();
  if (!was){
    node.classList.add('open');
    const trigger = ev?.currentTarget || ev?.target;
    if (trigger){
      const r = trigger.getBoundingClientRect();
      const menuWidth = Math.max(node.offsetWidth, 130);
      const left = Math.min(r.right - menuWidth, window.innerWidth - menuWidth - 8);
      node.style.top = (r.bottom + 4) + 'px';
      node.style.left = Math.max(8, left) + 'px';
    }
  }
}
/* fixed-position menus don't move with the table's own scroll, so close
   them rather than let them drift away from the row that opened them */
document.addEventListener('scroll', () => closeAllRowMenus(), true);
function markFilterActive(menuId, node){
  document.querySelectorAll('#' + menuId + ' .filter-opt').forEach(o => {
    o.classList.remove('active');
    if (o.hasAttribute('aria-checked')) o.setAttribute('aria-checked', 'false');
  });
  node.classList.add('active');
  if (node.hasAttribute('aria-checked')) node.setAttribute('aria-checked', 'true');
}

/* ---------- modals ---------- */
let lastFocused = null;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function trapFocus(e){
  const modal = document.querySelector('.overlay.show .modal');
  if (!modal || e.key !== 'Tab') return;
  const nodes = [...modal.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
}
function openModal(id){
  lastFocused = document.activeElement;
  const node = el(id);
  node.classList.add('show');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    node.querySelector('input:not([type=hidden]), select, textarea, button')?.focus();
    document.querySelectorAll('.main, .workspace-strip, .topbar').forEach(n => n.setAttribute('aria-hidden', 'true'));
  }, 40);
}
function closeModal(id){
  el(id).classList.remove('show');
  if (!document.querySelector('.overlay.show')){
    document.body.style.overflow = '';
    document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  }
  clearFieldErrors(el(id));
  lastFocused?.focus?.();
}

/* ---------- Finder: shared search-and-select overlay ----------
   One component behind both the Customer Finder (spec §9-12) and the
   Invited By / Marketing profile search (spec §13) — a guest picks a
   result by mouse or keyboard (arrows + Enter), Escape backs out, and the
   caller-supplied onSelect writes the choice back into its own form. */
let finderMode = 'customer';
let finderTargetInput = null;
let finderOnSelect = null;
let finderScoped = false;
let finderWriteAs = 'id';
let finderRows = [];
let finderCursor = -1;
let finderSearchTimer = null;
let finderSeq = 0;

function openFinder(opts){
  finderMode = opts.mode;
  finderTargetInput = opts.targetInputId;
  finderOnSelect = opts.onSelect || null;
  finderScoped = !!opts.scoped;
  finderWriteAs = opts.writeAs || (finderMode === 'profile' ? 'name' : 'id');
  el('finderTitle').textContent = opts.title;
  el('finderSubtitle').textContent = opts.subtitle;
  el('finderInput').value = '';
  el('finderCols').className = finderMode === 'profile' ? 'finder-cols single' : 'finder-cols';
  el('finderCols').innerHTML = finderMode === 'profile'
    ? '<div>NAME</div>'
    : '<div>ID</div><div>NAME SURNAME</div><div class="fc-phone">LAST VISIT</div>';
  openModal('modalFinder');
  runFinderSearch('');
  setTimeout(() => el('finderInput').focus(), 40);
}
function closeFinder(){ closeModal('modalFinder'); }

function onFinderInput(){
  clearTimeout(finderSearchTimer);
  finderSearchTimer = setTimeout(() => runFinderSearch(el('finderInput').value.trim()), 160);
}

async function runFinderSearch(q){
  const seq = ++finderSeq;
  if (finderMode === 'profile'){
    const query = q.toLowerCase();
    let rows = state.profiles.filter(p => !query || p.full_name.toLowerCase().includes(query));
    rows = rows.slice().sort((a,b) => a.full_name.localeCompare(b.full_name,'tr'));
    finderRows = rows.slice(0,50).map(p => ({ id:p.id, full_name:p.full_name,
      sub:p.employment_status === 'inactive' ? 'inactive' : '' }));
  } else {
    const data = await call(window.api.customers.picker, { search:q, pageSize:50, scoped:finderScoped }, { silent:true });
    if (seq !== finderSeq) return;
    finderRows = (data || []).map(c => ({ id:c.id, code:c.code, full_name:c.full_name, phone:c.phone, last_visit:c.last_visit }));
  }
  finderCursor = finderRows.length ? 0 : -1;
  renderFinderResults(q);
}

function renderFinderResults(q){
  const wrap = el('finderResults');
  if (!finderRows.length){
    wrap.innerHTML = emptyState({ icon:'search',
      title: q ? 'No matches' : (finderMode === 'profile' ? 'No profiles yet' : 'No guests yet'),
      text: q ? 'Try a different ID, name or phone.' : '' });
    el('finderFoot').textContent = '';
    return;
  }
  wrap.innerHTML = finderRows.map((r,i) => finderMode === 'profile'
    ? `<div class="finder-row single${i === finderCursor ? ' cursor' : ''}" role="option" aria-selected="${i === finderCursor}"
         onmouseenter="finderSetCursor(${i})" data-act="selectFinderRow" data-on="click" data-args='[${i}]'>
         <span class="fc-name">${escapeHtml(r.full_name)}${r.sub ? `<span class="fc-sub">${escapeHtml(r.sub)}</span>` : ''}</span>
       </div>`
    : `<div class="finder-row${i === finderCursor ? ' cursor' : ''}" role="option" aria-selected="${i === finderCursor}"
         onmouseenter="finderSetCursor(${i})" data-act="selectFinderRow" data-on="click" data-args='[${i}]'>
         <span class="fc-id">#${escapeHtml(r.code)}</span>
         <span class="fc-name">${escapeHtml(r.full_name)}</span>
         <span class="fc-phone">${r.last_visit ? fmtDate(r.last_visit) : '—'}</span>
       </div>`
  ).join('');
  const capped = finderRows.length === 50;
  el('finderFoot').textContent = `${finderRows.length}${capped ? '+' : ''} result${finderRows.length === 1 ? '' : 's'}` +
    (capped ? ' — keep typing to narrow it down' : '');
  scrollFinderCursorIntoView();
}
function finderSetCursor(i){ finderCursor = i; renderFinderCursorState(); }
function renderFinderCursorState(){
  [...el('finderResults').children].forEach((row,i) => {
    row.classList.toggle('cursor', i === finderCursor);
    row.setAttribute('aria-selected', i === finderCursor);
  });
}
function scrollFinderCursorIntoView(){
  el('finderResults').children[finderCursor]?.scrollIntoView({ block:'nearest' });
}
function selectFinderRow(i){
  const r = finderRows[i]; if (!r) return;
  el(finderTargetInput).value = finderWriteAs === 'name' ? r.full_name : r.id;
  closeFinder();
  finderOnSelect?.(r);
}
function finderKeydown(e){
  /* stopPropagation on every key this handles — the document-level Escape
     handler closes "the topmost open overlay", and without stopping the
     bubble here it would run a second time after this closes the Finder
     and close the modal underneath it too (Reservation/Record) in the
     same keystroke */
  if (e.key === 'ArrowDown'){ e.preventDefault(); e.stopPropagation(); if (finderRows.length){ finderCursor = Math.min(finderCursor+1, finderRows.length-1); renderFinderCursorState(); scrollFinderCursorIntoView(); } }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); e.stopPropagation(); if (finderRows.length){ finderCursor = Math.max(finderCursor-1, 0); renderFinderCursorState(); scrollFinderCursorIntoView(); } }
  else if (e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); if (finderCursor >= 0) selectFinderRow(finderCursor); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeFinder(); }
}

/* ---------- global wiring ---------- */
document.addEventListener('click', () => { closeAllFilterMenus(); closeAllRowMenus(); });
el('palette')?.addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(ov.id); });
});
/* Enter/Space activates any element marked as a button role but built
   from a div/tr (table rows, cards, list rows) — keeps native semantics
   for the many rows that must stay <tr>, while making them operable. */
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-activatable]')){
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    e.target.click();
  }
});
document.addEventListener('keydown', (e) => {
  trapFocus(e);
  if (e.key === 'Escape'){
    if (palette.open){ closePalette(); return; }
    const open = [...document.querySelectorAll('.overlay.show')].pop();
    if (open) closeModal(open.id);
    else if (el('crmSubmenu')?.classList.contains('show')) closeCrmSubmenu();
    else if (el('appMenu')?.classList.contains('show')) closeAppMenu();
    else { closeAllFilterMenus(); closeAllRowMenus(); }
    return;
  }
  /* F10/F8 are global workspace shortcuts — they work regardless of
     focus, matching desktop application conventions */
  if (e.key === 'F10'){ e.preventDefault(); if (state.session) resetWorkspace(); return; }
  if (e.key === 'F8'){ e.preventDefault(); if (state.session) doLogout(); return; }
  if (!state.session) return;
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'f'){ e.preventDefault(); focusSearch(); }
});
function focusSearch(){
  const page = document.querySelector('.page.active')?.id || '';
  if (page === 'page-customers'){
    const id = { overview:'custSearch', customerlist:'listSearch', norecord:'norecSearch' }[state.crmView] || 'custSearch';
    el(id)?.focus();
    return;
  }
  const id = { 'page-reservations':'resSearch' }[page];
  if (id) el(id)?.focus();
}
function contextualNew(){
  const page = document.querySelector('.page.active')?.id || '';
  if (page === 'page-profiles') return openProfileModal();
  if (page === 'page-customers'){
    /* Customer List is the one tab that creates guests (spec §13/§14) —
       every other CRM Panel tab's contextual action is a CRM record on an existing guest */
    return state.crmView === 'customerlist' ? openCustomerModal() : openRecordModal();
  }
  if (page === 'page-users' && isAdmin()) return openUserModal();
  openReservationModal();
}

window.api?.onMenuAction?.((action) => {
  if (action === 'logout') doLogout();
  if (action === 'backup') doBackupNow();
});

document.addEventListener('DOMContentLoaded', () => { initCropDrag(); bootstrap(); });

/* =====================================================================
   EMPTY STATES
   A dead end is where software feels unfinished, so every empty list
   explains itself and offers the one thing you would do next.
   ===================================================================== */
const ES_ICONS = {
  search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  guests:'<path d="M17 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="10" cy="7" r="4"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  bell:'<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  check:'<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'
};
function emptyState({ icon = 'search', title, text = '', actions = [] }){
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ES_ICONS[icon] || ES_ICONS.search}</svg>
    <div class="es-title">${escapeHtml(title)}</div>
    ${text ? `<div class="es-text">${escapeHtml(text)}</div>` : ''}
    ${actions.length ? `<div class="es-actions">${actions.map(a =>
      `<button class="btn ${a.primary ? 'btn-gold' : 'btn-outline'} btn-sm" data-act="${a.act}" data-on="click" data-args='${JSON.stringify(a.actArgs || [])}'>${escapeHtml(a.label)}</button>`
    ).join('')}</div>` : ''}
  </div>`;
}
const emptyRow = (cols, html) => `<tr class="empty-row"><td colspan="${cols}">${html}</td></tr>`;

/* =====================================================================
   COMMAND PALETTE
   ===================================================================== */
const palette = { open:false, items:[], cursor:0, timer:null };

function openPalette(){
  palette.open = true;
  lastFocused = document.activeElement;
  el('palette').classList.add('show');
  const input = el('paletteInput');
  input.value = '';
  renderPalette(defaultCommands());
  setTimeout(() => {
    input.focus();
    document.querySelectorAll('.main, .workspace-strip, .topbar').forEach(n => n.setAttribute('aria-hidden', 'true'));
  }, 30);
}
function closePalette(){
  palette.open = false;
  el('palette').classList.remove('show');
  document.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  lastFocused?.focus?.();
}
function defaultCommands(){
  const cmds = [
    { kind:'Go', title:'Dashboard', run:"switchTab('dashboard')" },
    { kind:'Go', title:'Reservation History', run:"switchTab('reservations')" },
    { kind:'Go', title:'Action Calendar', run:"switchTab('calendar')" },
    { kind:'Go', title:'CRM Panel', run:"switchTab('customers')" },
    { kind:'Go', title:'Reports', run:"switchTab('reports')" },
    { kind:'Go', title:'Settings', run:"switchTab('settings')" },
    { kind:'New', title:'New Reservation', run:'openReservationModal()' },
    { kind:'New', title:'New Customer', run:'openCustomerModal()' }
  ];
  if (mayOpen('profiles')) cmds.push({ kind:'Go', title:'Profiles', run:"switchTab('profiles')" },
                                     { kind:'New', title:'New Profile', run:'openProfileModal()' });
  if (mayOpen('customerlist')) cmds.push({ kind:'Go', title:'Customer List', run:"goCrmView('customerlist')" });
  if (mayOpen('norecord')) cmds.push({ kind:'Go', title:'No Record', run:"goCrmView('norecord')" });
  if (mayOpen('users')) cmds.push({ kind:'Go', title:'Users', run:"switchTab('users')" });
  if (mayOpen('audit')) cmds.push({ kind:'Go', title:'Audit Log', run:"switchTab('audit')" });
  return cmds;
}

function onPaletteInput(){
  clearTimeout(palette.timer);
  palette.timer = setTimeout(runPaletteSearch, 140);
}
async function runPaletteSearch(){
  const q = el('paletteInput').value.trim();
  if (!q){ renderPalette(defaultCommands()); return; }
  const lower = q.toLowerCase();
  const items = defaultCommands().filter(c => c.title.toLowerCase().includes(lower));

  /* MARKETING can't open Profiles and their profiles.list rows carry no
     other marketer's real figures anymore (spec §7/§11) — searching people
     would either be a dead end or show blank counts, so skip the category
     for them entirely rather than surface something unusable/confusing */
  const canSearchPeople = mayOpen('profiles');
  const [guests, reservations, profiles] = await Promise.all([
    call(window.api.customers.list, { search:q, pageSize:6 }, { silent:true }).catch(() => null),
    call(window.api.reservations.list, { search:q, pageSize:5 }, { silent:true }).catch(() => null),
    canSearchPeople ? Promise.resolve(state.profiles.filter(p => p.full_name.toLowerCase().includes(lower)).slice(0,4)) : Promise.resolve([])
  ]);

  (guests?.rows || []).forEach(c => items.push({
    kind:'Guest', title:c.full_name, sub:`#${c.code}${c.phone ? ' · ' + c.phone : ''}`,
    run:`goToGuest(${c.id},'customers')` }));
  (reservations?.rows || []).forEach(r => items.push({
    kind:'Stay', title:r.customer_name, sub:`${fmtDate(r.check_in)} – ${fmtDate(r.check_out)}`,
    run:`openReservationModal(${r.id})` }));
  (profiles || []).forEach(p => items.push({
    kind:'Person', title:p.full_name, sub:`${p.reservation_count} invited · ${p.customer_count} guests`,
    run:`openProfileDetail(${p.id})` }));

  renderPalette(items);
}

function renderPalette(items){
  palette.items = items;
  palette.cursor = 0;
  const list = el('paletteList');
  if (!items.length){
    list.innerHTML = '<div class="palette-empty">Nothing matched that.</div>';
    return;
  }
  let html = '', lastKind = null;
  items.forEach((it, i) => {
    if (it.kind !== lastKind){ html += `<div class="palette-group">${escapeHtml(it.kind)}</div>`; lastKind = it.kind; }
    html += `<div class="palette-item${i === 0 ? ' active' : ''}" data-i="${i}" data-act="runPaletteItem" data-on="click" data-args='[${i}]'>
      <div class="pi-main">
        <div class="pi-title">${escapeHtml(it.title)}</div>
        ${it.sub ? `<div class="pi-sub">${escapeHtml(it.sub)}</div>` : ''}
      </div>
      <div class="pi-kind">${escapeHtml(it.kind)}</div>
    </div>`;
  });
  list.innerHTML = html;
}
function movePalette(delta){
  if (!palette.items.length) return;
  palette.cursor = (palette.cursor + delta + palette.items.length) % palette.items.length;
  const nodes = [...document.querySelectorAll('#paletteList .palette-item')];
  nodes.forEach(n => n.classList.remove('active'));
  const active = nodes.find(n => Number(n.dataset.i) === palette.cursor);
  if (active){ active.classList.add('active'); active.scrollIntoView?.({ block:'nearest' }); }
}
function runPaletteItem(i){
  const item = palette.items[i];
  if (!item) return;
  closePalette();
  try { window.eval ? eval(item.run) : Function(item.run)(); } catch (e) { console.error(e); }
}
function onPaletteKey(e){
  if (e.key === 'ArrowDown'){ e.preventDefault(); movePalette(1); }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); movePalette(-1); }
  else if (e.key === 'Enter'){ e.preventDefault(); runPaletteItem(palette.cursor); }
  else if (e.key === 'Escape'){ e.preventDefault(); closePalette(); }
}

/* =====================================================================
   KEYBOARD NAVIGATION
   ===================================================================== */
const rowNav = { index: -1 };

function activeTableBody(){
  const page = document.querySelector('.page.active')?.id || '';
  if (page === 'page-customers'){
    const id = { overview:'custTableBody', customerlist:'listTableBody', norecord:'norecTableBody' }[state.crmView] || 'custTableBody';
    return el(id) || null;
  }
  const map = { 'page-reservations':'resTableBody', 'page-users':'usersTableBody', 'page-audit':'auditTableBody' };
  return el(map[page] || '') || null;
}
function navRows(){
  const body = activeTableBody();
  return body ? [...body.querySelectorAll('tr')].filter(r => !r.classList.contains('empty-row')) : [];
}
function moveRow(delta){
  const rows = navRows();
  if (!rows.length) return;
  rowNav.index = Math.min(rows.length - 1, Math.max(0, rowNav.index + delta));
  rows.forEach(r => r.classList.remove('row-cursor'));
  const row = rows[rowNav.index];
  row.classList.add('row-cursor');
  row.scrollIntoView?.({ block:'nearest' });
}
function currentRow(){ return navRows()[rowNav.index] || null; }
function resetRowCursor(){ rowNav.index = -1; document.querySelectorAll('tr.row-cursor').forEach(r => r.classList.remove('row-cursor')); }
function fireRow(type){
  const row = currentRow();
  if (!row) return;
  row.dispatchEvent(new MouseEvent(type, { bubbles:true }));
}
function showShortcuts(){ openModal('modalShortcuts'); }

document.addEventListener('keydown', (e) => {
  if (!state.session) return;
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'k'){ e.preventDefault(); palette.open ? closePalette() : openPalette(); return; }
  if (palette.open) return;

  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const inModal = !!document.querySelector('.overlay.show');
  if (typing || inModal) return;

  switch (e.key){
    case '/': e.preventDefault(); focusSearch(); break;
    case '?': e.preventDefault(); showShortcuts(); break;
    case 'j': e.preventDefault(); moveRow(1); break;
    case 'k': e.preventDefault(); moveRow(-1); break;
    case 'Enter': if (currentRow()){ e.preventDefault(); fireRow('click'); } break;
    case 'e': if (currentRow()){ e.preventDefault(); fireRow('dblclick'); } break;
    case 'n': e.preventDefault(); contextualNew(); break;
    default: break;
  }
});
