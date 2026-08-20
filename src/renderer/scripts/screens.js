'use strict';
/* =====================================================================
   Modals + write operations. Validation errors come back from the main
   process and are shown against the field that caused them.
   ===================================================================== */

function applyServerError(err, map){
  if (err?.field && map[err.field]) { showFieldError(map[err.field], err.message); return true; }
  return false;
}
async function confirmDialog(opts){
  const r = await window.api.dialog.confirm(opts);
  return !!(r && r.data);
}

/* ---------------- RESERVATION ---------------- */
let editingReservationId = null;

async function openReservationModal(id, presetCustomerId){
  editingReservationId = id ?? null;
  clearFieldErrors(el('modalReservation'));
  const sel = el('resCustomerSelect');

  el('resNewCustomerField').style.display = 'none';
  el('resNewCustomerId').value = '';
  el('resNewCustomerName').value = '';

  if (editingReservationId !== null){
    /* same hazard class as showCustomerDetail: a reservation id can become
       unreadable between listing and opening, and an uncaught FORBIDDEN would
       leave editingReservationId pointing at a record we never loaded */
    let r = null;
    try { r = await call(window.api.reservations.get, { id }, { silent:true }); }
    catch (e){
      editingReservationId = null;
      toast('error', e.code === 'FORBIDDEN' ? 'No access' : 'Could not open',
            e.code === 'FORBIDDEN' ? 'This reservation is no longer yours.' : e.message);
      return;
    }
    if (!r){ editingReservationId = null; return; }
    el('resModalTitle').textContent = 'Edit Reservation';
    el('resModalSubtitle').innerHTML =
      `${escapeHtml(r.customer_name)} <span class="msub-code">· #${escapeHtml(r.customer_code)}</span> · ${statusTagHTML(r.status)}`;
    sel.value = r.customer_id;
    el('resCheckIn').value = r.check_in || '';
    el('resCheckOut').value = r.check_out || '';
    el('resInvitedBy').value = r.invited_by_name || '';
    el('resNotes').value = r.reservation_note || '';
    /* Cancel keeps history, Delete does not — they're never both hidden or
       both the only option: an already-cancelled reservation can only be
       permanently deleted, never cancelled again (spec §16-19). */
    el('resCancelResBtn').style.display = r.status === 'CANCELLED' ? 'none' : 'inline-flex';
    el('resDeleteResBtn').style.display = can1('reservations.delete') ? 'grid' : 'none';
  } else {
    el('resModalTitle').textContent = 'New Reservation';
    el('resModalSubtitle').textContent = 'Book a stay for an existing or new guest';
    sel.value = presetCustomerId || '';
    el('resCheckIn').value = '';
    el('resCheckOut').value = '';
    el('resInvitedBy').value = '';
    el('resNotes').value = '';
    el('resCancelResBtn').style.display = 'none';
    el('resDeleteResBtn').style.display = 'none';
  }
  /* MARKETING is already scoped to their own invited-by profile everywhere
     they can see a reservation, so letting them retype a different name
     here would be meaningless at best and a scope-changing mistake at
     worst — lock it to self and let the API enforce it authoritatively. */
  const marketingLock = state.session?.role === 'MARKETING';
  el('resInvitedBy').disabled = marketingLock;
  el('resInvitedByFinderBtn').style.display = marketingLock ? 'none' : '';
  el('resInvitedByLockedHint').style.display = marketingLock ? '' : 'none';
  if (marketingLock) el('resInvitedBy').value = state.session.full_name || '';
  await onResCustomerChange();
  openModal('modalReservation');
}

function setResNewGuest(isNew){
  el('resCustomerSelect').value = isNew ? '__new__' : '';
  onResCustomerChange();
  if (isNew) setTimeout(() => el('resNewCustomerId')?.focus(), 30);
}

