'use strict';
/* Cross-platform equivalent of Recover-Push403.ps1.
 *
 * Same contract: nothing is reset, nothing is discarded. This writes a copy of
 * the local commits that can be carried to a machine whose credentials work.
 *
 *   node scripts/recovery/recover-push.js [--base origin/main]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/* execFile, never a shell string. Two of the values interpolated here — the
   --base argument and the current branch name — come from outside this script,
   and a git ref may legally contain characters a shell treats as syntax. A
   hostile branch name in a cloned repository would otherwise run as a command
   on the machine of whoever ran the recovery. */
const git = (args, allowFailure = false) => {
  const argv = Array.isArray(args) ? args : String(args).split(/\s+/).filter(Boolean);
  try { return execFileSync('git', argv, { encoding: 'utf8' }).trim(); }
  catch (err) { if (allowFailure) return null; throw err; }
};

function main() {
  const repoRoot = git('rev-parse --show-toplevel');
  process.chdir(repoRoot);

  const baseArg = process.argv.indexOf('--base');
  let base = baseArg !== -1 ? process.argv[baseArg + 1] : null;
  if (!base) base = git('rev-parse --abbrev-ref --symbolic-full-name @{u}', true) || 'origin/main';

  const branch = git('rev-parse --abbrev-ref HEAD');
  const commit = git('rev-parse HEAD');
  const short = commit.slice(0, 12);

  const dirty = git('status --porcelain');
  if (dirty) {
    console.warn('WARNING: the working tree has uncommitted changes.');
    console.warn('They will NOT be in the bundle — a bundle only carries commits.');
    console.warn(dirty.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
  }

  const recoveryDir = path.join(repoRoot, 'recovery');
  const patchDir = path.join(recoveryDir, 'patches');
  fs.mkdirSync(patchDir, { recursive: true });
  for (const f of fs.readdirSync(patchDir)) {
    if (f.endsWith('.patch')) fs.unlinkSync(path.join(patchDir, f));
  }

  const bundleName = `merit-recovery-${short}.bundle`;
  const bundlePath = path.join(recoveryDir, bundleName);

  const baseKnown = git(['rev-parse', '--verify', base], true) !== null;
  const range = baseKnown ? `${base}..${branch}` : branch;
  if (!baseKnown) console.warn(`${base} is not known locally; bundling the whole branch.`);

  git(['bundle', 'create', bundlePath, ...(baseKnown ? [range] : []), branch]);
  git(['format-patch', range, '-o', patchDir]);
  const patches = fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch'));

  const manifest = `Merit Marketing Hub — push recovery bundle
==========================================
Created   : ${new Date().toISOString()}
Branch    : ${branch}
Commit    : ${commit}
Base      : ${base}
Patches   : ${patches.length}

COMMITS
-------
${git(['log', '--oneline', range]) || '(none)'}

FILES CHANGED
-------------
${git(['diff', '--stat', range]) || '(none)'}

HOW TO PUSH THIS FROM A MACHINE THAT CAN AUTHENTICATE
-----------------------------------------------------
Option A — the bundle (keeps history exactly):

    git clone <your-repo-url> merit && cd merit
    git fetch ../${bundleName} '${branch}:${branch}-recovered'
    git checkout ${branch}-recovered
    git push -u origin ${branch}

Option B — the patch series:

    git checkout ${branch}
    git am ../recovery/patches/*.patch
    git push -u origin ${branch}

VERIFY BEFORE TRUSTING
----------------------
    sha256sum ${bundleName}
and compare against SHA256SUMS.txt.
`;
  fs.writeFileSync(path.join(recoveryDir, 'manifest.txt'), manifest);

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  const sums = walk(recoveryDir)
    .filter((f) => path.basename(f) !== 'SHA256SUMS.txt')
    .map((f) => {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      return `${hash}  ${path.relative(recoveryDir, f).split(path.sep).join('/')}`;
    });
  fs.writeFileSync(path.join(recoveryDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

  console.log('\nRecovery written to:');
  console.log(`  ${bundlePath}`);
  console.log(`  ${patchDir} (${patches.length} patches)`);
  console.log(`  ${path.join(recoveryDir, 'manifest.txt')}`);
  console.log(`  ${path.join(recoveryDir, 'SHA256SUMS.txt')}`);
  console.log('\nNothing was reset. Your commits are still on this machine.');
}

if (require.main === module) main();
