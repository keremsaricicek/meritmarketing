'use strict';
/* One-time extraction of the single-file application into renderer assets.
 *
 * Three jobs:
 *   1. split CSS / markup / scripts out of merit-marketing-hub.html
 *   2. drop the in-page mock backend — it now lives in the main process
 *   3. rewrite every inline event handler as a data-action, because a strict
 *      Content-Security-Policy (script-src 'self') makes inline handlers inert
 *
 * Step 3 is mechanical for `fn(literal, literal)` shapes. Anything more
 * complicated is listed in COMPLEX below and converted deliberately, because a
 * regex that half-understands JavaScript is worse than one that refuses.
 *
 * Run: node scripts/extract-renderer.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'merit-marketing-hub.html');
const OUT = path.join(ROOT, 'src', 'renderer');

/* Handlers that are not a single call with literal arguments. Each becomes a
   named action so the delegation never has to interpret JavaScript. */
const COMPLEX = [
  { from: `closeModal('modalCalDay'); goToGuest(${'${r.customer_id}'},'reservations')`,
    to: { action: 'calDayGoToGuest', args: '[${r.customer_id}]' } },
  { from: `openCancelReservationModal(${'${r.id}'}); event.stopPropagation();`,
    to: { action: 'rowCancelReservation', args: '[${r.id}]' } },
  { from: `openCustomerModal(${'${c.id}'}); event.stopPropagation();`,
    to: { action: 'rowEditCustomer', args: '[${c.id}]' } },
  { from: `openReservationModal(${'${r.id}'}); event.stopPropagation();`,
    to: { action: 'rowEditReservation', args: '[${r.id}]' } },
  { from: "setResNewGuest(false); openFinder({ mode:'customer', targetInputId:'resCustomerSelect', scoped:false, title:'Find Guest', subtitle:'Search by ID, name or phone', onSelect:onResCustomerChange })",
    to: { action: 'openReservationGuestFinder', args: '[]' } },
  { from: "openFinder({ mode:'customer', targetInputId:'recCustomerSelect', scoped:isMarketingScoped(), title:'Find Guest', subtitle:'Search by ID, name or phone', onSelect:onRecordCustomerChange })",
    to: { action: 'openRecordGuestFinder', args: '[]' } },
  { from: "openFinder({ mode:'customer', targetInputId:'resCustomerSelect', scoped:false, title:'Find Guest', subtitle:'Search by ID, name or phone', onSelect:onResCustomerChange })",
    to: { action: 'openReservationGuestFinder', args: '[]' } },
  { from: "openFinder({ mode:'profile', targetInputId:'resInvitedBy', title:'Find Marketing Profile', subtitle:'Search by name', onSelect:onResInvitedByChange })",
    to: { action: 'openReservationInvitedByFinder', args: '[]' } },
  { from: "openFinder({ mode:'profile', targetInputId:'resInvitedBy', title:'Find Marketing Profile', subtitle:'Search by name' })",
    to: { action: 'openReservationInvitedByFinder', args: '[]' } },
  { from: "openFinder({ mode:'profile', targetInputId:'recMarketing', writeAs:'id', title:'Find Marketing Profile', subtitle:'Search by name' })",
    to: { action: 'openRecordMarketingFinder', args: '[]' } },
  { from: 'openCancelReservationModal(editingReservationId)',
    to: { action: 'cancelEditingReservation', args: '[]' } },
  { from: 'openDeleteReservationModal(editingReservationId)',
    to: { action: 'deleteEditingReservation', args: '[]' } },
  { from: "if(event.key==='Enter'){openCustomerModal(${c.id})}",
    to: { action: 'enterOpensCustomer', args: '[${c.id}]' } },
  { from: "if(event.key==='Enter'){openUserModal(${u.id})}",
    to: { action: 'enterOpensUser', args: '[${u.id}]' } },
  { from: "if(event.key==='ArrowRight')openCrmSubmenu(event)",
    to: { action: 'arrowRightOpensCrmSubmenu', args: '[{"$":"event"}]' } },
];


/* Handlers whose text comes from DATA rather than markup. The data itself is
   rewritten to carry an action name and arguments, so nothing anywhere needs to
   interpret a JavaScript string at runtime. */
