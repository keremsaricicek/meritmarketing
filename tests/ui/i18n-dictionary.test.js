'use strict';
/* THE TWO DICTIONARIES STAY COMPLETE.
 *
 * The interface is English or Turkish (src/renderer/scripts/i18n.js). A key
 * that exists in one dictionary and not the other is a label that silently
 * stays English — nothing fails, the screen just looks half translated. So:
 *
 *   - every data-i18n / data-i18n-placeholder / -title / -aria-label key in
 *     index.html exists in BOTH dictionaries;
 *   - every English phrase passed as a literal to t(), te() or tn() in the
 *     renderer scripts has a Turkish entry;
 *   - the dictionaries carry only strings, and Turkish placeholders match the
 *     English ones ({n} stays {n});
 *   - the in-app copy of the user manual matches docs/.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { Suite } = require('../lib/harness');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

function loadDictionaries() {
  const ctx = { window: {}, document: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RENDERER, 'scripts', 'i18n.js'), 'utf8')
    + '\nthis.EN = I18N_EN; this.TR = I18N_TR; this.t = t; this.tn = tn; this.tNotice = tNotice; this.setLang = (l) => { i18nLang = l; };', ctx);
  return ctx;
}

/** Literal first arguments of t()/te(), and both phrases of tn(). */
function scriptPhrases() {
  const lit = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")`;
  const one = new RegExp(String.raw`(?<![\w.])(?:t|te)\(\s*` + lit, 'g');
  const two = new RegExp(String.raw`(?<![\w.])(?:tn|plural)\([^,()]+(?:\([^()]*\))?[^,()]*,\s*` + lit + String.raw`\s*,\s*` + lit, 'g');
  const unq = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const found = new Map();
  const dir = path.join(RENDERER, 'scripts');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'help-content.js' && f !== 'i18n.js')) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(one)) found.set(unq(m[1] ?? m[2]), file);
    for (const m of src.matchAll(two)) { found.set(unq(m[1] ?? m[2]), file); found.set(unq(m[3] ?? m[4]), file); }
  }
  return found;
}

module.exports = async function () {
  const s = new Suite('ui/i18n-dictionary');
  const d = loadDictionaries();
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

  // ------------------------------------------------------ static markup keys
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) keys.add(m[1]);
  s.check('index.html marks its static text with data-i18n keys', keys.size > 300, String(keys.size));
  const noEn = [...keys].filter((k) => !Object.prototype.hasOwnProperty.call(d.EN, k));
  const noTr = [...keys].filter((k) => !Object.prototype.hasOwnProperty.call(d.TR, k));
  s.check('every data-i18n key exists in the English dictionary', noEn.length === 0, noEn.join(', '));
  s.check('every data-i18n key exists in the Turkish dictionary', noTr.length === 0, noTr.join(', '));
  /* The English text in the markup is what the English dictionary says, so
     the page reads the same before and after applyI18n(). */
  const mismatched = [];
  for (const m of html.matchAll(/<(\w+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    const text = m[3].trim().replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    if (text && d.EN[m[2]] !== text) mismatched.push(`${m[2]}: "${text}" vs "${d.EN[m[2]]}"`);
  }
  s.check('the English dictionary matches the English text in the markup', mismatched.length === 0, mismatched.slice(0, 10).join('\n'));

  // ---------------------------------------------------- phrases built in JS
  const phrases = scriptPhrases();
  s.check('the renderer passes its visible text through t()', phrases.size > 400, String(phrases.size));
  const missing = [...phrases.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(d.TR, k));
  s.check('every phrase passed to t()/te()/tn() has a Turkish entry', missing.length === 0,
    missing.map((k) => `${k} (${phrases.get(k)})`).join('\n'));

  // --------------------------------------------------------- dictionary shape
  const nonString = Object.entries({ ...d.EN, ...d.TR }).filter(([, v]) => typeof v !== 'string');
  s.check('dictionaries hold only strings', nonString.length === 0, nonString.map(([k]) => k).join(', '));
  const placeholders = (x) => [...String(x).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const badVars = Object.keys(d.TR).filter((k) => {
    const en = Object.prototype.hasOwnProperty.call(d.EN, k) ? d.EN[k] : k;
    return !k.startsWith('action.') && placeholders(en) !== placeholders(d.TR[k]);
  });
  s.check('Turkish entries keep the same {placeholders} as the English', badVars.length === 0, badVars.join('\n'));
  const markup = Object.entries(d.TR).filter(([, v]) => /<[a-z/!]/i.test(v));
  s.check('no translation contains markup', markup.length === 0, markup.map(([k]) => k).join(', '));

  // ----------------------------------------------------------------- t() itself
  d.setLang('tr');
  s.check('t() fills placeholders', d.t('{n} rows → {file}', { n: 3, file: 'a.xlsx' }) === '3 satır → a.xlsx', d.t('{n} rows → {file}', { n: 3, file: 'a.xlsx' }));
  s.check('t() returns markup keys in Turkish', d.t('h.save') === 'Kaydet');
  s.check('an unknown phrase falls back to its English text', d.t('Some text nobody translated') === 'Some text nobody translated');
  s.check('tNotice() translates a known main-process sentence', d.tNotice('Guest not found.') === 'Misafir bulunamadı.');
  s.check('tNotice() translates a patterned sentence and keeps the values',
    d.tNotice('owner: Created guest Ayşe Demir (G1007)') === 'owner: Ayşe Demir (G1007) misafiri oluşturuldu', d.tNotice('owner: Created guest Ayşe Demir (G1007)'));
  s.check('tNotice() leaves an unknown sentence unchanged', d.tNotice('Something else entirely.') === 'Something else entirely.');
  d.setLang('en');
  s.check('English is unchanged by the dictionary', d.t('Note added') === 'Note added' && d.t('h.save') === 'Save' && d.tNotice('Guest not found.') === 'Guest not found.');

  // ------------------------------------------------------- in-app manual copy
  let fresh = true, detail = '';
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-help.js'), '--check'], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); }
  catch (e) { fresh = false; detail = String(e.stdout || '') + String(e.stderr || ''); }
  s.check('the in-app manual matches docs/ (node scripts/build-help.js)', fresh, detail);
  const helpJs = fs.readFileSync(path.join(RENDERER, 'scripts', 'help.js'), 'utf8');
  s.check('the manual is rendered without innerHTML', !/innerHTML|insertAdjacentHTML|outerHTML/.test(helpJs.replace(/\/\*[\s\S]*?\*\//g, '')));
  s.check('the manual is not fetched over the network', !/fetch\(|XMLHttpRequest/.test(helpJs));

  return s.finish();
};