async function onResCustomerChange(){
  const v = el('resCustomerSelect').value;
  const isNew = v === '__new__';
  el('resNewCustomerField').style.display = isNew ? 'flex' : 'none';
  /* the finder trigger + "new guest" link only make sense before a guest
     is chosen — once one is (existing or "__new__"), the entity-preview
     card (with its own Change link) or the new-guest fields take over */
  el('resGuestFinderField').style.display = v ? 'none' : '';
  const prev = el('resGuestPreview');
  const warn = el('resGuestProtectedWarning');
  const saveBtn = document.querySelector('#modalReservation .btn-gold');
  if (!v || isNew){ prev.classList.remove('show'); warn.style.display = 'none'; if (saveBtn) saveBtn.disabled = false; return; }

  const c = await call(window.api.customers.summary, { id: Number(v) }, { silent:true }).catch(() => null);
  if (!c){ prev.classList.remove('show'); warn.style.display = 'none'; if (saveBtn) saveBtn.disabled = false; return; }
  await resolvePhotos([c.photo_name]);
  const av = el('resGuestAvatar');
  const url = photoUrl(c.photo_name);
  if (url){ av.style.backgroundImage = `url('${url}')`; av.textContent=''; }
  else { av.style.backgroundImage='none'; av.textContent = initials(c.full_name); }
  el('resGuestName').textContent = c.full_name;
  /* a guest outside your own book comes back identity-only (see
     customers.summary) — render what we were given, never "null" */
  el('resGuestMeta').innerHTML = c.reservation_count === null
    ? `#${escapeHtml(c.code)}`
    : `#${escapeHtml(c.code)} · ${c.phone ? escapeHtml(c.phone) : 'no phone'}<br>Passport: ${c.passport_no ? escapeHtml(c.passport_no) : '—'}`;
  el('resGuestPills').innerHTML = c.reservation_count === null
    ? ''
    : `${statusTagHTML(c.status)}<span class="ep-pill">${c.reservation_count} visits</span>`;
  prev.classList.add('show');
  /* the API is authoritative and will refuse this at save time regardless
     — this early flag just avoids sending the guest through the whole
     form only to be blocked at the end (spec §21). The text is reset here
     rather than left to the static markup because clearFieldErrors() —
     run at the top of every openReservationModal() call since this is a
     .field-error element too — blanks it the first time the modal opens
     and nothing else would ever put it back. */
  warn.textContent = 'Guest protection period has not expired.';
  /* explicit 'block', not '' — clearFieldErrors() (run at the top of every
     openReservationModal() call) strips this element's .show class along
     with every other .field-error, so relying on that class to drive
     visibility left the banner permanently invisible after the first
     modal open regardless of this flag */
  warn.style.display = c.protected_from_me ? 'block' : 'none';
  if (saveBtn) saveBtn.disabled = !!c.protected_from_me;
}

function profileIdByName(name){
  if (!name) return null;
  const p = state.profiles.find(x => x.full_name.toLowerCase() === String(name).trim().toLowerCase());
  return p ? p.id : null;
}

async function saveReservation(force){
  clearFieldErrors(el('modalReservation'));
  const sel = el('resCustomerSelect').value;
  const checkIn = el('resCheckIn').value;
  const checkOut = el('resCheckOut').value;
  const invitedName = el('resInvitedBy').value.trim();
  const note = el('resNotes').value.trim();

  if (!sel){ showFieldError('resCustomerSelect', 'Select a guest.'); return; }
  if (!checkIn){ showFieldError('resCheckIn', 'Check-in date is required.'); return; }
  if (!checkOut){ showFieldError('resCheckOut', 'Check-out date is required.'); return; }
  if (invitedName && !profileIdByName(invitedName)){
    showFieldError('resInvitedBy', 'No marketing profile with that name.'); return;
  }

  let customerId = sel;
  const btn = document.querySelector('#modalReservation .btn-gold');
  await withBusy(btn, 'Saving…', async () => {
    try {
      if (sel === '__new__'){
        const code = el('resNewCustomerId').value.trim();
        const name = el('resNewCustomerName').value.trim();
        if (!code){ showFieldError('resNewCustomerId','A unique ID is required.'); return; }
        if (!name){ showFieldError('resNewCustomerName','Name is required.'); return; }
        const created = await call(window.api.customers.create,
          { code, fullName:name, registered:false }, { silent:true });
        customerId = created.id;
      }
      const payload = {
        customerId: Number(customerId), checkIn, checkOut,
        invitedByProfileId: profileIdByName(invitedName), note, force: !!force
      };
      const result = editingReservationId !== null
        ? await call(window.api.reservations.update, { id:editingReservationId, ...payload }, { silent:true })
        : await call(window.api.reservations.create, payload, { silent:true });

      closeModal('modalReservation');
      editingReservationId = null;
      (result?.warnings || []).forEach(w => toast('warning','Heads up', w));
      toast('success', 'Reservation saved');
      await refreshReservationViews(customerId);
      refreshNotifBadge();
    } catch (e) {
      if (e.code === 'CONFLICT'){
        const overlap = (e.conflicts || []).map(c => `${fmtDate(c.check_in)} – ${fmtDate(c.check_out)}`).join(', ');
        const proceed = await confirmDialog({
          title:'Overlapping reservation', message:e.message,
          detail: overlap ? `Existing: ${overlap}` : '', confirmLabel:'Save anyway'
        });
        if (proceed) await saveReservation(true);
        return;
      }
      if (!applyServerError(e, { customerId:'resCustomerSelect', checkIn:'resCheckIn', checkOut:'resCheckOut',
                                 code:'resNewCustomerId', invitedByProfileId:'resInvitedBy' })){
        toast('error','Reservation not saved', e.message);
      }
    }
  });
}