const DATA_HANDLERS = [
  // dashboard KPI cells: go:"switchTab('profiles')"  ->  act/args pair
  [/go:"switchTab\('([a-z]+)'\)"/g, "act:'switchTab', actArgs:['$1']"],
  [/go:"goReservationsUpcoming\(\)"/g, "act:'goReservationsUpcoming', actArgs:[]"],
  [/go:"goCustomersFiltered\('([A-Z_]+)'\)"/g, "act:'goCustomersFiltered', actArgs:['$1']"],
  // empty-state actions
  [/onclick:"el\('([A-Za-z]+)'\)\.value='';on([A-Za-z]+)\(\)"/g, "act:'clearSearchAnd', actArgs:['$1','on$2']"],
  [/onclick:'clearListFilters\(\);el\(\\'listSearch\\'\)\.value=\\'\\';onListSearch\(\)'/g,
   "act:'clearListFiltersAndSearch', actArgs:[]"],
  [/onclick:'([A-Za-z]+)\(\)'/g, "act:'$1', actArgs:[]"],
  [/onclick:"([A-Za-z]+)\('([a-zA-Z_]+)'\)"/g, "act:'$1', actArgs:['$2']"],
  [/onclick:`openCrmNoteModal\(\$\{c\.id\}\)`/g, "act:'openCrmNoteModal', actArgs:[c.id]"],
];

/* Trivial handlers with no function call of their own. */
const LITERAL_HANDLERS = [
  ['onclick="event.stopPropagation()"', `data-act="stopPropagation" data-on="click" data-args='[]'`],
];


/* Corrections applied after the handler rewrite.
 *
 * jsAttr() escaped a value for a single-quoted JavaScript string — the context
 * it was written for. After the rewrite the same values sit inside JSON in a
 * data-args attribute, where its output is not merely wrong but invalid: an
 * apostrophe becomes \' which JSON.parse rejects, so the control silently does
 * nothing. Replaced with a JSON-body escaper. */
const POST_FIXES = [
  [/jsAttr\(/g, 'jsonAttr('],
  [/function jsonAttr\(str\)\{[^}]*\}/g, ''],
];

const JSON_ATTR_HELPER = `
/* Escape a value for embedding inside JSON that itself sits inside a
   single-quoted HTML attribute. JSON.stringify handles the quoting and control
   characters; the apostrophe would otherwise close the attribute early. */
function jsonAttr(value){
  return JSON.stringify(String(value)).slice(1, -1).replace(/'/g, '&#39;');
}
`;

function splitSource() {
  const text = fs.readFileSync(SOURCE, 'utf8');
  const styleStart = text.indexOf('<style>');
  const styleEnd = text.indexOf('</style>');
  const css = text.slice(styleStart + '<style>'.length, styleEnd);

  const bodyStart = text.indexOf('<body>');
  const bodyEnd = text.lastIndexOf('</body>');
  const body = text.slice(bodyStart + '<body>'.length, bodyEnd);

  /* Script blocks, in document order. The first is the localStorage mock
     backend; it is dropped rather than ported, because its replacement is the
     main process. */
  const scripts = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(body)) !== null) scripts.push(m[1]);

  const markup = body.replace(/<script>[\s\S]*?<\/script>/g, '').trim();
  return { css, markup, scripts };
}

/* Split an argument list on top-level commas only, so a string containing a
   comma does not become two arguments. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/* Convert one JS argument into the JSON the delegation will parse.
   `${...}` interpolations are left in place: at render time the template
   literal fills them in, and the result has to be valid JSON. */
function argToJson(arg) {
  const value = arg.trim();
  if (value === 'event') return '{"$":"event"}';
  if (value === 'this') return '{"$":"this"}';
  /* The delegation reads these off the element that fired, so a select or a
     checkbox keeps working without an inline expression. */
  if (value === 'this.value') return '{"$":"value"}';
  if (value === 'this.checked') return '{"$":"checked"}';
  if (value === 'true' || value === 'false' || value === 'null') return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  /* A bare interpolation: `${r.id}` or `${page + 1}`. Emitted raw so a number
     stays a number. */
  if (/^\$\{[^{}]*\}$/.test(value)) return value;
  /* A single-quoted string, possibly containing interpolations. */
  const quoted = /^'([\s\S]*)'$/.exec(value);
  if (quoted) return `"${quoted[1].replace(/"/g, '\\"')}"`;
  const dquoted = /^"([\s\S]*)"$/.exec(value);
  if (dquoted) return `"${dquoted[1].replace(/"/g, '\\"')}"`;
  return null; // not a literal we are willing to guess at
}

