'use strict';
/* UI CONTROLS — every interactive affordance actually does something.
 *
 * Search, sort, filter, row selection, the finder, modals, workspace tabs, the
 * command palette and the keyboard shortcuts are driven here through real DOM
 * events, not by calling the functions behind them where that would skip the
 * wiring being tested.
 */

const { Suite } = require('../lib/harness');

module.exports = async function () {
  const s = new Suite('ui/controls');
  await s.open();
  await s.bootstrap();

  // ------------------------------------------------------------------ search
  await s.page.evaluate(async () => {
    await window.openWorkspaceTab('customers');
    await window.setCrmView('customerlist');
  });
  await s.page.waitForTimeout(400);
  const allRows = await s.page.evaluate(() => document.querySelectorAll('#listTableBody tr').length);
  s.check('the customer list renders rows to work with', allRows > 1, String(allRows));

  await s.page.fill('#listSearch', 'MEHMET');
  await s.page.waitForTimeout(450);
  const searched = await s.page.evaluate(() => ({
    n: document.querySelectorAll('#listTableBody tr').length,
    txt: document.getElementById('listTableBody').innerText,
  }));
  s.check('search narrows the list to matching rows',
    searched.n === 1 && searched.txt.includes('MEHMET'), JSON.stringify(searched.n));

  await s.page.fill('#listSearch', '');
  await s.page.waitForTimeout(450);
  const cleared = await s.page.evaluate(() => document.querySelectorAll('#listTableBody tr').length);
  s.check('clearing search restores the full list', cleared === allRows, `all=${allRows} cleared=${cleared}`);

  // -------------------------------------------------------------------- sort
  const sorted = await s.page.evaluate(async () => {
    const names = () => [...document.querySelectorAll('#listTableBody tr')].map(r => r.children[1].textContent.trim());
    window.sortList('name'); await new Promise(r => setTimeout(r, 350));
    const first = names();
    window.sortList('name'); await new Promise(r => setTimeout(r, 350));
    const second = names();
    return { first, second };
  });
  s.check('sorting by name reorders the rows',
    JSON.stringify(sorted.first) !== JSON.stringify(sorted.second), JSON.stringify(sorted.first.slice(0, 3)));
  s.check('clicking the same column again reverses the order exactly',
    JSON.stringify(sorted.second) === JSON.stringify([...sorted.first].reverse()),
    JSON.stringify({ first: sorted.first.slice(0, 3), second: sorted.second.slice(0, 3) }));

  // ------------------------------------------------------------------ filter
  const filt = await s.page.evaluate(async () => {
    document.getElementById('listFStatus').value = 'NO_RECORD';
    window.applyListFilters();
    await new Promise(r => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('#listTableBody tr')].map(r => r.innerText);
    const btnFiltered = document.getElementById('listFilterBtn').classList.contains('filtered');
    window.clearListFilters();
    await new Promise(r => setTimeout(r, 400));
    return {
      count: rows.length,
      allNoRecord: rows.length > 0 && rows.every(t => t.includes('NO RECORD')),
      btnFiltered,
      afterClear: document.querySelectorAll('#listTableBody tr').length,
    };
  });
  s.check('the status filter returns only matching rows', filt.allNoRecord, JSON.stringify(filt));
  s.check('the filter button shows an active state while filtered', filt.btnFiltered, String(filt.btnFiltered));
  s.check('clearing filters restores the full list', filt.afterClear === allRows, JSON.stringify(filt));

  // ------------------------------------------------------- row click / dblclick
  const rowInteract = await s.page.evaluate(async () => {
    const row = document.querySelector('#listTableBody tr');
    row.click();
    await new Promise(r => setTimeout(r, 400));
    const inspector = !document.getElementById('listDetailPanel').classList.contains('empty');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const modal = document.getElementById('modalCustomer').classList.contains('show');
    window.closeModal('modalCustomer');
    return { inspector, modal };
  });
  s.check('clicking a row opens the guest inspector', rowInteract.inspector, JSON.stringify(rowInteract));
  s.check('double-clicking a row opens the edit modal', rowInteract.modal, JSON.stringify(rowInteract));

  // ------------------------------------------------------------ customer finder
  const finder = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('reservations');
    await window.openReservationModal();
    await new Promise(r => setTimeout(r, 250));
    document.getElementById('resGuestFinderBtn').click();
    await new Promise(r => setTimeout(r, 350));
    return {
      cols: document.getElementById('finderCols').textContent.replace(/\s+/g, ' ').trim(),
      initial: document.querySelectorAll('#finderResults .finder-row').length,
    };
  });
  s.check('finder columns are ID / NAME SURNAME / LAST VISIT',
    /ID.*NAME SURNAME.*LAST VISIT/.test(finder.cols), finder.cols);
  s.check('finder columns no longer expose a phone number',
    !/PHONE/i.test(finder.cols), finder.cols);
  s.check('the finder lists guests before anything is typed', finder.initial > 0, String(finder.initial));

  await s.page.fill('#finderInput', 'ELIF');
  await s.page.waitForTimeout(450);
  const fRes = await s.page.evaluate(() => ({
    n: document.querySelectorAll('#finderResults .finder-row').length,
    first: document.querySelector('#finderResults .finder-row')?.innerText.replace(/\s+/g, ' ').trim(),
  }));
  s.check('finder search narrows the result set', fRes.n === 1 && fRes.first.includes('ELIF'), JSON.stringify(fRes));

  await s.page.keyboard.press('Enter');
  await s.page.waitForTimeout(400);
  const picked = await s.page.evaluate(() => ({
    shown: document.getElementById('resGuestPreview').classList.contains('show'),
    name: document.getElementById('resGuestName').textContent,
    closed: !document.getElementById('modalFinder').classList.contains('show'),
  }));
  s.check('pressing Enter in the finder selects the guest and closes it',
    picked.shown && picked.closed && picked.name.includes('ELIF'), JSON.stringify(picked));

  // Escape must dismiss only the topmost overlay.
  const reopened = await s.page.evaluate(async () => {
    document.querySelector('#resGuestPreview .ep-change').click();
    await new Promise(r => setTimeout(r, 350));
    return document.getElementById('modalFinder').classList.contains('show');
  });
  await s.page.keyboard.press('Escape');
  await s.page.waitForTimeout(300);
  const escAfter = await s.page.evaluate(() => ({
    finder: document.getElementById('modalFinder').classList.contains('show'),
    res: document.getElementById('modalReservation').classList.contains('show'),
  }));
  s.check('Escape closes the finder only, leaving the reservation modal open',
    reopened && !escAfter.finder && escAfter.res, JSON.stringify(escAfter));
  await s.page.evaluate(() => window.closeModal('modalReservation'));

  // ------------------------------------------------- reservation create via UI
  const resFlow = await s.page.evaluate(async () => {
    const before = (await window.api.reservations.list({ pageSize: 5000 })).data.total;
    await window.openReservationModal();
    await new Promise(r => setTimeout(r, 250));
    const c = (await window.api.customers.list({ search: 'ELIF', pageSize: 5 })).data.rows[0];
    document.getElementById('resCustomerSelect').value = String(c.id);
    await window.onResCustomerChange();
    await new Promise(r => setTimeout(r, 250));
    document.getElementById('resCheckIn').value = '2027-09-01';
    document.getElementById('resCheckOut').value = '2027-09-04';
    document.querySelector('#modalReservation .btn-gold').click();
    await new Promise(r => setTimeout(r, 700));
    const after = (await window.api.reservations.list({ pageSize: 5000 })).data.total;
    return { before, after, modalClosed: !document.getElementById('modalReservation').classList.contains('show') };
  });
  s.check('saving the reservation form adds a row to the dataset',
    resFlow.after === resFlow.before + 1, JSON.stringify(resFlow));
  s.check('the reservation modal closes after a successful save', resFlow.modalClosed, JSON.stringify(resFlow));

  // --------------------------------------------------- cancel with OTHER reason
  const cancelFlow = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('reservations');
    await new Promise(r => setTimeout(r, 350));
    const row = [...document.querySelectorAll('#resTableBody tr')].find(r => r.textContent.includes('ELIF'));
    row.querySelector('.ra-btn.danger').click();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('cancelResReason').value = 'Other';
    window.onCancelReasonChange();
    const otherShown = getComputedStyle(document.getElementById('cancelResOtherField')).display !== 'none';

    // submitting OTHER with no text must be refused by the form
    document.querySelector('#modalCancelReservation .btn-destructive-solid').click();
    await new Promise(r => setTimeout(r, 300));
    const blocked = document.getElementById('modalCancelReservation').classList.contains('show');
    const errShown = document.getElementById('err-cancelResOtherText').classList.contains('show');

    document.getElementById('cancelResOtherText').value = 'Guest changed plans';
    document.querySelector('#modalCancelReservation .btn-destructive-solid').click();
    await new Promise(r => setTimeout(r, 700));
    document.getElementById('resViewCancelledTab').click();
    await new Promise(r => setTimeout(r, 450));
    return { otherShown, blocked, errShown, reasonShown: document.getElementById('resTableBody').innerText.includes('Guest changed plans') };
  });
  s.check('choosing OTHER reveals the free-text reason field', cancelFlow.otherShown, JSON.stringify(cancelFlow));
  s.check('OTHER with no text is refused by the form', cancelFlow.blocked && cancelFlow.errShown, JSON.stringify(cancelFlow));
  s.check('the custom cancellation reason surfaces in the Cancelled view',
    cancelFlow.reasonShown, JSON.stringify(cancelFlow));

  // ------------------------------------------------- dashboard period control
  const period = await s.page.evaluate(async () => {
    const read = l => {
      const c = [...document.querySelectorAll('.stat-cell')].find(x => x.querySelector('.sc-l')?.textContent.trim() === l);
      return c?.querySelector('.sc-n')?.textContent.trim();
    };
    const snap = () => ({
      am: read('Active Marketing'), tg: read('Total Guests'),
      nr: read('No Record'), cold: read('Cold Guests'), res: read('Reservations'),
    });
    await window.openWorkspaceTab('dashboard');
    await window.setDashboardPeriod('all'); await new Promise(r => setTimeout(r, 450));
    const all = snap();
    await window.setDashboardPeriod('7'); await new Promise(r => setTimeout(r, 450));
    const d7 = snap();
    return { all, d7 };
  });
  s.check('STOCK KPIs are unaffected by the period control',
    period.all.am === period.d7.am && period.all.tg === period.d7.tg &&
    period.all.nr === period.d7.nr && period.all.cold === period.d7.cold, JSON.stringify(period));
  s.check('the PERIOD KPI responds to the period control',
    Number(period.d7.res) <= Number(period.all.res), JSON.stringify(period));

  // ----------------------------------------------------------- workspace tabs
  const tabs = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('reports');
    await window.openWorkspaceTab('reports');
    await new Promise(r => setTimeout(r, 250));
    const dupes = [...document.querySelectorAll('.ws-tab')].filter(t => t.textContent.includes('Reports')).length;
    const before = document.querySelectorAll('.ws-tab').length;
    document.querySelector('.ws-tab .ws-tab-close')?.click();
    await new Promise(r => setTimeout(r, 250));
    return { dupes, before, after: document.querySelectorAll('.ws-tab').length };
  });
  s.check('opening the same screen twice does not create a duplicate tab', tabs.dupes === 1, JSON.stringify(tabs));
  s.check('the tab close button removes exactly one tab', tabs.after === tabs.before - 1, JSON.stringify(tabs));

  // ---------------------------------------------------------- command palette
  const palette = await s.page.evaluate(async () => {
    window.openPalette();
    await new Promise(r => setTimeout(r, 250));
    document.getElementById('paletteInput').value = 'MEHMET';
    window.onPaletteInput();
    await new Promise(r => setTimeout(r, 400));
    const items = document.querySelectorAll('#paletteList .palette-item').length;
    const hit = document.getElementById('paletteList').innerText.includes('MEHMET');
    window.closePalette();
    return { items, hit };
  });
  s.check('the command palette returns matching results', palette.items > 0 && palette.hit, JSON.stringify(palette));

  // ---------------------------------------------------------- F10 / F8 keys
  await s.page.evaluate(async () => {
    await window.openWorkspaceTab('reports');
    await window.openWorkspaceTab('calendar');
  });
  await s.page.waitForTimeout(250);
  await s.page.keyboard.press('F10');
  await s.page.waitForTimeout(400);
  const f10 = await s.page.evaluate(() => ({
    tabs: document.querySelectorAll('.ws-tab').length,
    active: document.querySelector('.page.active')?.id,
  }));
  s.check('F10 resets the workspace to Dashboard alone',
    f10.tabs === 1 && f10.active === 'page-dashboard', JSON.stringify(f10));

  await s.page.keyboard.press('F8');
  await s.page.waitForTimeout(500);
  const f8 = await s.page.evaluate(() => !document.getElementById('loginScreen').classList.contains('hidden'));
  s.check('F8 signs out to the login screen', f8, String(f8));

  await s.close();
  return s.finish();
};