/* ---------------- CUSTOMER ---------------- */
let editingCustomerId = null;
let pendingCustomerPhoto = null;

async function openCustomerModal(id){
  editingCustomerId = id ?? null;
  pendingCustomerPhoto = null;
  clearFieldErrors(el('modalCustomer'));

  if (editingCustomerId !== null){
    const c = await call(window.api.customers.get, { id });
    if (!c){ editingCustomerId = null; return; }
    el('custModalTitle').textContent = 'Edit Customer';
    el('custModalSubtitle').innerHTML = `${escapeHtml(c.full_name)} <span class="msub-code">· #${escapeHtml(c.code)}</span>`;
    el('custId').value = c.code; el('custId').disabled = true;
    el('custName').value = c.full_name || '';
    el('custPassport').value = c.passport_no || '';
    el('custPhone').value = c.phone || '';
    pendingCustomerPhoto = c.photo_name || null;
    await resolvePhotos([c.photo_name]);
    setPhotoDrop('custPhotoDrop', photoUrl(c.photo_name));
    el('custDeleteBtn').style.display = 'flex';
  } else {
    el('custModalTitle').textContent = 'New Customer';
    el('custModalSubtitle').textContent = 'Create a new guest profile';
    el('custId').value = ''; el('custId').disabled = false;
    ['custName','custPassport','custPhone'].forEach(f => el(f).value = '');
    setPhotoDrop('custPhotoDrop', null);
    el('custDeleteBtn').style.display = 'none';
  }
  openModal('modalCustomer');
}

function setPhotoDrop(elId, url){
  const node = el(elId);
  if (url){
    node.style.backgroundImage = `url('${url}')`; node.innerHTML = ''; node.classList.add('has-photo');
  } else {
    node.style.backgroundImage = 'none'; node.classList.remove('has-photo');
    node.innerHTML = `<span class="pd-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/></svg>
      <span>Add Photo</span>
    </span>`;
  }
}
async function saveCustomer(){
  clearFieldErrors(el('modalCustomer'));
  const fullName = el('custName').value.trim();
  const passportNo = el('custPassport').value.trim();
  const phone = el('custPhone').value.trim();
  if (!fullName){ showFieldError('custName','Name is required.'); return; }

  const btn = document.querySelector('#modalCustomer .btn-gold');
  await withBusy(btn, 'Saving…', async () => {
    try {
      const editedId = editingCustomerId;
      if (editedId !== null){
        await call(window.api.customers.update,
          { id:editedId, fullName, passportNo, phone, photoName:pendingCustomerPhoto }, { silent:true });
      } else {
        const code = el('custId').value.trim();
        if (!code){ showFieldError('custId','A unique ID is required.'); return; }
        /* a marketer creating a guest through their own (now-scoped)
           Customer List must actually be able to see that guest afterward
           — auto-assign to self, the same self-attribution already used
           for reservations' Invited By (spec §3) */
        const marketingProfileId = state.session?.role === 'MARKETING' ? state.session.profile_id : undefined;
        await call(window.api.customers.create,
          { code, fullName, passportNo, phone, photoName:pendingCustomerPhoto, registered:true, marketingProfileId }, { silent:true });
      }
      closeModal('modalCustomer');
      editingCustomerId = null;
      toast('success','Customer saved');
      await Promise.all([refreshCrmViews(), renderDashboard(), editedId !== null ? refreshOpenInspectors(editedId) : Promise.resolve()]);
    } catch (e) {
      if (!applyServerError(e, { code:'custId', fullName:'custName', passportNo:'custPassport', email:'custPhone' })){
        toast('error','Customer not saved', e.message);
      }
    }
  });
}

