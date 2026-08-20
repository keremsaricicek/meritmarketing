'use strict';
/* STATIC SECURITY GATE OVER THE PRODUCTION RENDERER SOURCE.
 *
 * Three defect classes kept coming back because every test that looked for them
 * was written as a hand-maintained list of things to look for. A list only
 * catches what somebody remembered to put in it:
 *
 *   - An assertion named "no inline event handler of any kind survives" checked
 *     `[onclick],[onchange],[oninput],[onkeydown]`. It could not match
 *     `onmouseenter` or `onmouseleave`, which is exactly what was still in the
 *     markup. The test passed and the claim in its own name was false.
 *
 *   - The Command Palette ran its commands with `eval(item.run)`, falling back
 *     to `Function(item.run)()`. Nothing tested for a code evaluator in the
 *     renderer at all, so a live `eval` sat beside a CSP whose entire purpose
 *     is to prevent one.
 *
 *   - Duplicate `data-act`/`data-on`/`data-args` triples on a single start tag.
 *     HTML keeps the first and discards the rest, so the second behaviour was
 *     silently dead. No error, no failing test, just a control that did nothing.
 *
 * So these are written as EXHAUSTIVE PATTERNS over the source rather than
 * enumerations: any `on*=` attribute, any code-constructing call, any repeated
 * action attribute in one tag. A new event type or a new evaluator is caught
 * because it matches the shape, not because somebody predicted it.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const SOURCES = ['index.html', 'scripts/actions.js', 'scripts/bridge.js',
  'scripts/core.js', 'scripts/views.js', 'scripts/screens.js'];

/** Strip /* *​/ and // comments so a discussion of eval is not a use of eval. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Strip HTML comments, for the same reason. */
function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, ' ');
}

function line(source, index) {
  return source.slice(0, index).split('\n').length;
}

