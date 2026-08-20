'use strict';
/* The security matrix a reviewer reads must describe the product that ships.
 *
 * There was already a freshness gate — and it passed, every run, while the
 * document it guards described the prototype. The gate compared the prototype's
 * matrix to the prototype's generator; both sides agreed, so nothing failed,
 * and the human-readable security document for the Electron application simply
 * did not exist. Sixty-odd verbs in that file (`auth.firstRun`, `export.filtered`,
 * `photos.pick`, `dialog.confirm`) are not IPC channels at all.
 *
 * A gate that can only tell you whether two copies of the wrong thing match is
 * worse than no gate: it produces confidence. So this suite checks the
 * generated document against the contract AND checks that the contract itself
 * still describes the channels the registry will actually serve.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');
const { render, DOC_PATH } = require('../../scripts/generate-ipc-doc');
const { SURFACE } = require('../../src/shared/contracts/ipc-surface');
const { SCHEMAS } = require('../../src/shared/validation/schemas');

module.exports = async function () {
  const s = new Suite('ipc/doc-freshness');

  const exists = fs.existsSync(DOC_PATH);
  s.check('the IPC security matrix document exists', exists, DOC_PATH);

  if (exists) {
    const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
    const generated = render();
    s.check('docs/IPC-SECURITY-SURFACE.md matches the contract (run: npm run ipc:doc)',
      onDisk === generated,
      onDisk.length === generated.length
        ? 'same length, differing content'
        : `on disk ${onDisk.length} chars, generated ${generated.length}`);

    /* Independent of the generator, so a bug in it cannot make the comparison
       above vacuously true on both sides. */
    const missing = Object.keys(SURFACE).filter((c) => !onDisk.includes(`\`${c}\``));
    s.check('every channel in the contract appears in the document',
      missing.length === 0, missing.join(', '));
    s.check('the document is not a stub', onDisk.length > 4000, String(onDisk.length));

    /* The document states counts in its summary table. If those were rendered
       from anything other than the contract, they would be decoration. */
    const total = Object.keys(SURFACE).length;
    s.check('the headline channel count is the real one',
      onDisk.includes(`| Channels | **${total}** |`), `expected ${total}`);
  }

  // ------------------------------------------- the contract matches the code
  /* The registry refuses to boot on a mismatch, which is the real enforcement.
     Asserting it here as well means the failure arrives as a named test rather
     than as an application that will not start. */
  const missingSchema = Object.keys(SURFACE).filter((c) => !SCHEMAS[c]);
  s.check('every documented channel has a validation schema',
    missingSchema.length === 0, missingSchema.join(', '));
  const orphanSchema = Object.keys(SCHEMAS).filter((c) => !SURFACE[c]);
  s.check('every validation schema belongs to a documented channel',
    orphanSchema.length === 0, orphanSchema.join(', '));

  /* The preload is the only route from the renderer to a channel. A channel the
     preload does not expose is unreachable; a preload function with no channel
     is a name that will fail at runtime. Both are drift. */
  const preload = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'), 'utf8');
  const exposed = new Set((preload.match(/call\('([^']+)'\)/g) || [])
    .map((m) => m.slice(6, -2)));
  const notExposed = Object.keys(SURFACE).filter((c) => !exposed.has(c));
  /* Channels main pushes TO the renderer are listeners, not invocations. */
  const PUSH_ONLY = new Set(['updates:status', 'session:ended']);
  s.check('every invocable channel is exposed by the preload',
    notExposed.every((c) => PUSH_ONLY.has(c)), notExposed.join(', '));
  const undocumentedExposure = [...exposed].filter((c) => !SURFACE[c]);
  s.check('the preload exposes no channel the contract does not document',
    undocumentedExposure.length === 0, undocumentedExposure.join(', '));

  /* The prototype matrix is still generated and still useful — but it must say
     what it is, or the next reader approves an Electron change against it. */
  const prototypeDoc = fs.readFileSync(
    path.join(__dirname, '..', 'API-SECURITY-SURFACE.md'), 'utf8');
  s.check('the prototype matrix declares that it describes the prototype',
    /PROTOTYPE BASELINE/.test(prototypeDoc) && prototypeDoc.includes('IPC-SECURITY-SURFACE.md'),
    prototypeDoc.slice(0, 200));

  return s.finish();
};
