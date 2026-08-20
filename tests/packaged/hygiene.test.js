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

  /* Never skip silently.
     This suite is the only thing standing between the repository and a
     released installer containing demo credentials, the prototype HTML or a
     developer's database. It used to pass with `s.check(..., true)` whenever
     `out/` was absent — which is every run that has not packaged, including
     every clean CI checkout. The one assertion that proves nothing dangerous
     ships was therefore green precisely when it had checked nothing.

     A missing package is now a FAILURE with the command that fixes it. Local
     runs that genuinely cannot package must say so out loud by setting
     MERIT_ALLOW_UNPACKAGED=1, and even then the run is marked, not hidden. */
  if (!asar) {
    if (process.env.MERIT_ALLOW_UNPACKAGED === '1') {
      s.check('PACKAGE HYGIENE NOT VERIFIED — MERIT_ALLOW_UNPACKAGED=1 was set for this run',
        false, 'Nothing was inspected. Run: npm run package');
    } else {
      s.check('a packaged application exists to inspect', false,
        'out/ contains no app.asar. Run: npm run package (CI and the release script do this first).');
    }
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
