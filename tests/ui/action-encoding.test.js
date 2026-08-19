'use strict';
/* The delegated-action encoding.
 *
 * Replacing inline handlers with `data-args` moved a class of value into a new
 * escaping context. jsAttr() escaped for a single-quoted JavaScript string —
 * the context it was written for — but its output inside JSON is not merely
 * wrong, it is invalid: an apostrophe becomes \' and JSON.parse throws, so the
 * control silently does nothing at all.
 *
 * That is a quiet failure, which is the worst kind: no error, no console
 * message, just a Restore button that does not restore.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');

/* Mirrors what a browser does: reads the attribute, decoding entities. */
const decodeAttribute = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/* The helper as it is written into core.js. */
const jsonAttr = (value) => JSON.stringify(String(value)).slice(1, -1).replace(/'/g, '&#39;');

module.exports = async function () {
  const s = new Suite('ui/action-encoding');

  const core = fs.readFileSync(path.join(RENDERER, 'scripts', 'core.js'), 'utf8');
  const views = fs.readFileSync(path.join(RENDERER, 'scripts', 'views.js'), 'utf8');
  const screens = fs.readFileSync(path.join(RENDERER, 'scripts', 'screens.js'), 'utf8');
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const all = [core, views, screens, html].join('\n');

  // ------------------------------------------------------------ the helper
  s.check('core.js defines the JSON-attribute escaper', /function jsonAttr\(/.test(core));
  s.check('the old JS-string escaper is gone from the renderer',
    !/\bjsAttr\s*\(/.test(all), 'jsAttr is still called somewhere');

  // Values that break naive escaping.
  const hostile = [
    "O'Brien",
    'say "hi"',
    'back\\slash',
    'tab\there',
    'newline\nhere',
    "both'\"quotes",
    'MeritBackup-2026-08-19-manual.mmhbackup',
  ];
  for (const value of hostile) {
    const attribute = `["${jsonAttr(value)}"]`;
    let parsed = null;
    let threw = null;
    try { parsed = JSON.parse(decodeAttribute(attribute)); }
    catch (err) { threw = err.message; }
    s.check(`data-args survives ${JSON.stringify(value)}`,
      threw === null && parsed[0] === value,
      threw || `got ${JSON.stringify(parsed)}`);
  }

  // The apostrophe must not close the single-quoted attribute early.
  s.check('an apostrophe is encoded so it cannot close the attribute',
    !jsonAttr("O'Brien").includes("'"), jsonAttr("O'Brien"));

  // ------------------------------------------------- every emitted data-args
  // Static ones must be valid JSON as written; interpolated ones are checked by
  // shape, since their values are only known at render time.
  const emitted = all.match(/data-args='(\[[^']*\])'/g) || [];
  s.check('the renderer emits delegated action arguments', emitted.length > 100, String(emitted.length));

  const literal = [];
  const interpolated = [];
  for (const raw of emitted) {
    const body = raw.slice("data-args='".length, -1);
    (body.includes('${') ? interpolated : literal).push(body);
  }
  s.check('there are both literal and interpolated argument lists',
    literal.length > 0 && interpolated.length > 0, `${literal.length} literal, ${interpolated.length} interpolated`);

  const badLiteral = literal.filter((body) => {
    try { JSON.parse(body); return false; } catch (_) { return true; }
  });
  s.check('every literal data-args is valid JSON', badLiteral.length === 0, badLiteral.slice(0, 3).join(' | '));

  /* An interpolated STRING argument must go through the escaper. A bare
     `"${x}"` is the shape that breaks the moment x contains a quote. */
  const unescaped = interpolated.filter((body) => {
    const stringSlots = body.match(/"\$\{[^}]*\}"/g) || [];
    return stringSlots.some((slot) => !/jsonAttr\(/.test(slot) && !/^"\$\{(page|uid|role|panelId|dateStr)\}"$/.test(slot));
  });
  s.check('every interpolated string argument is escaped or a known-safe internal id',
    unescaped.length === 0, unescaped.slice(0, 3).join(' | '));

  // -------------------------------------------------- dispatcher robustness
  const actions = fs.readFileSync(path.join(RENDERER, 'scripts', 'actions.js'), 'utf8');
  s.check('the dispatcher tolerates unparseable arguments rather than throwing',
    /catch \(_\) \{ return \[\]; \}/.test(actions), 'no guard around JSON.parse');
  s.check('the dispatcher looks a name up rather than evaluating a string',
    !/\beval\(|new Function\(/.test(actions), 'the dispatcher evaluates code');
  s.check('every event the markup declares is listened for', (() => {
    const declared = new Set((all.match(/data-on="([a-z]+)"/g) || [])
      .map((m) => m.slice('data-on="'.length, -1)));
    const listened = new Set((actions.match(/for \(const type of \[([^\]]*)\]/) || [, ''])[1]
      .split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean));
    const missing = [...declared].filter((d) => !listened.has(d));
    return missing.length === 0 ? true : missing.join(',');
  })() === true, 'an event type is declared in markup but never listened for');

  return s.finish();
};