async function deleteCustomer(){
  if (editingCustomerId === null) return;
  const c = await call(window.api.customers.get, { id: editingCustomerId });
  const n = c?.reservation_count || 0;
  /* This is a soft archive: the guest leaves the active views and every
     reservation and CRM note is retained. The dialog used to promise that the
     reservations would be removed and that it could not be undone — neither of
     which the backend does. */
  if (!await confirmDialog({
    title:'Archive guest',
    message:`Archive ${c?.full_name || 'this guest'}?`,
    detail: n
      ? `They will be removed from the active guest views. Their ${n} reservation(s) and CRM history are retained.`
      : 'They will be removed from the active guest views. Their CRM history is retained.',
    confirmLabel:'Archive' })) return;

  await call(window.api.customers.delete, { id: editingCustomerId });
  closeModal('modalCustomer');
  editingCustomerId = null;
  toast('success','Guest archived');
  ['detailPanel','resDetailPanel','listDetailPanel'].forEach(pid => {
    const p = el(pid);
    if (p){ p.classList.add('empty'); p.innerHTML = 'No guest selected'; }
  });
  await Promise.all([refreshCrmViews(), renderReservations(), renderDashboard()]);
}

/* ---------------- PHOTO PICK + CROP ----------------
   Faces are rarely centred in a snapshot, so the square that ends up on the
   card is chosen deliberately rather than by luck. */
const crop = { img:null, zoom:1, x:0, y:0, drag:false, lastX:0, lastY:0, target:null, sourceName:null };

async function pickPhotoFor(target){
  const r = await call(window.api.photos.pick, {});
  if (!r) return;
  crop.target = target;
  crop.sourceName = r.name;
  const img = new Image();
  img.onload = () => {
    crop.img = img; crop.zoom = 1; crop.x = 0; crop.y = 0;
    el('cropZoom').value = 100;
    openModal('modalCrop');
    initCropDrag();
    drawCrop();
  };
  img.src = r.dataUrl;
}
/* Reachable by name from the delegated action table. A top-level `const` is
   not a window property, so the dispatcher could never find these. */
window.pickPhotoFor = pickPhotoFor;

/**
 * One piece of geometry drives both the preview and the saved file, so what the
 * circle shows is exactly what gets stored. Returns the source rectangle that is
 * currently visible inside the square frame.
 */
function cropRect(frame){
  const img = crop.img;
  const base = Math.max(frame / img.width, frame / img.height);
  const scale = base * crop.zoom;
  const w = img.width * scale, h = img.height * scale;
  const maxX = Math.max(0, (w - frame) / 2), maxY = Math.max(0, (h - frame) / 2);
  crop.x = Math.min(maxX, Math.max(-maxX, crop.x));
  crop.y = Math.min(maxY, Math.max(-maxY, crop.y));
  const dx = (frame - w) / 2 + crop.x;
  const dy = (frame - h) / 2 + crop.y;
  return { sx: -dx / scale, sy: -dy / scale, size: frame / scale };
}

function drawCrop(){
  const canvas = el('cropCanvas');
  if (!canvas || !crop.img) return;
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  crop.zoom = Number(el('cropZoom').value) / 100;
  const r = cropRect(S);
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#0b0e1c';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(crop.img, r.sx, r.sy, r.size, r.size, 0, 0, S, S);
}

function initCropDrag(){
  const canvas = el('cropCanvas');
  if (!canvas || canvas.dataset.wired) return;
  canvas.dataset.wired = '1';
  const point = (e) => e.touches ? { x:e.touches[0].clientX, y:e.touches[0].clientY } : { x:e.clientX, y:e.clientY };
  const down = (e) => { crop.drag = true; const p = point(e); crop.lastX = p.x; crop.lastY = p.y; };
  const move = (e) => {
    if (!crop.drag) return;
    const p = point(e);
    // the canvas is 320px internally but may be laid out smaller
    const rect = canvas.getBoundingClientRect();
    const ratio = rect.width ? canvas.width / rect.width : 1;
    crop.x += (p.x - crop.lastX) * ratio;
    crop.y += (p.y - crop.lastY) * ratio;
    crop.lastX = p.x; crop.lastY = p.y;
    drawCrop(); e.preventDefault();
  };
  const up = () => { crop.drag = false; };
  canvas.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('touchstart', down, { passive:true });
  canvas.addEventListener('touchmove', move, { passive:false });
  canvas.addEventListener('touchend', up);
  el('cropZoom')?.addEventListener('input', drawCrop);
}