module.exports = async function () {
  const s = new Suite('ui/renderer-source-safety');

  const files = {};
  for (const rel of SOURCES) files[rel] = fs.readFileSync(path.join(RENDERER, rel), 'utf8');

  // ================================================== no code evaluators
  /* Each of these turns a STRING into running code. `setTimeout`/`setInterval`
     are only dangerous in their string form, so the pattern requires a quote —
     an ordinary `setTimeout(fn, 200)` is legitimate and must not be flagged. */
  const EVALUATORS = [
    ['eval(...)', /(^|[^.\w])eval\s*\(/],
    ['window.eval(...)', /\bwindow\s*\.\s*eval\b/],
    ['new Function(...)', /\bnew\s+Function\s*\(/],
    ['Function(...) as a constructor', /(^|[^.\w])Function\s*\(\s*['"`]/],
    ['setTimeout with a string body', /\bsetTimeout\s*\(\s*['"`]/],
    ['setInterval with a string body', /\bsetInterval\s*\(\s*['"`]/],
    ['document.write', /\bdocument\s*\.\s*write\b/],
    ['a javascript: URL', /['"`]javascript:/i],
  ];

  for (const rel of SOURCES) {
    const code = stripComments(rel.endsWith('.html') ? stripHtmlComments(files[rel]) : files[rel]);
    for (const [label, pattern] of EVALUATORS) {
      const match = pattern.exec(code);
      s.check(`${rel} contains no ${label}`, match === null,
        match ? `line ${line(code, match.index)}: ${code.slice(match.index, match.index + 60).trim()}` : '');
    }
  }

  // ============================================ no inline event attributes
  /* Exhaustive by shape: ANY attribute whose name starts with "on" followed by
     letters and an equals sign, sitting inside a tag. This is what the previous
     selector-list assertion could not do.

     `stripComments` has already removed prose. The leading boundary keeps
     `version=` and `data-on=` from matching, and requires the attribute to be
     preceded by whitespace or a quote as a real attribute always is. */
  const INLINE_HANDLER = /[\s"'`]on[a-z]{2,}\s*=/gi;
  for (const rel of SOURCES) {
    const code = stripComments(rel.endsWith('.html') ? stripHtmlComments(files[rel]) : files[rel]);
    const hits = [];
    for (const m of code.matchAll(INLINE_HANDLER)) {
      const attr = m[0].trim().replace(/[="'`\s]/g, '');
      /* `data-on="click"` is the delegated system's own attribute, and the
         match cannot reach it because of the boundary — but be explicit. */
      if (attr === 'on') continue;
      hits.push(`line ${line(code, m.index)}: ${attr}=`);
    }
    s.check(`${rel} contains no inline event attribute of any name`,
      hits.length === 0, hits.join(' | '));
  }

  /* The specific ones that escaped the old assertion, named so a regression is
     unmistakable rather than buried in a count. */
  for (const event of ['onmouseenter', 'onmouseleave', 'onmouseover', 'onmouseout',
    'onclick', 'onchange', 'oninput', 'onkeydown', 'onload', 'onerror', 'onsubmit', 'onfocus']) {
    const found = SOURCES.filter((rel) => new RegExp(`[\\s"'\`]${event}\\s*=`, 'i')
      .test(stripComments(files[rel])));
    s.check(`no source authors ${event}=`, found.length === 0, found.join(', '));
  }

  // ====================================== no duplicate action attributes
  /* HTML keeps the first occurrence of a repeated attribute and drops the rest.
     Two `data-act` triples on one tag therefore means the second one does
     nothing, silently. The event-scoped form (`data-act-click`,
     `data-act-mouseenter`) cannot collide with itself, which is why it exists.

     Template literals containing a ternary that emits ONE of two attribute sets
     are not duplicates in the rendered output, so a tag whose duplicate
     occurrences are separated by a `?`/`:` boundary is not reported. */
  const TAG = /<[a-zA-Z][^>]*>/g;
  for (const rel of SOURCES) {
    const code = rel.endsWith('.html') ? stripHtmlComments(files[rel]) : files[rel];
    const dupes = [];
    for (const m of code.matchAll(TAG)) {
      const tag = m[0];
      for (const attr of ['data-act', 'data-on', 'data-args']) {
        const occurrences = [...tag.matchAll(new RegExp(`\\b${attr}=`, 'g'))];
        if (occurrences.length < 2) continue;
        const between = tag.slice(occurrences[0].index, occurrences[occurrences.length - 1].index);
        if (/\?[\s\S]*`|`[\s\S]*:/.test(between)) continue;   // ternary, one branch renders
        dupes.push(`line ${line(code, m.index)}: ${attr} ×${occurrences.length}`);
        break;
      }
    }
    s.check(`${rel} has no tag carrying a duplicate data-act/data-on/data-args`,
      dupes.length === 0, dupes.join(' | '));
  }

  // ============================ the palette dispatches names, not source
  const core = files['scripts/core.js'];
  s.check('palette commands carry a named action, not a code fragment',
    !/\brun\s*:\s*['"`]/.test(stripComments(core)),
    'a palette entry still carries an executable string');
  s.check('the palette resolves commands through an allowlist',
    /PALETTE_ACTIONS\s*=\s*Object\.freeze\(/.test(core), 'no frozen allowlist found');
  s.check('every palette entry names an action in that allowlist',
    (() => {
      const allow = new Set([...core.matchAll(/^\s{2}([a-zA-Z][\w]*):\s*\(\.\.\.a\)/gm)].map((m) => m[1]));
      const used = [...core.matchAll(/action:\s*'([^']+)'/g)].map((m) => m[1]);
      return used.length > 0 && used.every((name) => allow.has(name));
    })(), 'a palette entry names a command the allowlist does not contain');

  // ================== the delegated dispatcher refuses to invoke built-ins
  const actions = files['scripts/actions.js'];
  s.check('the dispatcher refuses to invoke native built-ins by name',
    /\[native code\]/.test(actions),
    'window[name] would resolve eval, Function and open');
  s.check('the dispatcher delegates hover through bubbling events',
    /mouseover.*mouseenter|HOVER/.test(actions),
    'mouseenter does not bubble and cannot be delegated directly');

  return s.finish();
};
