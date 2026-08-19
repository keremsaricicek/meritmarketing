'use strict';
/* PACKAGE HYGIENE.
 *
 * What ships to a customer's machine, checked against the archive rather than
 * against the ignore list — a rule that does not match is not a rule.
 *
 * Skips cleanly when no package has been built, so the suite stays green for
 * someone who has not run `npm run package`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');

function findAsar() {
  const out = path.join(ROOT, 'out');
  if (!fs.existsSync(out)) return null;
  for (const entry of fs.readdirSync(out)) {
    const candidate = path.join(out, entry, 'resources', 'app.asar');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = async function () {
  const s = new Suite('packaged/hygiene');
  const asar = findAsar();

  if (!asar) {
    s.check('no package built — hygiene check skipped (run npm run package)', true);
    return s.finish();
  }

  let listing;
  try {
    listing = execFileSync('npx', ['asar', 'list', asar], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    s.check('the asar archive can be listed', false, err.message.slice(0, 200));
    return s.finish();
  }

  const ours = listing.filter((f) => !f.startsWith('/node_modules/'));

  s.check('the archive contains the application source',
    ours.some((f) => f.startsWith('/src/main/main.js')), 'main.js missing');
  s.check('the archive contains the renderer',
    ours.some((f) => f === '/src/renderer/index.html'), 'renderer missing');
  s.check('the archive contains the migrations',
    ours.some((f) => f.startsWith('/database/migrations/')), 'migrations missing');

  /* Each of these would be a real defect if it shipped: test fixtures a
     customer could mistake for data, the prototype with its demo seed, or
     anything carrying a credential. */
  const forbidden = [
    ['our test suite', (f) => f.startsWith('/tests/')],
    ['the legacy single-file prototype', (f) => f.includes('merit-marketing-hub.html')],
    ['the migration status file', (f) => f.includes('MIGRATION-STATUS')],
    ['build and release scripts', (f) => f.startsWith('/scripts/')],
    ['developer documentation', (f) => f.startsWith('/docs/')],
    ['CI configuration', (f) => f.startsWith('/.github/')],
    ['git metadata', (f) => f.startsWith('/.git/') || f === '/.gitignore'],
    ['environment files', (f) => f.startsWith('/.env')],
    ['a database file', (f) => /\.sqlite3(-wal|-shm)?$/.test(f)],
    ['a backup archive', (f) => f.endsWith('.mmhbackup')],
    ['a certificate', (f) => /\.(pfx|p12|pem|key)$/.test(f)],
    ['a recovery bundle', (f) => f.startsWith('/recovery/') || f.endsWith('.bundle')],
    ['skill definitions', (f) => f.startsWith('/.claude/')],
  ];
  for (const [label, matches] of forbidden) {
    const hits = ours.filter(matches);
    s.check(`the package does not ship ${label}`, hits.length === 0, hits.slice(0, 3).join(', '));
  }

  /* No demo data means no seeded database either — the application creates an
     empty one on first run. */
  s.check('no pre-populated database ships with the application',
    !listing.some((f) => f.endsWith('.sqlite3')), 'a .sqlite3 file is inside the package');

  return s.finish();
};
