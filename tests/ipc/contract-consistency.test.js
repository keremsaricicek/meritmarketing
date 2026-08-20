'use strict';
/* THE RENDERER AND THE CONTRACT MUST AGREE — CHECKED STATICALLY.
 *
 * This gate exists because of one defect class that kept shipping and kept
 * being invisible: the renderer sending a field the strict schema does not
 * accept, or reading a field the service never returns.
 *
 * Every instance looked different and was the same thing:
 *
 *   - the Customer form sent `photoPath`; the contract says `photoName`
 *   - the Profile form sent `photoPath` AND `inactive` on create
 *   - the renderer read `photo_name` as `photo_path` in twenty-five places, so
 *     every avatar in the product was blank
 *   - Reports sent `status:''` and `from:''` for blank filters
 *   - Reports offered `createdFrom`/`createdTo` the contract never accepted
 *   - `customers:picker` was sent a `scoped` flag that does not exist
 *
 * None of it failed loudly. A strict schema refuses the call and the screen
 * renders nothing; a missing property reads as `undefined` and the avatar is
 * simply empty. The service tests passed throughout, because they never
 * constructed the payload the renderer constructs.
 *
 * So: parse the renderer's LITERAL payloads out of the source and check every
 * key against the real schema. This cannot catch a key computed at runtime —
 * the golden-path suite is the authority for that — but it catches the whole
 * class of mistyped and invented field names before anything is launched.
 */

const fs = require('fs');
const path = require('path');
const { Suite } = require('../lib/harness');
const { SCHEMAS } = require('../../src/shared/validation/schemas');
const { SURFACE } = require('../../src/shared/contracts/ipc-surface');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'scripts');

/* `window.api.customers.create` → `customers:create`. The adapter renames a
   handful of verbs, so those map explicitly rather than by convention. */
const ADAPTED = Object.freeze({
  'auth.firstRun': 'app:needsSetup',
  'export.filtered': 'export:run',
  'export.run': 'export:run',
  'photos.pick': 'photos:import',
  'photos.crop': 'photos:crop',
  'notifications.dismissAll': 'notifications:markAllRead',
  'profiles.relatedCustomers': 'profiles:related',
  'backup.openFolder': 'app:openDataFolder',
  'reports.access': null,          // resolved in the renderer, never crosses
  'dialog.confirm': null,          // an in-app modal, not IPC
  'photos.save': null,             // removed; crop replaced it
});

function channelFor(verb) {
  if (Object.prototype.hasOwnProperty.call(ADAPTED, verb)) return ADAPTED[verb];
  const [namespace, name] = verb.split('.');
  return `${namespace}:${name}`;
}

/** The keys a zod object schema accepts, or null if it is not a plain object. */
function allowedKeys(schema) {
  const shape = schema && schema._def && (schema._def.shape
    ? (typeof schema._def.shape === 'function' ? schema._def.shape() : schema._def.shape)
    : null);
  return shape ? Object.keys(shape) : null;
}

/* Pull `window.api.x.y({ ...literal object... })` out of the source. Only the
   TOP-LEVEL keys of a literal are read; a spread or a computed key makes the
   payload unknowable statically and the call site is skipped rather than
   guessed at. */
