#!/usr/bin/env node
'use strict';
/* Test runner. Discovers every *.test.js under tests/, runs them in sequence
 * (each owns a browser, so parallelism would just fight for CPU), and exits
 * non-zero if anything failed.
 *
 *   node tests/run-all.js                 # everything
 *   node tests/run-all.js authorization   # only suites whose path matches
 *   node tests/run-all.js --verbose       # print every assertion, not just failures
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const filters = args.filter(a => !a.startsWith('--'));

function discover(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'lib' || entry.name === 'node_modules') continue;
      out.push(...discover(full));
    } else if (entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

(async () => {
  let files = discover(ROOT);
  if (filters.length) {
    files = files.filter(f => filters.some(t => f.includes(t)));
  }
  if (!files.length) {
    console.error('No matching test files found.');
    process.exit(1);
  }

  const started = Date.now();
  let totalPassed = 0, totalFailed = 0;
  const failedSuites = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    process.stdout.write(`\n▶ ${rel}\n`);
    let report;
    try {
      report = await require(file)();
    } catch (e) {
      console.error(`  SUITE CRASHED: ${e && e.stack ? e.stack : e}`);
      totalFailed++; failedSuites.push(rel);
      continue;
    }
    totalPassed += report.passed;
    totalFailed += report.failed;
    for (const r of report.results) {
      if (!r.ok) console.log(`  ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
      else if (verbose) console.log(`  ✓ ${r.name}`);
    }
    console.log(`  ${report.passed} passed, ${report.failed} failed`);
    if (report.failed) failedSuites.push(rel);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log(`${files.length} suites · ${totalPassed} passed · ${totalFailed} failed · ${secs}s`);
  if (failedSuites.length) {
    console.log('\nFailing suites:');
    failedSuites.forEach(s => console.log('  - ' + s));
  }
  console.log('='.repeat(60));
  process.exit(totalFailed ? 1 : 0);
})();
