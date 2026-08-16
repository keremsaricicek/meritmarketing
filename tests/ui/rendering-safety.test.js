'use strict';
/* RENDERING SAFETY — hostile data must render as text, everywhere.
 *
 * Guest names, notes, phone numbers, passport numbers and reservation notes are
 * all operator-supplied and all end up interpolated into template strings. Each
 * vector below targets a different escape context: a JS string inside an inline
 * handler, an HTML attribute, element content, and a URL position.
 *
 * The assertion is not "the app did not visibly break". It is that no injected
 * handler ran and no injected element exists in the document.
 */

const { Suite } = require('../lib/harness');

const VECTORS = [
  `'); window.__x1=1; ('`,              // JS string breakout inside onclick="fn('…')"
  `" onmouseover="window.__x2=1" x="`,  // attribute breakout
  `<script>window.__x3=1<\/script>`,    // element injection
  `<img src=x onerror="window.__x4=1">`,// element + event handler injection
  `javascript:window.__x5=1`,           // URL context
];

module.exports = async function () {
  const s = new Suite('ui/rendering-safety');
  await s.open();
  await s.bootstrap();

  await s.page.evaluate(async (vs) => {
    for (let i = 0; i < vs.length; i++) {
      const c = (await window.api.customers.create({
        code: 'XSS' + i, fullName: vs[i], registered: true })).data;
      await window.api.crmNotes.create({ customerId: c.id, note: vs[i] });
      await window.api.customers.update({ id: c.id, phone: vs[i], passportNo: vs[i] });
      await window.api.reservations.create({
        customerId: c.id, checkIn: '2027-10-0' + (i + 1), checkOut: '2027-10-0' + (i + 2), note: vs[i] });
    }
    // a hostile code as well — it is rendered in a different column
    await window.api.customers.create({ code: '<b>XSSCODE</b>', fullName: 'HOSTILE CODE GUEST', registered: true });
  }, VECTORS);

  // Render every surface that displays those values.
  await s.page.evaluate(async () => {
    await window.openWorkspaceTab('customers');
    await window.setCrmView('overview'); await new Promise(r => setTimeout(r, 400));
    await window.setCrmView('customerlist'); await new Promise(r => setTimeout(r, 400));
    document.querySelector('#listTableBody tr')?.click(); await new Promise(r => setTimeout(r, 400));
    await window.openWorkspaceTab('reservations'); await new Promise(r => setTimeout(r, 400));
    document.querySelector('#resTableBody tr')?.click(); await new Promise(r => setTimeout(r, 400));
    await window.openWorkspaceTab('dashboard'); await new Promise(r => setTimeout(r, 400));
    await window.openWorkspaceTab('calendar'); await new Promise(r => setTimeout(r, 400));
    await window.openWorkspaceTab('profiles'); await new Promise(r => setTimeout(r, 400));
    await window.openWorkspaceTab('reports'); await new Promise(r => setTimeout(r, 400));
  });
  await s.page.evaluate(() => {
    window.openPalette();
    document.getElementById('paletteInput').value = 'onerror';
    window.onPaletteInput();
  });
  await s.page.waitForTimeout(500);
  await s.page.evaluate(() => window.closePalette());

  // Hovering is the trigger for the attribute-breakout vector.
  await s.page.evaluate(async () => {
    await window.openWorkspaceTab('customers');
    await window.setCrmView('customerlist');
    await new Promise(r => setTimeout(r, 400));
    document.querySelectorAll('#listTableBody tr').forEach(r =>
      r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await new Promise(r => setTimeout(r, 300));
  });

  const xss = await s.page.evaluate(() => ({
    fired: [1, 2, 3, 4, 5].map(i => !!window['__x' + i]),
    injectedImgs: document.querySelectorAll('img[src="x"]').length,
    injectedScripts: [...document.querySelectorAll('script')].filter(x => x.textContent.includes('__x3')).length,
    injectedBold: [...document.querySelectorAll('#listTableBody b')].length,
    // the app ships two static href="javascript:void(0)" affordances; anything
    // BEYOND that pattern would have to have been built from guest data
    jsHrefs: [...document.querySelectorAll('a[href^="javascript:"]')]
      .map(a => a.getAttribute('href'))
      .filter(h => h !== 'javascript:void(0)'),
  }));
  s.check('no injected event handler executed on any surface', xss.fired.every(f => !f), JSON.stringify(xss));
  s.check('no injected <img> element was created', xss.injectedImgs === 0, JSON.stringify(xss));
  s.check('no injected <script> element was created', xss.injectedScripts === 0, JSON.stringify(xss));
  s.check('a hostile customer code renders as text, not markup', xss.injectedBold === 0, JSON.stringify(xss));
  s.check('no javascript: URL was constructed from guest data', xss.jsHrefs.length === 0, JSON.stringify(xss));

  // And the hostile text is genuinely on screen — otherwise the checks above
  // would pass simply because nothing rendered at all.
  const rendered = await s.page.evaluate(() =>
    document.getElementById('listTableBody').innerText.includes('onerror'));
  s.check('the hostile value is displayed as literal text (checks are not vacuous)',
    rendered, String(rendered));

  // The CSV serializer is a second escaping context with its own rules: a value
  // containing a quote or a delimiter must be quoted, not allowed to break out
  // into extra columns.
  const exported = await s.exportCsv('customerlist', {});
  s.check('hostile values are carried into the export as inert data',
    exported.ok && String(exported.csv).includes('onerror'), JSON.stringify(exported).slice(0, 200));

  const csvShape = String(exported.csv || '').trim().split('\n');
  const cols = (csvShape[0] || '').split(',').length;
  const brokenRows = csvShape.slice(1).filter(line => {
    // count only delimiters outside quoted fields
    let inQ = false, n = 1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) n++;
    }
    return n !== cols;
  });
  s.check('no hostile value breaks a row out into extra CSV columns',
    brokenRows.length === 0, JSON.stringify(brokenRows.slice(0, 2)));

  await s.close();
  return s.finish();
};
