'use strict';
/* The human-readable matrix must match the machine-readable one.
 *
 * API-SECURITY-SURFACE.md is what a person reads when deciding whether a verb
 * is safe. If it can drift from surface.js, it becomes a document that describes
 * a system nobody is running — and the drift is invisible, because nothing reads
 * both. This is a pure file comparison: no browser, no fixtures.
 */

const fs = require('fs');
const { Suite } = require('../lib/harness');
const { render, DOC_PATH } = require('./generate-doc');
const { SURFACE } = require('./surface');

module.exports = async function () {
  const s = new Suite('api-surface/doc-freshness');

  const exists = fs.existsSync(DOC_PATH);
  s.check('the human-readable matrix document exists', exists, DOC_PATH);

  if (exists) {
    const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
    const generated = render();
    s.check('API-SECURITY-SURFACE.md matches surface.js (run: npm run surface:doc)',
      onDisk === generated,
      onDisk.length === generated.length
        ? 'same length, differing content'
        : `on disk ${onDisk.length} chars, generated ${generated.length}`);

    // Cheap independent check, so a bug in the generator cannot make the
    // comparison above vacuously true for both sides.
    const missing = Object.keys(SURFACE).filter(v => !onDisk.includes('`' + v + '`'));
    s.check('every documented verb appears in the rendered document',
      missing.length === 0, missing.join(', '));
    s.check('the document is not empty', onDisk.length > 2000, String(onDisk.length));
  }

  return s.finish();
};