async function applyCrop(){
  if (!crop.img) return closeModal('modalCrop');
  /* The renderer computes the RECTANGLE and nothing else. The trusted process
     owns the pixels: it re-reads the managed source, clamps the rectangle to
     the real image, crops with Electron's nativeImage and stores a new managed
     photo. Image bytes never cross the boundary.

     This used to crop on a canvas and call a `photos.save` that always failed,
     then silently keep the ORIGINAL name while caching the cropped data URL in
     memory — so the crop survived exactly until the next launch. */
  const r = cropRect(el('cropCanvas').width);
  const saved = await call(window.api.photos.crop, {
    name: crop.sourceName,
    x: Math.max(0, Math.round(r.sx)),
    y: Math.max(0, Math.round(r.sy)),
    size: Math.max(16, Math.round(r.size)),
  }, { silent:true }).catch(() => null);

  if (!saved){
    toast('error','Crop not applied','The image could not be cropped. The original photo is unchanged.');
    return closeModal('modalCrop');
  }
  const name = saved.name;
  const dataUrl = saved.dataUrl;
  state.photoCache.set(name, dataUrl);
  if (crop.target === 'profile'){ pendingProfilePhoto = name; setPhotoDrop('profPhotoDrop', dataUrl); }
  else { pendingCustomerPhoto = name; setPhotoDrop('custPhotoDrop', dataUrl); }
  closeModal('modalCrop');
}

/* ---------------- PROFILE ---------------- */
let editingProfileId = null;
let pendingProfilePhoto = null;

async function openProfileModal(id){
  editingProfileId = id ?? null;
  pendingProfilePhoto = null;
  clearFieldErrors(el('modalProfile'));

  if (editingProfileId !== null){
    const p = state.profiles.find(x => x.id === id);
    if (!p){ editingProfileId = null; return; }
    el('profModalTitle').textContent = 'Edit Profile';
    el('profName').value = p.full_name || '';
    el('profNationality').value = p.nationality || '';
    el('profPassport').value = p.passport_no || '';
    el('profPhone').value = p.phone || '';
    el('profInactive').checked = p.employment_status === 'inactive';
    pendingProfilePhoto = p.photo_name || null;
    setPhotoDrop('profPhotoDrop', photoUrl(p.photo_name));
    el('profStatusSection').style.display = 'block';
    el('profDeleteBtn').style.display = isAdmin() ? 'flex' : 'none';
  } else {
    el('profModalTitle').textContent = 'New Profile';
    ['profName','profNationality','profPassport','profPhone'].forEach(f => el(f).value = '');
    el('profInactive').checked = false;
    setPhotoDrop('profPhotoDrop', null);
    el('profStatusSection').style.display = 'none';
    el('profDeleteBtn').style.display = 'none';
  }
  closeModal('modalProfileDetail');
  openModal('modalProfile');
}

async function saveProfile(){
  clearFieldErrors(el('modalProfile'));
  const fullName = el('profName').value.trim();
  if (!fullName){ showFieldError('profName','Name is required.'); return; }
  const payload = {
    fullName,
    nationality: el('profNationality').value.trim(),
    passportNo: el('profPassport').value.trim(),
    phone: el('profPhone').value.trim(),
    photoName: pendingProfilePhoto,
  };
  const btn = document.querySelector('#modalProfile .btn-gold');
  await withBusy(btn, 'Saving…', async () => {
    try {
      /* Employment status is an EDIT concern: a profile being created is
         active by definition, and `profiles:create` does not accept the flag. */
      if (editingProfileId !== null){
        await call(window.api.profiles.update,
          { id:editingProfileId, ...payload, inactive: el('profInactive').checked }, { silent:true });
      } else {
        await call(window.api.profiles.create, payload, { silent:true });
      }
      closeModal('modalProfile');
      editingProfileId = null;
      toast('success','Profile saved');
      await Promise.all([renderProfiles(), renderCustomers(), renderDashboard()]);
    } catch (e) {
      if (!applyServerError(e, { fullName:'profName', email:'profPhone' })) toast('error','Profile not saved', e.message);
    }
  });
}

