#!/usr/bin/env node
'use strict';
/* Cross-platform test launcher.
 *
 * The suites must run on ELECTRON'S Node, not the system's: production uses
 * `node:sqlite`, which Electron 43 ships as a stable built-in and system Node
 * 22 keeps behind an experimental flag. So the runner is the Electron binary
 * started with ELECTRON_RUN_AS_NODE=1.
 *
 * Expressing that in an npm script as
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron tests/run-all.js
 *
 * works on a POSIX shell and fails on Windows twice over: cmd.exe does not
 * accept a leading VAR=value assignment, and the binary is `electron.exe`
 * inside a path written with the other separator. Rather than depend on a
 * shell shim, this launcher asks Electron's own package where its binary is
 * and spawns it with the environment set — identical behaviour on Windows,
 * macOS and Linux, and no new dependency.
 *
 *   node scripts/run-tests.js                 # everything
 *   node scripts/run-tests.js ui database     # only matching suites
 *   node scripts/run-tests.js --verbose
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* `require('electron')` from plain Node exports the absolute path to the
   binary. It is the package's own answer, so it stays correct if the layout
   ever changes; the explicit path is only a fallback for a partial install. */
function electronBinary() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && fs.existsSync(resolved)) return resolved;
  } catch (_) { /* fall through to the conventional location */ }

  const fallback = path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

const binary = electronBinary();
if (!binary) {
  console.error('Electron is not installed. Run `npm ci` before running the tests.');
  process.exit(1);
}

const result = spawnSync(binary, [path.join(ROOT, 'tests', 'run-all.js'), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

if (result.error) {
  console.error(`Could not start Electron: ${result.error.message}`);
  process.exit(1);
}
/* A signal kill has no exit code; report it as a failure rather than as 0. */
process.exit(result.status === null ? 1 : result.status);
