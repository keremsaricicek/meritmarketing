#!/usr/bin/env node
'use strict';
/* Runs a recovery script on ELECTRON'S Node.
 *
 * The database driver uses `node:sqlite`, which Electron 43 ships as a stable
 * built-in and which system Node keeps behind an experimental flag. Same
 * reason the test launcher exists, same approach: ask Electron's package where
 * its binary is and set ELECTRON_RUN_AS_NODE here, so the person running this
 * types one command and no environment variables.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function electronBinary() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && fs.existsSync(resolved)) return resolved;
  } catch (_) { /* fall through */ }
  const fallback = path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  return fs.existsSync(fallback) ? fallback : null;
}

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node scripts/recovery/run-with-electron.js <script.js> [args…]');
  process.exit(1);
}

const binary = electronBinary();
if (!binary) {
  console.error('Electron is not installed. Run `npm ci` first.');
  process.exit(1);
}

const result = spawnSync(binary, [path.resolve(ROOT, script), ...rest], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status === null ? 1 : result.status);