async function deleteProfile(){
  if (editingProfileId === null) return;
  const p = state.profiles.find(x => x.id === editingProfileId);
  if (!await confirmDialog({
    title:'Archive profile',
    message:`Archive ${p?.full_name || 'this profile'}?`,
    detail:'Reservation history is kept. If they simply left the company, mark them inactive instead.',
    confirmLabel:'Archive' })) return;
  await call(window.api.profiles.delete, { id: editingProfileId });
  closeModal('modalProfile');
  editingProfileId = null;
  toast('success','Profile archived');
  await Promise.all([renderProfiles(), renderCustomers(), renderDashboard()]);
}

/* ---------------- CRM NOTE ---------------- */
let crmNoteCustomerId = null;
function openCrmNoteModal(customerId){
  crmNoteCustomerId = customerId;
  clearFieldErrors(el('modalCrmNote'));
  el('crmNoteDate').value = todayYMD();
  el('crmNoteText').value = '';
  openModal('modalCrmNote');
}
async function saveCrmNote(){
  clearFieldErrors(el('modalCrmNote'));
  const note = el('crmNoteText').value.trim();
  if (!note){ showFieldError('crmNoteText','Enter the note text.'); return; }
  const btn = document.querySelector('#modalCrmNote .btn-gold');
  await withBusy(btn, 'Saving…', async () => {
    try {
      await call(window.api.crmNotes.create,
        { customerId:crmNoteCustomerId, note, noteDate: el('crmNoteDate').value || todayYMD() }, { silent:true });
      closeModal('modalCrmNote');
      toast('success','Note added');
      await refreshOpenInspectors(crmNoteCustomerId);
      await refreshCrmViews();
    } catch (e){ if (!applyServerError(e, { note:'crmNoteText' })) toast('error','Note not saved', e.message); }
  });
}

/* ---------------- RECORD ---------------- */
function isMarketingScoped(){ return state.session?.role === 'MARKETING'; }
async function openRecordModal(){
  clearFieldErrors(el('modalRecord'));
  el('recCustomerSelect').value = '';
  el('recGuestFinderField').style.display = '';
  el('recMarketing').innerHTML = '<option value=""></option>' +
    state.profiles.filter(p => p.employment_status === 'active')
      .map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');
  el('recDate').value = todayYMD();
  el('recNote').value = '';
  el('recPreview').classList.remove('show');
  openModal('modalRecord');
}
function onRecordChangeGuestClick(){
  el('recCustomerSelect').value = '';
  el('recGuestFinderField').style.display = '';
  el('recPreview').classList.remove('show');
  openFinder({ mode:'customer', targetInputId:'recCustomerSelect', scoped:isMarketingScoped(),
    title:'Find Guest', subtitle:'Search by ID, name or phone', onSelect:onRecordCustomerChange });
}
async function onRecordCustomerChange(){
  const v = el('recCustomerSelect').value;
  const prev = el('recPreview');
  el('recGuestFinderField').style.display = v ? 'none' : '';
  if (!v){ prev.classList.remove('show'); return; }
  const c = await call(window.api.customers.summary, { id: Number(v) }, { silent:true }).catch(() => null);
  if (!c){ prev.classList.remove('show'); return; }
  await resolvePhotos([c.photo_name]);
  const av = el('recPreviewAvatar');
  const url = photoUrl(c.photo_name);
  if (url){ av.style.backgroundImage = `url('${url}')`; av.textContent=''; }
  else { av.style.backgroundImage='none'; av.textContent = initials(c.full_name); }
  el('recPreviewName').textContent = c.full_name;
  el('recPreviewMeta').innerHTML = c.reservation_count === null
    ? `#${escapeHtml(c.code)}`
    : `#${escapeHtml(c.code)} · ${c.phone ? escapeHtml(c.phone) : 'no phone'}<br>Marketing: ${invitedByHTML(c.marketing_name, c.marketing_status)}`;
  el('recPreviewPills').innerHTML = c.reservation_count === null
    ? ''
    : `${statusTagHTML(c.status)}<span class="ep-pill">${c.reservation_count} visits</span><span class="ep-pill">${c.note_count} notes</span>`;
  if (c.marketing_profile_id) el('recMarketing').value = c.marketing_profile_id;
  prev.classList.add('show');
}
async function saveRecord(){
  clearFieldErrors(el('modalRecord'));
  const id = el('recCustomerSelect').value;
  if (!id){ showFieldError('recCustomerSelect','Select a guest.'); return; }
  const marketing = el('recMarketing').value;
  const note = el('recNote').value.trim();
  if (!marketing && !note){ showFieldError('recNote','Select a marketer or write a note.'); return; }

  const btn = document.querySelector('#modalRecord .btn-gold');
  await withBusy(btn, 'Saving…', async () => {
    try {
      if (marketing) await call(window.api.customers.assign, { id:Number(id), profileId:Number(marketing) }, { silent:true });
      if (note) await call(window.api.crmNotes.create,
        { customerId:Number(id), note, noteDate: el('recDate').value || todayYMD() }, { silent:true });
      closeModal('modalRecord');
      toast('success','Record saved');
      await Promise.all([refreshCrmViews(), renderDashboard(), renderProfiles(), refreshOpenInspectors(Number(id))]);
      refreshNotifBadge();
    } catch (e){ toast('error','Record not saved', e.message); }
  });
}

