'use strict';
/* RESPONSIVE LAYOUT — no horizontal overflow at the supported widths.
 *
 * The target is a desktop operations console, so the widths checked are the
 * three the product is actually used at. The rule is narrow and objective: the
 * page body must never scroll sideways. Wide content (tables) is allowed to
 * scroll, but inside its own container.
 */

const { Suite } = require('../lib/harness');

const WIDTHS = [1920, 1600, 1366];
const PAGES = ['dashboard', 'reservations', 'calendar', 'customers', 'profiles', 'reports', 'settings'];

module.exports = async function () {
  const s = new Suite('ui/responsive');
  await s.open({ width: WIDTHS[0], height: 1000 });
  await s.bootstrap();

  for (const width of WIDTHS) {
    await s.page.setViewportSize({ width, height: 1000 });
    await s.page.waitForTimeout(250);

    const report = await s.page.evaluate(async (pages) => {
      const out = {};
      for (const pg of pages) {
        await window.openWorkspaceTab(pg);
        await new Promise(r => setTimeout(r, 300));
        const doc = document.documentElement;
        // any element wider than the viewport that is not inside a scroller
        const offenders = [...document.querySelectorAll('.page.active *')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0) return false;
            if (r.right <= doc.clientWidth + 1) return false;
            let p = el.parentElement;
            while (p && p !== document.body) {
              const ov = getComputedStyle(p).overflowX;
              if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') return false;
              p = p.parentElement;
            }
            return true;
          })
          .slice(0, 3)
          .map(el => el.tagName + '.' + (el.className || '').toString().split(' ')[0]);
        out[pg] = { bodyOverflow: doc.scrollWidth - doc.clientWidth, offenders };
      }
      return out;
    }, PAGES);

    for (const [pg, r] of Object.entries(report)) {
      s.check(`${width}px / ${pg}: the page does not scroll horizontally`,
        r.bodyOverflow <= 1, `overflow=${r.bodyOverflow}px offenders=${JSON.stringify(r.offenders)}`);
    }
  }

  // Below the table's readable minimum the columns must become reachable by
  // scrolling the table body, NOT by truncating columns or by letting the whole
  // page slide sideways. Above that breakpoint the table fits and needs no
  // scroller, so this is checked on both sides of the boundary.
  const scrollerAt = async (width) => {
    await s.page.setViewportSize({ width, height: 1000 });
    await s.page.waitForTimeout(250);
    return s.page.evaluate(async () => {
      await window.openWorkspaceTab('customers');
      await window.setCrmView('customerlist');
      await new Promise(r => setTimeout(r, 400));
      const el = document.querySelector('#page-customers .table-scroll');
      if (!el) return { found: false };
      const doc = document.documentElement;
      return {
        found: true,
        overflowX: getComputedStyle(el).overflowX,
        pageOverflow: doc.scrollWidth - doc.clientWidth,
      };
    });
  };

  const narrow = await scrollerAt(700);
  s.check('below the readable minimum the table body becomes its own scroller',
    narrow.found && ['auto', 'scroll'].includes(narrow.overflowX), JSON.stringify(narrow));
  s.check('and the page itself still does not scroll sideways',
    narrow.pageOverflow <= 1, JSON.stringify(narrow));

  const wide = await scrollerAt(1366);
  s.check('at desktop width the table fits and needs no scroller',
    wide.found && wide.overflowX === 'visible', JSON.stringify(wide));

  // Modals must fit the narrowest supported viewport, in both axes.
  await s.page.setViewportSize({ width: 1366, height: 768 });
  await s.page.waitForTimeout(250);
  const modalFit = await s.page.evaluate(async () => {
    await window.openWorkspaceTab('reservations');
    await window.openReservationModal();
    await new Promise(r => setTimeout(r, 350));
    const box = document.querySelector('#modalReservation .modal');
    const r = box.getBoundingClientRect();
    const fitsWidth = r.left >= 0 && r.right <= window.innerWidth + 1;
    // Taller than the viewport is fine only if the modal scrolls internally;
    // otherwise its footer buttons are unreachable.
    const style = getComputedStyle(box);
    const scrolls = box.scrollHeight > box.clientHeight
      ? ['auto', 'scroll'].includes(style.overflowY)
      : true;
    const fitsHeight = r.height <= window.innerHeight || scrolls;
    window.closeModal('modalReservation');
    return {
      fitsWidth, fitsHeight, scrolls,
      w: Math.round(r.width), h: Math.round(r.height),
      vw: window.innerWidth, vh: window.innerHeight,
    };
  });
  s.check('the reservation modal fits the narrowest supported viewport horizontally',
    modalFit.fitsWidth, JSON.stringify(modalFit));
  s.check('the reservation modal is reachable vertically (fits, or scrolls internally)',
    modalFit.fitsHeight, JSON.stringify(modalFit));

  await s.close();
  return s.finish();
};