function transformHandlers(text, report) {
  let out = text;

  for (const [find, replace] of LITERAL_HANDLERS) {
    while (out.includes(find)) { out = out.replace(find, replace); report.converted++; }
  }
  for (const [pattern, replacement] of DATA_HANDLERS) {
    out = out.replace(pattern, (...m) => { report.dataHandlers++; return replacement.replace(/\$(\d)/g, (_, i) => m[Number(i)]); });
  }
  /* The pager builds its handler from a function NAME held in a variable. */
  out = out.replace(/onclick="\$\{fnName\}\(\$\{page ([-+]) 1\}\)"/g,
    (_, op) => { report.converted++; return `data-act="\${fnName}" data-on="click" data-args='[\${page ${op} 1}]'`; });
  /* Consumers of the rewritten data. */
  out = out.replace(/onclick="\$\{a\.onclick\}"/g,
    () => { report.converted++; return `data-act="\${a.act}" data-on="click" data-args='\${JSON.stringify(a.actArgs || [])}'`; });
  out = out.replace(/onclick="\$\{c\.go\}"/g,
    () => { report.converted++; return `data-act="\${c.act}" data-on="click" data-args='\${JSON.stringify(c.actArgs || [])}'`; });

  for (const { from, to } of COMPLEX) {
    let index = out.indexOf(from);
    while (index !== -1) {
      const before = out.slice(0, index);
      let attrStart = -1;
      let attrName = '';
      for (const candidate of ['onclick', 'onchange', 'oninput', 'onkeydown', 'ondblclick']) {
        const at = Math.max(before.lastIndexOf(`${candidate}="`), before.lastIndexOf(`${candidate}='`));
        if (at > attrStart) { attrStart = at; attrName = candidate; }
      }
      if (attrStart === -1) break;
      const quote = out[attrStart + `${attrName}=`.length];
      const end = index + from.length;
      if (out[end] !== quote) break;
      out = out.slice(0, attrStart)
        + `data-act="${to.action}" data-on="${attrName.slice(2)}" data-args='${to.args}'`
        + out.slice(end + 1);
      report.complex++;
      index = out.indexOf(from);
    }
  }

  const EVENTS = ['onclick', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onmouseover', 'ondblclick'];
  for (const event of EVENTS) {
    const attr = event.slice(2);
    const pattern = new RegExp(`${event}=(["'])([a-zA-Z_$][a-zA-Z0-9_$]*)\\(([\\s\\S]*?)\\)\\1`, 'g');
    out = out.replace(pattern, (whole, q, fn, argText) => {
      const args = argText.trim() === '' ? [] : splitArgs(argText);
      const json = args.map(argToJson);
      if (json.some((v) => v === null)) { report.skipped.push(whole.slice(0, 90)); return whole; }
      report.converted++;
      const argsAttr = `[${json.join(',')}]`;
      /* Single-quoted attribute so the JSON's double quotes need no escaping. */
      return `data-act="${fn}" data-on="${attr}" data-args='${argsAttr}'`;
    });
  }
  return out;
}

function main() {
  const { css, markup, scripts } = splitSource();
  const report = { converted: 0, complex: 0, dataHandlers: 0, skipped: [] };

  fs.mkdirSync(path.join(OUT, 'styles'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'scripts'), { recursive: true });

  fs.writeFileSync(path.join(OUT, 'styles', 'app.css'), css.trim() + '\n');

  /* scripts[0] is the mock backend and is deliberately discarded. */
  const rendererScripts = scripts.slice(1);
  const names = ['core.js', 'views.js', 'screens.js', 'extra.js'];
  const written = [];
  rendererScripts.forEach((code, i) => {
    const name = names[i] || `part-${i}.js`;
    let out = transformHandlers(code, report);
    for (const [pattern, replacement] of POST_FIXES) out = out.replace(pattern, replacement);
    /* The helper lives beside the other DOM helpers in the first script. */
    if (name === 'core.js') {
      out = out.replace(/function el\(id\)\{ return document\.getElementById\(id\); \}/,
        (m) => `${JSON_ATTR_HELPER.trim()}\n${m}`);
    }
    fs.writeFileSync(path.join(OUT, 'scripts', name), out.trim() + '\n');
    written.push(name);
  });

  const transformedMarkup = transformHandlers(markup, report);
  const scriptTags = ['bridge.js', 'actions.js', ...written]
    .map((f) => `  <script src="./scripts/${f}"></script>`).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Merit Marketing Hub</title>
<link rel="stylesheet" href="./styles/app.css">
</head>
<body>
${transformedMarkup}
${scriptTags}
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);

  console.log(`inline handlers converted : ${report.converted}`);
  console.log(`complex handlers named    : ${report.complex}`);
  console.log(`data-driven handlers      : ${report.dataHandlers}`);
  console.log(`skipped (need attention)  : ${report.skipped.length}`);
  for (const s of report.skipped.slice(0, 25)) console.log(`  ! ${s}`);
  console.log(`scripts written           : ${written.join(', ')}`);
}

if (require.main === module) main();
module.exports = { splitArgs, argToJson, transformHandlers };