/* ---------------- ASSIGN ---------------- */
let assigningCustomerId = null;
async function openAssignModal(customerId, ev){
  ev?.stopPropagation();
  closeAllRowMenus();
  const c = await call(window.api.customers.get, { id: customerId });
  if (!c) return;
  assigningCustomerId = customerId;
  await resolvePhotos([c.photo_name]);
  const av = el('assignAvatar');
  const url = photoUrl(c.photo_name);
  if (url){ av.style.backgroundImage = `url('${url}')`; av.textContent=''; }
  else { av.style.backgroundImage='none'; av.textContent = initials(c.full_name); }
  el('assignName').textContent = c.full_name;
  el('assignMeta').innerHTML =
    `#${escapeHtml(c.code)} · ${c.phone ? escapeHtml(c.phone) : 'no phone'}<br>Current: ${c.marketing_name ? invitedByHTML(c.marketing_name, c.marketing_status) : 'unassigned'}`;
  el('assignPills').innerHTML = `${statusTagHTML(c.status)}<span class="ep-pill">${c.reservation_count} visits</span>`;
  el('assignSelect').innerHTML = '<option value=""></option>' +
    state.profiles.filter(p => p.employment_status === 'active')
      .map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');
  openModal('modalAssign');
}
async function saveAssign(){
  const to = el('assignSelect').value;
  if (!to){ showFieldError('assignSelect','Select an active marketer.'); return; }
  const btn = document.querySelector('#modalAssign .btn-gold');
  await withBusy(btn, 'Assigning…', async () => {
    try {
      await call(window.api.customers.assign, { id:assigningCustomerId, profileId:Number(to) }, { silent:true });
    } catch (e) {
      if (!applyServerError(e, { profileId:'assignSelect' })) toast('error','Guest not assigned', e.message);
      return;
    }
    closeModal('modalAssign');
    toast('success','Guest assigned');
    /* current assigned-guest counts move immediately wherever they're
       shown — Profiles' own count, Customer List/CRM, Dashboard, any open
       inspector — none of them should need a reload to agree (spec §25) */
    await Promise.all([refreshCrmViews(), renderDashboard(), renderProfiles(), refreshOpenInspectors(assigningCustomerId)]);
    refreshNotifBadge();
  });
}