function literalCallSites(source) {
  const sites = [];
  const call = /window\.api\.([a-zA-Z]+)\.([a-zA-Z]+)\s*,?\s*\{/g;
  let m;
  while ((m = call.exec(source)) !== null) {
    const verb = `${m[1]}.${m[2]}`;
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    const body = source.slice(m.index + m[0].length, end);
    if (body.includes('...')) continue;                       // spread: unknowable
    const keys = [];
    let nesting = 0;
    let literal = true;
    for (const part of body.split(/,(?![^[{(]*[\]})])/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed);
      if (key) keys.push(key[1]);
      else if (/^\[/.test(trimmed)) literal = false;          // computed key
    }
    void nesting;
    if (!literal) continue;
    sites.push({ verb, keys, at: source.slice(0, m.index).split('\n').length });
  }
  return sites;
}

module.exports = async function () {
  const s = new Suite('ipc/contract-consistency');

  const files = {};
  for (const f of fs.readdirSync(RENDERER)) files[f] = fs.readFileSync(path.join(RENDERER, f), 'utf8');

  // ============================ every literal renderer payload type-checks
  const offenders = [];
  let checked = 0;
  for (const [file, source] of Object.entries(files)) {
    for (const site of literalCallSites(source)) {
      const channel = channelFor(site.verb);
      if (channel === null) continue;                          // never reaches IPC
      const schema = SCHEMAS[channel];
      if (!schema) {
        offenders.push(`${file}:${site.at} ${site.verb} → no schema for ${channel}`);
        continue;
      }
      const allowed = allowedKeys(schema);
      if (!allowed) continue;                                  // not a plain object schema
      checked++;
      const unknown = site.keys.filter((k) => !allowed.includes(k));
      if (unknown.length) {
        offenders.push(`${file}:${site.at} ${site.verb} sends ${unknown.join(', ')} — accepts ${allowed.join(', ')}`);
      }
    }
  }
  s.check(`every literal renderer payload uses fields the contract accepts (${checked} call sites)`,
    offenders.length === 0, offenders.slice(0, 6).join(' | '));

  // ========================== every preload method maps to a real channel
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  const exposed = [...preload.matchAll(/call\('([^']+)'\)/g)].map((m) => m[1]);
  const undocumented = exposed.filter((c) => !SURFACE[c]);
  const unschemad = exposed.filter((c) => !SCHEMAS[c]);
  s.check(`every preload method targets a documented channel (${exposed.length} methods)`,
    undocumented.length === 0, undocumented.join(', '));
  s.check('every preload method targets a channel with a schema',
    unschemad.length === 0, unschemad.join(', '));

  // ================= surface, schemas and handlers describe the same set
  const handlers = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc', 'handlers.js'), 'utf8');
  const handled = new Set([...handlers.matchAll(/^\s*'([a-zA-Z]+:[a-zA-Z]+)'\s*:/gm)].map((m) => m[1]));
  const documented = Object.keys(SURFACE);
  const schemad = Object.keys(SCHEMAS);

  s.check(`the surface and the schemas cover the same channels (${documented.length})`,
    documented.length === schemad.length
      && documented.every((c) => schemad.includes(c)),
    `only in surface: ${documented.filter((c) => !schemad.includes(c)).join(', ')} | only in schemas: ${schemad.filter((c) => !documented.includes(c)).join(', ')}`);

  const missingHandler = documented.filter((c) => !handled.has(c));
  s.check('every documented channel has a handler',
    missingHandler.length === 0, missingHandler.join(', '));

  // ============== the renderer only reads columns the database actually has
  /* `photo_path` is the cautionary tale: a field that exists in no table, no
     query and no service, read in twenty-five places, silently yielding
     undefined. Checking the specific shape that bit is cheap and exact. */
  /* EVERY migration, not just the first — a column added later is still a
     column the renderer may legitimately read. */
  const migrationsDir = path.join(ROOT, 'database', 'migrations');
  const schemaSql = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n');
  const phantomColumns = ['photo_path', 'created_by_user_id', 'note_date', 'deleted_by_name'];
  for (const column of phantomColumns) {
    const inSchema = new RegExp(`\\b${column}\\b`).test(schemaSql);
    const usedBy = Object.entries(files)
      .filter(([, src]) => new RegExp(`\\.${column}\\b`).test(src))
      .map(([f]) => f);
    s.check(`the renderer does not read a column named ${column} that the schema lacks`,
      inSchema || usedBy.length === 0, `${column} read in: ${usedBy.join(', ')}`);
  }

  // ====================== blank optional filters are omitted, not sent empty
  const views = files['views.js'];
  s.check('report and filter payloads are normalised through omitBlank',
    (views.match(/omitBlank\(/g) || []).length >= 6,
    'a filter payload still builds its object inline');
  s.check('the normaliser drops empty strings but keeps false and zero',
    (() => {
      const core = files['core.js'];
      const fn = /function omitBlank\(payload\)\{?[\s\S]*?\n\}/.exec(core);
      if (!fn) return false;
      /* eslint-disable no-new-func */
      const omitBlank = new Function(`${fn[0]}; return omitBlank;`)();
      const out = omitBlank({ a: '', b: null, c: undefined, d: false, e: 0, f: 'x' });
      return !('a' in out) && !('b' in out) && !('c' in out)
        && out.d === false && out.e === 0 && out.f === 'x';
    })(), 'omitBlank does not behave as documented');

  return s.finish();
};