/* ---------------- USERS ---------------- */
let editingUserId = null;
async function openUserModal(id){
  editingUserId = id ?? null;
  clearFieldErrors(el('modalUser'));
  /* Every profile, marketing or staff — an admin account needs one too. Profiles
     already tied to another login are shown but not selectable, so the conflict is
     visible before saving rather than after. */
  const [all, users] = await Promise.all([
    call(window.api.profiles.list, { includeStaff:true }, { silent:true }),
    call(window.api.users.list, {}, { silent:true })
  ]);
  const roster = all || state.profiles;
  const takenBy = {};
  (users || []).forEach(u => { if (u.profile_id) takenBy[u.profile_id] = u.username; });

  el('userProfile').innerHTML = '<option value="">— none —</option>' +
    roster.map(p => {
      const owner = takenBy[p.id];
      const mine = editingUserId !== null && (users || []).some(u => u.id === editingUserId && u.profile_id === p.id);
      const blocked = owner && !mine;
      const suffix = blocked ? ` — in use by ${owner}` : (p.kind === 'staff' ? ' (staff)' : '');
      return `<option value="${p.id}"${blocked ? ' disabled' : ''}>${escapeHtml(p.full_name)}${escapeHtml(suffix)}</option>`;
    }).join('');

  if (editingUserId !== null){
    const users = await call(window.api.users.list, {});
    const u = (users || []).find(x => x.id === id);
    if (!u){ editingUserId = null; return; }
    el('userModalTitle').textContent = 'Edit User';
    el('userUsername').value = u.username;
    el('userPassword').value = '';
    el('userPassword').placeholder = 'Leave blank to keep current';
    el('userRole').value = u.role;
    el('userProfile').value = u.profile_id || '';
    el('userActive').checked = !!u.active;
    el('userDeleteBtn').style.display = state.session.id === u.id ? 'none' : 'flex';
  } else {
    el('userModalTitle').textContent = 'New User';
    el('userUsername').value = '';
    el('userPassword').value = '';
    el('userPassword').placeholder = '';
    el('userRole').value = 'MARKETING';
    el('userProfile').value = '';
    el('userActive').checked = true;
    el('userDeleteBtn').style.display = 'none';
  }
  openModal('modalUser');
}

async function saveUser(){
  clearFieldErrors(el('modalUser'));
  const username = el('userUsername').value.trim();
  const password = el('userPassword').value;
  const role = el('userRole').value;
  const profileId = el('userProfile').value || null;
  const active = el('userActive').checked;

  if (!username){ showFieldError('userUsername','Username is required.'); return; }
  if (editingUserId === null && !password){ showFieldError('userPassword','Password is required.'); return; }
  /* There is no STAFF account role — ADMIN, MANAGER, MARKETING. A marketer
     without a linked profile has no scope, which the schema also refuses. */
  if (role === 'MARKETING' && !profileId){
    showFieldError('userProfile','A marketing account must be linked to a marketing profile.'); return;
  }

  await withBusy(el('userSaveBtn'), 'Saving…', async () => {
    try {
      const payload = { username, role, profileId: profileId ? Number(profileId) : null, active };
      if (password) payload.password = password;
      if (editingUserId !== null) await call(window.api.users.update, { id:editingUserId, ...payload }, { silent:true });
      else await call(window.api.users.create, payload, { silent:true });
      closeModal('modalUser');
      editingUserId = null;
      toast('success','User saved');
      await renderUsers();
    } catch (e){
      if (!applyServerError(e, { username:'userUsername', password:'userPassword', profileId:'userProfile' })) toast('error','User not saved', e.message);
    }
  });
}

async function deleteUser(){
  if (editingUserId === null) return;
  if (!await confirmDialog({ title:'Disable user', message:'Disable this account?',
      detail:'The person will no longer be able to sign in. History is preserved.', confirmLabel:'Disable' })) return;
  try {
    await call(window.api.users.delete, { id: editingUserId }, { silent:true });
    closeModal('modalUser');
    editingUserId = null;
    toast('success','User disabled');
    await renderUsers();
  } catch (e){ toast('error','Could not disable user', e.message); }
}

/* ---------------- PASSWORD ---------------- */
function openPasswordModal(){
  clearFieldErrors(el('modalPassword'));
  ['pwCurrent','pwNew','pwConfirm'].forEach(f => el(f).value = '');
  openModal('modalPassword');
}
async function savePassword(){
  clearFieldErrors(el('modalPassword'));
  const currentPassword = el('pwCurrent').value;
  const newPassword = el('pwNew').value;
  const confirm = el('pwConfirm').value;
  if (!currentPassword){ showFieldError('pwCurrent','Enter your current password.'); return; }
  if (!newPassword){ showFieldError('pwNew','Enter a new password.'); return; }
  if (newPassword !== confirm){ showFieldError('pwConfirm','Passwords do not match.'); return; }

  await withBusy(el('pwSaveBtn'), 'Saving…', async () => {
    try {
      await call(window.api.auth.changePassword,
        { currentPassword, newPassword, newPasswordConfirm:confirm }, { silent:true });
      closeModal('modalPassword');
      toast('success','Password changed');
    } catch (e){
      if (!applyServerError(e, { currentPassword:'pwCurrent', password:'pwNew' })) toast('error','Password not changed', e.message);
    }
  });
}
